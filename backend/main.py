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

# ─── Cache refresh ────────────────────────────────────────────────────────────
_refresh_lock = asyncio.Lock()
_refresh_in_progress = False
_last_refresh: Optional[datetime] = None
REFRESH_INTERVAL_SECONDS = 5 * 60
FULL_SCAN_LIMIT = 10_000

async def refresh_file_cache():
    global _refresh_in_progress, _last_refresh
    if _refresh_in_progress:
        return
    async with _refresh_lock:
        _refresh_in_progress = True
        try:
            client = get_client()
            new_cache: Dict[str, Dict] = {}

            anchor_id = config.DATABASE_BACKUP_MSG_ID
            upper_id  = anchor_id

            if file_cache:
                max_cached = max((v.get("message_id", 0) for v in file_cache.values()), default=0)
                if max_cached > upper_id:
                    upper_id = max_cached

            for probe_ids in [
                list(range(anchor_id + 1, anchor_id + 501, 50)),
                list(range(upper_id + 1, upper_id + 101)),
            ]:
                try:
                    msgs = await client.get_messages(config.STORAGE_CHANNEL, probe_ids)
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
                    messages = await client.get_messages(config.STORAGE_CHANNEL, ids)
                except Exception as e:
                    logger.warning(f"Batch fetch failed: {e}")
                    continue

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
                    key = f"msg_{message.id}"
                    new_cache[key] = {
                        "id": key, "message_id": message.id, "name": fname,
                        "size": getattr(media, "file_size", 0),
                        "date": message.date.timestamp() if message.date else 0,
                        "caption": message.caption or "", "type": ftype, "mime": mime,
                    }
                await asyncio.sleep(0.1)

            file_cache.clear()
            file_cache.update(new_cache)
            _last_refresh = datetime.utcnow()
            pdfs  = sum(1 for f in file_cache.values() if f["type"] == "pdf")
            epubs = sum(1 for f in file_cache.values() if f["type"] == "epub")
            logger.info(f"Cache refreshed: {pdfs} PDFs, {epubs} EPUBs")
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
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Health ───────────────────────────────────────────────────────────────────
@app.get("/health")
@app.head("/health")
async def health():
    pdfs  = sum(1 for f in file_cache.values() if f.get("type") == "pdf")
    epubs = sum(1 for f in file_cache.values() if f.get("type") == "epub")
    return {
        "status": "ok", "files_cached": len(file_cache), "pdfs": pdfs, "epubs": epubs,
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
    if type in ("pdf", "epub"):
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

@app.get("/api/files/{file_id}/stream")
async def stream_file(file_id: str, request: Request, user=Depends(require_auth)):
    if file_id not in file_cache:
        if not _refresh_in_progress:
            asyncio.create_task(refresh_file_cache())
        raise HTTPException(status_code=404, detail="File not found — cache may be refreshing, please retry shortly")
    info = file_cache[file_id]
    return await media_streamer(config.STORAGE_CHANNEL, info["message_id"], info["name"], request)

@app.delete("/api/files/{file_id}")
async def delete_file(file_id: str, user=Depends(require_auth)):
    if file_id not in file_cache:
        raise HTTPException(status_code=404, detail="File not found")
    info = file_cache[file_id]
    try:
        client = get_client()
        await client.delete_messages(config.STORAGE_CHANNEL, [info["message_id"]])
    except Exception as e:
        logger.warning(f"Could not delete Telegram message: {e}")
    del file_cache[file_id]
    folder_db["file_assignments"].pop(file_id, None)
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
        copied = await client.copy_message(config.STORAGE_CHANNEL, config.STORAGE_CHANNEL, info["message_id"])
        new_key = f"msg_{copied.id}"
        file_cache[new_key] = {
            "id": new_key, "message_id": copied.id, "name": info["name"],
            "size": info["size"], "date": datetime.utcnow().timestamp(),
            "caption": info.get("caption", ""), "type": info["type"], "mime": info.get("mime", ""),
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
    if type in ("pdf", "epub"):
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
