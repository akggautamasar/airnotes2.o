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
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            # Download to memory then write to disk to avoid path issues
            raw = await client.download_media(msg, in_memory=True)
            data = bytes(raw.getbuffer()) if hasattr(raw, "getbuffer") else raw.read()
            FOLDERS_FILE.write_bytes(data)
            logger.info("folders.json restored from Telegram.")
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

AUDIO_MIMES = {"audio/mpeg","audio/mp3","audio/ogg","audio/flac","audio/wav","audio/aac","audio/m4a","audio/opus","audio/webm","audio/x-m4a"}
AUDIO_EXTS  = {".mp3",".wav",".flac",".aac",".ogg",".m4a",".opus",".wma"}
IMAGE_MIMES = {"image/jpeg","image/png","image/gif","image/webp","image/bmp","image/svg+xml"}
IMAGE_EXTS  = {".jpg",".jpeg",".png",".gif",".webp",".bmp",".svg"}

def is_audio(mime: str, fname: str) -> bool:
    return mime in AUDIO_MIMES or Path(fname).suffix.lower() in AUDIO_EXTS

def is_image(mime: str, fname: str) -> bool:
    return mime in IMAGE_MIMES or Path(fname).suffix.lower() in IMAGE_EXTS

def file_type(mime: str, fname: str) -> str:
    if is_pdf(mime, fname):   return "pdf"
    if is_epub(mime, fname):  return "epub"
    if is_video(mime, fname): return "video"
    if is_audio(mime, fname): return "audio"
    if is_image(mime, fname): return "image"
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
                continue  # skip non-media
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
        file_count = sum(1 for f in file_cache.values() if f.get("channel_id") in (ch_id, abs(ch_id), -abs(ch_id)))
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
    # Match by channel_id — handle both positive and negative stored values
    files = [f for f in file_cache.values() if f.get("channel_id") == ch_id or f.get("channel_id") == abs(ch_id) or f.get("channel_id") == -abs(ch_id)]
    if type in ("pdf", "epub", "video"):
        files = [f for f in files if f.get("type") == type]
    files.sort(key=lambda f: f["date"], reverse=True)
    return {"files": files, "channel": registry[channel_str_id], "total": len(files)}

@app.get("/api/channels-all-files")
async def get_all_channels_files(type: str = None, user=Depends(require_auth)):
    registry = folder_db.get("channel_registry", {})
    registered_ids = set()
    for k, v in registry.items():
        ch_id = v.get("id") or int(k)
        registered_ids.add(ch_id)
        registered_ids.add(abs(ch_id))
        registered_ids.add(-abs(ch_id))
    files = [f for f in file_cache.values() if f.get("channel_id") in registered_ids]
    if type in ("pdf", "epub", "video"):
        files = [f for f in files if f.get("type") == type]
    files.sort(key=lambda f: f["date"], reverse=True)
    return {"files": files, "total": len(files), "channel_count": len(registry)}

# ─── AirPlayer (served as standalone HTML page) ───────────────────────────────
from fastapi.responses import HTMLResponse

AIRPLAYER_HTML = open(Path(__file__).parent / "airplayer.html").read() if (Path(__file__).parent / "airplayer.html").exists() else ""

@app.get("/airplayer", response_class=HTMLResponse)
async def airplayer(url: str = "", name: str = "", size: str = ""):
    """Serve the AirPlayer HTML with the stream URL injected."""
    html = AIRPLAYER_HTML
    if not html:
        return HTMLResponse("<h2>AirPlayer not found. Please add airplayer.html to backend/</h2>", status_code=404)
    return HTMLResponse(html)


# ─── Fast Player Route ────────────────────────────────────────────────────────
from fastapi.responses import HTMLResponse

FAST_PLAYER_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AirNotes - Fast Player</title>
    <style>
        :root {
            --primary-500: #0ea5e9;
            --primary-600: #0284c7;
            --primary-700: #0369a1;
            --secondary-50: #f8fafc;
            --secondary-100: #f1f5f9;
            --secondary-200: #e2e8f0;
            --secondary-600: #475569;
            --secondary-700: #334155;
            --secondary-800: #1e293b;
            --secondary-900: #0f172a;
            --success-500: #22c55e;
            --success-600: #16a34a;
            --warning-500: #f59e0b;
            --warning-600: #d97706;
            --space-2: 0.5rem;
            --space-3: 0.75rem;
            --space-4: 1rem;
            --space-5: 1.25rem;
            --space-6: 1.5rem;
            --radius-lg: 0.75rem;
            --radius-xl: 1rem;
            --radius-2xl: 1.5rem;
            --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
            --shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
            --shadow-2xl: 0 25px 50px -12px rgb(0 0 0 / 0.25);
            --transition-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1);
            --transition-normal: 300ms cubic-bezier(0.4, 0, 0.2, 1);
        }
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
        body { background: #000; color: white; overflow: hidden; position: relative; }
        .fast-player-container { width: 100vw; height: 100vh; position: relative; display: flex; align-items: center; justify-content: center; background: #000; }
        .video-wrapper { position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
        #fast-video { width: 100%; height: 100%; object-fit: contain; background: #000; }
        .controls-overlay { position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(transparent, rgba(0,0,0,0.8)); padding: var(--space-6) var(--space-4) var(--space-4); transform: translateY(100%); transition: transform var(--transition-normal); z-index: 100; }
        .controls-overlay.show { transform: translateY(0); }
        .progress-container { margin-bottom: var(--space-4); }
        .progress-bar { width: 100%; height: 6px; background: rgba(255,255,255,0.3); border-radius: 3px; cursor: pointer; position: relative; }
        .progress-filled { height: 100%; background: var(--primary-500); border-radius: 3px; width: 0%; transition: width 0.1s ease; }
        .progress-buffered { position: absolute; top: 0; height: 100%; background: rgba(255,255,255,0.5); border-radius: 3px; width: 0%; }
        .controls-row { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
        .control-btn { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; padding: var(--space-2); border-radius: var(--radius-lg); cursor: pointer; transition: all var(--transition-fast); display: flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; }
        .control-btn:hover { background: rgba(255,255,255,0.2); border-color: rgba(255,255,255,0.4); }
        .control-btn svg { width: 20px; height: 20px; stroke: currentColor; }
        .play-pause-btn svg { width: 24px; height: 24px; }
        .time-display { color: white; font-size: 0.9rem; font-weight: 500; white-space: nowrap; }
        .volume-container { display: flex; align-items: center; gap: var(--space-2); }
        .volume-slider { width: 80px; height: 4px; background: rgba(255,255,255,0.3); border-radius: 2px; cursor: pointer; position: relative; }
        .volume-filled { height: 100%; background: white; border-radius: 2px; width: 100%; transition: width 0.1s ease; }
        .speed-display { color: white; font-size: 0.8rem; font-weight: 600; min-width: 40px; text-align: center; }
        .top-controls { position: absolute; top: 0; left: 0; right: 0; background: linear-gradient(rgba(0,0,0,0.8), transparent); padding: var(--space-4); transform: translateY(-100%); transition: transform var(--transition-normal); z-index: 100; }
        .top-controls.show { transform: translateY(0); }
        .top-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4); }
        .player-title { color: white; font-size: 1.1rem; font-weight: 600; display: flex; align-items: center; gap: var(--space-2); }
        .fast-badge { background: var(--success-500); color: white; padding: 2px 8px; border-radius: var(--radius-lg); font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
        .quality-selector { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; padding: var(--space-2) var(--space-3); border-radius: var(--radius-lg); cursor: pointer; font-size: 0.8rem; font-weight: 500; }
        .center-play { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); width: 80px; height: 80px; background: rgba(0,0,0,0.8); border: 2px solid white; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all var(--transition-fast); z-index: 50; }
        .center-play:hover { background: rgba(0,0,0,0.9); transform: translate(-50%,-50%) scale(1.1); }
        .center-play svg { width: 32px; height: 32px; stroke: white; margin-left: 4px; }
        .center-play.hidden { opacity: 0; pointer-events: none; }
        .loading-indicator { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); width: 60px; height: 60px; border: 4px solid rgba(255,255,255,0.3); border-top: 4px solid var(--primary-500); border-radius: 50%; animation: spin 1s linear infinite; z-index: 60; }
        .loading-indicator.hidden { display: none; }
        @keyframes spin { 0% { transform: translate(-50%,-50%) rotate(0deg); } 100% { transform: translate(-50%,-50%) rotate(360deg); } }
        .tap-zone { position: absolute; top: 0; bottom: 0; width: 30%; z-index: 40; display: flex; align-items: center; justify-content: center; cursor: pointer; }
        .tap-zone.left { left: 0; }
        .tap-zone.right { right: 0; }
        .tap-feedback { position: absolute; background: rgba(0,0,0,0.8); color: white; padding: var(--space-3) var(--space-4); border-radius: var(--radius-xl); font-weight: 600; font-size: 0.9rem; pointer-events: none; opacity: 0; transform: scale(0.8); transition: all var(--transition-fast); z-index: 70; }
        .tap-feedback.show { opacity: 1; transform: scale(1); }
        .pip-indicator { position: absolute; top: var(--space-4); right: var(--space-4); background: rgba(0,0,0,0.8); color: white; padding: var(--space-2) var(--space-3); border-radius: var(--radius-lg); font-size: 0.8rem; font-weight: 600; opacity: 0; transition: opacity var(--transition-fast); z-index: 80; }
        .pip-indicator.show { opacity: 1; }
        .fast-player-container.inactive { cursor: none; }
        .fast-player-container.inactive .controls-overlay { transform: translateY(100%); }
        .fast-player-container.inactive .top-controls { transform: translateY(-100%); }
        @media (max-width: 768px) { .controls-row { gap: var(--space-2); } .control-btn { min-width: 40px; min-height: 40px; } .volume-slider { width: 60px; } .time-display { font-size: 0.8rem; } }
        @media (max-width: 480px) { .volume-container { display: none; } }
        @keyframes slideUp { from { opacity: 0; transform: translateX(-50%) translateY(20px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
    </style>
</head>
<body>
<div class="fast-player-container" id="playerContainer">
  <div class="video-wrapper">
    <video id="fast-video" preload="auto">
      <source id="video-source" src="" type="video/mp4">
    </video>
    <div class="center-play" id="centerPlay">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
    </div>
    <div class="loading-indicator hidden" id="loadingIndicator"></div>
    <div class="tap-zone left" id="leftTapZone"></div>
    <div class="tap-zone right" id="rightTapZone"></div>
    <div class="tap-feedback" id="tapFeedback"></div>
    <div class="pip-indicator" id="pipIndicator">Picture-in-Picture</div>
  </div>
  <div class="top-controls" id="topControls">
    <div class="top-row">
      <div class="player-title">
        <span id="videoTitle">Loading...</span>
        <span class="fast-badge">Fast</span>
      </div>
      <select class="quality-selector" id="qualitySelector">
        <option value="auto">Auto Quality</option>
        <option value="720">720p</option>
        <option value="480">480p</option>
        <option value="360">360p</option>
      </select>
    </div>
  </div>
  <div class="controls-overlay" id="controlsOverlay">
    <div class="progress-container">
      <div class="progress-bar" id="progressBar">
        <div class="progress-buffered" id="progressBuffered"></div>
        <div class="progress-filled" id="progressFilled"></div>
      </div>
    </div>
    <div class="controls-row">
      <button class="control-btn play-pause-btn" id="playPauseBtn">
        <svg id="playIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <svg id="pauseIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
      </button>
      <div class="volume-container">
        <button class="control-btn" id="muteBtn">
          <svg id="volumeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
          <svg id="muteIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
        </button>
        <div class="volume-slider" id="volumeSlider"><div class="volume-filled" id="volumeFilled"></div></div>
      </div>
      <div class="time-display" id="timeDisplay">0:00 / 0:00</div>
      <button class="control-btn" id="speedBtn" title="Speed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg></button>
      <div class="speed-display" id="speedDisplay">1x</div>
      <button class="control-btn" id="rewindBtn" title="Rewind 10s"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg></button>
      <button class="control-btn" id="forwardBtn" title="Forward 10s"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg></button>
      <button class="control-btn" id="pipBtn" title="PiP"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h20v14H2z"/><rect x="14" y="8" width="6" height="4" rx="1"/></svg></button>
      <button class="control-btn" id="fullscreenBtn" title="Fullscreen">
        <svg id="fullscreenIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
        <svg id="exitFullscreenIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
      </button>
    </div>
  </div>
</div>
<script>
'use strict';
const urlParams = new URLSearchParams(window.location.search);
const videoUrl = urlParams.get('url');
const videoName = urlParams.get('name') || 'Video';
const videoId = urlParams.get('id') || videoUrl;

const video = document.getElementById('fast-video');
const videoSource = document.getElementById('video-source');
const playerContainer = document.getElementById('playerContainer');
const controlsOverlay = document.getElementById('controlsOverlay');
const topControls = document.getElementById('topControls');
const centerPlay = document.getElementById('centerPlay');
const loadingIndicator = document.getElementById('loadingIndicator');
const pipIndicator = document.getElementById('pipIndicator');
const playPauseBtn = document.getElementById('playPauseBtn');
const playIcon = document.getElementById('playIcon');
const pauseIcon = document.getElementById('pauseIcon');
const muteBtn = document.getElementById('muteBtn');
const volumeIcon = document.getElementById('volumeIcon');
const muteIcon = document.getElementById('muteIcon');
const volumeSlider = document.getElementById('volumeSlider');
const volumeFilled = document.getElementById('volumeFilled');
const progressBar = document.getElementById('progressBar');
const progressFilled = document.getElementById('progressFilled');
const progressBuffered = document.getElementById('progressBuffered');
const timeDisplay = document.getElementById('timeDisplay');
const speedBtn = document.getElementById('speedBtn');
const speedDisplay = document.getElementById('speedDisplay');
const rewindBtn = document.getElementById('rewindBtn');
const forwardBtn = document.getElementById('forwardBtn');
const pipBtn = document.getElementById('pipBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const fullscreenIcon = document.getElementById('fullscreenIcon');
const exitFullscreenIcon = document.getElementById('exitFullscreenIcon');
const tapFeedback = document.getElementById('tapFeedback');
const videoTitle = document.getElementById('videoTitle');

let isPlaying = false, currentSpeed = 1.0, controlsTimeout, lastTapTime = 0, tapCount = 0, isFullscreen = false, savedVolume = 1;

const HISTORY_KEY = 'airnotes_watch_history';
function getHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]'); } catch { return []; } }
function saveProgress() {
  if (!video.duration || video.duration < 10) return;
  const pct = video.currentTime / video.duration;
  if (pct < 0.02 || pct > 0.97) return;
  let hist = getHistory().filter(h => h.id !== videoId);
  hist.unshift({ id: videoId, progress: video.currentTime, duration: video.duration, name: videoName, ts: Date.now() });
  if (hist.length > 30) hist.pop();
  localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
}
function getResumePoint() { const item = getHistory().find(h => h.id === videoId); return item ? item.progress : null; }
function showResumePrompt(resumeAt) {
  const mins = Math.floor(resumeAt/60), secs = Math.floor(resumeAt%60);
  const banner = document.createElement('div');
  banner.style.cssText = 'position:absolute;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(14,165,233,0.95);color:#fff;padding:10px 20px;border-radius:12px;font-size:0.9rem;font-weight:600;display:flex;gap:12px;align-items:center;z-index:200;box-shadow:0 4px 20px rgba(0,0,0,0.4);animation:slideUp 0.3s ease;';
  banner.innerHTML = `<span>▶ Resume from ${mins}:${String(secs).padStart(2,'0')}?</span><button onclick="video.currentTime=${resumeAt};this.parentElement.remove();" style="background:#fff;color:#0ea5e9;border:none;padding:4px 12px;border-radius:8px;cursor:pointer;font-weight:700;">Resume</button><button onclick="this.parentElement.remove();" style="background:rgba(255,255,255,0.2);color:#fff;border:none;padding:4px 10px;border-radius:8px;cursor:pointer;">Start over</button>`;
  playerContainer.appendChild(banner);
  setTimeout(() => banner.remove(), 8000);
}

function initPlayer() {
  if (!videoUrl) { alert('No video URL provided'); return; }
  videoTitle.textContent = videoName.replace(/\.[^.]+$/, '');
  document.title = videoName + ' — AirNotes Fast Player';
  videoSource.src = videoUrl;
  video.load();
  showLoading();
  video.addEventListener('loadstart', showLoading);
  video.addEventListener('canplay', hideLoading);
  video.addEventListener('waiting', showLoading);
  video.addEventListener('playing', hideLoading);
  video.addEventListener('timeupdate', updateProgress);
  video.addEventListener('progress', updateBuffered);
  video.addEventListener('ended', onVideoEnded);
  video.addEventListener('loadedmetadata', () => {
    updateTimeDisplay();
    const resumeAt = getResumePoint();
    if (resumeAt && resumeAt > 5) showResumePrompt(resumeAt);
  });
  playPauseBtn.addEventListener('click', togglePlayPause);
  centerPlay.addEventListener('click', togglePlayPause);
  muteBtn.addEventListener('click', toggleMute);
  speedBtn.addEventListener('click', cycleSpeed);
  rewindBtn.addEventListener('click', () => seek(-10));
  forwardBtn.addEventListener('click', () => seek(10));
  pipBtn.addEventListener('click', togglePiP);
  fullscreenBtn.addEventListener('click', toggleFullscreen);
  progressBar.addEventListener('click', onProgressClick);
  volumeSlider.addEventListener('click', onVolumeClick);
  document.getElementById('leftTapZone').addEventListener('click', handleLeftTap);
  document.getElementById('rightTapZone').addEventListener('click', handleRightTap);
  playerContainer.addEventListener('mousemove', showControls);
  playerContainer.addEventListener('touchstart', showControls);
  playerContainer.addEventListener('click', showControls);
  document.addEventListener('keydown', handleKeyboard);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  video.addEventListener('enterpictureinpicture', () => pipIndicator.classList.add('show'));
  video.addEventListener('leavepictureinpicture', () => pipIndicator.classList.remove('show'));
  video.addEventListener('volumechange', () => { volumeFilled.style.width = (video.muted ? 0 : video.volume) * 100 + '%'; });
  showControls();
  const savedSpeed = localStorage.getItem('airnotes_speed');
  if (savedSpeed) { currentSpeed = parseFloat(savedSpeed); video.playbackRate = currentSpeed; speedDisplay.textContent = currentSpeed + 'x'; }
  setInterval(saveProgress, 5000);
  window.addEventListener('beforeunload', saveProgress);
}

function showLoading() { loadingIndicator.classList.remove('hidden'); centerPlay.classList.add('hidden'); }
function hideLoading() { loadingIndicator.classList.add('hidden'); if (!isPlaying) centerPlay.classList.remove('hidden'); }
function togglePlayPause() {
  if (video.paused) { video.play(); isPlaying = true; playIcon.style.display='none'; pauseIcon.style.display='block'; centerPlay.classList.add('hidden'); }
  else { video.pause(); isPlaying = false; playIcon.style.display='block'; pauseIcon.style.display='none'; centerPlay.classList.remove('hidden'); }
}
function toggleMute() {
  if (video.muted) { video.muted=false; video.volume=savedVolume; volumeIcon.style.display='block'; muteIcon.style.display='none'; }
  else { savedVolume=video.volume; video.muted=true; volumeIcon.style.display='none'; muteIcon.style.display='block'; }
}
function cycleSpeed() {
  const speeds = [0.25,0.5,0.75,1,1.25,1.5,1.75,2,2.5,3];
  const idx = speeds.indexOf(currentSpeed);
  currentSpeed = speeds[(idx+1) % speeds.length];
  video.playbackRate = currentSpeed;
  speedDisplay.textContent = currentSpeed + 'x';
  localStorage.setItem('airnotes_speed', currentSpeed.toString());
  showFeedback(currentSpeed + 'x');
}
function seek(s) { video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime+s)); showFeedback(s>0?'+'+s+'s':s+'s'); }
function togglePiP() { if (document.pictureInPictureElement) document.exitPictureInPicture(); else if (document.pictureInPictureEnabled) video.requestPictureInPicture(); }
function toggleFullscreen() {
  if (!isFullscreen) { (playerContainer.requestFullscreen||playerContainer.webkitRequestFullscreen)?.call(playerContainer); }
  else { (document.exitFullscreen||document.webkitExitFullscreen)?.call(document); }
}
function onFullscreenChange() {
  isFullscreen = !!(document.fullscreenElement||document.webkitFullscreenElement);
  fullscreenIcon.style.display = isFullscreen ? 'none' : 'block';
  exitFullscreenIcon.style.display = isFullscreen ? 'block' : 'none';
}
function handleLeftTap() { const now=Date.now(); if (now-lastTapTime<300) { if (++tapCount>=2) { seek(-10); tapCount=0; } } else { tapCount=1; } lastTapTime=now; }
function handleRightTap() { const now=Date.now(); if (now-lastTapTime<300) { if (++tapCount>=2) { seek(10); tapCount=0; } } else { tapCount=1; } lastTapTime=now; }
function showFeedback(text) { tapFeedback.textContent=text; tapFeedback.style.top='50%'; tapFeedback.style.left='50%'; tapFeedback.style.transform='translate(-50%,-50%)'; tapFeedback.classList.add('show'); setTimeout(()=>tapFeedback.classList.remove('show'),1000); }
function onProgressClick(e) { const r=progressBar.getBoundingClientRect(); video.currentTime=((e.clientX-r.left)/r.width)*video.duration; }
function onVolumeClick(e) { const r=volumeSlider.getBoundingClientRect(); video.volume=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)); video.muted=false; }
function updateProgress() { if(video.duration){const p=(video.currentTime/video.duration)*100; progressFilled.style.width=p+'%'; updateTimeDisplay();} }
function updateBuffered() { if(video.buffered.length>0&&video.duration){progressBuffered.style.width=(video.buffered.end(video.buffered.length-1)/video.duration)*100+'%';} }
function updateTimeDisplay() { timeDisplay.textContent=fmt(video.currentTime)+' / '+fmt(video.duration); }
function fmt(s) { if(isNaN(s))return'0:00'; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60); return h>0?h+':'+String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0'):m+':'+String(sec).padStart(2,'0'); }
function showControls() { controlsOverlay.classList.add('show'); topControls.classList.add('show'); playerContainer.classList.remove('inactive'); clearTimeout(controlsTimeout); if(isPlaying) controlsTimeout=setTimeout(()=>{controlsOverlay.classList.remove('show');topControls.classList.remove('show');playerContainer.classList.add('inactive');},3000); }
function onVideoEnded() { isPlaying=false; playIcon.style.display='block'; pauseIcon.style.display='none'; centerPlay.classList.remove('hidden'); showControls(); }
function handleKeyboard(e) {
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT') return;
  switch(e.code){
    case 'Space': case 'KeyK': e.preventDefault(); togglePlayPause(); break;
    case 'ArrowLeft': e.preventDefault(); seek(-10); break;
    case 'ArrowRight': e.preventDefault(); seek(10); break;
    case 'ArrowUp': e.preventDefault(); video.volume=Math.min(1,video.volume+0.1); break;
    case 'ArrowDown': e.preventDefault(); video.volume=Math.max(0,video.volume-0.1); break;
    case 'KeyM': toggleMute(); break;
    case 'KeyF': toggleFullscreen(); break;
    case 'KeyP': togglePiP(); break;
    case 'Comma': cycleSpeed(); break;
  }
}
document.addEventListener('DOMContentLoaded', initPlayer);
</script>
</body>
</html>"""

@app.get("/player", response_class=HTMLResponse)
async def fast_player(url: str = "", name: str = "", id: str = ""):
    """Serve the Fast Player page."""
    return HTMLResponse(content=FAST_PLAYER_HTML)
