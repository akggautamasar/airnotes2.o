import asyncio
import json
import hashlib
from datetime import datetime, timedelta
from typing import Dict, Optional
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.responses import Response, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import jwt as pyjwt
import uuid

import config
from utils.clients import initialize_clients, get_client
from utils.streamer import media_streamer
from utils.extra import auto_ping_website
from utils.logger import Logger
import encoder

logger = Logger(__name__)
file_cache: Dict[str, Dict] = {}
security = HTTPBearer(auto_error=False)

# ─── Persistent storage ───────────────────────────────────────────────────────
DATA_DIR = Path("./cache")
DATA_DIR.mkdir(parents=True, exist_ok=True)
FOLDERS_FILE = DATA_DIR / "folders.json"

# folder_db holds folders, assignments, channel_registry AND file_cache_data
# This means everything survives redeploys via Telegram backup
folder_db: Dict = {
    "folders": {},
    "file_assignments": {},
    "channel_registry": {},
    "file_cache_data": {},   # ← persisted file index (like drive.data)
}

# ─── Save to disk ─────────────────────────────────────────────────────────────
def _save_folders():
    # Also persist current file_cache into folder_db before saving
    folder_db["file_cache_data"] = dict(file_cache)
    with open(FOLDERS_FILE, "w") as f:
        json.dump(folder_db, f, indent=2)

# ─── Backup folders.json to Telegram (survives redeploys) ────────────────────
_backup_pending = False

async def _backup_to_telegram():
    global _backup_pending
    if _backup_pending:
        return
    _backup_pending = True
    try:
        await asyncio.sleep(5)  # debounce
        _save_folders()  # ensure file_cache_data is up to date
        client = get_client()
        caption = (
            f"📦 AirNotes backup\n"
            f"Updated: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')} UTC\n"
            "Do not delete — used to restore data on redeploy."
        )
        backup_msg_id = getattr(config, "FOLDERS_BACKUP_MSG_ID", None) or config.DATABASE_BACKUP_MSG_ID
        try:
            from pyrogram.types import InputMediaDocument
            await client.edit_message_media(
                config.STORAGE_CHANNEL,
                backup_msg_id,
                media=InputMediaDocument(
                    str(FOLDERS_FILE),
                    caption=caption,
                    file_name="folders.json",
                ),
            )
            logger.info("folders.json backed up to Telegram.")
        except Exception as e:
            logger.warning(f"edit_message_media failed: {e} — trying send_document")
            try:
                await client.send_document(
                    config.STORAGE_CHANNEL,
                    str(FOLDERS_FILE),
                    caption=caption,
                    file_name="folders.json",
                )
            except Exception as e2:
                logger.error(f"Telegram backup failed: {e2}")
    finally:
        _backup_pending = False

def _save_and_backup():
    _save_folders()
    asyncio.create_task(_backup_to_telegram())

# ─── Restore from Telegram on startup ────────────────────────────────────────
async def _restore_from_telegram():
    global folder_db
    try:
        client = get_client()
        backup_msg_id = getattr(config, "FOLDERS_BACKUP_MSG_ID", None) or config.DATABASE_BACKUP_MSG_ID
        msg = await client.get_messages(config.STORAGE_CHANNEL, backup_msg_id)
        if msg and msg.document and msg.document.file_name == "folders.json":
            dl_path = await msg.download(file_name=str(FOLDERS_FILE))
            logger.info(f"folders.json restored from Telegram.")
            with open(FOLDERS_FILE) as f:
                folder_db = json.load(f)
            folder_db.setdefault("channel_registry", {})
            folder_db.setdefault("folders", {})
            folder_db.setdefault("file_assignments", {})
            folder_db.setdefault("file_cache_data", {})

            # Restore file_cache from persisted data — instant, no Telegram scan needed
            restored = folder_db.get("file_cache_data", {})
            file_cache.clear()
            file_cache.update(restored)
            logger.info(
                f"Restored: {len(file_cache)} files, "
                f"{len(folder_db.get('folders', {}))} folders, "
                f"{len(folder_db.get('channel_registry', {}))} channels"
            )
            return True
        else:
            logger.info("No folders.json backup in Telegram — will do full scan.")
            return False
    except Exception as e:
        logger.warning(f"Could not restore from Telegram: {e} — will do full scan.")
        return False

def _load_folders():
    global folder_db
    if FOLDERS_FILE.exists():
        try:
            with open(FOLDERS_FILE) as f:
                folder_db = json.load(f)
            folder_db.setdefault("channel_registry", {})
            folder_db.setdefault("folders", {})
            folder_db.setdefault("file_assignments", {})
            folder_db.setdefault("file_cache_data", {})
            # Restore file cache from disk
            restored = folder_db.get("file_cache_data", {})
            file_cache.clear()
            file_cache.update(restored)
            logger.info(f"Loaded {len(file_cache)} files from local disk cache.")
        except Exception as e:
            logger.warning(f"Could not load from disk: {e}")

# ─── SSE broadcast ────────────────────────────────────────────────────────────
_sse_queues: list = []

def notify_new_file(file_entry: dict):
    data = json.dumps({"event": "new_file", "file": file_entry})
    dead = []
    for q in _sse_queues:
        try:
            q.put_nowait(data)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        try: _sse_queues.remove(q)
        except ValueError: pass

# ─── File type detection ──────────────────────────────────────────────────────
VIDEO_MIMES = {
    "video/mp4","video/x-matroska","video/webm","video/x-msvideo",
    "video/quicktime","video/x-flv","video/x-ms-wmv","video/3gpp",
    "video/mp2t","video/mpeg",
}
VIDEO_EXTS = {".mp4",".mkv",".webm",".avi",".mov",".m4v",".flv",".wmv",".3gp",".ts",".mpeg"}
EPUB_EXTS  = {".epub"}

def is_pdf(mime: str, fname: str) -> bool:
    return mime == "application/pdf" or fname.lower().endswith(".pdf")

def is_epub(mime: str, fname: str) -> bool:
    return mime in ("application/epub+zip","application/epub") or fname.lower().endswith(".epub")

def is_video(mime: str, fname: str) -> bool:
    return mime in VIDEO_MIMES or Path(fname).suffix.lower() in VIDEO_EXTS

def file_type(mime: str, fname: str) -> str:
    if is_pdf(mime, fname):   return "pdf"
    if is_epub(mime, fname):  return "epub"
    if is_video(mime, fname): return "video"
    return "other"

# ─── Auth helpers ─────────────────────────────────────────────────────────────
def create_jwt(data: dict, expires_hours: int = 24 * 7) -> str:
    payload = {**data, "exp": datetime.utcnow() + timedelta(hours=expires_hours)}
    return pyjwt.encode(payload, config.JWT_SECRET, algorithm="HS256")

def verify_jwt(token: str) -> dict:
    return pyjwt.decode(token, config.JWT_SECRET, algorithms=["HS256"])

async def require_auth(request: Request, credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = None
    if credentials and credentials.credentials:
        token = credentials.credentials
    if not token:
        token = request.query_params.get("token")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return verify_jwt(token)
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except pyjwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

# ─── Cache refresh (multi-channel) ───────────────────────────────────────────
_refresh_lock = asyncio.Lock()
_refresh_in_progress = False
_last_refresh: Optional[datetime] = None
REFRESH_INTERVAL_SECONDS = 5 * 60
FULL_SCAN_LIMIT = 50_000  # scan up to 50k messages per channel

async def refresh_channel(client, channel_id: int, new_cache: Dict):
    """Scan a single channel and populate new_cache with its files."""
    anchor_id = 1  # always scan from message 1
    upper_id  = anchor_id

    # Resolve channel name
    channel_name = None
    registry = folder_db.get("channel_registry", {})
    str_id = str(channel_id)
    if str_id in registry:
        channel_name = registry[str_id].get("name")
    if not channel_name:
        try:
            chat = await client.get_chat(channel_id)
            channel_name = getattr(chat, "title", None) or getattr(chat, "username", None) or str(channel_id)
            if str_id not in registry:
                registry[str_id] = {
                    "id": channel_id,
                    "name": channel_name,
                    "username": getattr(chat, "username", None) or "",
                    "registered_at": datetime.utcnow().isoformat(),
                    "auto_detected": True,
                }
                folder_db["channel_registry"] = registry
                _save_folders()
        except Exception:
            channel_name = str(channel_id)

    # Find highest existing message ID for this channel
    channel_prefix = f"ch{abs(channel_id)}_msg_"
    legacy_prefix  = "msg_"
    for key, v in file_cache.items():
        if key.startswith(channel_prefix) or (channel_id == config.STORAGE_CHANNEL and key.startswith(legacy_prefix)):
            mid = v.get("message_id", 0)
            if mid > upper_id:
                upper_id = mid

    # Probe for upper bound
    for probe_ids in [
        list(range(upper_id + 1, upper_id + 201, 20)),
        list(range(upper_id + 201, upper_id + 1001, 100)),
    ]:
        try:
            msgs = await client.get_messages(channel_id, probe_ids)
            for m in msgs:
                if m and not m.empty and m.id > upper_id:
                    upper_id = m.id
        except Exception:
            pass

    if upper_id <= 1:
        upper_id = FULL_SCAN_LIMIT

    start_id = 1
    new_files = 0
    for batch_start in range(upper_id, start_id - 1, -200):
        batch_end = max(batch_start - 199, start_id)
        ids = list(range(batch_start, batch_end - 1, -1))
        try:
            messages = await client.get_messages(channel_id, ids)
        except Exception as e:
            logger.warning(f"Batch fetch failed for channel {channel_id} at {batch_start}: {e}")
            break

        for message in messages:
            if not message or message.empty:
                continue
            media = getattr(message, "document", None) or getattr(message, "video", None)
            if not media:
                continue
            mime  = getattr(media, "mime_type", "") or ""
            fname = getattr(media, "file_name", "") or f"file_{message.id}"
            ftype = file_type(mime, fname)
            if ftype == "other":
                continue
            if channel_id == config.STORAGE_CHANNEL:
                key = f"msg_{message.id}"
            else:
                key = f"ch{abs(channel_id)}_msg_{message.id}"
            new_cache[key] = {
                "id": key, "message_id": message.id, "channel_id": channel_id,
                "channel_name": channel_name,
                "name": fname, "size": getattr(media, "file_size", 0),
                "date": message.date.timestamp() if message.date else 0,
                "caption": message.caption or "", "type": ftype, "mime": mime,
                **folder_db.get("file_meta", {}).get(key, {}),
            }
            new_files += 1
        await asyncio.sleep(0.05)

    return new_files

async def refresh_file_cache():
    global _refresh_in_progress, _last_refresh
    if _refresh_in_progress:
        return
    async with _refresh_lock:
        _refresh_in_progress = True
        try:
            client = get_client()
            new_cache: Dict[str, Dict] = {}

            # Scan config channels + dynamically registered channels
            config_channels = set(config.STORAGE_CHANNELS if config.STORAGE_CHANNELS else [config.STORAGE_CHANNEL])
            registry_channels = {v.get("id") or int(k) for k, v in folder_db.get("channel_registry", {}).items()}
            channels = list(config_channels | registry_channels)

            failed_channels = set()
            for channel_id in channels:
                if not channel_id:
                    continue
                try:
                    count = await refresh_channel(client, channel_id, new_cache)
                    logger.info(f"Channel {channel_id} scanned: {count} files")
                except Exception as e:
                    logger.error(f"Failed to refresh channel {channel_id}: {e}")
                    failed_channels.add(channel_id)

            prev_count = len(file_cache)
            new_count  = len(new_cache)
            if prev_count > 0 and new_count < prev_count * 0.7:
                logger.warning(f"Scan got {new_count}/{prev_count} — merging to avoid data loss")
                merged = dict(file_cache)
                merged.update(new_cache)
                new_cache = merged
            else:
                for key, val in file_cache.items():
                    ch = val.get("channel_id", config.STORAGE_CHANNEL)
                    if ch in failed_channels and key not in new_cache:
                        new_cache[key] = val

            file_cache.clear()
            file_cache.update(new_cache)
            _last_refresh = datetime.utcnow()
            pdfs   = sum(1 for f in file_cache.values() if f["type"] == "pdf")
            epubs  = sum(1 for f in file_cache.values() if f["type"] == "epub")
            videos = sum(1 for f in file_cache.values() if f["type"] == "video")
            logger.info(f"Cache refreshed: {pdfs} PDFs, {epubs} EPUBs, {videos} Videos across {len(channels)} channel(s)")

            # Save updated file index to Telegram so next startup is instant
            _save_and_backup()

        except Exception as e:
            logger.error(f"Cache refresh failed: {e}")
        finally:
            _refresh_in_progress = False

async def _periodic_refresh():
    await asyncio.sleep(300)  # wait 5 min before first periodic refresh
    while True:
        await asyncio.sleep(REFRESH_INTERVAL_SECONDS)
        await refresh_file_cache()

# ─── App lifecycle ────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1. Load from local disk (fast fallback)
    _load_folders()
    # 2. Init Telegram clients
    await initialize_clients()
    # 3. Restore from Telegram — overwrites disk data with latest backup
    #    This also restores file_cache instantly with no Telegram scan
    restored = await _restore_from_telegram()
    if not restored and not file_cache:
        logger.info("No backup found — scheduling full scan")

    encoder.init_encoder(file_cache, folder_db, _save_and_backup)
    asyncio.create_task(encoder.encoder_worker())

    # Always do a background scan to pick up any new files since last backup
    asyncio.create_task(refresh_file_cache())
    asyncio.create_task(_periodic_refresh())

    try:
        from bot_handler import setup_bot_handlers
        from utils.clients import multi_clients
        for client in multi_clients.values():
            setup_bot_handlers(client, file_cache, folder_db, _save_and_backup)
            logger.info("Bot handlers registered")
            break
    except Exception as e:
        logger.error(f"Bot handler setup failed: {e}")

    if config.WEBSITE_URL:
        asyncio.create_task(auto_ping_website(config.WEBSITE_URL))
    yield


app = FastAPI(title="AirNotes 2.0", lifespan=lifespan)

# ─── CORS ─────────────────────────────────────────────────────────────────────
_cors_origins = (
    [o.strip() for o in config.FRONTEND_URL.split(",") if o.strip()]
    if config.FRONTEND_URL and config.FRONTEND_URL != "*"
    else ["*"]
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Length", "Content-Range", "Accept-Ranges"],
)

# ─── Health ───────────────────────────────────────────────────────────────────
@app.get("/health")
@app.head("/health")
async def health():
    pdfs   = sum(1 for f in file_cache.values() if f.get("type") == "pdf")
    epubs  = sum(1 for f in file_cache.values() if f.get("type") == "epub")
    videos = sum(1 for f in file_cache.values() if f.get("type") == "video")
    config_channels = set(config.STORAGE_CHANNELS if config.STORAGE_CHANNELS else [config.STORAGE_CHANNEL])
    registry_channels = {v.get("id") or int(k) for k, v in folder_db.get("channel_registry", {}).items()}
    return {
        "status": "ok", "files_cached": len(file_cache),
        "pdfs": pdfs, "epubs": epubs, "videos": videos,
        "channels": len(config_channels | registry_channels),
        "registered_channels": len(folder_db.get("channel_registry", {})),
        "last_refresh": _last_refresh.isoformat() if _last_refresh else None,
        "refresh_in_progress": _refresh_in_progress,
    }

# ─── Auth ─────────────────────────────────────────────────────────────────────
@app.post("/api/auth/login")
async def login(request: Request):
    body = await request.json()
    if body.get("password", "") != config.ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="Invalid password")
    return {"token": create_jwt({"authenticated": True}), "message": "Login successful"}

@app.get("/api/auth/verify")
async def verify(user=Depends(require_auth)):
    return {"valid": True}

# ─── Files ────────────────────────────────────────────────────────────────────
@app.get("/api/files")
async def list_files(type: str = None, folder_id: str = None, user=Depends(require_auth)):
    files = list(file_cache.values())
    if type in ("pdf", "epub", "video"):
        files = [f for f in files if f.get("type") == type]
    elif type == "document":
        files = [f for f in files if f.get("type") in ("pdf", "epub")]
    if folder_id is not None:
        assignments = folder_db.get("file_assignments", {})
        files = [f for f in files if assignments.get(f["id"]) == folder_id]
    files.sort(key=lambda f: f["date"], reverse=True)
    return {
        "files": files, "total": len(files),
        "last_refresh": _last_refresh.isoformat() if _last_refresh else None,
        "refresh_in_progress": _refresh_in_progress,
    }

@app.get("/api/files/{file_id}/qualities")
async def get_qualities(file_id: str, user=Depends(require_auth)):
    if file_id not in file_cache:
        raise HTTPException(status_code=404, detail="File not found")
    variants = encoder.get_quality_variants(file_id)
    result = {"original": {"file_id": file_id, "label": "Original", "size": file_cache[file_id].get("size", 0), "ready": True}}
    for label, enc_file_id in variants.items():
        enc_info = file_cache.get(enc_file_id, {})
        result[label] = {"file_id": enc_file_id, "label": label, "size": enc_info.get("size", 0), "ready": bool(enc_info)}
    from encoder import QUALITY_PRESETS
    for q_label, *_ in QUALITY_PRESETS:
        if q_label not in result:
            result[q_label] = {"file_id": None, "label": q_label, "size": 0, "ready": False}
    return result

@app.head("/api/files/{file_id}/stream")
async def stream_file_head(file_id: str, request: Request, user=Depends(require_auth)):
    if file_id not in file_cache:
        raise HTTPException(status_code=404, detail="File not found")
    info = file_cache[file_id]
    file_size = info.get("size", 0)
    mime_type = info.get("mime", "application/octet-stream") or "application/octet-stream"
    from utils.streamer import get_mime_type
    if not mime_type or mime_type == "application/octet-stream":
        mime_type = get_mime_type(info["name"])
    return Response(
        status_code=200,
        headers={
            "Content-Length": str(file_size),
            "Content-Type": mime_type,
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=86400",
        }
    )

@app.get("/api/files/{file_id}/audio-info")
async def audio_info(file_id: str, user=Depends(require_auth)):
    if file_id not in file_cache:
        raise HTTPException(status_code=404, detail="File not found")
    info = file_cache[file_id]
    channel_id = info.get("channel_id", config.STORAGE_CHANNEL)
    try:
        import asyncio, json as _json
        from utils.clients import get_client
        from utils.streamer.custom_dl import ByteStreamer
        from utils.streamer import class_cache
        client = get_client()
        if client not in class_cache:
            class_cache[client] = ByteStreamer(client)
        streamer = class_cache[client]
        file_id_obj = await streamer.get_file_properties(channel_id, info["message_id"])
        chunks = []
        collected = 0
        probe_limit = 128 * 1024
        async for chunk in client.stream_media(file_id_obj.file_id, offset=0, limit=1):
            chunks.append(chunk)
            collected += len(chunk)
            if collected >= probe_limit:
                break
        sample = b"".join(chunks)[:probe_limit]
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_streams", "-select_streams", "a", "-i", "pipe:0",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(input=sample), timeout=15)
        probe = _json.loads(stdout or b"{}")
        streams = probe.get("streams", [])
        codec = streams[0].get("codec_name", "unknown") if streams else "unknown"
        BROWSER_SAFE = {"aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le", "pcm_u8"}
        needs_transcode = codec.lower() not in BROWSER_SAFE
        audio_tracks = []
        for i, s in enumerate(streams):
            tags = s.get("tags", {})
            lang  = tags.get("language") or tags.get("LANGUAGE") or ""
            title = tags.get("title") or tags.get("TITLE") or ""
            label = title or (lang.upper() if lang and lang != "und" else f"Track {i+1}")
            audio_tracks.append({"index": i, "codec": s.get("codec_name",""), "label": label, "lang": lang})
        return {"codec": codec, "needs_transcode": needs_transcode, "streams": len(streams), "audio_tracks": audio_tracks}
    except Exception as e:
        logger.warning(f"audio-info probe failed for {file_id}: {e}")
        return {"codec": "unknown", "needs_transcode": True, "error": str(e)}

@app.get("/api/files/{file_id}/stream")
async def stream_file(file_id: str, request: Request, transcode: bool = False, start_time: float = 0.0, audio_track: int = 0, user=Depends(require_auth)):
    if file_id not in file_cache:
        if not _refresh_in_progress:
            asyncio.create_task(refresh_file_cache())
        raise HTTPException(status_code=404, detail="File not found — cache may be refreshing, retry shortly")
    info = file_cache[file_id]
    channel_id = info.get("channel_id", config.STORAGE_CHANNEL)

    if not transcode:
        return await media_streamer(channel_id, info["message_id"], info["name"], request)

    from utils.clients import get_client
    from utils.streamer.custom_dl import ByteStreamer
    from utils.streamer import class_cache
    import os

    client = get_client()
    if client not in class_cache:
        class_cache[client] = ByteStreamer(client)
    streamer = class_cache[client]

    try:
        file_id_obj = await streamer.get_file_properties(channel_id, info["message_id"])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    async def transcode_stream():
        fifo_path = f"/tmp/tg_fifo_{info['message_id']}_{id(asyncio.current_task())}"
        try:
            os.mkfifo(fifo_path)
        except FileExistsError:
            os.unlink(fifo_path)
            os.mkfifo(fifo_path)
        seek_args = ["-ss", str(start_time)] if start_time > 0 else []
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-fflags", "+genpts+discardcorrupt",
            "-analyzeduration", "10M", "-probesize", "10M",
            "-i", fifo_path, *seek_args,
            "-map", "0:v:0", "-map", f"0:a:{audio_track}",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ac", "2",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof",
            "-f", "mp4", "pipe:1",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        async def feed_fifo():
            try:
                loop = asyncio.get_event_loop()
                fd = await loop.run_in_executor(None, lambda: os.open(fifo_path, os.O_WRONLY))
                async for chunk in client.stream_media(file_id_obj.file_id, offset=0, limit=99999):
                    if not chunk: break
                    await loop.run_in_executor(None, lambda c=chunk: os.write(fd, c))
            except Exception as e:
                logger.error(f"FIFO feeder error: {e}")
            finally:
                try: os.close(fd)
                except: pass
                try: os.unlink(fifo_path)
                except: pass
        feed_task = asyncio.create_task(feed_fifo())
        try:
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk: break
                yield chunk
        except (GeneratorExit, asyncio.CancelledError): pass
        except Exception as e: logger.error(f"Transcode read error: {e}")
        finally:
            feed_task.cancel()
            try: proc.kill(); await proc.wait()
            except: pass
            try: os.unlink(fifo_path)
            except: pass

    return StreamingResponse(
        transcode_stream(), media_type="video/mp4",
        headers={
            "Content-Type": "video/mp4", "Cache-Control": "no-store",
            "X-Accel-Buffering": "no", "Accept-Ranges": "none",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
        },
        status_code=200,
    )

@app.delete("/api/files/{file_id}")
async def delete_file(file_id: str, user=Depends(require_auth)):
    if file_id not in file_cache:
        raise HTTPException(status_code=404, detail="File not found")
    info = file_cache[file_id]
    try:
        client = get_client()
        channel_id = info.get("channel_id", config.STORAGE_CHANNEL)
        await client.delete_messages(channel_id, [info["message_id"]])
    except Exception as e:
        logger.warning(f"Could not delete Telegram message: {e}")
    del file_cache[file_id]
    folder_db["file_assignments"].pop(file_id, None)
    folder_db.setdefault("file_meta", {}).pop(file_id, None)
    _save_and_backup()
    return {"success": True}

@app.patch("/api/files/{file_id}/rename")
async def rename_file(file_id: str, request: Request, user=Depends(require_auth)):
    if file_id not in file_cache:
        raise HTTPException(status_code=404, detail="File not found")
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    file_cache[file_id]["name"] = name
    return {"success": True, "file": file_cache[file_id]}

@app.post("/api/files/{file_id}/copy")
async def copy_file(file_id: str, user=Depends(require_auth)):
    if file_id not in file_cache:
        raise HTTPException(status_code=404, detail="File not found")
    info = file_cache[file_id]
    try:
        client = get_client()
        src_channel = info.get("channel_id", config.STORAGE_CHANNEL)
        copied = await client.copy_message(config.STORAGE_CHANNEL, src_channel, info["message_id"])
        new_key = f"msg_{copied.id}"
        file_cache[new_key] = {
            "id": new_key, "message_id": copied.id, "channel_id": config.STORAGE_CHANNEL,
            "name": info["name"], "size": info["size"],
            "date": datetime.utcnow().timestamp(),
            "caption": info.get("caption", ""), "type": info["type"], "mime": info.get("mime", ""),
            "uploaded_by": info.get("uploaded_by", {}),
        }
        return {"success": True, "file": file_cache[new_key]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/files/{file_id}/move")
async def move_file(file_id: str, request: Request, user=Depends(require_auth)):
    if file_id not in file_cache:
        raise HTTPException(status_code=404, detail="File not found")
    body = await request.json()
    folder_id = body.get("folder_id")
    if folder_id is None:
        folder_db["file_assignments"].pop(file_id, None)
    else:
        if folder_id not in folder_db["folders"]:
            raise HTTPException(status_code=404, detail="Folder not found")
        folder_db["file_assignments"][file_id] = folder_id
    _save_and_backup()
    return {"success": True, "file_id": file_id, "folder_id": folder_id}

@app.get("/api/search")
async def search_files(q: str = "", type: str = None, user=Depends(require_auth)):
    q = q.lower().strip()
    results = [
        f for f in file_cache.values()
        if q in f["name"].lower() or q in f.get("caption", "").lower()
    ]
    if type in ("pdf", "epub", "video"):
        results = [f for f in results if f.get("type") == type]
    results.sort(key=lambda f: f["date"], reverse=True)
    return {"results": results, "total": len(results)}

@app.post("/api/files/refresh")
async def trigger_refresh(user=Depends(require_auth)):
    if not _refresh_in_progress:
        asyncio.create_task(refresh_file_cache())
    return {"message": "Refresh started in background", "refresh_in_progress": True}

# ─── Folders ──────────────────────────────────────────────────────────────────
@app.get("/api/folders")
async def list_folders(user=Depends(require_auth)):
    folders = list(folder_db["folders"].values())
    assignments = folder_db.get("file_assignments", {})
    for folder in folders:
        folder["file_count"] = sum(1 for v in assignments.values() if v == folder["id"])
    return {"folders": folders}

@app.post("/api/folders")
async def create_folder_api(request: Request, user=Depends(require_auth)):
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    folder_id = str(uuid.uuid4())[:8]
    folder = {
        "id": folder_id, "name": name, "parent_id": body.get("parent_id"),
        "locked": False, "password_hash": None,
        "created_at": datetime.utcnow().isoformat(),
    }
    folder_db["folders"][folder_id] = folder
    _save_and_backup()
    return {"success": True, "folder": folder}

@app.patch("/api/folders/{folder_id}")
async def update_folder_api(folder_id: str, request: Request, user=Depends(require_auth)):
    if folder_id not in folder_db["folders"]:
        raise HTTPException(status_code=404, detail="Folder not found")
    body = await request.json()
    folder = folder_db["folders"][folder_id]
    if "name" in body and body["name"].strip():
        folder["name"] = body["name"].strip()
    if "locked" in body:
        folder["locked"] = bool(body["locked"])
    if "password_hash" in body:
        folder["password_hash"] = body["password_hash"]
    _save_and_backup()
    return {"success": True, "folder": folder}

@app.post("/api/folders/{folder_id}/verify-password")
async def verify_folder_password(folder_id: str, request: Request, user=Depends(require_auth)):
    if folder_id not in folder_db["folders"]:
        raise HTTPException(status_code=404, detail="Folder not found")
    folder = folder_db["folders"][folder_id]
    if not folder.get("locked"):
        return {"valid": True}
    body = await request.json()
    password_hash = body.get("password_hash", "")
    stored_hash   = folder.get("password_hash", "")
    if not stored_hash or password_hash == stored_hash:
        return {"valid": True}
    raise HTTPException(status_code=403, detail="Invalid password")

@app.delete("/api/folders/{folder_id}")
async def delete_folder(folder_id: str, user=Depends(require_auth)):
    if folder_id not in folder_db["folders"]:
        raise HTTPException(status_code=404, detail="Folder not found")
    assignments = folder_db["file_assignments"]
    for fid in list(assignments.keys()):
        if assignments[fid] == folder_id:
            del assignments[fid]
    del folder_db["folders"][folder_id]
    _save_and_backup()
    return {"success": True}

@app.get("/api/folders/{folder_id}/files")
async def get_folder_files(folder_id: str, user=Depends(require_auth)):
    if folder_id not in folder_db["folders"]:
        raise HTTPException(status_code=404, detail="Folder not found")
    assignments = folder_db.get("file_assignments", {})
    file_ids = [fid for fid, vid in assignments.items() if vid == folder_id]
    files = [file_cache[fid] for fid in file_ids if fid in file_cache]
    files.sort(key=lambda f: f["date"], reverse=True)
    return {"files": files, "folder": folder_db["folders"][folder_id]}

@app.get("/api/assignments")
async def get_all_assignments(user=Depends(require_auth)):
    return {"assignments": folder_db.get("file_assignments", {})}

# ─── SSE ─────────────────────────────────────────────────────────────────────
@app.get("/api/events")
async def sse_events(request: Request, token: str = None):
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        verify_jwt(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    queue: asyncio.Queue = asyncio.Queue(maxsize=100)
    _sse_queues.append(queue)
    async def event_generator():
        try:
            yield ": keepalive\n\n"
            while True:
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=25)
                    yield f"data: {data}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                except Exception:
                    break
                if await request.is_disconnected():
                    break
        finally:
            try: _sse_queues.remove(queue)
            except ValueError: pass
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )

# ─── Channel Registry ─────────────────────────────────────────────────────────
@app.get("/api/channels")
async def list_channels(user=Depends(require_auth)):
    registry = folder_db.get("channel_registry", {})
    channels = []
    for str_id, ch in registry.items():
        ch_id = ch.get("id") or int(str_id)
        file_count = sum(1 for f in file_cache.values() if f.get("channel_id") == ch_id)
        channels.append({**ch, "id": ch_id, "str_id": str_id, "file_count": file_count})
    channels.sort(key=lambda c: c.get("registered_at", ""), reverse=True)
    return {"channels": channels}

@app.post("/api/channels/register")
async def register_channel(request: Request, user=Depends(require_auth)):
    body = await request.json()
    channel_id = body.get("channel_id")
    channel_name = body.get("name", "").strip()
    username = body.get("username", "").strip()
    if not channel_id or not channel_name:
        raise HTTPException(status_code=400, detail="channel_id and name required")
    str_id = str(channel_id)
    registry = folder_db.setdefault("channel_registry", {})
    existing = registry.get(str_id)
    registry[str_id] = {
        "id": int(channel_id),
        "name": channel_name,
        "username": username,
        "registered_at": existing.get("registered_at", datetime.utcnow().isoformat()) if existing else datetime.utcnow().isoformat(),
        "setup_at": datetime.utcnow().isoformat(),
        "auto_detected": False,
    }
    _save_and_backup()
    asyncio.create_task(refresh_file_cache())
    return {"success": True, "channel": registry[str_id]}

@app.delete("/api/channels/{channel_str_id}")
async def unregister_channel(channel_str_id: str, user=Depends(require_auth)):
    registry = folder_db.get("channel_registry", {})
    if channel_str_id not in registry:
        raise HTTPException(status_code=404, detail="Channel not found")
    del registry[channel_str_id]
    _save_and_backup()
    return {"success": True}

@app.get("/api/channels/{channel_str_id}/files")
async def get_channel_files(channel_str_id: str, type: str = None, user=Depends(require_auth)):
    registry = folder_db.get("channel_registry", {})
    if channel_str_id not in registry:
        raise HTTPException(status_code=404, detail="Channel not found")
    ch_id = registry[channel_str_id].get("id") or int(channel_str_id)
    files = [f for f in file_cache.values() if f.get("channel_id") == ch_id]
    if type in ("pdf", "epub", "video"):
        files = [f for f in files if f.get("type") == type]
    files.sort(key=lambda f: f["date"], reverse=True)
    return {"files": files, "channel": registry[channel_str_id], "total": len(files)}

@app.get("/api/channels-all-files")
async def get_all_channels_files(type: str = None, user=Depends(require_auth)):
    registry = folder_db.get("channel_registry", {})
    registered_ids = {v.get("id") or int(k) for k, v in registry.items()}
    files = [f for f in file_cache.values() if f.get("channel_id") in registered_ids]
    if type in ("pdf", "epub", "video"):
        files = [f for f in files if f.get("type") == type]
    files.sort(key=lambda f: f["date"], reverse=True)
    return {"files": files, "total": len(files), "channel_count": len(registered_ids)}
