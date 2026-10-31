from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("MIDICON_DATA_DIR", ROOT / ".web-data")).resolve()
MODEL_DIR = Path(os.environ.get("MIDICON_MODEL_DIR", DATA_DIR / "models" / "kong-piano")).resolve()
MAX_UPLOAD_BYTES = int(os.environ.get("MIDICON_MAX_UPLOAD_MB", "100")) * 1024 * 1024
MAX_DURATION_SECONDS = float(os.environ.get("MIDICON_MAX_DURATION_SECONDS", "600"))
RETENTION_DAYS = int(os.environ.get("MIDICON_RETENTION_DAYS", "7"))
SESSION_DAYS = int(os.environ.get("MIDICON_SESSION_DAYS", "180"))
MAX_JOBS_PER_SESSION = int(os.environ.get("MIDICON_MAX_JOBS", "100"))
INFERENCE_THREADS = int(os.environ.get("MIDICON_INFERENCE_THREADS", "2"))
ALLOW_YOUTUBE = os.environ.get("MIDICON_ALLOW_YOUTUBE", "1") != "0"
COOKIE_NAME = "midicon_workspace"
SUPPORTED_EXTENSIONS = {".mp3", ".wav", ".m4a", ".mp4", ".flac", ".ogg", ".opus", ".aac", ".webm", ".aiff", ".aif", ".mov", ".wma"}


def ensure_directories() -> None:
    for path in (DATA_DIR, DATA_DIR / "jobs", MODEL_DIR):
        path.mkdir(parents=True, exist_ok=True)
