"""
encoder.py — Background video quality encoder for AirNotes

Flow:
  1. When a new video is indexed (bot upload or cache refresh), schedule_encoding(file_id) is called
  2. Encoder picks up queued jobs one at a time: 480p → 360p → 720p
  3. Each job: streams from Telegram via FIFO → ffmpeg → uploads result back to STORAGE_CHANNEL
  4. Encoded file is indexed in file_cache and tagged in folder_db as a quality variant
  5. Progress is checkpointed to disk every 30s so restarts can skip already-done qualities
  6. Frontend reads /api/files/{id}/qualities → streams the right variant
"""

import asyncio
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Dict, Optional
from utils.logger import Logger

logger = Logger(__name__)

# ── Quality presets ───────────────────────────────────────────────────────────
QUALITY_PRESETS = [
    # (label, height, video_bitrate, audio_bitrate)
    ("480p",  480,  "800k",  "128k"),
    ("360p",  360,  "500k",  "96k"),
    ("720p",  720,  "2000k", "128k"),
]

# ── Persistent state ──────────────────────────────────────────────────────────
ENCODE_DB_FILE = Path("./cache/encode_db.json")

def _load_encode_db() -> dict:
    if ENCODE_DB_FILE.exists():
        try:
            return json.loads(ENCODE_DB_FILE.read_text())
        except Exception:
            pass
    return {"done": {}, "queue": []}   # done: {file_id: {quality: encoded_file_id}}

def _save_encode_db(db: dict):
    try:
        ENCODE_DB_FILE.write_text(json.dumps(db, indent=2))
    except Exception as e:
        logger.error(f"encode_db save failed: {e}")

# Shared state (populated by init_encoder)
_encode_db: dict = {}
_file_cache: dict = {}
_folder_db: dict = {}
_save_fn = None
_queue: asyncio.Queue = None
_running = False

def init_encoder(file_cache: dict, folder_db: dict, save_fn):
    global _encode_db, _file_cache, _folder_db, _save_fn, _queue
    _file_cache = file_cache
    _folder_db  = folder_db
    _save_fn    = save_fn
    _encode_db  = _load_encode_db()
    _queue      = asyncio.Queue()

    # Re-queue any files that have pending qualities from before a restart
    requeued = 0
    for file_id, done_qualities in _encode_db.get("done", {}).items():
        pending = [q[0] for q in QUALITY_PRESETS if q[0] not in done_qualities]
        if pending and file_id in _file_cache:
            _queue.put_nowait(file_id)
            requeued += 1
    if requeued:
        logger.info(f"Encoder: re-queued {requeued} files with pending qualities")


def schedule_encoding(file_id: str):
    """Call this whenever a new video is added to file_cache."""
    if _queue is None:
        return
    if _encode_db.get("done", {}).get(file_id, {}).keys() >= {q[0] for q in QUALITY_PRESETS}:
        return  # all qualities already done
    try:
        _queue.put_nowait(file_id)
        logger.info(f"Encoder: queued {file_id}")
    except asyncio.QueueFull:
        pass


def get_quality_variants(file_id: str) -> dict:
    """Return {quality_label: encoded_file_id} for a given original file."""
    return _encode_db.get("done", {}).get(file_id, {})


async def encoder_worker():
    """Long-running background task. Processes one file at a time."""
    global _running
    _running = True
    logger.info("Encoder worker started")

    while True:
        try:
            file_id = await _queue.get()
            await _encode_file(file_id)
            _queue.task_done()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Encoder worker error: {e}")
            await asyncio.sleep(5)

    _running = False


async def _encode_file(file_id: str):
    """Encode all pending quality variants for one file."""
    info = _file_cache.get(file_id)
    if not info:
        logger.warning(f"Encoder: {file_id} not in file_cache, skipping")
        return

    done_qualities = _encode_db.setdefault("done", {}).setdefault(file_id, {})

    for label, height, vbr, abr in QUALITY_PRESETS:
        if label in done_qualities:
            logger.info(f"Encoder: {file_id} {label} already done, skipping")
            continue

        logger.info(f"Encoder: starting {label} encode for {file_id} ({info['name']})")
        try:
            encoded_id = await _encode_quality(file_id, info, label, height, vbr, abr)
            if encoded_id:
                done_qualities[label] = encoded_id
                _save_encode_db(_encode_db)
                logger.info(f"Encoder: {file_id} {label} done → {encoded_id}")
            else:
                logger.warning(f"Encoder: {file_id} {label} returned no file id")
        except Exception as e:
            logger.error(f"Encoder: {file_id} {label} failed: {e}")
            # Continue to next quality even on failure
            continue

        # Small pause between qualities to avoid hammering Telegram
        await asyncio.sleep(2)


async def _encode_quality(file_id: str, info: dict, label: str, height: int, vbr: str, abr: str) -> Optional[str]:
    """
    Stream from Telegram → ffmpeg re-encode → upload result back to Telegram.
    Returns the new file_cache key of the encoded file.
    """
    from utils.clients import get_client
    import config

    client = get_client()

    # Use a named pipe (FIFO) so ffmpeg can read from the Telegram stream
    fifo_dir  = tempfile.mkdtemp()
    fifo_path = os.path.join(fifo_dir, "input.mkv")
    out_path  = os.path.join(fifo_dir, f"output_{label}.mp4")
    os.mkfifo(fifo_path)

    file_id_obj = info.get("message_id")
    channel_id  = info.get("channel_id", config.STORAGE_CHANNEL)

    # ── Feed Telegram stream into FIFO ────────────────────────────────────────
    async def feed_fifo():
        try:
            with open(fifo_path, "wb") as fifo:
                async for chunk in client.stream_media(
                    (await client.get_messages(channel_id, file_id_obj)).document
                    or (await client.get_messages(channel_id, file_id_obj)).video,
                    offset=0
                ):
                    fifo.write(chunk)
        except Exception as e:
            logger.error(f"FIFO feed error for {file_id}: {e}")

    feed_task = asyncio.create_task(feed_fifo())

    try:
        # ── Run ffmpeg ────────────────────────────────────────────────────────
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y",
            "-fflags", "+genpts+discardcorrupt",
            "-analyzeduration", "20M",
            "-probesize", "20M",
            "-i", fifo_path,
            "-map", "0:v:0",
            "-map", "0:a?",           # include all audio tracks
            "-c:v", "libx264",
            "-preset", "veryfast",    # fast encode, good enough quality
            "-crf", "28",             # quality-based, ignores -b:v if CRF mode
            "-vf", f"scale=-2:{height}",   # scale to target height, keep aspect
            "-c:a", "aac",
            "-b:a", abr,
            "-ac", "2",
            "-movflags", "+faststart",    # web-optimised MP4
            "-f", "mp4",
            out_path,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )

        # Checkpoint progress every 30s
        last_checkpoint = time.time()
        while True:
            try:
                line = await asyncio.wait_for(proc.stderr.readline(), timeout=60)
            except asyncio.TimeoutError:
                logger.warning(f"Encoder: ffmpeg timeout for {file_id} {label}")
                break
            if not line:
                break
            if time.time() - last_checkpoint > 30:
                _save_encode_db(_encode_db)
                last_checkpoint = time.time()

        await proc.wait()
        feed_task.cancel()

        if proc.returncode != 0:
            logger.error(f"ffmpeg failed for {file_id} {label} with code {proc.returncode}")
            return None

        if not os.path.exists(out_path) or os.path.getsize(out_path) < 1024:
            logger.error(f"Output file missing/empty for {file_id} {label}")
            return None

        # ── Upload encoded file back to Telegram ──────────────────────────────
        original_name = info["name"]
        stem = original_name.rsplit(".", 1)[0] if "." in original_name else original_name
        encoded_name  = f"{stem} [{label}].mp4"
        caption       = f"#encoded #original_{file_id} #{label}\n{original_name}"

        sent = await client.send_document(
            chat_id=channel_id,
            document=out_path,
            file_name=encoded_name,
            caption=caption,
            force_document=True,
        )

        # ── Index in file_cache ───────────────────────────────────────────────
        sent_media = sent.document or sent.video
        new_key = f"msg_{sent.id}"
        entry = {
            "id":          new_key,
            "message_id":  sent.id,
            "channel_id":  channel_id,
            "name":        encoded_name,
            "size":        getattr(sent_media, "file_size", 0) or 0,
            "date":        sent.date.timestamp() if sent.date else 0,
            "caption":     caption,
            "type":        "video",
            "mime":        "video/mp4",
            "is_encoded_variant": True,
            "original_file_id":   file_id,
            "quality_label":      label,
        }
        _file_cache[new_key] = entry

        # Assign encoded variant to same folder as original
        orig_folder = _folder_db.get("file_assignments", {}).get(file_id)
        if orig_folder:
            _folder_db.setdefault("file_assignments", {})[new_key] = orig_folder
        if _save_fn:
            try: _save_fn()
            except Exception as e: logger.error(f"save_fn error: {e}")

        return new_key

    finally:
        feed_task.cancel()
        # Cleanup temp files
        try:
            if os.path.exists(out_path): os.unlink(out_path)
            if os.path.exists(fifo_path): os.unlink(fifo_path)
            os.rmdir(fifo_dir)
        except Exception:
            pass
