"""
HLS Output Session Manager
Manages FFmpeg processes that transcode TS streams to HLS format.
Each session reads from the internal TS proxy and outputs M3U8+segments.
"""

import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

logger = logging.getLogger("hls_proxy")

# Base temp directory for all HLS output sessions
HLS_OUTPUT_BASE = os.path.join(tempfile.gettempdir(), "dispatcharr_hls")

# How long a session can go without a heartbeat before being reaped (seconds)
STALE_SESSION_TIMEOUT = 30

# How often to check for stale sessions (seconds)
CLEANUP_INTERVAL = 10

# Default internal server port
DEFAULT_SERVER_PORT = 9191


def _get_server_port():
    """Get the port the Django server is listening on."""
    port = os.environ.get("GUNICORN_PORT", str(DEFAULT_SERVER_PORT))
    try:
        return int(port)
    except (ValueError, TypeError):
        return DEFAULT_SERVER_PORT


class HLSSession:
    """
    Manages a single FFmpeg process that reads a TS stream from the internal
    proxy and outputs HLS segments + playlist to a temp directory.
    """

    def __init__(self, channel_id):
        self.session_id = str(uuid.uuid4())[:12]
        self.channel_id = channel_id
        self.output_dir = os.path.join(HLS_OUTPUT_BASE, self.session_id)
        self.playlist_path = os.path.join(self.output_dir, "stream.m3u8")
        self.process = None
        self.created_at = time.time()
        self.last_heartbeat = time.time()
        self._lock = threading.Lock()

        os.makedirs(self.output_dir, exist_ok=True)

    def start(self):
        """Launch the FFmpeg process to transcode TS → HLS."""
        port = _get_server_port()
        source_url = f"http://127.0.0.1:{port}/proxy/ts/stream/{self.channel_id}"
        segment_pattern = os.path.join(self.output_dir, "seg_%05d.ts")

        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "warning",
            # Input from internal TS proxy
            "-i", source_url,
            # Video: copy (no re-encode)
            "-c:v", "copy",
            # Audio: transcode to AAC stereo 128k
            "-c:a", "aac",
            "-b:a", "128k",
            "-ac", "2",
            # HLS output format
            "-f", "hls",
            "-hls_time", "6",
            "-hls_list_size", "10",
            "-hls_flags", "delete_segments+append_list",
            "-hls_segment_filename", segment_pattern,
            self.playlist_path,
        ]

        logger.info(
            f"[HLS:{self.session_id}] Starting FFmpeg for channel {self.channel_id}: "
            f"{' '.join(cmd)}"
        )

        self.process = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )

        # Start a stderr reader thread for logging
        threading.Thread(
            target=self._read_stderr, daemon=True, name=f"hls-stderr-{self.session_id}"
        ).start()

    def _read_stderr(self):
        """Read FFmpeg stderr and log it."""
        try:
            for line in self.process.stderr:
                text = line.decode("utf-8", errors="ignore").strip()
                if text:
                    logger.debug(f"[HLS:{self.session_id}] FFmpeg: {text}")
        except Exception as e:
            logger.debug(f"[HLS:{self.session_id}] stderr reader error: {e}")

    def heartbeat(self):
        """Record client activity."""
        self.last_heartbeat = time.time()

    def is_stale(self):
        """Check if this session has had no client activity recently."""
        return time.time() - self.last_heartbeat > STALE_SESSION_TIMEOUT

    def is_running(self):
        """Check if the FFmpeg process is still alive."""
        return self.process is not None and self.process.poll() is None

    def playlist_ready(self):
        """Check if the M3U8 playlist file exists and has content."""
        return os.path.exists(self.playlist_path) and os.path.getsize(self.playlist_path) > 0

    def read_playlist(self):
        """Read the current M3U8 playlist content."""
        try:
            with open(self.playlist_path, "r") as f:
                return f.read()
        except (FileNotFoundError, IOError):
            return None

    def get_segment_path(self, filename):
        """Get the full path to a segment file, with safety checks."""
        # Prevent directory traversal
        safe_name = os.path.basename(filename)
        path = os.path.join(self.output_dir, safe_name)
        if os.path.exists(path) and path.startswith(self.output_dir):
            return path
        return None

    def stop(self):
        """Kill the FFmpeg process and clean up temp files."""
        with self._lock:
            if self.process and self.process.poll() is None:
                logger.info(f"[HLS:{self.session_id}] Stopping FFmpeg for channel {self.channel_id}")
                try:
                    self.process.terminate()
                    try:
                        self.process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self.process.kill()
                        self.process.wait(timeout=2)
                except Exception as e:
                    logger.warning(f"[HLS:{self.session_id}] Error stopping FFmpeg: {e}")
                self.process = None

            # Clean up temp directory
            if os.path.exists(self.output_dir):
                try:
                    shutil.rmtree(self.output_dir)
                    logger.info(f"[HLS:{self.session_id}] Cleaned up output dir: {self.output_dir}")
                except Exception as e:
                    logger.warning(f"[HLS:{self.session_id}] Error cleaning up: {e}")


class HLSSessionManager:
    """
    Thread-safe singleton that manages all HLS output sessions.
    Runs a background cleanup thread to reap stale sessions.
    """

    _instance = None
    _lock = threading.Lock()

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def __init__(self):
        self._sessions = {}  # session_id -> HLSSession
        self._channel_sessions = {}  # channel_id -> session_id
        self._sessions_lock = threading.Lock()
        self._cleanup_thread = None
        self._running = True
        self._start_cleanup_thread()

    def _start_cleanup_thread(self):
        """Start background thread to reap stale sessions."""
        self._cleanup_thread = threading.Thread(
            target=self._cleanup_loop, daemon=True, name="hls-session-cleanup"
        )
        self._cleanup_thread.start()

    def _cleanup_loop(self):
        """Periodically check for and remove stale sessions."""
        while self._running:
            try:
                self.cleanup_stale_sessions()
            except Exception as e:
                logger.error(f"Error in HLS session cleanup: {e}")
            time.sleep(CLEANUP_INTERVAL)

    def get_or_create_session(self, channel_id):
        """
        Get an existing session for a channel, or create a new one.
        Returns the HLSSession.
        """
        with self._sessions_lock:
            # Check for existing session
            existing_id = self._channel_sessions.get(channel_id)
            if existing_id and existing_id in self._sessions:
                session = self._sessions[existing_id]
                if session.is_running():
                    session.heartbeat()
                    return session
                else:
                    # Process died — clean up and recreate
                    logger.warning(
                        f"[HLS] Existing session {existing_id} for channel {channel_id} "
                        f"is no longer running, recreating"
                    )
                    session.stop()
                    del self._sessions[existing_id]

            # Create new session
            session = HLSSession(channel_id)
            session.start()
            self._sessions[session.session_id] = session
            self._channel_sessions[channel_id] = session.session_id
            logger.info(
                f"[HLS] Created session {session.session_id} for channel {channel_id}"
            )
            return session

    def get_session(self, session_id):
        """Get a session by ID."""
        return self._sessions.get(session_id)

    def heartbeat(self, session_id):
        """Update last_heartbeat for a session."""
        session = self._sessions.get(session_id)
        if session:
            session.heartbeat()

    def stop_session(self, session_id):
        """Stop and remove a specific session."""
        with self._sessions_lock:
            session = self._sessions.pop(session_id, None)
            if session:
                # Remove channel mapping
                if self._channel_sessions.get(session.channel_id) == session_id:
                    del self._channel_sessions[session.channel_id]
                session.stop()

    def cleanup_stale_sessions(self):
        """Remove sessions with no recent heartbeat."""
        stale_ids = []
        with self._sessions_lock:
            for sid, session in self._sessions.items():
                if session.is_stale() or not session.is_running():
                    reason = "stale" if session.is_stale() else "process exited"
                    logger.info(
                        f"[HLS] Reaping session {sid} for channel {session.channel_id} "
                        f"(reason: {reason})"
                    )
                    stale_ids.append(sid)

        for sid in stale_ids:
            self.stop_session(sid)

    def shutdown(self):
        """Stop all sessions and the cleanup thread."""
        self._running = False
        with self._sessions_lock:
            for sid in list(self._sessions.keys()):
                session = self._sessions.pop(sid, None)
                if session:
                    session.stop()
            self._channel_sessions.clear()
        logger.info("[HLS] Session manager shut down")
