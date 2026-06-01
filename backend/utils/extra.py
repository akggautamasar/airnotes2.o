import asyncio
import aiohttp
from datetime import datetime, timezone
from utils.logger import Logger
logger = Logger(__name__)

async def auto_ping_website(url: str, interval: int = 840, active_hours: str = "7-22"):
    """Self-ping to prevent Render free-tier sleep.

    active_hours: "START-END" in UTC (e.g. "7-22" = 7am–10pm).
    Sleeping 9 hrs/night saves ~270 hrs/month, keeping usage well under
    Render's 750 hr/month free limit.  Set "0-24" to ping 24/7.
    """
    try:
        start_h, end_h = (int(h) for h in active_hours.split("-"))
    except Exception:
        start_h, end_h = 0, 24

    await asyncio.sleep(30)
    while True:
        hour = datetime.now(timezone.utc).hour
        if start_h <= hour < end_h:
            try:
                async with aiohttp.ClientSession() as s:
                    async with s.get(f"{url}/ping", timeout=aiohttp.ClientTimeout(total=15)) as r:
                        logger.info(f"Auto-ping {url}: {r.status}")
            except Exception as e:
                logger.warning(f"Auto-ping failed: {e}")
        await asyncio.sleep(interval)
