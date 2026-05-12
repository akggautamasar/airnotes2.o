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

folder_db: Dict = {"folders": {}, "file_assignments": {}}

def _save_folders():
    with open(FOLDERS_FILE, "w") as f:
        json.dump(folder_db, f, indent=2)

def _load_folders():
    global folder_db
    if FOLDERS_FILE.exists():
        try:
            with open(FOLDERS_FILE) as f:
                folder_db = json.load(f)
        except Exception as e:
            logger.warning(f"Could not load folders: {e}")

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
FULL_SCAN_LIMIT = 10_000

async def refresh_channel(client, channel_id: int, new_cache: Dict):
    """Scan a single channel and populate new_cache with its files."""
    anchor_id = config.DATABASE_BACKUP_MSG_ID
    upper_id  = anchor_id

    # Find the highest existing message ID for this channel in file_cache
    channel_prefix = f"ch{channel_id}_msg_"
    legacy_prefix  = "msg_"  # backwards compat for single-channel setups
    for key, v in file_cache.items():
        if key.startswith(channel_prefix) or (channel_id == config.STORAGE_CHANNEL and key.startswith(legacy_prefix)):
            mid = v.get("message_id", 0)
            if mid > upper_id:
                upper_id = mid

    # Probe for upper bound
    for probe_ids in [
        list(range(anchor_id + 1, anchor_id + 501, 50)),
        list(range(upper_id + 1, upper_id + 101)),
    ]:
        try:
            msgs = await client.get_messages(channel_id, probe_ids)
            for m in msgs:
                if m and not m.empty and m.id > upper_id:
                    upper_id = m.id
        except Exception:
            pass

    start_id = max(1, upper_id - FULL_SCAN_LIMIT)
    for batch_start in range(upper_id, start_id - 1, -200):
        batch_end = max(batch_start - 199, start_id)
        ids = list(range(batch_start, batch_end - 1, -1))
        try:
            messages = await client.get_messages(channel_id, ids)
        except Exception as e:
            logger.warning(f"Batch fetch failed for channel {channel_id} at {batch_start}: {e} — stopping scan early to preserve existing files")
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
            # Use channel-scoped key; primary channel keeps old key format for backwards compat
            if channel_id == config.STORAGE_CHANNEL:
                key = f"msg_{message.id}"
            else:
                key = f"ch{channel_id}_msg_{message.id}"
            new_cache[key] = {
                "id": key, "message_id": message.id, "channel_id": channel_id,
                "name": fname, "size": getattr(media, "file_size", 0),
                "date": message.date.timestamp() if message.date else 0,
                "caption": message.caption or "", "type": ftype, "mime": mime,
                # Restore persisted metadata (e.g. uploaded_by) that isn't in the Telegram message
                **folder_db.get("file_meta", {}).get(key, {}),
            }
        await asyncio.sleep(0.1)

async def refresh_file_cache():
    global _refresh_in_progress, _last_refresh
    if _refresh_in_progress:
        return
    async with _refresh_lock:
        _refresh_in_progress = True
        try:
            client = get_client()
            new_cache: Dict[str, Dict] = {}

            channels = config.STORAGE_CHANNELS if config.STORAGE_CHANNELS else [config.STORAGE_CHANNEL]
            failed_channels = set()
            for channel_id in channels:
                if not channel_id:
                    continue
                try:
                    await refresh_channel(client, channel_id, new_cache)
                    logger.info(f"Channel {channel_id} scanned: {sum(1 for v in new_cache.values() if v.get('channel_id') == channel_id)} files")
                except Exception as e:
                    logger.error(f"Failed to refresh channel {channel_id}: {e}")
                    failed_channels.add(channel_id)

            # Safety check: never replace cache with a suspiciously smaller result.
            # If new_cache has fewer than 70% of existing entries, it likely means
            # Telegram FloodWait cut the scan short — keep old entries for missing files.
            prev_count = len(file_cache)
            new_count  = len(new_cache)
            if prev_count > 0 and new_count < prev_count * 0.7:
                logger.warning(
                    f"Refresh returned only {new_count}/{prev_count} files — "
                    f"merging instead of replacing to avoid data loss (FloodWait likely)"
                )
                # Keep all old entries, then overlay with whatever we did get freshly
                merged = dict(file_cache)
                merged.update(new_cache)
                new_cache = merged
            else:
                # For channels that failed entirely, preserve their old entries
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
            # Auto-encoding is disabled — use /encode <file_id> bot command to encode on demand
        except Exception as e:
            logger.error(f"Cache refresh failed: {e}")
        finally:
            _refresh_in_progress = False

async def _periodic_refresh():
    await asyncio.sleep(90)
    while True:
        await asyncio.sleep(REFRESH_INTERVAL_SECONDS)
        await refresh_file_cache()

# ─── App lifecycle ────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    _load_folders()
    await initialize_clients()
    encoder.init_encoder(file_cache, folder_db, _save_folders)
    asyncio.create_task(encoder.encoder_worker())
    asyncio.create_task(refresh_file_cache())
    asyncio.create_task(_periodic_refresh())
    try:
        from bot_handler import setup_bot_handlers
        from utils.clients import multi_clients
        for client in multi_clients.values():
            setup_bot_handlers(client, file_cache, folder_db, _save_folders)
            logger.info("Bot handlers registered")
            break
    except Exception as e:
        logger.error(f"Bot handler setup failed: {e}")
    if config.WEBSITE_URL:
        asyncio.create_task(auto_ping_website(config.WEBSITE_URL))
    yield


app = FastAPI(title="AirNotes 2.0", lifespan=lifespan)

# ─── CORS — must use specific origins when allow_credentials=True ─────────────
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
    channels = config.STORAGE_CHANNELS or [config.STORAGE_CHANNEL]
    return {
        "status": "ok", "files_cached": len(file_cache),
        "pdfs": pdfs, "epubs": epubs, "videos": videos,
        "channels": len(channels),
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
    """Return available quality variants for a video file."""
    if file_id not in file_cache:
        raise HTTPException(status_code=404, detail="File not found")
    variants = encoder.get_quality_variants(file_id)
    # Build response: {label: {file_id, size, ready: True}}
    result = {"original": {"file_id": file_id, "label": "Original", "size": file_cache[file_id].get("size", 0), "ready": True}}
    for label, enc_file_id in variants.items():
        enc_info = file_cache.get(enc_file_id, {})
        result[label] = {
            "file_id": enc_file_id,
            "label":   label,
            "size":    enc_info.get("size", 0),
            "ready":   bool(enc_info),
        }
    # Also add pending qualities (not yet encoded)
    from encoder import QUALITY_PRESETS
    for q_label, *_ in QUALITY_PRESETS:
        if q_label not in result:
            result[q_label] = {"file_id": None, "label": q_label, "size": 0, "ready": False}
    return result


@app.head("/api/files/{file_id}/stream")
async def stream_file_head(file_id: str, request: Request, user=Depends(require_auth)):
    """Fast HEAD response so browsers can get Content-Length without downloading anything."""
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
    """Probe audio codec via ffprobe so the frontend knows whether to request transcoded stream."""
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

        # Collect first ~128 KB for ffprobe — codec info is in container headers, no need for 2MB
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
            "-show_streams", "-select_streams", "a",
            "-i", "pipe:0",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(input=sample), timeout=15)
        probe = _json.loads(stdout or b"{}")
        streams = probe.get("streams", [])
        codec = streams[0].get("codec_name", "unknown") if streams else "unknown"

        # Audio codecs browsers support natively
        BROWSER_SAFE = {"aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le", "pcm_u8"}
        needs_transcode = codec.lower() not in BROWSER_SAFE

        # Build per-track info for the frontend audio switcher
        audio_tracks = []
        for i, s in enumerate(streams):
            tags = s.get("tags", {})
            lang  = tags.get("language") or tags.get("LANGUAGE") or ""
            title = tags.get("title")    or tags.get("TITLE")    or ""
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
        raise HTTPException(status_code=404, detail="File not found — cache may be refreshing, please retry shortly")
    info = file_cache[file_id]
    channel_id = info.get("channel_id", config.STORAGE_CHANNEL)

    if not transcode:
        return await media_streamer(channel_id, info["message_id"], info["name"], request)

    # ── Transcode path: pipe Telegram stream through ffmpeg, re-encode audio to AAC ──
    from utils.clients import get_client
    from utils.streamer.custom_dl import ByteStreamer
    from utils.streamer import class_cache
    import tempfile, os

    client = get_client()
    if client not in class_cache:
        class_cache[client] = ByteStreamer(client)
    streamer = class_cache[client]

    try:
        file_id_obj = await streamer.get_file_properties(channel_id, info["message_id"])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    async def transcode_stream():
        # Use a named FIFO so ffmpeg can "seek" in it (MKV needs seekable input)
        fifo_path = f"/tmp/tg_fifo_{info['message_id']}_{id(asyncio.current_task())}"
        try:
            os.mkfifo(fifo_path)
        except FileExistsError:
            os.unlink(fifo_path)
            os.mkfifo(fifo_path)

        seek_args = ["-ss", str(start_time)] if start_time > 0 else []
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y",
            "-fflags", "+genpts+discardcorrupt",
            "-analyzeduration", "10M",   # give ffmpeg time to find audio stream in MKV
            "-probesize", "10M",
            "-i", fifo_path,
            *seek_args,                      # seek AFTER input so ffmpeg decodes to the right point
            "-map", "0:v:0",             # first video track
            "-map", f"0:a:{audio_track}", # selected audio track
            "-c:v", "copy",              # copy video — no re-encode
            "-c:a", "aac",               # transcode audio to AAC
            "-b:a", "192k",
            "-ac", "2",                  # stereo (handles 5.1 downmix)
            "-movflags", "frag_keyframe+empty_moov+default_base_moof",
            "-f", "mp4",
            "pipe:1",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )

        async def feed_fifo():
            """Write Telegram chunks into the FIFO in a thread to avoid blocking."""
            try:
                # Open FIFO for writing in a thread (blocks until ffmpeg opens read end)
                loop = asyncio.get_event_loop()
                fd = await loop.run_in_executor(None, lambda: os.open(fifo_path, os.O_WRONLY))
                async for chunk in client.stream_media(file_id_obj.file_id, offset=0, limit=99999):
                    if not chunk:
                        break
                    # Write in executor to avoid blocking the event loop
                    await loop.run_in_executor(None, lambda c=chunk: os.write(fd, c))
            except Exception as e:
                logger.error(f"FIFO feeder error: {e}")
            finally:
                try:
                    os.close(fd)
                except Exception:
                    pass
                try:
                    os.unlink(fifo_path)
                except Exception:
                    pass

        feed_task = asyncio.create_task(feed_fifo())

        try:
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                yield chunk
        except (GeneratorExit, asyncio.CancelledError):
            pass
        except Exception as e:
            logger.error(f"Transcode read error: {e}")
        finally:
            feed_task.cancel()
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass
            try:
                os.unlink(fifo_path)
            except Exception:
                pass

    return StreamingResponse(
        transcode_stream(),
        media_type="video/mp4",
        headers={
            "Content-Type": "video/mp4",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
            "Accept-Ranges": "none",
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
    _save_folders()
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
    _save_folders()
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
    _save_folders()
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
    _save_folders()
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
    _save_folders()
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
