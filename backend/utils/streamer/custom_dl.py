"""
ByteStreamer — optimized for fast Telegram media streaming.

Key optimizations vs original:
1. Parallel prefetch: while yielding chunk N, we fetch chunk N+1 from Telegram.
   This eliminates the gap between chunks and keeps the pipe full.
2. Aggressive file-property caching — no Telegram round-trip after first request.
3. Per-client ByteStreamer cache so we don't recreate the object per request.
"""

import asyncio
from typing import Dict, Optional, AsyncGenerator
from pyrogram import Client
from pyrogram.file_id import FileId
from .file_properties import get_file_ids
from utils.logger import Logger

logger = Logger(__name__)

# How many chunks to prefetch ahead while streaming.
# 2 = fetch N+1 while yielding N  →  near-zero inter-chunk gaps.
PREFETCH_CHUNKS = 2


class ByteStreamer:
    def __init__(self, client: Client):
        self.client: Client = client
        self.cached_file_ids: Dict[int, FileId] = {}
        asyncio.create_task(self._periodic_cache_clean())

    # ── File property cache ──────────────────────────────────────────────

    async def get_file_properties(self, channel, message_id: int) -> FileId:
        if message_id not in self.cached_file_ids:
            file_id = await get_file_ids(self.client, channel, message_id)
            if not file_id:
                raise Exception("FileNotFound")
            self.cached_file_ids[message_id] = file_id
        return self.cached_file_ids[message_id]

    # ── Streaming with parallel prefetch ────────────────────────────────

    async def yield_file(
        self,
        file_id: FileId,
        offset: int,
        first_part_cut: int,
        last_part_cut: int,
        part_count: int,
        chunk_size: int,
    ) -> AsyncGenerator[bytes, None]:
        """
        Yield the requested byte range as a stream.

        Uses a small async queue to prefetch the next chunk from Telegram
        while the current chunk is being sent to the client — this keeps
        the TCP pipe full and eliminates the stall between chunks.
        """
        chunk_offset = offset // chunk_size
        client       = self.client

        # Queue holds prefetched chunks; size = PREFETCH_CHUNKS + 1 (current being sent)
        queue: asyncio.Queue[Optional[bytes]] = asyncio.Queue(maxsize=PREFETCH_CHUNKS + 1)

        async def _producer():
            """Fetch chunks from Telegram and push them into the queue."""
            try:
                fetched = 0
                async for chunk in client.stream_media(
                    file_id.file_id,
                    offset=chunk_offset,
                    limit=part_count,
                ):
                    if not chunk:
                        break
                    await queue.put(chunk)
                    fetched += 1
                    if fetched >= part_count:
                        break
            except Exception as e:
                logger.error(f"Producer error: {e}")
            finally:
                await queue.put(None)   # sentinel — tells consumer we're done

        producer_task = asyncio.create_task(_producer())

        current_part = 1
        try:
            while True:
                chunk = await queue.get()
                if chunk is None:
                    break           # producer finished

                # Slice bytes for range alignment
                if part_count == 1:
                    yield chunk[first_part_cut:last_part_cut]
                elif current_part == 1:
                    yield chunk[first_part_cut:]
                elif current_part == part_count:
                    yield chunk[:last_part_cut]
                else:
                    yield chunk

                current_part += 1
                if current_part > part_count:
                    break
        except (GeneratorExit, asyncio.CancelledError):
            pass
        except Exception as e:
            logger.error(f"Consumer error: {e}")
        finally:
            producer_task.cancel()
            try:
                await producer_task
            except asyncio.CancelledError:
                pass

    # ── Cache maintenance ────────────────────────────────────────────────

    async def _periodic_cache_clean(self):
        while True:
            await asyncio.sleep(30 * 60)    # every 30 min
            n = len(self.cached_file_ids)
            self.cached_file_ids.clear()
            logger.debug(f"File-ID cache cleared: {n} entries")
