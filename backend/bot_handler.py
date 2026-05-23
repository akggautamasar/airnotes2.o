"""
AirNotes Bot Handler
Full bot with /start, /help, /set_folder, /current_folder, /create_folder,
/bulk_import commands. Handles PDF, EPUB, and Video uploads from admins.
Inspired by TGDrive's bot_mode.py.
"""
import asyncio
import json
import re
from datetime import datetime
from pathlib import Path
from pyrogram import filters
from pyrogram.types import InlineKeyboardMarkup, InlineKeyboardButton
from utils.logger import Logger

logger = Logger(__name__)

# ─── Globals ──────────────────────────────────────────────────────────────────
_file_cache   = None
_folder_db    = None
_save_fn      = None
_current_folder    = None   # current upload folder key in _folder_db
_current_folder_name = "Root"
_pending_asks = {}          # {chat_id: (queue, event)}
_folder_button_cache = {}   # {cache_id: {folder_id: (key, name)}}

FOLDER_CONFIG_FILE = Path("./cache/bot_folder_config.json")

START_MSG = """✦ **AirNotes Bot**

Send me a **PDF, EPUB, or Video** file and I'll add it to the shared library instantly.
Your Telegram username will be shown on the website next to your upload.

**Commands:**
/current_folder — show active upload folder
/help — show this message

**In groups/channels:**
/setup_channel — register this channel on the website
/channel_info — show indexing stats for this channel

*Folder management is available to admins only.*
"""

# ─── Manual ask helper ────────────────────────────────────────────────────────
async def _ask(client, chat_id: int, text: str, timeout: int = 120) -> str | None:
    """Send `text` and wait for a plain-text reply. Returns None on timeout/cancel."""
    queue = asyncio.Queue(1)
    event = asyncio.Event()
    _pending_asks[chat_id] = (queue, event)
    await client.send_message(chat_id, text)
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout)
        return await queue.get()
    except asyncio.TimeoutError:
        return None
    finally:
        _pending_asks.pop(chat_id, None)

# ─── Folder helpers ───────────────────────────────────────────────────────────
def _set_folder(key, name):
    global _current_folder, _current_folder_name
    _current_folder = key
    _current_folder_name = name
    try:
        FOLDER_CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(FOLDER_CONFIG_FILE, "w") as f:
            json.dump({"key": key, "name": name}, f)
    except Exception as e:
        logger.error(f"Failed to save folder config: {e}")

def _load_folder_config():
    global _current_folder, _current_folder_name
    if FOLDER_CONFIG_FILE.exists():
        try:
            with open(FOLDER_CONFIG_FILE) as f:
                d = json.load(f)
            if d.get("key") and d.get("name"):
                _current_folder = d["key"]
                _current_folder_name = d["name"]
                logger.info(f"Restored bot folder: {_current_folder_name}")
        except Exception as e:
            logger.error(f"Could not load folder config: {e}")

def _list_all_folders():
    """Return list of (key, name) for all non-locked folders."""
    if not _folder_db:
        return []
    return [(fid, f["name"]) for fid, f in _folder_db.get("folders", {}).items()]

def _search_folders(query: str):
    q = query.lower().strip()
    return [(fid, f["name"]) for fid, f in _folder_db.get("folders", {}).items()
            if q in f["name"].lower()]

# ─── File indexing ────────────────────────────────────────────────────────────
def _index_file(message, media, ftype: str, fname: str, uploader: dict = None):
    """Add a file to the in-memory cache and notify SSE clients."""
    from main import notify_new_file
    key = f"msg_{message.id}"
    entry = {
        "id": key, "message_id": message.id,
        "channel_id": message.chat.id,
        "name": fname,
        "size": getattr(media, "file_size", 0) or 0,
        "date": message.date.timestamp() if message.date else datetime.utcnow().timestamp(),
        "caption": message.caption or "",
        "type": ftype, "mime": getattr(media, "mime_type", "") or "",
        "uploaded_by": uploader or {},
    }
    _file_cache[key] = entry

    # ── Assign to the active folder so it appears in the folder on the website ──
    if _current_folder and _folder_db is not None:
        _folder_db.setdefault("file_assignments", {})[key] = _current_folder
        if _save_fn:
            try:
                _save_fn()
            except Exception as e:
                logger.error(f"Failed to save folder assignment: {e}")

    # ── Persist uploader info so it survives cache refreshes ──────────────────
    if uploader and _folder_db is not None:
        _folder_db.setdefault("file_meta", {})[key] = {"uploaded_by": uploader}
        if _save_fn:
            try:
                _save_fn()
            except Exception as e:
                logger.error(f"Failed to save file meta: {e}")

    notify_new_file(entry)
    logger.info(f"Indexed {ftype.upper()}: {fname} (msg {message.id}) → folder '{_current_folder_name}'")

    return entry

# ─── Setup function (called from main.py lifespan) ───────────────────────────
def setup_bot_handlers(client, file_cache: dict, folder_db: dict, save_fn):
    global _file_cache, _folder_db, _save_fn
    _file_cache = file_cache
    _folder_db  = folder_db
    _save_fn    = save_fn
    _load_folder_config()

    import config
    admin_ids = config.TELEGRAM_ADMIN_IDS

    # ── /start  /help ─────────────────────────────────────────────────────────
    @client.on_message(filters.command(["start", "help"]) & filters.private)
    async def cmd_start(c, m):
        await m.reply_text(START_MSG)

    # ── /current_folder ───────────────────────────────────────────────────────
    @client.on_message(filters.command("current_folder") & filters.private)
    async def cmd_current_folder(c, m):
        if m.from_user.id not in admin_ids:
            return
        if _current_folder:
            await m.reply_text(
                f"📁 **Current folder:** {_current_folder_name}\n"
                f"ID: `{_current_folder}`\n\n"
                f"Send files to upload here, or use /set_folder to change."
            )
        else:
            await m.reply_text("❌ No folder set. Use /set_folder first.")

    # ── /set_folder ───────────────────────────────────────────────────────────
    @client.on_message(filters.command("set_folder") & filters.private)
    async def cmd_set_folder(c, m):
        if m.from_user.id not in admin_ids:
            return
        if m.chat.id in _pending_asks:
            await m.reply_text("⏳ Already waiting for your input. Reply or send /cancel.")
            return

        # Direct argument: /set_folder Physics
        args = m.command[1:] if len(m.command) > 1 else []
        query = " ".join(args).strip() if args else None

        folders = _search_folders(query) if query else _list_all_folders()

        if not folders:
            answer = await _ask(c, m.chat.id,
                "🔍 No folder found. Send the folder name to search:\n\n/cancel to cancel",
                timeout=60)
            if not answer or answer.strip().lower() == "/cancel":
                await c.send_message(m.chat.id, "❌ Cancelled.")
                return
            folders = _search_folders(answer)
            if not folders:
                await c.send_message(m.chat.id, f"❌ No folder matching '{answer}' found.")
                return

        if len(folders) == 1:
            fid, fname = folders[0]
            _set_folder(fid, fname)
            await m.reply_text(f"✅ Folder set to **{fname}**")
            return

        # Multiple matches — show inline buttons
        cache_id = len(_folder_button_cache) + 1
        _folder_button_cache[cache_id] = {fid: (fid, fname) for fid, fname in folders}
        buttons = [[InlineKeyboardButton(fname, callback_data=f"sf_{cache_id}_{fid}")] for fid, fname in folders[:20]]
        await m.reply_text("📁 Select the folder:", reply_markup=InlineKeyboardMarkup(buttons))

    @client.on_callback_query(filters.regex(r"^sf_"))
    async def cb_set_folder(c, cq):
        if cq.from_user.id not in admin_ids:
            await cq.answer("Unauthorized")
            return
        parts = cq.data.split("_", 2)  # sf_<cache_id>_<folder_id>
        cache_id = int(parts[1])
        fid = parts[2]
        cache = _folder_button_cache.get(cache_id)
        if not cache:
            await cq.answer("Session expired. Use /set_folder again.")
            await cq.message.delete()
            return
        folder_key, fname = cache[fid]
        _set_folder(folder_key, fname)
        _folder_button_cache.pop(cache_id, None)
        await cq.answer(f"✅ Folder set to {fname}")
        await cq.message.edit_text(f"✅ **Folder set to:** {fname}")

    # ── /create_folder ────────────────────────────────────────────────────────
    @client.on_message(filters.command("create_folder") & filters.private)
    async def cmd_create_folder(c, m):
        if m.from_user.id not in admin_ids:
            return
        if m.chat.id in _pending_asks:
            await m.reply_text("⏳ Already waiting for your input. Reply or send /cancel.")
            return

        args = m.command[1:]
        name = " ".join(args).strip() if args else None

        if not name:
            name = await _ask(c, m.chat.id,
                "📁 Send the name for the new folder:\n\n/cancel to cancel",
                timeout=60)
            if not name or name.strip().lower() == "/cancel":
                await c.send_message(m.chat.id, "❌ Cancelled.")
                return
            name = name.strip()

        if not name:
            await m.reply_text("❌ Folder name cannot be empty.")
            return

        import uuid
        fid = str(uuid.uuid4())[:8]
        folder = {
            "id": fid, "name": name, "parent_id": None,
            "locked": False, "password_hash": None,
            "created_at": datetime.utcnow().isoformat(),
        }
        _folder_db["folders"][fid] = folder
        _save_fn()
        _set_folder(fid, name)
        await m.reply_text(f"✅ Folder **{name}** created and set as current folder.")

    # ── /encode ───────────────────────────────────────────────────────────────
    @client.on_message(filters.command("encode") & filters.private)
    async def cmd_encode(c, m):
        if m.from_user.id not in admin_ids:
            return

        args = m.command[1:]

        if not args:
            await m.reply_text(
                "\U0001f4cb **Encode Usage:**\n"
                "`/encode msg_4641` \u2014 encode all qualities (480p, 360p, 720p)\n"
                "`/encode msg_4641 480p` \u2014 specific quality\n"
                "`/encode msg_4641 480p 720p` \u2014 multiple qualities\n\n"
                "\U0001f4a1 Find the file ID on the website (visible in the player URL or title)."
            )
            return

        file_id = args[0].strip()

        if file_id not in _file_cache:
            await m.reply_text("File `" + file_id + "` not found in cache.")
            return

        info = _file_cache[file_id]
        if info.get("type") != "video":
            await m.reply_text("`" + file_id + "` is not a video file.")
            return
        if info.get("is_encoded_variant"):
            await m.reply_text("That file is already an encoded variant.")
            return

        import encoder as enc
        from encoder import QUALITY_LABELS

        requested = [a.lower() for a in args[1:]]
        if requested:
            invalid = [q for q in requested if q not in QUALITY_LABELS]
            if invalid:
                await m.reply_text(
                    "Unknown qualities: " + ", ".join(invalid) + "\n"
                    "Valid: " + ", ".join(QUALITY_LABELS)
                )
                return
            qualities = requested
        else:
            qualities = list(QUALITY_LABELS)

        already_done = enc.get_quality_variants(file_id)
        pending = [q for q in qualities if q not in already_done]

        if not pending:
            await m.reply_text(
                "\u2705 All requested qualities already encoded!\n"
                + info['name'] + "\n"
                "Done: " + ", ".join(already_done.keys())
            )
            return

        enc.schedule_encoding(file_id, pending, notify_chat_id=m.chat.id)
        done_str = ("Already done: " + ", ".join(already_done.keys()) + "\n") if already_done else ""
        await m.reply_text(
            "\u23f3 **Queued for encoding!**\n"
            + info['name'] + "\n\n"
            "Qualities: " + ", ".join(pending) + "\n"
            + done_str
            + "\nYou'll get updates as each quality finishes.\n"
            "\u23f1 ~20\u201340 min per quality."
        )

    # ── /bulk_import ──────────────────────────────────────────────────────────
        # ── /bulk_import ──────────────────────────────────────────────────────────
    @client.on_message(filters.command("bulk_import") & filters.private)
    async def cmd_bulk_import(c, m):
        if m.from_user.id not in admin_ids:
            return
        if m.chat.id in _pending_asks:
            await m.reply_text("⏳ Already waiting. Reply or send /cancel.")
            return
        if not _current_folder:
            await m.reply_text("❌ No folder set. Use /set_folder first.")
            return

        await m.reply_text(
            "📦 **Bulk Import**\n\n"
            "Send links to the first and last messages in the source channel.\n"
            "Format: `https://t.me/channelname/123`\n\n"
            "**Step 1/2:** Send the FIRST message link:"
        )

        start_link = await _ask(c, m.chat.id, "Send first message link:", timeout=120)
        if not start_link or start_link.strip().lower() == "/cancel":
            await c.send_message(m.chat.id, "❌ Cancelled.")
            return

        start_parsed = _parse_tg_link(start_link.strip())
        if not start_parsed:
            await c.send_message(m.chat.id, "❌ Invalid link. Use /bulk_import to retry.")
            return

        end_link = await _ask(c, m.chat.id,
            f"**Step 2/2:** Send the LAST message link:\n\nChannel: {start_parsed['channel']}",
            timeout=120)
        if not end_link or end_link.strip().lower() == "/cancel":
            await c.send_message(m.chat.id, "❌ Cancelled.")
            return

        end_parsed = _parse_tg_link(end_link.strip())
        if not end_parsed:
            await c.send_message(m.chat.id, "❌ Invalid link. Use /bulk_import to retry.")
            return

        if start_parsed["channel"] != end_parsed["channel"]:
            await c.send_message(m.chat.id, "❌ Both links must be from the same channel.")
            return

        s_id, e_id = start_parsed["message_id"], end_parsed["message_id"]
        if s_id >= e_id:
            await c.send_message(m.chat.id, "❌ Start ID must be less than end ID.")
            return

        total = e_id - s_id + 1
        confirm = await _ask(c, m.chat.id,
            f"📋 **Confirm:**\nChannel: {start_parsed['channel']}\n"
            f"Range: {s_id} → {e_id} ({total} messages)\n"
            f"Folder: {_current_folder_name}\n\nType **YES** to start:",
            timeout=60)
        if not confirm or confirm.strip().upper() not in ("YES", "Y"):
            await c.send_message(m.chat.id, "❌ Cancelled.")
            return

        asyncio.create_task(_do_bulk_import(c, m.chat.id, start_parsed["channel"], s_id, e_id))

    # ── File handler (PDF / EPUB / Video) ─────────────────────────────────────
    @client.on_message(
        filters.private
        & (filters.document | filters.video | filters.audio)
    )
    async def handle_file(c, m):
        # If waiting for a text reply (admin flow), ignore file messages
        if m.chat.id in _pending_asks:
            return
        if not _current_folder:
            await m.reply_text(
                "❌ No folder set yet. An admin needs to /set_folder first.\n\n"
                "Use /help for all commands."
            )
            return

        media = m.document or m.video or m.audio
        if not media:
            return

        mime  = getattr(media, "mime_type", "") or ""
        fname = getattr(media, "file_name", "") or f"file_{m.id}"

        from main import file_type
        ftype = file_type(mime, fname)

        if ftype == "other":
            await m.reply_text(
                "⚠️ Only PDF, EPUB, and Video files are supported.\n"
                f"Received: {fname} ({mime})"
            )
            return

        # Build uploader info from Telegram user
        user = m.from_user
        uploader = {
            "id": user.id,
            "username": user.username or "",
            "first_name": user.first_name or "",
            "last_name": user.last_name or "",
            "display": (
                f"@{user.username}" if user.username
                else f"{(user.first_name or '')} {(user.last_name or '')}".strip()
                or str(user.id)
            ),
        }

        processing_msg = await m.reply_text(f"⏳ Indexing **{fname}**…")

        try:
            import config as cfg
            # Copy to primary storage channel so we own the message
            copied = await m.copy(cfg.STORAGE_CHANNEL)
            copied_media = copied.document or copied.video or copied.audio
            if not copied_media:
                await processing_msg.edit_text("❌ Failed to copy file to storage channel.")
                return

            entry = _index_file(copied, copied_media, ftype, fname, uploader=uploader)
            size_mb = entry["size"] / (1024 * 1024)
            await processing_msg.edit_text(
                f"✅ **{ftype.upper()} added!**\n\n"
                f"📄 **{fname}**\n"
                f"📁 Folder: {_current_folder_name}\n"
                f"💾 Size: {size_mb:.1f} MB\n"
                f"👤 Uploaded by: {uploader['display']}"
            )
        except Exception as e:
            logger.error(f"File handler error: {e}")
            await processing_msg.edit_text(f"❌ Error: {e}")

    # ── Generic text handler (fulfills pending _ask calls) ────────────────────
    @client.on_message(filters.private & filters.text)
    async def handle_text(c, m):
        # Only admins can trigger pending asks (folder management flows)
        if m.from_user.id not in admin_ids:
            return
        chat_id = m.chat.id
        if chat_id in _pending_asks:
            queue, event = _pending_asks[chat_id]
            await queue.put(m.text)
            event.set()

    # Register channel-level commands
    _register_channel_commands(client, admin_ids, file_cache, folder_db, save_fn)
    # Register instant channel post handler
    _register_channel_post_handler(client, file_cache, folder_db, save_fn)


# ─── Bulk import worker ───────────────────────────────────────────────────────
def _parse_tg_link(link: str):
    patterns = [
        r"https?://t\.me/([^/]+)/(\d+)",
        r"https?://telegram\.me/([^/]+)/(\d+)",
        r"t\.me/([^/]+)/(\d+)",
    ]
    for p in patterns:
        m = re.match(p, link.strip())
        if m:
            return {"channel": m.group(1), "message_id": int(m.group(2))}
    return None


async def _do_bulk_import(client, user_chat_id: int, channel_name: str, start_id: int, end_id: int):
    import config as cfg
    from main import file_type, notify_new_file

    try:
        channel = await client.get_chat(channel_name)
        channel_id = channel.id
    except Exception as e:
        await client.send_message(user_chat_id, f"❌ Cannot access channel `{channel_name}`:\n{e}")
        return

    total = end_id - start_id + 1
    imported = skipped = errors = 0

    status_msg = await client.send_message(
        user_chat_id,
        f"📊 **Bulk Import Progress**\nTotal: {total}\nImported: 0 | Skipped: 0 | Errors: 0"
    )

    for msg_id in range(start_id, end_id + 1):
        try:
            src = await client.get_messages(channel_id, msg_id)
            if not src or src.empty:
                skipped += 1
                continue

            media = src.document or src.video or src.audio or src.photo
            if not media:
                skipped += 1
                continue

            mime  = getattr(media, "mime_type", "") or ""
            fname = getattr(media, "file_name", "") or f"file_{msg_id}"
            ftype = file_type(mime, fname)
            if ftype == "other":
                skipped += 1
                continue

            copied = await src.copy(cfg.STORAGE_CHANNEL)
            copied_media = copied.document or copied.video or copied.audio or copied.photo
            key = f"msg_{copied.id}"
            entry = {
                "id": key, "message_id": copied.id,
                "channel_id": cfg.STORAGE_CHANNEL,
                "name": getattr(copied_media, "file_name", fname) or fname,
                "size": getattr(copied_media, "file_size", 0) or 0,
                "date": datetime.utcnow().timestamp(),
                "caption": src.caption or "", "type": ftype,
                "mime": getattr(copied_media, "mime_type", mime) or mime,
            }
            _file_cache[key] = entry
            # Assign to active folder so files appear in the folder on the website
            if _current_folder and _folder_db is not None:
                _folder_db.setdefault("file_assignments", {})[key] = _current_folder
            notify_new_file(entry)
            imported += 1
        except Exception as e:
            logger.error(f"Bulk import msg {msg_id}: {e}")
            errors += 1

        processed = imported + skipped + errors
        if processed % 50 == 0 or msg_id == end_id:
            pct = processed / total * 100
            try:
                await status_msg.edit_text(
                    f"📊 **Bulk Import Progress**\n"
                    f"Total: {total} | Progress: {pct:.1f}%\n"
                    f"Imported: {imported} | Skipped: {skipped} | Errors: {errors}"
                )
            except Exception:
                pass

        await asyncio.sleep(0.3)

    await client.send_message(
        user_chat_id,
        f"✅ **Bulk Import Done!**\n\n"
        f"Total processed: {total}\n"
        f"✅ Imported: {imported}\n"
        f"⏭ Skipped: {skipped}\n"
        f"❌ Errors: {errors}\n\n"
        f"Files are now live in your library!"
    )
    # Persist folder assignments after bulk import
    if _save_fn and imported > 0:
        try:
            _save_fn()
        except Exception as e:
            logger.error(f"Failed to save bulk import folder assignments: {e}")


# ─── Channel setup (appended) ─────────────────────────────────────────────────
# This block is appended separately so it can be hot-patched without touching
# the original file structure.  Import setup_bot_handlers from this same file.

def _register_channel_commands(client, admin_ids, file_cache, folder_db, save_fn):
    """Register /setup_channel and channel file-handling commands."""
    import httpx
    import config as cfg
    from pyrogram import filters as _f

    @client.on_message(_f.command("setup_channel") & (_f.group | _f.channel))
    async def cmd_setup_channel(c, m):
        """Register this channel to the AirNotes website. Admin-only."""
        chat = m.chat
        # Must be an admin of the chat
        try:
            member = await c.get_chat_member(chat.id, m.from_user.id)
            status = getattr(member, "status", None)
            if status not in ("administrator", "creator"):
                await m.reply_text("⚠️ Only channel/group admins can run /setup_channel.")
                return
        except Exception:
            pass

        channel_name = getattr(chat, "title", None) or getattr(chat, "username", None) or str(chat.id)
        username = getattr(chat, "username", None) or ""

        # Call the website API to register
        base_url = getattr(cfg, "WEBSITE_URL", None) or getattr(cfg, "FRONTEND_URL", None)
        # Prefer the backend URL (WEBSITE_URL is the backend API URL in env)
        api_url = getattr(cfg, "WEBSITE_URL", None)
        if not api_url:
            await m.reply_text(
                f"✅ Channel **{channel_name}** (`{chat.id}`) noted.\n\n"
                "⚠️ `WEBSITE_URL` env var is not set — cannot auto-register to website.\n"
                "Add it to `.env` so the bot can call `/api/channels/register`."
            )
            return

        try:
            token_payload = {"sub": "bot", "role": "admin"}
            import jwt as pyjwt
            token = pyjwt.encode({**token_payload, "exp": __import__("datetime").datetime.utcnow() + __import__("datetime").timedelta(hours=1)}, cfg.JWT_SECRET, algorithm="HS256")
            async with httpx.AsyncClient(timeout=10) as http:
                resp = await http.post(
                    f"{api_url.rstrip('/')}/api/channels/register",
                    json={"channel_id": chat.id, "name": channel_name, "username": username},
                    headers={"Authorization": f"Bearer {token}"},
                )
            if resp.status_code == 200:
                await m.reply_text(
                    f"🎉 **Channel registered!**\n\n"
                    f"📺 **{channel_name}**\n"
                    f"🆔 `{chat.id}`\n\n"
                    f"All PDF, EPUB & Video files I can access here will now appear on the website "
                    f"under a **'{channel_name}'** channel folder.\n\n"
                    f"A background rescan has been triggered — files will appear shortly."
                )
            else:
                await m.reply_text(f"❌ Registration failed: {resp.text}")
        except Exception as e:
            await m.reply_text(f"❌ Could not register channel: {e}")

    @client.on_message(_f.command("channel_info") & (_f.group | _f.channel))
    async def cmd_channel_info(c, m):
        """Show info about this channel and how many files are indexed."""
        chat = m.chat
        channel_id = chat.id
        count = sum(1 for f in file_cache.values() if f.get("channel_id") == channel_id)
        name = getattr(chat, "title", None) or str(channel_id)
        await m.reply_text(
            f"📊 **Channel Info**\n\n"
            f"📺 **{name}**\n"
            f"🆔 `{channel_id}`\n"
            f"📄 Indexed files: **{count}**\n\n"
            f"Use /setup_channel to register this channel on the website."
        )

    logger.info("Channel commands registered (/setup_channel, /channel_info)")


# ─── Instant channel post handler (appended) ─────────────────────────────────

def _register_channel_post_handler(client, file_cache, folder_db, save_fn):
    """Watch registered channels for new media posts and add them instantly."""
    from pyrogram import filters as _f
    from main import file_type, notify_new_file
    import config as cfg
    from datetime import datetime

    @client.on_message(_f.channel & (_f.document | _f.video | _f.audio | _f.photo))
    async def on_channel_post(c, m):
        chat = m.chat
        channel_id = chat.id
        registry = folder_db.get("channel_registry", {})
        config_channels = set(cfg.STORAGE_CHANNELS if cfg.STORAGE_CHANNELS else [cfg.STORAGE_CHANNEL])
        registered_ids = {v.get("id") or int(k) for k, v in registry.items()} | config_channels

        if channel_id not in registered_ids:
            return  # not a registered channel

        media = getattr(m, "document", None) or getattr(m, "video", None) or getattr(m, "audio", None)
        if not media and m.photo:
            # Handle photo
            photo = m.photo
            key = f"ch{abs(channel_id)}_msg_{m.id}" if channel_id != cfg.STORAGE_CHANNEL else f"msg_{m.id}"
            channel_name = registry.get(str(channel_id), {}).get("name") or getattr(chat, "title", str(channel_id))
            entry = {
                "id": key, "message_id": m.id, "channel_id": channel_id,
                "channel_name": channel_name,
                "name": f"photo_{m.id}.jpg",
                "size": getattr(photo, "file_size", 0),
                "date": m.date.timestamp() if m.date else datetime.utcnow().timestamp(),
                "caption": m.caption or "", "type": "image", "mime": "image/jpeg",
            }
            file_cache[key] = entry
            notify_new_file(entry)
            save_fn()
            return

        if not media:
            return

        mime = getattr(media, "mime_type", "") or ""
        fname = getattr(media, "file_name", "") or f"file_{m.id}"
        ftype = file_type(mime, fname)
        if ftype == "other":
            return

        key = f"ch{abs(channel_id)}_msg_{m.id}" if channel_id != cfg.STORAGE_CHANNEL else f"msg_{m.id}"
        if key in file_cache:
            return  # already indexed

        channel_name = registry.get(str(channel_id), {}).get("name") or getattr(chat, "title", str(channel_id))
        entry = {
            "id": key, "message_id": m.id, "channel_id": channel_id,
            "channel_name": channel_name,
            "name": fname, "size": getattr(media, "file_size", 0),
            "date": m.date.timestamp() if m.date else datetime.utcnow().timestamp(),
            "caption": m.caption or "", "type": ftype, "mime": mime,
        }
        file_cache[key] = entry
        notify_new_file(entry)
        save_fn()
        logger.info(f"Instant index: {fname} from channel {channel_name} ({channel_id})")

    logger.info("Channel post handler registered (instant indexing active)")
