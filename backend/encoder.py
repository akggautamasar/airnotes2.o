"""
encoder.py — Background video quality encoder for AirNotes

Flow:
  1. When a new video is indexed, schedule_encoding(file_id) is queued
  2. Worker picks jobs one at a time: 480p → 360p → 720p
  3. Each job: downloads from Telegram → pipes to ffmpeg stdin → output file → uploads to Telegram
  4. Encoded file indexed in file_cache, tagged as quality variant
  5. Progress checkpointed every 30s so restarts resume correctly
"""

import asyncio
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Optional
from utils.logger import Logger

logger = Logger(__name__)

# ── Quality presets ───────────────────────────────────────────────────────────
# (label, height, crf)  — CRF controls quality; lower = better, larger file
QUALITY_PRESETS = [
    ("480p", 480, 28),
    ("360p", 360, 30),
    ("720p", 720, 26),
]

# ── Persistent state ──────────────────────────────────────────────────────────
ENCODE_DB_FILE = Path("./cache/encode_db.json")

def _load_encode_db() -> dict:
    if ENCODE_DB_FILE.exists():
        try:
            return json.loads(ENCODE_DB_FILE.read_text())
        except Exception:
            pass
    return {"done": {}}

def _save_encode_db(db: dict):
    try:
        ENCODE_DB_FILE.write_text(json.dumps(db, indent=2))
    except Exception as e:
        logger.error(f"encode_db save failed: {e}")

# ── Shared state ──────────────────────────────────────────────────────────────
_encode_db: dict = {}
_file_cache: dict = {}
_folder_db: dict = {}
_save_fn = None
_queue: asyncio.Queue = None

def init_encoder(file_cache: dict, folder_db: dict, save_fn):
    global _encode_db, _file_cache, _folder_db, _save_fn, _queue
    _file_cache = file_cache
    _folder_db  = folder_db
    _save_fn    = save_fn
    _encode_db  = _load_encode_db()
    _queue      = asyncio.Queue()

    # Re-queue files with pending qualities after a restart
    all_labels = {q[0] for q in QUALITY_PRESETS}
    requeued = 0
    for file_id, done_qualities in _encode_db.get("done", {}).items():
        if set(done_qualities.keys()) < all_labels and file_id in _file_cache:
            _queue.put_nowait(file_id)
            requeued += 1
    if requeued:
        logger.info(f"Encoder: re-queued {requeued} files with pending qualities")


def schedule_encoding(file_id: str):
    """Call whenever a new video is added to file_cache."""
    if _queue is None:
        return
    done = _encode_db.get("done", {}).get(file_id, {})
    if set(done.keys()) >= {q[0] for q in QUALITY_PRESETS}:
        return  # all done
    try:
        _queue.put_nowait(file_id)
    except asyncio.QueueFull:
        pass


def get_quality_variants(file_id: str) -> dict:
    """Return {quality_label: encoded_file_id} for a given original file."""
    return _encode_db.get("done", {}).get(file_id, {})


async def encoder_worker():
    """Long-running background task."""
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


async def _encode_file(file_id: str):
    """Encode all pending quality variants for one file."""
    info = _file_cache.get(file_id)
    if not info:
        logger.warning(f"Encoder: {file_id} not in file_cache, skipping")
        return

    done_qualities = _encode_db.setdefault("done", {}).setdefault(file_id, {})

    for label, height, crf in QUALITY_PRESETS:
        if label in done_qualities:
            logger.info(f"Encoder: {file_id} {label} already done, skipping")
            continue

        logger.info(f"Encoder: starting {label} for {file_id} ({info['name']})")
        try:
            encoded_id = await _encode_quality(file_id, info, label, height, crf)
            if encoded_id:
                done_qualities[label] = encoded_id
                _save_encode_db(_encode_db)
                logger.info(f"Encoder: {file_id} {label} done → {encoded_id}")
            else:
                logger.warning(f"Encoder: {file_id} {label} produced no output")
        except Exception as e:
            logger.error(f"Encoder: {file_id} {label} failed: {e}")

        await asyncio.sleep(2)


async def _encode_quality(file_id: str, info: dict, label: str, height: int, crf: int) -> Optional[str]:
    """
    Download from Telegram, pipe to ffmpeg, save to temp file, upload back.
    Returns new file_cache key on success, None on failure.
    """
    from utils.clients import get_client
    import config

    client  = get_client()
    msg_id  = info.get("message_id")
    chan_id = info.get("channel_id", config.STORAGE_CHANNEL)

    # ── Fetch the message to get the media object ─────────────────────────────
    msg = await client.get_messages(chan_id, msg_id)
    if not msg or msg.empty:
        logger.error(f"Encoder: could not fetch message {msg_id}")
        return None
    media = msg.document or msg.video
    if not media:
        logger.error(f"Encoder: message {msg_id} has no document/video")
        return None

    # ── Temp output file ──────────────────────────────────────────────────────
    tmp_dir  = tempfile.mkdtemp(prefix="airnotes_enc_")
    out_path = os.path.join(tmp_dir, f"out_{label}.mp4")

    try:
        # ── Start ffmpeg reading from stdin ───────────────────────────────────
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y",
            "-fflags", "+genpts+discardcorrupt",
            "-analyzeduration", "20M",
            "-probesize", "20M",
            "-i", "pipe:0",              # read from stdin
            "-map", "0:v:0",
            "-map", "0:a?",              # keep all audio tracks
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", str(crf),
            "-vf", f"scale=-2:{height}",
            "-c:a", "aac",
            "-b:a", "128k",
            "-ac", "2",
            "-movflags", "+faststart",
            "-f", "mp4",
            out_path,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )

        # ── Stream Telegram → ffmpeg stdin concurrently ───────────────────────
        async def feed_stdin():
            try:
                async for chunk in client.iter_download(media):
                    if proc.stdin.is_closing():
                        break
                    proc.stdin.write(chunk)
                    await proc.stdin.drain()
            except Exception as e:
                logger.error(f"Encoder feed error {file_id} {label}: {e}")
            finally:
                try:
                    proc.stdin.close()
                except Exception:
                    pass

        # ── Read stderr for progress logging + checkpoint ─────────────────────
        async def read_stderr():
            last_ckpt = time.time()
            while True:
                try:
                    line = await asyncio.wait_for(proc.stderr.readline(), timeout=120)
                except asyncio.TimeoutError:
                    logger.warning(f"Encoder: no ffmpeg output for 120s ({file_id} {label})")
                    break
                if not line:
                    break
                txt = line.decode(errors="ignore").strip()
                if "time=" in txt:
                    logger.debug(f"ffmpeg [{label}]: {txt}")
                if time.time() - last_ckpt > 30:
                    _save_encode_db(_encode_db)
                    last_ckpt = time.time()

        feed_task   = asyncio.create_task(feed_stdin())
        stderr_task = asyncio.create_task(read_stderr())

        await asyncio.gather(feed_task, stderr_task)
        await proc.wait()

        if proc.returncode != 0:
            logger.error(f"ffmpeg exited {proc.returncode} for {file_id} {label}")
            return None

        if not os.path.exists(out_path) or os.path.getsize(out_path) < 10_000:
            logger.error(f"Output too small/missing for {file_id} {label}")
            return None

        out_size_mb = os.path.getsize(out_path) / 1024 / 1024
        logger.info(f"Encoder: {label} encoded {out_size_mb:.1f} MB, uploading...")

        # ── Upload back to Telegram ───────────────────────────────────────────
        stem         = info["name"].rsplit(".", 1)[0] if "." in info["name"] else info["name"]
        encoded_name = f"{stem} [{label}].mp4"
        caption      = f"#encoded #original_{file_id} #{label}\n{info['name']}"

        sent = await client.send_document(
            chat_id=chan_id,
            document=out_path,
            file_name=encoded_name,
            caption=caption,
            force_document=True,
        )

        sent_media = sent.document or sent.video
        new_key    = f"msg_{sent.id}"
        entry = {
            "id":                  new_key,
            "message_id":          sent.id,
            "channel_id":          chan_id,
            "name":                encoded_name,
            "size":                getattr(sent_media, "file_size", 0) or 0,
            "date":                sent.date.timestamp() if sent.date else 0,
            "caption":             caption,
            "type":                "video",
            "mime":                "video/mp4",
            "is_encoded_variant":  True,
            "original_file_id":    file_id,
            "quality_label":       label,
        }
        _file_cache[new_key] = entry

        # Assign to same folder as original
        orig_folder = _folder_db.get("file_assignments", {}).get(file_id)
        if orig_folder:
            _folder_db.setdefault("file_assignments", {})[new_key] = orig_folder
        if _save_fn:
            try:
                _save_fn()
            except Exception as e:
                logger.error(f"save_fn error: {e}")

        return new_key

    finally:
        # Clean up temp file
        try:
            if os.path.exists(out_path):
                os.unlink(out_path)
            os.rmdir(tmp_dir)
        except Exception:
            pass
