from __future__ import annotations

import ipaddress
import re
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, urlsplit

from .audio import Cancelled
from .config import ALLOW_YOUTUBE, MAX_DURATION_SECONDS, MAX_UPLOAD_BYTES

HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"}


def validate_youtube_url(value: str) -> str:
    if not ALLOW_YOUTUBE:
        raise ValueError("YouTube imports are disabled on this server. Please upload an audio file.")
    try:
        url = urlsplit(value.strip())
        port = url.port
    except ValueError as exc:
        raise ValueError("That doesn't look like a valid YouTube link.") from exc
    if url.scheme not in {"http", "https"} or url.hostname not in HOSTS or url.username or url.password or port not in {None, 80, 443}:
        raise ValueError("Use a public youtube.com or youtu.be link, not a playlist page or another website.")
    video_id = parse_qs(url.query).get("v", [""])[0] if url.hostname != "youtu.be" else url.path.strip("/").split("/")[0]
    if not video_id and url.path.startswith(("/shorts/", "/live/", "/embed/")):
        video_id = url.path.split("/")[2]
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise ValueError("Paste a link to one YouTube video. Playlist-only and channel links aren't supported.")
    return f"https://www.youtube.com/watch?v={video_id}"


def download_youtube(value: str, directory: Path, progress: Callable[[str, float, str], None], cancelled: Callable[[], bool]) -> tuple[Path, str]:
    url = validate_youtube_url(value)
    try:
        from yt_dlp import YoutubeDL
        from yt_dlp.utils import DownloadError, DownloadCancelled
    except ImportError as exc:
        raise ValueError("YouTube support isn't installed on this server. Upload the audio instead.") from exc

    def check():
        if cancelled():
            raise DownloadCancelled("Conversion cancelled")

    def hook(data):
        check()
        if data["status"] == "downloading":
            total = data.get("total_bytes") or data.get("total_bytes_estimate")
            fraction = min(1, data.get("downloaded_bytes", 0) / total) if total else 0
            speed = data.get("speed") or 0
            detail = f"{data.get('downloaded_bytes', 0) / 1e6:.1f} MB downloaded"
            if speed:
                detail += f" · {speed / 1e6:.1f} MB/s"
            progress("downloading", 3 + fraction * 15, detail)
        elif data["status"] == "finished":
            progress("preparing", 19, "Download complete. Extracting the audio…")

    def post_hook(data):
        check()
        if data["status"] == "finished":
            progress("preparing", 23, "Audio extracted. Preparing your transcription…")

    options = {
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "outtmpl": str(directory / "youtube.%(ext)s"),
        "noplaylist": True, "playlist_items": "1", "quiet": True, "no_warnings": True,
        "socket_timeout": 20, "retries": 2, "extractor_retries": 2,
        "max_filesize": MAX_UPLOAD_BYTES, "concurrent_fragment_downloads": 1,
        "progress_hooks": [hook], "postprocessor_hooks": [post_hook],
        "js_runtimes": {"node": {}},
        "match_filter": lambda info, incomplete: "Live streams aren't supported. Use a finished video." if info.get("is_live") else None,
        "allowed_extractors": ["youtube", "youtube:.*"],
    }
    try:
        progress("downloading", 3, "Connecting to YouTube and finding the audio stream…")
        with YoutubeDL(options) as client:
            info = client.extract_info(url, download=False)
            check()
            duration = float(info.get("duration") or 0)
            if duration > MAX_DURATION_SECONDS:
                raise ValueError(f"This video is longer than {MAX_DURATION_SECONDS / 60:.0f} minutes. Download it and upload a shorter audio clip.")
            title = str(info.get("title") or "YouTube transcription")[:160]
            progress("downloading", 5, title)
            client.download([url])
        check()
        files = [path for path in directory.glob("youtube.*") if path.is_file() and not path.name.endswith((".part", ".ytdl", ".json"))]
        if not files:
            raise ValueError("YouTube returned no audio file. Please try uploading the audio directly.")
        return max(files, key=lambda path: path.stat().st_size), title
    except (DownloadError, DownloadCancelled) as exc:
        if cancelled():
            raise Cancelled() from exc
        message = str(exc).lower()
        if any(word in message for word in ("sign in", "bot", "captcha", "cookies")):
            raise ValueError("YouTube is asking this server to verify it's human. We don't bypass that check. Download audio you have permission to use, then upload it here.")
        if any(word in message for word in ("private", "unavailable", "removed", "copyright", "members-only")):
            raise ValueError("This video isn't publicly available. Check the link, or upload an audio file you have permission to use.")
        if any(word in message for word in ("resolve", "timed out", "connection", "network", "ssl", "403")):
            raise ValueError("The server couldn't reach YouTube. Its network may restrict YouTube access. Your upload workflow still works—try an MP3, M4A, or WAV instead.")
        raise ValueError("YouTube couldn't provide this audio. Try another public video, or upload the file directly.") from exc
