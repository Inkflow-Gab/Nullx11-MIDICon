from __future__ import annotations

import asyncio
import io
import json
import logging
import re
import shutil
import time
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from .audio import ffmpeg_binary
from .config import COOKIE_NAME, DATA_DIR, MAX_DURATION_SECONDS, MAX_JOBS_PER_SESSION, MAX_UPLOAD_BYTES, RETENTION_DAYS, ROOT, SESSION_DAYS, SUPPORTED_EXTENSIONS, ensure_directories
from .midi import export_midi, export_notes, normalize_edited_notes
from .models import DemoRequest, EditRequest, JobPatch, RefineRequest, TranscriptionOptions, YouTubeRequest
from .pipeline import Pipeline
from .store import ACTIVE, Store
from .transcription import available_engines
from .youtube import validate_youtube_url

log = logging.getLogger("midicon")
store = Store()
pipeline = Pipeline(store)


def remove_files(job_id: str) -> None:
    directory = store.job_dir(job_id)
    if directory.parent == DATA_DIR / "jobs":
        shutil.rmtree(directory, ignore_errors=True)


def cleanup_expired() -> None:
    for job_id in store.expired_jobs():
        store.remove_expired(job_id)
        if not store.job_dir(job_id).exists():
            continue
        with store.connection() as db:
            exists = db.execute("SELECT 1 FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not exists:
            remove_files(job_id)


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_directories()
    store.interrupt_unfinished()
    cleanup_expired()
    async def periodic_cleanup():
        while True:
            await asyncio.sleep(3600)
            await asyncio.to_thread(cleanup_expired)
    task = asyncio.create_task(periodic_cleanup())
    yield
    task.cancel()
    pipeline.shutdown()


app = FastAPI(title="Nullx MIDICon", version="1.0.0", lifespan=lifespan, docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.method not in {"GET", "HEAD", "OPTIONS"}:
        if request.headers.get("x-midicon-client") != "web":
            return JSONResponse({"detail": "Open the MIDICon studio to make changes."}, status_code=403)
        origin = request.headers.get("origin")
        if origin:
            expected = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
            try:
                allowed = urlsplit(origin).netloc.lower() == expected.split(",")[0].strip().lower()
            except ValueError:
                allowed = False
            if not allowed:
                return JSONResponse({"detail": "Cross-origin changes are not allowed."}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(ValueError)
async def value_error(request: Request, exc: ValueError):
    return JSONResponse({"detail": str(exc)}, status_code=422)


@app.exception_handler(ValidationError)
async def validation_error(request: Request, exc: ValidationError):
    errors = exc.errors()
    message = errors[0].get("msg", "Please check your settings.") if errors else "Please check your settings."
    return JSONResponse({"detail": message.removeprefix("Value error, ")}, status_code=422)


def owner_for(request: Request) -> str:
    token = request.cookies.get(COOKIE_NAME)
    if not store.session_exists(token):
        raise HTTPException(401, "Your workspace session expired. Refresh the page to start a new workspace.")
    return store.hash_token(token)


def require_job(request: Request, job_id: str) -> dict:
    job = store.get_job(owner_for(request), job_id)
    if not job:
        raise HTTPException(404, "This conversion isn't in your workspace.")
    return job


def set_cookie(request: Request, response: Response, token: str) -> None:
    secure = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip() == "https"
    response.set_cookie(COOKIE_NAME, token, max_age=SESSION_DAYS * 86400, httponly=True, secure=secure, samesite="lax", path="/")


@app.get("/api/health")
def health():
    engines = available_engines()
    from importlib.util import find_spec
    from .config import ALLOW_YOUTUBE
    payload = {"status": "ready" if engines else "setup_required", "engines": engines, "inference": "onnx-cpu", "youtube_configured": ALLOW_YOUTUBE and find_spec("yt_dlp") is not None}
    return JSONResponse(payload, status_code=200 if engines else 503)


@app.get("/api/session")
def session(request: Request, response: Response):
    token = request.cookies.get(COOKIE_NAME)
    if not store.session_exists(token):
        token = store.create_session()
        set_cookie(request, response, token)
    return {"workspace_id": store.hash_token(token)[:8], "retention_days": RETENTION_DAYS,
        "max_upload_mb": MAX_UPLOAD_BYTES // 1024 // 1024, "max_duration_seconds": MAX_DURATION_SECONDS,
        "max_jobs": MAX_JOBS_PER_SESSION, "engines": available_engines(),
        "extensions": sorted(SUPPORTED_EXTENSIONS), "scope": "browser", "authentication": "anonymous-session"}


@app.get("/api/jobs")
def list_jobs(request: Request):
    return {"jobs": store.list_jobs(owner_for(request))}


@app.post("/api/jobs", status_code=202)
async def upload(request: Request, file: UploadFile = File(...), options: str = Form("{}")):
    owner = owner_for(request)
    settings = TranscriptionOptions.model_validate_json(options)
    original_name = Path((file.filename or "audio").replace("\\", "/")).name
    extension = Path(original_name).suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise HTTPException(415, "Choose an MP3, WAV, M4A, MP4, FLAC, OGG, AAC, WEBM, or AIFF file.")
    length = request.headers.get("content-length")
    try:
        too_large = bool(length and int(length) > MAX_UPLOAD_BYTES + 1024 * 1024)
    except ValueError:
        raise HTTPException(400, "Invalid upload length.")
    if too_large:
        raise HTTPException(413, f"Please use a file smaller than {MAX_UPLOAD_BYTES // 1024 // 1024} MB.")
    title = Path(original_name).stem.replace("_", " ").strip()[:160] or "Untitled transcription"
    job = store.create_job(owner, title=title, source_type="upload", options=settings.model_dump(), source_name=original_name)
    destination = store.job_dir(job["id"]) / f"upload{extension}"
    try:
        size = 0
        with destination.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"Please use a file smaller than {MAX_UPLOAD_BYTES // 1024 // 1024} MB.")
                output.write(chunk)
        if size < 32:
            raise HTTPException(422, "This file is empty or too small to contain audio.")
        pipeline.submit(job["id"])
    except Exception:
        store.delete_job(owner, job["id"])
        remove_files(job["id"])
        raise
    finally:
        await file.close()
    return store.get_job(owner, job["id"])


@app.post("/api/jobs/youtube", status_code=202)
def youtube(body: YouTubeRequest, request: Request):
    url = validate_youtube_url(body.url)
    job = store.create_job(owner_for(request), title="YouTube transcription", source_type="youtube", source_url=url, options=body.options.model_dump())
    pipeline.submit(job["id"])
    return job


@app.post("/api/demo", status_code=202)
def demo(body: DemoRequest, request: Request):
    job = store.create_job(owner_for(request), title="Little steps · original demo", source_type="demo", source_name="little-steps.wav", options=body.options.model_dump())
    pipeline.submit(job["id"])
    return job


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, request: Request):
    return require_job(request, job_id)


@app.get("/api/jobs/{job_id}/events")
async def events(job_id: str, request: Request):
    require_job(request, job_id)
    owner = owner_for(request)
    async def stream():
        last = None
        idle = 0
        while True:
            if await request.is_disconnected():
                break
            job = await asyncio.to_thread(store.get_job, owner, job_id)
            if not job:
                break
            fingerprint = (job["status"], job["progress"], job["stage"], job["detail"], job["title"])
            if fingerprint != last:
                yield f"event: job\ndata: {json.dumps(job)}\n\n"
                last = fingerprint
                idle = 0
            if job["status"] in {"completed", "failed", "cancelled"}:
                break
            idle += 1
            if idle >= 30:
                yield ": keep-alive\n\n"
                idle = 0
            await asyncio.sleep(0.5)
    return StreamingResponse(stream(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no", "Connection": "keep-alive"})


@app.get("/api/jobs/{job_id}/notes")
def notes(job_id: str, request: Request):
    job = require_job(request, job_id)
    path = store.job_dir(job_id) / "notes.json"
    if job["status"] != "completed" or not path.exists():
        raise HTTPException(409, "The notes aren't ready yet.")
    return {"notes": json.loads(path.read_text())}


@app.patch("/api/jobs/{job_id}")
def patch_job(job_id: str, body: JobPatch, request: Request):
    require_job(request, job_id)
    return store.patch(owner_for(request), job_id, body.model_dump())


@app.post("/api/jobs/{job_id}/cancel")
def cancel(job_id: str, request: Request):
    job = require_job(request, job_id)
    if job["status"] in ACTIVE:
        pipeline.cancel(job_id)
    return store.get_job(owner_for(request), job_id)


@app.post("/api/jobs/{job_id}/retry", status_code=202)
def retry(job_id: str, request: Request, settings: TranscriptionOptions | None = None):
    owner = owner_for(request)
    job = require_job(request, job_id)
    if job["status"] not in {"failed", "cancelled"}:
        raise HTTPException(409, "Only failed or cancelled conversions can be retried. Use Refine for a completed result.")
    active = sum(item["status"] in ACTIVE for item in store.list_jobs(owner))
    if active >= 3:
        raise HTTPException(429, "Let one of your active conversions finish first.")
    directory = store.job_dir(job_id)
    if not (directory / "audio.wav").exists() and not list(directory.glob("upload.*")) and job["source_type"] not in {"youtube", "demo"}:
        raise HTTPException(409, "The source audio is no longer available. Please upload it again.")
    values = {"status": "queued", "progress": 0, "stage": "Waiting for an available worker", "detail": "", "error": None, "completed_at": None, "result": None}
    if settings:
        values["options"] = settings.model_dump()
    store.update(job_id, **values)
    pipeline.submit(job_id)
    return store.get_job(owner, job_id)


@app.post("/api/jobs/{job_id}/refine", status_code=202)
def refine(job_id: str, body: RefineRequest, request: Request):
    owner = owner_for(request)
    job = require_job(request, job_id)
    directory = store.job_dir(job_id)
    if job["status"] != "completed" or not (directory / "raw_notes.json").exists() or not (directory / "audio.wav").exists():
        raise HTTPException(409, "The original analysis isn't available. Please upload the song again.")
    original_engine = job["result"]["engine"]
    if body.options.engine not in {"auto", original_engine}:
        raise HTTPException(422, "To change the neural engine, start a new conversion. Refine adjusts the existing analysis.")
    settings = body.options.model_dump()
    settings["engine"] = original_engine
    settings["start_seconds"] = job["options"]["start_seconds"]
    settings["duration_seconds"] = job["options"]["duration_seconds"]
    title = job["title"].removesuffix(" · refined")[:145] + " · refined"
    new_job = store.create_job(owner, title=title, source_type="refined", options=settings, source_name=job["source_name"], source_url=job["source_url"])
    pipeline.submit(new_job["id"], refinement_from=job_id)
    return new_job


@app.post("/api/jobs/{job_id}/save-edit", status_code=201)
def save_edit(job_id: str, body: EditRequest, request: Request):
    owner = owner_for(request)
    job = require_job(request, job_id)
    directory = store.job_dir(job_id)
    if job["status"] != "completed" or not (directory / "notes.json").exists():
        raise HTTPException(409, "Only a completed conversion can be edited.")
    notes = normalize_edited_notes([note.model_dump() for note in body.notes])
    if not notes:
        raise HTTPException(422, "Keep at least one valid note in your edited version.")
    if max(note["end"] for note in notes) > 3600:
        raise HTTPException(422, "Edited notes must stay within one hour.")
    original_result = job["result"] or {}
    tempo = float(original_result.get("tempo") or 120)
    options = TranscriptionOptions(**job["options"])
    title = body.title or (job["title"].removesuffix(" · edited")[:145] + " · edited")
    new_job = store.create_job(owner, title=title, source_type="edited", options=options.model_dump(), source_name=job["source_name"], source_url=job["source_url"])
    new_directory = store.job_dir(new_job["id"])
    try:
        for name in ("audio.wav", "preview.m4a"):
            source = directory / name
            if source.exists():
                shutil.copy2(source, new_directory / name)
        result = {**original_result,
            "duration": max(float(original_result.get("duration") or 0), max(note["end"] for note in notes)),
            "note_count": len(notes), "raw_note_count": len(notes), "merged_notes": 0, "filtered_notes": 0,
            "lowest_pitch": min(note["pitch"] for note in notes), "highest_pitch": max(note["pitch"] for note in notes),
            "edited_from": job_id}
        export_midi(notes, new_directory / "transcription.mid", tempo=tempo, options=options, title=title)
        (new_directory / "notes.json").write_text(json.dumps(notes))
        (new_directory / "raw_notes.json").write_text(json.dumps(notes))
        store.finish(new_job["id"], "completed", result=result, waveform=job.get("waveform"))
    except Exception:
        store.delete_job(owner, new_job["id"])
        remove_files(new_job["id"])
        raise
    return store.get_job(owner, new_job["id"])


@app.get("/api/library/download")
def download_library(request: Request):
    owner = owner_for(request)
    jobs = [job for job in store.list_jobs(owner) if job["status"] == "completed"]
    if not jobs:
        raise HTTPException(409, "Convert a song first. Your library has no completed MIDI files yet.")
    buffer = io.BytesIO()
    manifest = []
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        used: set[str] = set()
        for job in jobs:
            directory = store.job_dir(job["id"])
            midi_path = directory / "transcription.mid"
            notes_path = directory / "notes.json"
            if not midi_path.exists() or not notes_path.exists():
                continue
            stem = re.sub(r"[^A-Za-z0-9_-]+", "-", job["title"]).strip("-")[:80] or "transcription"
            base = stem; suffix = 1
            while base in used:
                suffix += 1; base = f"{stem}-{suffix}"
            used.add(base)
            archive.write(midi_path, f"midi/{base}.mid")
            archive.write(notes_path, f"notes/{base}.json")
            manifest.append({"id": job["id"], "title": job["title"], "midi": f"midi/{base}.mid", "notes": f"notes/{base}.json", "result": job["result"], "options": job["options"]})
        if not manifest:
            raise HTTPException(409, "No downloadable MIDI files are available.")
        archive.writestr("manifest.json", json.dumps({"format": "nullx-midicon-library-v1", "jobs": manifest}, indent=2))
        archive.writestr("README.txt", "Nullx MIDICon library export\nEach MIDI file is an automatic estimate or a manual edit, not a verified score.\nSee manifest.json for titles, settings, tempo/key estimates, and note counts.\n")
    filename = time.strftime("midicon-library-%Y%m%d.zip", time.gmtime())
    return Response(buffer.getvalue(), media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.delete("/api/jobs/{job_id}", status_code=204)
def delete_job(job_id: str, request: Request):
    owner = owner_for(request)
    require_job(request, job_id)
    if not store.delete_job(owner, job_id):
        raise HTTPException(409, "Cancel this conversion before deleting it.")
    remove_files(job_id)
    return Response(status_code=204)


@app.delete("/api/history")
def clear_history(request: Request):
    removed = store.clear_history(owner_for(request))
    for job_id in removed:
        remove_files(job_id)
    return {"deleted": len(removed)}


@app.get("/api/jobs/{job_id}/download/{format}")
def download(job_id: str, format: str, request: Request):
    job = require_job(request, job_id)
    directory = store.job_dir(job_id)
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", job["title"]).strip("-")[:90] or "transcription"
    if format == "audio":
        path = directory / "preview.m4a"
        if not path.exists():
            raise HTTPException(404, "The audio preview isn't available yet.")
        return FileResponse(path, media_type="audio/mp4", filename=stem + ".m4a")
    if job["status"] != "completed":
        raise HTTPException(409, "Your download will be ready when the conversion finishes.")
    if format == "midi":
        return FileResponse(directory / "transcription.mid", media_type="audio/midi", filename=stem + ".mid")
    if format in {"json", "csv"}:
        notes = json.loads((directory / "notes.json").read_text())
        return Response(export_notes(notes, format), media_type="application/json" if format == "json" else "text/csv", headers={"Content-Disposition": f'attachment; filename="{stem}.{format}"'})
    if format == "zip":
        buffer = io.BytesIO()
        notes = json.loads((directory / "notes.json").read_text())
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(directory / "transcription.mid", stem + ".mid")
            archive.writestr(stem + ".json", export_notes(notes, "json"))
            archive.writestr(stem + ".csv", export_notes(notes, "csv"))
            archive.writestr("transcription-settings.json", json.dumps({"options": job["options"], "result": job["result"]}, indent=2))
            archive.writestr("README.txt", "Nullx MIDICon\nMIDI notes are an automatic estimate, not a verified score.\nTempo and key are estimates. The export meter defaults to 4/4.\nUpper/lower tracks are split at C4, not identified hand assignments.\nPiano model: Kong et al. (2020), CC BY 4.0; ONNX mirror by pratham-jain33 / Mingji Wang.\nAlternative model: Spotify Basic Pitch, Apache 2.0.\n")
        return Response(buffer.getvalue(), media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{stem}.zip"'})
    raise HTTPException(404, "Choose MIDI, JSON, CSV, or the complete ZIP package.")


# Production serves the built React app. Development uses Vite's /api proxy.
DIST = ROOT / "web" / "dist"
if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="studio")
