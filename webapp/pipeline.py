from __future__ import annotations

import json
import logging
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor

from .audio import AudioError, Cancelled, normalize_audio, probe_duration, waveform_peaks
from .config import MAX_DURATION_SECONDS, MAX_UPLOAD_BYTES
from .midi import estimate_music, export_midi, refine_notes, result_metadata
from .models import TranscriptionOptions
from .store import Store
from .transcription import transcribe
from .youtube import download_youtube

log = logging.getLogger("midicon")


class Pipeline:
    def __init__(self, store: Store):
        self.store = store
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="midicon-transcription")
        self.cancellations: dict[str, threading.Event] = {}
        self.lock = threading.Lock()

    def submit(self, job_id: str, *, refinement_from: str | None = None) -> None:
        with self.lock:
            self.cancellations[job_id] = threading.Event()
        self.executor.submit(self.run, job_id, refinement_from)

    def cancel(self, job_id: str) -> None:
        with self.lock:
            event = self.cancellations.get(job_id)
        if event:
            event.set()
        self.store.finish(job_id, "cancelled", stage="Conversion cancelled", detail="You can retry this conversion anytime.", error=None)

    def run(self, job_id: str, refinement_from: str | None = None) -> None:
        with self.lock:
            event = self.cancellations.setdefault(job_id, threading.Event())
        job = None
        directory = self.store.job_dir(job_id)
        try:
            with self.store.connection() as db:
                row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
                job = self.store.decode(row)
            if not job or event.is_set():
                return
            options = TranscriptionOptions(**job["options"])
            def check():
                return event.is_set()
            def progress(status, value, stage, detail="", log_event=False):
                if check():
                    raise Cancelled()
                self.store.progress(job_id, status, value, stage, detail, event=log_event)

            source = directory / "audio.wav"
            if refinement_from:
                origin = self.store.job_dir(refinement_from)
                if not (origin / "audio.wav").exists() or not (origin / "raw_notes.json").exists():
                    raise ValueError("The original audio or notes are no longer available. Please upload the song again.")
                if not source.exists():
                    shutil.copy2(origin / "audio.wav", source)
                if not (directory / "preview.m4a").exists() and (origin / "preview.m4a").exists():
                    shutil.copy2(origin / "preview.m4a", directory / "preview.m4a")
                raw_notes = json.loads((origin / "raw_notes.json").read_text())
                duration = probe_duration(source)
                engine = job["options"]["engine"]
                if engine == "auto":
                    from .transcription import choose_engine
                    engine = choose_engine("auto")
                progress("refining", 88, "Applying your note settings…", "Reusing the original neural analysis", True)
            elif source.exists() and probe_duration(source) > 0.15:
                progress("preparing", 24, "Reusing your prepared audio", "The original recording is still in your library", True)
            else:
                if job["source_type"] == "youtube":
                    for partial in directory.glob("youtube.*"):
                        partial.unlink(missing_ok=True)
                    source, title = download_youtube(job["source_url"], directory, lambda status, value, detail: progress(status, value, "Fetching YouTube audio" if status == "downloading" else "Extracting audio", detail, status == "preparing"), check)
                    with self.store.connection() as db:
                        db.execute("UPDATE jobs SET title=? WHERE id=?", (title, job_id))
                elif job["source_type"] == "demo":
                    from pathlib import Path
                    source = Path(__file__).parent / "assets" / "demo.wav"
                    if not source.exists():
                        raise ValueError("The demo is not installed. Run python scripts/create_demo.py.")
                else:
                    candidates = list(directory.glob("upload.*"))
                    if not candidates:
                        raise ValueError("The upload is missing. Please add the file again.")
                    source = candidates[0]
                if check():
                    raise Cancelled()
                progress("preparing", 25, "Preparing your audio", "Decoding, checking the waveform, and building your preview", True)
                total_duration = probe_duration(source)
                remaining = min(MAX_DURATION_SECONDS, max(0, total_duration - options.start_seconds))
                length = min(options.duration_seconds or remaining, remaining)
                source, duration = normalize_audio(source, directory, start=options.start_seconds, duration=length, cancelled=check)
                if job["source_type"] != "demo":
                    for uploaded in directory.glob("upload.*"):
                        uploaded.unlink(missing_ok=True)
                    for downloaded in directory.glob("youtube.*"):
                        downloaded.unlink(missing_ok=True)
                raw_notes, engine = transcribe(source, options, lambda value, detail: progress("transcribing", 31 + value * 56, "Listening for every note", detail), check)
                if check():
                    raise Cancelled()
                (directory / "raw_notes.json").write_text(json.dumps(raw_notes))
            progress("refining", 89, "Putting the notes together", "Estimating tempo and key, cleaning note boundaries", True)
            tempo, key = estimate_music(source, raw_notes)
            if options.tempo:
                tempo = float(options.tempo)
            notes, stats = refine_notes(raw_notes, options, tempo)
            if not notes:
                raise AudioError("No confident piano notes were found. Try a cleaner recording, raise note sensitivity, or choose the Polyphonic engine.")
            if check():
                raise Cancelled()
            progress("refining", 96, "Creating your MIDI", "Adding dynamics and saving your downloadable files")
            result = result_metadata(notes, duration, tempo, key, engine, stats)
            export_midi(notes, directory / "transcription.mid", tempo=tempo, options=options, title=job["title"])
            (directory / "notes.json").write_text(json.dumps(notes))
            waveform = waveform_peaks(source)
            self.store.finish(job_id, "completed", result=result, waveform=waveform)
        except Cancelled:
            self.store.finish(job_id, "cancelled", stage="Conversion cancelled", detail="Your input is still here. Retry whenever you're ready.")
        except (AudioError, ValueError) as exc:
            self.store.finish(job_id, "failed", stage="Let's give that another try", detail="Your input is still here. Adjust the settings and retry.", error=str(exc))
        except MemoryError:
            self.store.finish(job_id, "failed", stage="This recording needs more memory", error="Try a shorter clip using the trim controls, then retry.")
        except Exception:
            log.exception("Conversion %s failed", job_id)
            self.store.finish(job_id, "failed", stage="Something interrupted the conversion", error="The transcription engine couldn't finish. Try a shorter WAV or MP3, or choose the other engine. No MIDI was created.")
        finally:
            with self.lock:
                self.cancellations.pop(job_id, None)

    def shutdown(self) -> None:
        with self.lock:
            for event in self.cancellations.values():
                event.set()
        self.executor.shutdown(wait=False, cancel_futures=True)
