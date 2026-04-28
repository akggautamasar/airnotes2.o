import asyncio
import config
from pathlib import Path
from pyrogram import Client
from utils.logger import Logger
import os, signal

logger = Logger(__name__)

multi_clients = {}
work_loads = {}

async def initialize_clients():
    global multi_clients, work_loads
    logger.info("Initializing Pyrogram clients...")

    cache_path = Path("./cache")
    cache_path.mkdir(parents=True, exist_ok=True)

    all_tokens = {i: t for i, t in enumerate(config.BOT_TOKENS, start=1)}

    async def start_bot(client_id, token):
        try:
            client = Client(
                name=str(client_id),
                api_id=config.API_ID,
                api_hash=config.API_HASH,
                bot_token=token,
                workdir=str(cache_path),
            )
            await client.start()
            multi_clients[client_id] = client
            work_loads[client_id] = 0
            logger.info(f"Bot client {client_id} started")
        except Exception as e:
            logger.error(f"Failed to start bot client {client_id}: {e}")

    await asyncio.gather(*[start_bot(cid, tok) for cid, tok in all_tokens.items()])

    if not multi_clients:
        logger.error("No clients initialized — check BOT_TOKENS")
        os.kill(os.getpid(), signal.SIGKILL)

    logger.info(f"Initialized {len(multi_clients)} client(s)")


def get_client() -> Client:
    if not multi_clients:
        raise Exception("No Telegram clients available")
    index = min(work_loads, key=work_loads.get)
    work_loads[index] += 1
    return multi_clients[index]
