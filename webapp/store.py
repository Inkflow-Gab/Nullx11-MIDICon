from __future__ import annotations

import hashlib
import json
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .config import DATA_DIR, MAX_JOBS_PER_SESSION, RETENTION_DAYS, ensure_directories

TERMINAL = {"completed", "failed", "cancelled"}
ACTIVE = {"queued", "downloading", "preparing", "transcribing", "refining"}
JSON_FIELDS = {"options", "result", "waveform", "events"}


class Store:
    def __init__(self, path: Path | None = None):
        ensure_directories()
        self.path = path or DATA_DIR / "midicon.sqlite3"
        with self.connection() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL,
                    title TEXT NOT NULL, source_type TEXT NOT NULL,
                    source_url TEXT NOT NULL DEFAULT '', source_name TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'queued', progress REAL NOT NULL DEFAULT 0,
                    stage TEXT NOT NULL DEFAULT 'Waiting for an available worker',
                    detail TEXT NOT NULL DEFAULT '', error TEXT,
                    options TEXT NOT NULL, result TEXT, waveform TEXT, events TEXT NOT NULL DEFAULT '[]',
                    favorite INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL,
                    updated_at REAL NOT NULL, completed_at REAL,
                    FOREIGN KEY(owner) REFERENCES sessions(token_hash)
                );
                CREATE INDEX IF NOT EXISTS jobs_owner_created ON jobs(owner, created_at DESC);
                CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
            """)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def hash_token(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def create_session(self) -> str:
        token = secrets.token_urlsafe(32)
        with self.connection() as db:
            db.execute("INSERT INTO sessions VALUES (?, ?)", (self.hash_token(token), time.time()))
        return token

    def session_exists(self, token: str | None) -> bool:
        if not token or len(token) > 100:
            return False
        with self.connection() as db:
            return db.execute("SELECT 1 FROM sessions WHERE token_hash=?", (self.hash_token(token),)).fetchone() is not None

    @staticmethod
    def decode(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        result = dict(row)
        for key in JSON_FIELDS:
            result[key] = json.loads(result[key]) if result[key] else None
        result["favorite"] = bool(result["favorite"])
        result["has_audio"] = bool(result.get("has_audio", 0))
        result.pop("owner", None)
        return result

    def create_job(self, owner: str, *, title: str, source_type: str, options: dict, source_url: str = "", source_name: str = "") -> dict:
        job_id = uuid.uuid4().hex
        now = time.time()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            count = db.execute("SELECT COUNT(*) FROM jobs WHERE owner=?", (owner,)).fetchone()[0]
            if count >= MAX_JOBS_PER_SESSION:
                raise ValueError("Your library is full. Delete older conversions to make room.")
            active = db.execute("SELECT COUNT(*) FROM jobs WHERE owner=? AND status IN ('queued','downloading','preparing','transcribing','refining')", (owner,)).fetchone()[0]
            if active >= 3:
                raise ValueError("You already have three conversions in progress. Let one finish or cancel it first.")
            db.execute("""INSERT INTO jobs(id,owner,title,source_type,source_url,source_name,options,created_at,updated_at,events)
                VALUES (?,?,?,?,?,?,?,?,?,?)""", (job_id, owner, title[:160], source_type, source_url, source_name[:240], json.dumps(options), now, now,
                json.dumps([{"time": now, "message": "Added to your conversion queue"}])))
        (DATA_DIR / "jobs" / job_id).mkdir(parents=True, exist_ok=True)
        return self.get_job(owner, job_id)  # type: ignore[return-value]

    def get_job(self, owner: str, job_id: str) -> dict | None:
        with self.connection() as db:
            row = db.execute("SELECT j.*, EXISTS(SELECT 1 FROM jobs AS active WHERE active.id=j.id) AS present FROM jobs j WHERE j.id=? AND j.owner=?", (job_id, owner)).fetchone()
        job = self.decode(row)
        if job:
            job.pop("present", None)
            job["has_audio"] = (self.job_dir(job_id) / "audio.wav").exists()
            job["queue_position"] = self.queue_position(job_id) if job["status"] == "queued" else 0
        return job

    def list_jobs(self, owner: str) -> list[dict]:
        with self.connection() as db:
            rows = db.execute("SELECT * FROM jobs WHERE owner=? ORDER BY created_at DESC", (owner,)).fetchall()
        jobs = [self.decode(row) for row in rows]
        for job in jobs:
            job["has_audio"] = (self.job_dir(job["id"]) / "audio.wav").exists()
            job["queue_position"] = self.queue_position(job["id"]) if job["status"] == "queued" else 0
        return jobs

    def queue_position(self, job_id: str) -> int:
        with self.connection() as db:
            row = db.execute("SELECT created_at FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                return 0
            return db.execute("SELECT COUNT(*) FROM jobs WHERE status='queued' AND created_at<=?", (row["created_at"],)).fetchone()[0]

    def update(self, job_id: str, **values) -> None:
        for key in JSON_FIELDS:
            if key in values and not isinstance(values[key], str):
                values[key] = json.dumps(values[key])
        if "favorite" in values:
            values["favorite"] = int(values["favorite"])
        values["updated_at"] = time.time()
        with self.connection() as db:
            db.execute(f"UPDATE jobs SET {','.join(key+'=?' for key in values)} WHERE id=?", (*values.values(), job_id))

    def progress(self, job_id: str, status: str, progress: float, stage: str, detail: str = "", *, event: bool = False) -> None:
        with self.connection() as db:
            row = db.execute("SELECT status,events FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row or row["status"] in TERMINAL:
                return
            now = time.time()
            values = {"status": status, "progress": min(99, max(0, progress)), "stage": stage, "detail": detail, "updated_at": now}
            if event:
                events = json.loads(row["events"])
                events.append({"time": now, "message": stage})
                values["events"] = json.dumps(events[-30:])
            db.execute(f"UPDATE jobs SET {','.join(key+'=?' for key in values)} WHERE id=?", (*values.values(), job_id))

    def finish(self, job_id: str, status: str, **values) -> None:
        with self.connection() as db:
            row = db.execute("SELECT status,events FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row or row["status"] in TERMINAL:
                return
            now = time.time()
            for key in JSON_FIELDS:
                if key in values:
                    values[key] = json.dumps(values[key])
            events = json.loads(row["events"])
            events.append({"time": now, "message": "Transcription ready" if status == "completed" else "Conversion cancelled" if status == "cancelled" else "Conversion needs attention"})
            values.update(status=status, updated_at=now, completed_at=now, events=json.dumps(events[-30:]))
            if status == "completed":
                values["progress"] = 100
                values["stage"] = "Your MIDI is ready"
                values["detail"] = "Saved to your private library"
                values["error"] = None
            db.execute(f"UPDATE jobs SET {','.join(key+'=?' for key in values)} WHERE id=?", (*values.values(), job_id))

    def patch(self, owner: str, job_id: str, values: dict) -> dict | None:
        values = {key: value for key, value in values.items() if value is not None}
        if values:
            with self.connection() as db:
                db.execute(f"UPDATE jobs SET {','.join(key+'=?' for key in values)},updated_at=? WHERE id=? AND owner=?", (*values.values(), time.time(), job_id, owner))
        return self.get_job(owner, job_id)

    def delete_job(self, owner: str, job_id: str) -> bool:
        with self.connection() as db:
            cursor = db.execute("DELETE FROM jobs WHERE id=? AND owner=? AND status NOT IN ('queued','downloading','preparing','transcribing','refining')", (job_id, owner))
            return cursor.rowcount > 0

    def clear_history(self, owner: str) -> list[str]:
        with self.connection() as db:
            rows = db.execute("SELECT id,status FROM jobs WHERE owner=?", (owner,)).fetchall()
            removable = [row["id"] for row in rows if row["status"] in TERMINAL]
            db.executemany("DELETE FROM jobs WHERE id=? AND owner=?", [(job_id, owner) for job_id in removable])
        return removable

    def interrupt_unfinished(self) -> None:
        with self.connection() as db:
            db.execute("UPDATE jobs SET status='failed',error='The server restarted before this conversion finished. Use Retry to run it again.',stage='Interrupted by a server restart',updated_at=? WHERE status IN ('queued','downloading','preparing','transcribing','refining')", (time.time(),))

    def expired_jobs(self) -> list[str]:
        with self.connection() as db:
            rows = db.execute("SELECT id FROM jobs WHERE created_at<? AND status IN ('completed','failed','cancelled')", (time.time() - RETENTION_DAYS * 86400,)).fetchall()
        return [row["id"] for row in rows]

    def remove_expired(self, job_id: str) -> None:
        with self.connection() as db:
            db.execute("DELETE FROM jobs WHERE id=? AND status IN ('completed','failed','cancelled') AND created_at<?", (job_id, time.time() - RETENTION_DAYS * 86400))

    @staticmethod
    def job_dir(job_id: str) -> Path:
        if len(job_id) != 32 or any(c not in "0123456789abcdef" for c in job_id):
            raise ValueError("Invalid job ID")
        return DATA_DIR / "jobs" / job_id
