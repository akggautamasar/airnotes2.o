"""
AirNotes — Enhanced media streaming with full HTTP Range Request support.
- PDFs: 256 KB chunks → fast initial render, low latency page jumps
- Videos: 1 MB chunks → smooth seek / scrub
"""

import math
import mimetypes
from pathlib import Path
from fastapi.responses import StreamingResponse, Response
from utils.logger import Logger
from utils.streamer.custom_dl import ByteStreamer
from utils.clients import get_client
from urllib.parse import quote

logger = Logger(__name__)

class_cache = {}

VIDEO_MIME_TYPES = {
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.m4v': 'video/mp4',
    '.flv': 'video/x-flv',
    '.wmv': 'video/x-ms-wmv',
    '.3gp': 'video/3gpp',
    '.ts':  'video/mp2t',
    '.mpeg':'video/mpeg',
}

AUDIO_MIME_TYPES = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
}

# Chunk size per file type:
#   PDF/EPUB → 256 KB: browser requests tiny ranges for individual pages,
#              smaller chunks mean faster time-to-first-byte and page renders.
#   Video    → 1 MB:   large chunks reduce round-trips during seek / playback.
CHUNK_SIZE_PDF   = 256 * 1024        # 256 KB
CHUNK_SIZE_VIDEO = 1 * 1024 * 1024   # 1 MB


def parse_range_header(range_header: str, file_size: int) -> tuple:
    if not range_header or not range_header.startswith('bytes='):
        return 0, file_size - 1
    range_spec = range_header[6:]
    try:
        if range_spec.startswith('-'):
            suffix_length = int(range_spec[1:])
            start = max(0, file_size - suffix_length)
            end = file_size - 1
        elif range_spec.endswith('-'):
            start = int(range_spec[:-1])
            end = file_size - 1
        elif '-' in range_spec:
            parts = range_spec.split('-', 1)
            start = int(parts[0])
            end = int(parts[1]) if parts[1] else file_size - 1
        else:
            return 0, file_size - 1
        start = max(0, min(start, file_size - 1))
        end   = max(start, min(end, file_size - 1))
        return start, end
    except (ValueError, IndexError) as e:
        logger.warning(f"Failed to parse range header '{range_header}': {e}")
        return 0, file_size - 1


def get_mime_type(file_name: str) -> str:
    ext = Path(file_name).suffix.lower()
    if ext in VIDEO_MIME_TYPES:
        return VIDEO_MIME_TYPES[ext]
    if ext in AUDIO_MIME_TYPES:
        return AUDIO_MIME_TYPES[ext]
    mime_type = mimetypes.guess_type(file_name.lower())[0]
    return mime_type or "application/octet-stream"


def _choose_chunk_size(mime_type: str, file_name: str) -> int:
    if "video" in mime_type or "audio" in mime_type:
        return CHUNK_SIZE_VIDEO
    ext = Path(file_name).suffix.lower()
    if ext in VIDEO_MIME_TYPES or ext in AUDIO_MIME_TYPES:
        return CHUNK_SIZE_VIDEO
    # PDF, EPUB, and everything else → small chunks
    return CHUNK_SIZE_PDF


async def media_streamer(channel: int, message_id: int, file_name: str, request):
    """
    Stream Telegram files with full HTTP Range Request support.
    Automatically selects chunk size based on file type.
    """
    global class_cache

    range_header = request.headers.get("Range", "")
    logger.info(f"Stream: {file_name} | channel={channel} | msg={message_id} | range='{range_header}'")

    faster_client = get_client()

    if faster_client in class_cache:
        tg_connect = class_cache[faster_client]
    else:
        tg_connect = ByteStreamer(faster_client)
        class_cache[faster_client] = tg_connect

    try:
        file_id = await tg_connect.get_file_properties(channel, message_id)
        file_size = file_id.file_size
        if file_size == 0:
            return Response(
                status_code=404,
                content="File not found or empty",
                headers={"Accept-Ranges": "bytes"}
            )
    except Exception as e:
        logger.error(f"Failed to get file properties for {file_name}: {e}")
        return Response(
            status_code=500,
            content=f"Failed to retrieve file: {str(e)}",
            headers={"Accept-Ranges": "bytes"}
        )

    from_bytes, until_bytes = parse_range_header(range_header, file_size)

    if from_bytes >= file_size or until_bytes >= file_size or from_bytes > until_bytes:
        return Response(
            status_code=416,
            content="Range Not Satisfiable",
            headers={
                "Content-Range": f"bytes */{file_size}",
                "Accept-Ranges": "bytes"
            },
        )

    until_bytes = min(until_bytes, file_size - 1)

    mime_type  = get_mime_type(file_name)
    chunk_size = _choose_chunk_size(mime_type, file_name)

    offset           = from_bytes - (from_bytes % chunk_size)
    first_part_cut   = from_bytes - offset
    last_part_cut    = (until_bytes % chunk_size) + 1
    req_length       = until_bytes - from_bytes + 1
    part_count       = math.ceil((until_bytes + 1) / chunk_size) - math.floor(offset / chunk_size)

    logger.info(f"Streaming: offset={offset}, parts={part_count}, length={req_length}, chunk={chunk_size//1024}KB")

    body = tg_connect.yield_file(
        file_id, offset, first_part_cut, last_part_cut, part_count, chunk_size
    )

    is_inline = any(x in mime_type for x in ["video/", "audio/", "image/", "/html", "/pdf", "epub"])
    disposition = "inline" if is_inline else "attachment"
    is_range_request = bool(range_header)
    status_code = 206 if is_range_request else 200

    headers = {
        "Content-Type":         mime_type,
        "Content-Length":       str(req_length),
        "Accept-Ranges":        "bytes",
        "Content-Disposition":  f'{disposition}; filename="{quote(file_name)}"',
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, Content-Type, Authorization",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
        "Cache-Control":        "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
    }

    if is_range_request:
        headers["Content-Range"] = f"bytes {from_bytes}-{until_bytes}/{file_size}"

    return StreamingResponse(
        status_code=status_code,
        content=body,
        headers=headers,
        media_type=mime_type,
    )
