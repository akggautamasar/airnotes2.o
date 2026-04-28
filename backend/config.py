from dotenv import load_dotenv
import os

load_dotenv()

API_ID    = int(os.getenv("API_ID", "0"))
API_HASH  = os.getenv("API_HASH", "")

BOT_TOKENS = [t.strip() for t in os.getenv("BOT_TOKENS", "").split(",") if t.strip()]
STRING_SESSIONS = [s.strip() for s in os.getenv("STRING_SESSIONS", "").split(",") if s.strip()]

# Primary storage channel (for bot uploads)
STORAGE_CHANNEL = int(os.getenv("STORAGE_CHANNEL", "0"))

# Multi-channel support: comma-separated list of channel IDs to scan for files
# e.g. STORAGE_CHANNELS=-1001234567890,-1009876543210
# If not set, falls back to STORAGE_CHANNEL
_channels_raw = os.getenv("STORAGE_CHANNELS", "")
if _channels_raw.strip():
    STORAGE_CHANNELS = [int(c.strip()) for c in _channels_raw.split(",") if c.strip()]
else:
    STORAGE_CHANNELS = [STORAGE_CHANNEL] if STORAGE_CHANNEL else []

DATABASE_BACKUP_MSG_ID = int(os.getenv("DATABASE_BACKUP_MSG_ID", "1"))

ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "airnotes123")
JWT_SECRET     = os.getenv("JWT_SECRET", "airnotes_super_secret_key_change_me")

_admin_ids_raw = os.getenv("TELEGRAM_ADMIN_IDS", "")
TELEGRAM_ADMIN_IDS = [int(x.strip()) for x in _admin_ids_raw.split(",") if x.strip().lstrip("-").isdigit()]

# Bot username (optional, for generating invite links in bot replies)
MAIN_BOT_TOKEN = BOT_TOKENS[0] if BOT_TOKENS else ""

MAX_FILE_SIZE          = 3.98 * 1024**3 if STRING_SESSIONS else 1.98 * 1024**3
DATABASE_BACKUP_TIME   = int(os.getenv("DATABASE_BACKUP_TIME", "300"))
SLEEP_THRESHOLD        = int(os.getenv("SLEEP_THRESHOLD", "60"))
WEBSITE_URL            = os.getenv("WEBSITE_URL", None)
FRONTEND_URL           = os.getenv("FRONTEND_URL", "*")
