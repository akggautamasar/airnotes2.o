"""Bot handler – registers Telegram message handlers for file uploads."""
from datetime import datetime
from utils.logger import Logger
logger = Logger(__name__)

def setup_bot_handlers(client, file_cache: dict, folder_db: dict, save_fn):
    import config

    @client.on_message()
    async def handle_message(client, message):
        try:
            if message.chat.id not in config.TELEGRAM_ADMIN_IDS:
                return
            media = getattr(message, 'document', None)
            if not media:
                return
            mime  = getattr(media, 'mime_type', '') or ''
            fname = getattr(media, 'file_name', '') or f'file_{message.id}'
            from main import file_type, notify_new_file
            ftype = file_type(mime, fname)
            if ftype in ('pdf', 'epub'):
                key  = f'msg_{message.id}'
                entry = {
                    'id': key, 'message_id': message.id, 'name': fname,
                    'size': getattr(media, 'file_size', 0),
                    'date': message.date.timestamp() if message.date else datetime.utcnow().timestamp(),
                    'caption': message.caption or '', 'type': ftype, 'mime': mime,
                }
                file_cache[key] = entry
                notify_new_file(entry)
                logger.info(f"New {ftype.upper()} indexed: {fname}")
        except Exception as e:
            logger.error(f"Bot handler error: {e}")
