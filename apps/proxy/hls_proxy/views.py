"""
HLS Output Proxy Views
Serves HLS (M3U8 + segments) by transcoding from the internal TS proxy.
"""

import logging
import re
import time

from django.http import (
    FileResponse,
    HttpResponse,
    JsonResponse,
    StreamingHttpResponse,
)
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from apps.proxy.ts_proxy.url_utils import get_stream_object
from dispatcharr.utils import network_access_allowed

from .session_manager import HLSSessionManager

logger = logging.getLogger("hls_proxy")

# Max seconds to wait for FFmpeg to produce the initial M3U8
PLAYLIST_WAIT_TIMEOUT = 15
PLAYLIST_POLL_INTERVAL = 0.3


@csrf_exempt
@require_http_methods(["GET"])
def stream_hls(request, channel_id):
    """
    Main HLS endpoint.  Returns the live M3U8 playlist for a channel.

    Flow:
    1. Validates the channel UUID (same as stream_ts)
    2. Gets or creates an HLS session (which launches FFmpeg reading from
       the internal TS proxy at /proxy/ts/stream/<uuid>)
    3. Waits for the M3U8 playlist to be created on disk
    4. Returns the playlist with segment URLs rewritten to point at our
       segment-serving endpoint
    """
    if not network_access_allowed(request, "STREAMS"):
        return JsonResponse({"error": "Forbidden"}, status=403)

    # Validate channel exists
    try:
        channel = get_stream_object(channel_id)
    except Exception:
        return JsonResponse({"error": "Channel not found"}, status=404)

    if channel is None:
        return JsonResponse({"error": "Channel not found"}, status=404)

    # Get or create the HLS session for this channel
    manager = HLSSessionManager.get_instance()
    session = manager.get_or_create_session(channel_id)

    # Wait for the playlist to appear (FFmpeg needs time to fetch first segments)
    start = time.time()
    while time.time() - start < PLAYLIST_WAIT_TIMEOUT:
        if session.playlist_ready():
            break
        if not session.is_running():
            logger.error(
                f"[HLS] FFmpeg process died for session {session.session_id}, "
                f"channel {channel_id}"
            )
            manager.stop_session(session.session_id)
            return JsonResponse(
                {"error": "Failed to start HLS stream (FFmpeg exited)"},
                status=502,
            )
        time.sleep(PLAYLIST_POLL_INTERVAL)
    else:
        logger.error(
            f"[HLS] Timeout waiting for playlist for session {session.session_id}, "
            f"channel {channel_id}"
        )
        manager.stop_session(session.session_id)
        return JsonResponse(
            {"error": "Timeout waiting for HLS stream to initialize"},
            status=504,
        )

    # Read playlist and rewrite segment URLs
    playlist = session.read_playlist()
    if not playlist:
        return JsonResponse({"error": "Playlist unavailable"}, status=500)

    # Rewrite local filenames (e.g. seg_00001.ts) to absolute URLs
    # pointing at our segment endpoint
    base_url = request.build_absolute_uri(f"/proxy/hls/segments/{session.session_id}/")
    rewritten = _rewrite_playlist(playlist, base_url)

    session.heartbeat()

    response = HttpResponse(rewritten, content_type="application/vnd.apple.mpegurl")
    response["Cache-Control"] = "no-cache, no-store"
    response["Access-Control-Allow-Origin"] = "*"
    return response


@csrf_exempt
@require_http_methods(["GET"])
def serve_segment(request, session_id, filename):
    """
    Serve an individual HLS .ts segment file.
    Also acts as a heartbeat — each segment fetch keeps the session alive.
    """
    manager = HLSSessionManager.get_instance()
    session = manager.get_session(session_id)

    if not session:
        return JsonResponse({"error": "Session not found"}, status=404)

    segment_path = session.get_segment_path(filename)
    if not segment_path:
        return JsonResponse({"error": "Segment not found"}, status=404)

    # Record heartbeat — this segment fetch proves a client is still watching
    session.heartbeat()

    response = FileResponse(
        open(segment_path, "rb"),
        content_type="video/MP2T",
    )
    response["Cache-Control"] = "no-cache"
    response["Access-Control-Allow-Origin"] = "*"
    return response


def _rewrite_playlist(playlist_content, base_url):
    """
    Rewrite segment filenames in an M3U8 playlist to absolute URLs.

    FFmpeg writes lines like:
        seg_00001.ts
    We rewrite them to:
        http://host:port/proxy/hls/segments/<session_id>/seg_00001.ts
    """
    lines = playlist_content.splitlines()
    rewritten = []
    for line in lines:
        stripped = line.strip()
        # Lines that are segment filenames (not comments/directives)
        if stripped and not stripped.startswith("#"):
            # This is a segment filename — prepend our base URL
            rewritten.append(base_url + stripped)
        else:
            rewritten.append(line)
    return "\n".join(rewritten) + "\n"