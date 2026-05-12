"""
encoder.py — On-demand video quality encoder for AirNotes

Triggered only via bot command: /encode <file_id> [quality]
Encodes 480p, 360p, 720p and uploads back to Telegram.
Progress checkpointed so restarts resume correctly.
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
QUALITY_PRESETS = [
    ("480p", 480, 28),
    ("360p", 360, 30),
    ("720p", 720, 26),
]
QUALITY_LABELS = [q[0] for q in QUALITY_PRESETS]

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
    logger.info("Encoder ready (manual mode — use /encode to trigger)")


def schedule_encoding(file_id: str, qualities: list = None, notify_chat_id: int = None):
    """Queue a file for encoding. qualities defaults to all presets."""
    if _queue is None:
        return
    q = qualities or QUALITY_LABELS
    try:
        _queue.put_nowait((file_id, q, notify_chat_id))
        logger.info(f"Encoder: queued {file_id} for {q}")
    except asyncio.QueueFull:
        logger.warning(f"Encoder queue full, could not add {file_id}")


def get_quality_variants(file_id: str) -> dict:
    """Return {quality_label: encoded_file_id} for a given original file."""
    return _encode_db.get("done", {}).get(file_id, {})


async def encoder_worker():
    """Long-running background task — processes encode jobs one at a time."""
    logger.info("Encoder worker started")
    while True:
        try:
            file_id, qualities, notify_chat_id = await _queue.get()
            await _encode_file(file_id, qualities, notify_chat_id)
            _queue.task_done()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Encoder worker error: {e}")
            await asyncio.sleep(5)


async def _encode_file(file_id: str, qualities: list, notify_chat_id: int = None):
    """Encode requested quality variants for one file."""
    info = _file_cache.get(file_id)
    if not info:
        logger.warning(f"Encoder: {file_id} not in file_cache, skipping")
        if notify_chat_id:
            from utils.clients import get_client
            await get_client().send_message(notify_chat_id, f"❌ File `{file_id}` not found in cache.")
        return

    done_qualities = _encode_db.setdefault("done", {}).setdefault(file_id, {})
    fname = info['name']

    if notify_chat_id:
        from utils.clients import get_client
        client = get_client()
        await client.send_message(
            notify_chat_id,
            f"🎬 Starting encode for **{fname}**\nQualities: {', '.join(qualities)}"
        )

    for label in qualities:
        preset = next((p for p in QUALITY_PRESETS if p[0] == label), None)
        if not preset:
            continue
        _, height, crf = preset

        if label in done_qualities:
            logger.info(f"Encoder: {file_id} {label} already done, skipping")
            if notify_chat_id:
                await client.send_message(notify_chat_id, f"⏭ {label} already encoded, skipping.")
            continue

        logger.info(f"Encoder: starting {label} for {file_id} ({fname})")
        if notify_chat_id:
            await client.send_message(notify_chat_id, f"⚙️ Encoding **{label}**… (this takes 20–40 min)")

        try:
            encoded_id = await _encode_quality(file_id, info, label, height, crf)
            if encoded_id:
                done_qualities[label] = encoded_id
                _save_encode_db(_encode_db)
                logger.info(f"Encoder: {file_id} {label} done → {encoded_id}")
                if notify_chat_id:
                    await client.send_message(notify_chat_id, f"✅ **{label}** done! Available on website.")
            else:
                logger.warning(f"Encoder: {file_id} {label} produced no output")
                if notify_chat_id:
                    await client.send_message(notify_chat_id, f"❌ **{label}** encode failed.")
        except Exception as e:
            logger.error(f"Encoder: {file_id} {label} failed: {e}")
            if notify_chat_id:
                await client.send_message(notify_chat_id, f"❌ **{label}** error: {e}")

        await asyncio.sleep(2)

    if notify_chat_id:
        await client.send_message(notify_chat_id, f"🎉 All done for **{fname}**!")


async def _encode_quality(file_id: str, info: dict, label: str, height: int, crf: int) -> Optional[str]:
    """Download from Telegram → ffmpeg → upload back. Returns new file_cache key."""
    from utils.clients import get_client
    from utils.streamer.custom_dl import ByteStreamer
    import config

    client   = get_client()
    msg_id   = info.get("message_id")
    chan_id  = info.get("channel_id", config.STORAGE_CHANNEL)

    # Get file properties via ByteStreamer
    streamer = ByteStreamer(client)
    try:
        file_props = await streamer.get_file_properties(chan_id, msg_id)
    except Exception as e:
        logger.error(f"Encoder: could not get file properties for {msg_id}: {e}")
        return None

    tmp_dir  = tempfile.mkdtemp(prefix="airnotes_enc_")
    out_path = os.path.join(tmp_dir, f"out_{label}.mp4")

    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y",
            "-fflags", "+genpts+discardcorrupt",
            "-analyzeduration", "20M",
            "-probesize", "20M",
            "-i", "pipe:0",
            "-map", "0:v:0",
            "-map", "0:a?",
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

        async def feed_stdin():
            try:
                async for chunk in client.stream_media(file_props.file_id, offset=0):
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
                if b"time=" in line:
                    logger.debug(f"ffmpeg [{label}]: {line.decode(errors='ignore').strip()}")
                if time.time() - last_ckpt > 30:
                    _save_encode_db(_encode_db)
                    last_ckpt = time.time()

        await asyncio.gather(
            asyncio.create_task(feed_stdin()),
            asyncio.create_task(read_stderr()),
        )
        await proc.wait()

        if proc.returncode != 0:
            logger.error(f"ffmpeg exited {proc.returncode} for {file_id} {label}")
            return None

        if not os.path.exists(out_path) or os.path.getsize(out_path) < 10_000:
            logger.error(f"Output too small/missing for {file_id} {label}")
            return None

        out_mb = os.path.getsize(out_path) / 1024 / 1024
        logger.info(f"Encoder: {label} {out_mb:.1f}MB encoded, uploading to Telegram...")

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
            "id":                 new_key,
            "message_id":         sent.id,
            "channel_id":         chan_id,
            "name":               encoded_name,
            "size":               getattr(sent_media, "file_size", 0) or 0,
            "date":               sent.date.timestamp() if sent.date else 0,
            "caption":            caption,
            "type":               "video",
            "mime":               "video/mp4",
            "is_encoded_variant": True,
            "original_file_id":   file_id,
            "quality_label":      label,
        }
        _file_cache[new_key] = entry

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
        try:
            if os.path.exists(out_path):
                os.unlink(out_path)
            os.rmdir(tmp_dir)
        except Exception:
            pass
