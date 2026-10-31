from __future__ import annotations

import gc
import threading
from pathlib import Path
from typing import Callable

import numpy as np

from .audio import Cancelled, load_audio
from .config import INFERENCE_THREADS, MODEL_DIR
from .models import TranscriptionOptions

KEYS = ("reg_onset_output", "reg_offset_output", "frame_output", "velocity_output")
Progress = Callable[[float, str], None]
_MODEL_LOCK = threading.Lock()
_PIANO_SESSION = None
_BASIC_SESSION = None
BASIC_MODEL_PATH = Path(__file__).parent / "assets" / "basic-pitch.onnx"


def piano_available() -> bool:
    return (MODEL_DIR / "model.onnx").exists() and (MODEL_DIR / "kong_notes_2s5_fp32.onnx.data").exists()


def available_engines() -> list[dict]:
    engines = []
    if piano_available():
        engines.append({"id": "piano", "name": "Piano specialist", "description": "Kong et al. · high-resolution onsets, offsets and dynamics", "ready": True})
    if BASIC_MODEL_PATH.exists():
        engines.append({"id": "basic", "name": "Polyphonic", "description": "Spotify Basic Pitch · instrument-agnostic transcription", "ready": True})
    return engines


def choose_engine(requested: str) -> str:
    ready = {engine["id"] for engine in available_engines()}
    if requested != "auto" and requested not in ready:
        raise ValueError("That transcription engine isn't installed. Run scripts/setup_web_models.py or choose an available engine.")
    if requested != "auto":
        return requested
    if "piano" in ready:
        return "piano"
    if "basic" in ready:
        return "basic"
    raise ValueError("No transcription model is installed. Run python scripts/setup_web_models.py, then restart the server.")


def _piano_session():
    global _PIANO_SESSION
    with _MODEL_LOCK:
        if _PIANO_SESSION is None:
            import onnxruntime as ort
            options = ort.SessionOptions()
            options.intra_op_num_threads = INFERENCE_THREADS
            options.inter_op_num_threads = 1
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
            options.add_session_config_entry("session.intra_op.allow_spinning", "0")
            _PIANO_SESSION = ort.InferenceSession(str(MODEL_DIR / "model.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
        return _PIANO_SESSION


def piano_transcribe(path: Path, options: TranscriptionOptions, progress: Progress, cancelled: Callable[[], bool]) -> list[dict]:
    """50% overlapping windows, cross-faded in probability space before decoding.

    Unlike decoding non-overlapping chunks, this retains note boundaries and
    sustain across windows. The fixed 2.5-second export has 251 output frames;
    its extra tail frame is discarded to keep exactly 100 frames per second.
    """
    from .vendor.kong_postprocessing import RegressionPostProcessor

    audio = load_audio(path, 16000)
    session = _piano_session()
    window, stride, fps = 40000, 20000, 100
    frames = int(np.ceil(len(audio) / 160))
    sums = {key: np.zeros((frames, 88), dtype=np.float32) for key in KEYS}
    weights = np.zeros(frames, dtype=np.float32)
    starts = list(range(0, len(audio), stride))
    # A triangular fade keeps contextual predictions away from padded edges.
    taper = np.minimum(np.arange(1, 251), np.arange(250, 0, -1)).astype(np.float32)
    taper /= float(taper.max())
    taper = np.maximum(taper, 0.025)
    for index, start in enumerate(starts):
        if cancelled():
            raise Cancelled()
        chunk = audio[start:start + window]
        if len(chunk) < window:
            chunk = np.pad(chunk, (0, window - len(chunk)))
        outputs = session.run(list(KEYS), {"waveform": chunk[None, :]})
        first = start // 160
        last = min(first + 250, frames)
        count = last - first
        weights[first:last] += taper[:count]
        for key, output in zip(KEYS, outputs):
            sums[key][first:last] += output[0, :count] * taper[:count, None]
        progress((index + 1) / len(starts), f"Analyzing piano · window {index + 1} of {len(starts)}")
        del outputs
    divisor = np.maximum(weights[:, None], 1e-8)
    for key in KEYS:
        sums[key] /= divisor
    if cancelled():
        raise Cancelled()
    onset = max(0.15, 0.6 - options.sensitivity * 0.005)
    processor = RegressionPostProcessor(frames_per_second=fps, classes_num=88, onset_threshold=onset, offset_threshold=onset, frame_threshold=max(0.1, onset / 2), pedal_offset_threshold=0.2)
    events, _ = processor.output_dict_to_midi_events(sums)
    notes = [{"start": float(event["onset_time"]), "end": float(event["offset_time"]), "pitch": int(event["midi_note"]), "velocity": max(1, min(127, int(event["velocity"])))} for event in events]
    del sums, audio
    gc.collect()
    return notes


def _basic_session():
    global _BASIC_SESSION
    with _MODEL_LOCK:
        if _BASIC_SESSION is None:
            import onnxruntime as ort
            options = ort.SessionOptions()
            options.intra_op_num_threads = INFERENCE_THREADS
            options.inter_op_num_threads = 1
            options.add_session_config_entry("session.intra_op.allow_spinning", "0")
            _BASIC_SESSION = ort.InferenceSession(str(BASIC_MODEL_PATH), sess_options=options, providers=["CPUExecutionProvider"])
        return _BASIC_SESSION


def basic_transcribe(path: Path, options: TranscriptionOptions, progress: Progress, cancelled: Callable[[], bool]) -> list[dict]:
    from .vendor.basic_pitch.constants import AUDIO_N_SAMPLES, FFT_HOP, ANNOTATIONS_FPS
    from .vendor.basic_pitch.note_creation import model_output_to_notes

    original = load_audio(path, 22050)
    session = _basic_session()
    overlap = 30 * FFT_HOP
    stride = AUDIO_N_SAMPLES - overlap
    # Match upstream's half-overlap lead-in. Without it, trimming 15 frames
    # from each window shifts every predicted note by 174 ms.
    audio = np.concatenate([np.zeros(overlap // 2, dtype=np.float32), original])
    starts = list(range(0, len(audio), stride))
    rolls = {"note": [], "onset": [], "contour": []}
    for index, start in enumerate(starts):
        if cancelled():
            raise Cancelled()
        chunk = audio[start:start + AUDIO_N_SAMPLES]
        if len(chunk) < AUDIO_N_SAMPLES:
            chunk = np.pad(chunk, (0, AUDIO_N_SAMPLES - len(chunk)))
        values = session.run(["StatefulPartitionedCall:1", "StatefulPartitionedCall:2", "StatefulPartitionedCall:0"], {"serving_default_input_2:0": chunk[None, :, None]})
        for key, value in zip(rolls, values):
            rolls[key].append(np.asarray(value))
        progress((index + 1) / len(starts), f"Analyzing audio · window {index + 1} of {len(starts)}")
    if cancelled():
        raise Cancelled()
    unwrapped = {}
    frame_count = int(np.floor(len(original) * ANNOTATIONS_FPS / 22050))
    for key, values in rolls.items():
        merged = np.concatenate(values, axis=0)[:, 15:-15, :]
        unwrapped[key] = merged.reshape(-1, merged.shape[-1])[:frame_count]
    onset = max(0.2, 0.8 - options.sensitivity * 0.005)
    _, events = model_output_to_notes(unwrapped, onset_thresh=onset, frame_thresh=0.3, infer_onsets=True, melodia_trick=True, min_note_len=max(1, round(options.min_duration_ms / 1000 * ANNOTATIONS_FPS)))
    notes = [{"start": float(start), "end": float(end), "pitch": int(pitch), "velocity": max(1, min(127, round(float(velocity) * 127)))} for start, end, pitch, velocity, _ in events]
    del rolls, unwrapped, audio, original
    gc.collect()
    return notes


def transcribe(path: Path, options: TranscriptionOptions, progress: Progress, cancelled: Callable[[], bool]) -> tuple[list[dict], str]:
    engine = choose_engine(options.engine)
    progress(0, "Loading the transcription model…")
    notes = piano_transcribe(path, options, progress, cancelled) if engine == "piano" else basic_transcribe(path, options, progress, cancelled)
    return notes, engine
