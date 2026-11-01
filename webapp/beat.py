"""Optional, local Beat This! small0 beat/downbeat analysis.

The model is the MIT-licensed ``small0`` checkpoint of Beat This! (Foscarin,
Schlüter & Widmer, ISMIR 2024), exported to ONNX.  It runs on the same machine
as the transcription pipeline; no audio is sent to a third-party AI service.
The DSP below mirrors ``beat_this.preprocessing.LogMelSpect`` (22.05 kHz mono,
1024-point Hann, 441 hop, 128 Slaney mel bands, frame-length normalization,
``log1p(1000 * magnitude)``).  Peak picking is a conservative non-maximum
suppression variant of the upstream minimal postprocessor.
"""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable

import numpy as np

from .config import MODEL_DIR

SAMPLE_RATE = 22050
N_FFT = 1024
HOP = 441
N_MELS = 128
F_MIN = 30.0
F_MAX = 11000.0
FPS = 50
CHUNK_FRAMES = 1500
BORDER = 6
MODEL_NAME = "beat-this-small0.onnx"
MODEL_SHA256 = "0d8dd8c9d59922a04f48e61848d21be316480b5d4ddef678f7b96fed56a4e512"

_session = None
_session_lock = threading.Lock()
_filterbank: np.ndarray | None = None
_window: np.ndarray | None = None


def model_path() -> Path:
    return MODEL_DIR.parent / "beat-this" / MODEL_NAME


def _hz_to_mel(hz):
    hz = np.asarray(hz, dtype=np.float64)
    linear = hz / (200.0 / 3.0)
    logarithmic = 15.0 + np.log(hz / 1000.0) / (np.log(6.4) / 27.0)
    return np.where(hz < 1000.0, linear, logarithmic)


def _mel_to_hz(mel):
    mel = np.asarray(mel, dtype=np.float64)
    linear = mel * (200.0 / 3.0)
    logarithmic = 1000.0 * np.exp((np.log(6.4) / 27.0) * (mel - 15.0))
    return np.where(mel < 15.0, linear, logarithmic)


def _mel_filterbank() -> np.ndarray:
    global _filterbank
    if _filterbank is None:
        edges = _mel_to_hz(np.linspace(_hz_to_mel(F_MIN), _hz_to_mel(F_MAX), N_MELS + 2))
        freqs = np.linspace(0.0, SAMPLE_RATE / 2.0, N_FFT // 2 + 1)
        bank = np.zeros((N_MELS, freqs.size), dtype=np.float64)
        for m in range(N_MELS):
            left, center, right = edges[m : m + 3]
            rising = (freqs - left) / (center - left)
            falling = (right - freqs) / (right - center)
            # Slaney area normalization, matching torchaudio mel_scale="slaney".
            bank[m] = np.maximum(0.0, np.minimum(rising, falling)) * (2.0 / (right - left))
        _filterbank = bank
    return _filterbank


def log_mel(audio: np.ndarray) -> np.ndarray:
    """Return ``[frames, 128]`` float32 log-mel features for mono 22.05 kHz audio."""
    global _window
    x = np.asarray(audio, dtype=np.float64).reshape(-1)
    if x.size == 0:
        return np.zeros((0, N_MELS), dtype=np.float32)
    if _window is None:
        _window = np.hanning(N_FFT + 1)[:-1]
    pad = N_FFT // 2
    padded = np.pad(x, pad, mode="reflect")
    frames = 1 + int(np.floor(x.size / HOP))
    out = np.empty((frames, N_MELS), dtype=np.float32)
    bank = _mel_filterbank()
    scale = 1.0 / np.sqrt(N_FFT)
    block = 512
    for first in range(0, frames, block):
        count = min(block, frames - first)
        start = first * HOP
        segment = padded[start : start + N_FFT + (count - 1) * HOP]
        windows = np.lib.stride_tricks.sliding_window_view(segment, N_FFT)[::HOP][:count]
        magnitude = np.abs(np.fft.rfft(windows * _window, axis=1)) * scale
        out[first : first + count] = np.log1p(1000.0 * (magnitude @ bank.T)).astype(np.float32)
    return out


def _session_or_create():
    global _session
    with _session_lock:
        if _session is None:
            import hashlib
            import onnxruntime as ort

            path = model_path()
            if not path.exists():
                raise RuntimeError("AI Assist model is not installed. Run python scripts/setup_beat_model.py, or disable AI Assist.")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != MODEL_SHA256:
                raise RuntimeError("AI Assist model failed its integrity check. Re-run python scripts/setup_beat_model.py.")
            options = ort.SessionOptions()
            options.intra_op_num_threads = 1
            options.inter_op_num_threads = 1
            _session = ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])
        return _session


def _pick_peaks(logits: np.ndarray, threshold: float = 0.0, min_distance: float = 0.18) -> np.ndarray:
    """Non-maximum suppression on frame logits; returns times in seconds."""
    candidates = [(float(logits[i]), i / FPS) for i in range(logits.size) if logits[i] > threshold]
    candidates.sort(key=lambda item: (-item[0], item[1]))
    kept: list[float] = []
    for _, time in candidates:
        if all(abs(time - other) > min_distance for other in kept):
            kept.append(time)
    return np.array(sorted(kept), dtype=np.float64)


def _median_interval(times: np.ndarray) -> float | None:
    if times.size < 3:
        return None
    diffs = np.diff(times)
    diffs = diffs[(diffs > 0.15) & (diffs < 6.0)]
    return float(np.median(diffs)) if diffs.size else None


def estimate_grid(beats: np.ndarray, downbeats: np.ndarray) -> tuple[float | None, int | None, float | None]:
    """Infer a plausible tempo/meter, correcting common half/double-time beats."""
    beat_interval = _median_interval(beats)
    if beat_interval is None:
        return None, None, None
    bpm = 60.0 / beat_interval
    # The upstream DBN range is 55–215 BPM.  Prefer that musical range before
    # trusting a half-time or double-time beat sequence.
    while bpm < 55.0 and beat_interval > 0.12:
        beat_interval /= 2.0
        bpm *= 2.0
    while bpm > 215.0:
        beat_interval *= 2.0
        bpm /= 2.0
    meter = None
    bar = _median_interval(downbeats)
    if bar is not None:
        ratio = bar / beat_interval
        nearest = int(round(ratio))
        if nearest in (3, 4) and abs(ratio - nearest) < 0.25:
            meter = nearest
    return round(bpm, 1), meter, round(beat_interval, 5)


def analyze_beats(
    audio: np.ndarray,
    sample_rate: int,
    *,
    progress: Callable[[float, str], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> dict:
    """Run Beat This! small0 and return beats, downbeats, tempo, and meter."""
    import librosa

    x = np.asarray(audio, dtype=np.float32).reshape(-1)
    if sample_rate != SAMPLE_RATE:
        x = librosa.resample(x, orig_sr=sample_rate, target_sr=SAMPLE_RATE, res_type="soxr_hq")
    if x.size < SAMPLE_RATE // 2:
        raise ValueError("AI Assist needs at least half a second of audio.")
    if progress:
        progress(0.05, "AI Assist · preparing log-mel features")
    mel = log_mel(x)
    session = _session_or_create()
    frames = mel.shape[0]
    beat_logits = np.full(frames, -1000.0, dtype=np.float32)
    down_logits = np.full(frames, -1000.0, dtype=np.float32)
    starts = list(range(-BORDER, frames - BORDER, CHUNK_FRAMES - 2 * BORDER))
    if not starts:
        starts = [-BORDER]
    if frames > CHUNK_FRAMES - 2 * BORDER:
        starts[-1] = frames - (CHUNK_FRAMES - BORDER)
    for index, start in enumerate(starts):
        if cancelled and cancelled():
            raise RuntimeError("Conversion cancelled")
        left = max(0, -start)
        right = max(0, min(BORDER, start + CHUNK_FRAMES - frames))
        piece = mel[max(start, 0) : min(start + CHUNK_FRAMES, frames)]
        piece = np.pad(piece, ((left, right), (0, 0)), mode="constant")
        beat, down = session.run(None, {"spect": piece[None].astype(np.float32)})
        beat = beat[0][BORDER : CHUNK_FRAMES - BORDER]
        down = down[0][BORDER : CHUNK_FRAMES - BORDER]
        target = start + BORDER
        count = min(beat.size, frames - target)
        if count > 0:
            beat_logits[target : target + count] = beat[:count]
            down_logits[target : target + count] = down[:count]
        if progress:
            progress(0.1 + 0.85 * (index + 1) / len(starts), f"AI Assist · beat window {index + 1}/{len(starts)}")
    beats = _pick_peaks(beat_logits, 0.0, 0.18)
    downbeats = _pick_peaks(down_logits, 0.0, 0.5)
    if beats.size:
        # Move downbeats onto the nearest detected beat, as upstream does.
        snapped = [beats[int(np.argmin(np.abs(beats - time)))] for time in downbeats]
        downbeats = np.unique(np.array(snapped, dtype=np.float64))
    tempo, meter, interval = estimate_grid(beats, downbeats)
    return {
        "model": "beat-this-small0",
        "model_name": "Beat This! small0 · local",
        "license": "MIT",
        "beats": [round(float(t), 4) for t in beats],
        "downbeats": [round(float(t), 4) for t in downbeats],
        "tempo": tempo,
        "meter": meter,
        "beat_interval": interval,
        "beat_count": int(beats.size),
        "downbeat_count": int(downbeats.size),
    }


def analyze_file(path: Path, **kwargs) -> dict:
    import librosa

    audio, sr = librosa.load(path, sr=SAMPLE_RATE, mono=True)
    return analyze_beats(audio, sr, **kwargs)


def align_notes_to_grid(notes: list[dict], ai: dict, *, tolerance: float = 0.085) -> tuple[list[dict], int]:
    """Conservatively nudge note starts to the AI beat/subdivision grid.

    Only notes already close to a grid line move; duration and velocity are
    preserved.  This is an assist, not a hard quantize, so rubato and expressive
    timing survive.  Returns the adjusted notes and the number moved.
    """
    beats = ai.get("beats") or []
    interval = ai.get("beat_interval")
    if not beats or not interval or interval <= 0:
        return notes, 0
    # Include half-beat subdivisions so eighth-note passages can align too.
    step = float(interval) / 2.0
    first = float(beats[0])
    last = max(float(beats[-1]), max((note["end"] for note in notes), default=first)) + step
    grid = np.arange(first, last + step, step)
    moved = 0
    adjusted = []
    for source in notes:
        note = dict(source)
        start = float(note["start"])
        index = int(np.argmin(np.abs(grid - start)))
        target = float(grid[index])
        delta = target - start
        if abs(delta) <= tolerance and target >= 0:
            duration = float(note["end"]) - start
            note["start"] = round(target, 5)
            note["end"] = round(max(target + 0.005, target + duration), 5)
            if abs(delta) > 1e-9:
                moved += 1
        adjusted.append(note)
    return adjusted, moved
