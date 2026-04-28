"""
AirNotes — Fast media streaming with HTTP Range Request support.

Chunk strategy:
  Video/Audio → 1 MB   — large enough for smooth playback, small enough for fast seek
  PDF/EPUB    → 512 KB — balanced for page-by-page access
"""

import math
import mimetypes
from pathlib import Path
from fastapi.responses import StreamingResponse, Response
from utils.logger import Logger
from utils.streamer.custom_dl import ByteStreamer
from utils.clients import get_client
from urllib.parse import quote

logger    = Logger(__name__)
class_cache = {}

VIDEO_MIME_TYPES = {
    '.mp4': 'video/mp4',    '.mkv': 'video/x-matroska',
    '.webm':'video/webm',   '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime', '.m4v': 'video/mp4',
    '.flv': 'video/x-flv', '.wmv': 'video/x-ms-wmv',
    '.3gp': 'video/3gpp',  '.ts':  'video/mp2t',
    '.mpeg':'video/mpeg',
}
AUDIO_MIME_TYPES = {
    '.mp3':'audio/mpeg', '.wav':'audio/wav',
    '.flac':'audio/flac','.aac':'audio/aac',
    '.ogg':'audio/ogg',  '.m4a':'audio/mp4',
}

CHUNK_VIDEO = 1 * 1024 * 1024   # 1 MB — sweet spot: fast seek + smooth play
CHUNK_PDF   = 512 * 1024         # 512 KB


def get_mime_type(file_name: str) -> str:
    ext = Path(file_name).suffix.lower()
    if ext in VIDEO_MIME_TYPES: return VIDEO_MIME_TYPES[ext]
    if ext in AUDIO_MIME_TYPES: return AUDIO_MIME_TYPES[ext]
    return mimetypes.guess_type(file_name.lower())[0] or "application/octet-stream"


def _chunk_size(mime_type: str, file_name: str) -> int:
    if "video" in mime_type or "audio" in mime_type:
        return CHUNK_VIDEO
    ext = Path(file_name).suffix.lower()
    if ext in VIDEO_MIME_TYPES or ext in AUDIO_MIME_TYPES:
        return CHUNK_VIDEO
    return CHUNK_PDF


def parse_range(header: str, file_size: int):
    if not header or not header.startswith('bytes='):
        return 0, file_size - 1
    spec = header[6:]
    try:
        if spec.startswith('-'):
            start = max(0, file_size - int(spec[1:]))
            return start, file_size - 1
        if spec.endswith('-'):
            start = int(spec[:-1])
            return max(0, min(start, file_size-1)), file_size - 1
        if '-' in spec:
            a, b = spec.split('-', 1)
            start = int(a)
            end   = int(b) if b else file_size - 1
            return max(0, min(start, file_size-1)), max(start, min(end, file_size-1))
    except (ValueError, IndexError):
        pass
    return 0, file_size - 1


async def media_streamer(channel: int, message_id: int, file_name: str, request):
    global class_cache

    range_hdr = request.headers.get("Range", "")
    client    = get_client()

    if client not in class_cache:
        class_cache[client] = ByteStreamer(client)
    streamer = class_cache[client]

    try:
        file_id   = await streamer.get_file_properties(channel, message_id)
        file_size = file_id.file_size
        if file_size == 0:
            return Response(status_code=404, content="Empty file",
                            headers={"Accept-Ranges": "bytes"})
    except Exception as e:
        logger.error(f"File properties error for {file_name}: {e}")
        return Response(status_code=500, content=str(e),
                        headers={"Accept-Ranges": "bytes"})

    from_bytes, until_bytes = parse_range(range_hdr, file_size)

    if from_bytes >= file_size or until_bytes >= file_size or from_bytes > until_bytes:
        return Response(
            status_code=416, content="Range Not Satisfiable",
            headers={"Content-Range": f"bytes */{file_size}", "Accept-Ranges": "bytes"},
        )

    until_bytes  = min(until_bytes, file_size - 1)
    mime_type    = get_mime_type(file_name)
    chunk_size   = _chunk_size(mime_type, file_name)

    offset         = from_bytes - (from_bytes % chunk_size)
    first_part_cut = from_bytes - offset
    last_part_cut  = (until_bytes % chunk_size) + 1
    req_length     = until_bytes - from_bytes + 1
    part_count     = math.ceil((until_bytes + 1) / chunk_size) - math.floor(offset / chunk_size)

    body = streamer.yield_file(file_id, offset, first_part_cut, last_part_cut, part_count, chunk_size)

    is_inline   = any(x in mime_type for x in ["video/", "audio/", "image/", "/html", "/pdf", "epub"])
    disposition = "inline" if is_inline else "attachment"
    is_range    = bool(range_hdr)

    etag          = f'"{message_id}-{file_size}"'
    if_none_match = request.headers.get("If-None-Match", "")
    if if_none_match == etag and not is_range:
        return Response(status_code=304,
                        headers={"ETag": etag, "Cache-Control": "public, max-age=86400"})

    headers = {
        "Content-Type":        mime_type,
        "Content-Length":      str(req_length),
        "Accept-Ranges":       "bytes",
        "Content-Disposition": f'{disposition}; filename="{quote(file_name)}"',
        "Access-Control-Allow-Origin":   "*",
        "Access-Control-Allow-Methods":  "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers":  "Range, Content-Type, Authorization",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
        "Cache-Control":       "public, max-age=86400",
        "ETag":                etag,
        "X-Accel-Buffering":   "no",   # tells nginx NOT to buffer — bytes flow straight to client
    }
    if is_range:
        headers["Content-Range"] = f"bytes {from_bytes}-{until_bytes}/{file_size}"

    return StreamingResponse(
        status_code=206 if is_range else 200,
        content=body,
        headers=headers,
        media_type=mime_type,
    )
