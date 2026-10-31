from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

from .config import MAX_DURATION_SECONDS

Progress = Callable[[float, str], None]


class AudioError(ValueError):
    pass


class Cancelled(Exception):
    pass


def ffmpeg_binary() -> str:
    if binary := shutil.which("ffmpeg"):
        return binary
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError as exc:
        raise AudioError("Audio support is not installed. Install requirements-web.txt on the server.") from exc


def probe_duration(path: Path) -> float:
    try:
        info = sf.info(str(path))
        if info.frames > 0 and info.samplerate > 0:
            return info.frames / info.samplerate
    except (RuntimeError, OSError):
        pass
    binary = ffmpeg_binary()
    ffprobe = Path(binary).with_name("ffprobe")
    if ffprobe.exists():
        result = subprocess.run([str(ffprobe), "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)], capture_output=True, text=True, timeout=30)
        try:
            return float(json.loads(result.stdout)["format"]["duration"])
        except (KeyError, ValueError, TypeError):
            pass
    result = subprocess.run([binary, "-hide_banner", "-i", str(path)], capture_output=True, text=True, timeout=30)
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr)
    if not match:
        raise AudioError("We couldn't find a readable audio track. Try MP3, WAV, M4A, or MP4.")
    h, m, s = map(float, match.groups())
    return h * 3600 + m * 60 + s


def normalize_audio(source: Path, directory: Path, *, start: float = 0, duration: float | None = None, progress: Progress | None = None, cancelled: Callable[[], bool] | None = None) -> tuple[Path, float]:
    """Decode locally with a bounded duration; never pass a URL or shell string."""
    total = probe_duration(source)
    if not math.isfinite(total) or total <= 0:
        raise AudioError("This file has no readable audio. Please try another recording.")
    if start >= total:
        raise AudioError("The trim start is after the end of the audio.")
    length = min(duration or MAX_DURATION_SECONDS, MAX_DURATION_SECONDS, total - start)
    destination = directory / "audio.wav"
    cmd = [ffmpeg_binary(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", str(start), "-i", str(source), "-t", str(length), "-vn", "-map", "0:a:0", "-ac", "1", "-ar", "22050", "-c:a", "pcm_f32le", str(destination)]
    run_ffmpeg(cmd, cancelled)
    if not destination.exists() or destination.stat().st_size < 100:
        raise AudioError("No audio could be decoded from this file.")
    actual = probe_duration(destination)
    if actual < 0.15:
        raise AudioError("This audio is too short. Please use at least 0.15 seconds.")
    peak = 0.0
    for block in sf.blocks(str(destination), blocksize=65536, dtype="float32"):
        peak = max(peak, float(np.max(np.abs(block))) if block.size else 0.0)
        if peak >= 0.0001:
            break
    if peak < 0.0001:
        raise AudioError("This recording appears to be silent. Try a file with audible music.")
    # A small, seekable playback file; the lossless analysis WAV is kept separately.
    preview = directory / "preview.m4a"
    run_ffmpeg([ffmpeg_binary(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(destination), "-t", str(length), "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(preview)], cancelled)
    if progress:
        progress(1.0, f"Prepared {actual:.1f} seconds of audio")
    return destination, actual


def run_ffmpeg(cmd: list[str], cancelled: Callable[[], bool] | None = None) -> None:
    process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    assert process.stderr is not None
    errors: list[bytes] = []
    def read_errors():
        errors.append(process.stderr.read())
    thread = threading.Thread(target=read_errors, daemon=True)
    thread.start()
    try:
        while process.poll() is None:
            if cancelled and cancelled():
                process.kill()
                process.wait()
                raise Cancelled()
            try:
                process.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                pass
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        thread.join(timeout=2)
    if process.returncode:
        raise AudioError("This audio couldn't be decoded. It may be damaged or use an unsupported codec. Try exporting it as WAV or MP3.")


def load_audio(path: Path, sample_rate: int = 16000) -> np.ndarray:
    audio, rate = sf.read(path, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if rate != sample_rate:
        import librosa
        audio = librosa.resample(audio, orig_sr=rate, target_sr=sample_rate, res_type="soxr_hq")
    peak = float(np.max(np.abs(audio))) if len(audio) else 0
    if peak < 0.0001:
        raise AudioError("This recording appears to be silent. Try a file with audible music.")
    # Scale conservatively, preserving dynamics and avoiding clipping.
    if peak > 0.98:
        audio = audio * (0.98 / peak)
    return np.ascontiguousarray(audio, dtype=np.float32)


def waveform_peaks(path: Path, count: int = 180) -> list[float]:
    info = sf.info(str(path))
    chunk = max(1, math.ceil(info.frames / count))
    peaks = []
    for start in range(0, info.frames, chunk):
        data, _ = sf.read(path, start=start, stop=min(start + chunk, info.frames), dtype="float32", always_2d=True)
        peaks.append(float(np.sqrt(np.mean(data * data))) if data.size else 0)
    maximum = max(peaks) or 1
    return [round(min(1, value / maximum), 4) for value in peaks[:count]]
