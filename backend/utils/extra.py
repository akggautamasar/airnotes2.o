import asyncio
import aiohttp
from utils.logger import Logger
logger = Logger(__name__)

async def auto_ping_website(url: str, interval: int = 840):
    """Ping the backend URL every 14 minutes to prevent Render sleep."""
    await asyncio.sleep(30)
    while True:
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(f"{url}/health", timeout=aiohttp.ClientTimeout(total=15)) as r:
                    logger.info(f"Auto-ping {url}: {r.status}")
        except Exception as e:
            logger.warning(f"Auto-ping failed: {e}")
        await asyncio.sleep(interval)
