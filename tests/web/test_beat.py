from __future__ import annotations

import numpy as np
import pytest

from webapp.beat import align_notes_to_grid, estimate_grid, log_mel, model_path
from webapp.midi import refine_notes
from webapp.models import TranscriptionOptions


def test_log_mel_shape_and_finite_values():
    audio = np.random.default_rng(7).normal(0, 0.1, 22050).astype(np.float32)
    mel = log_mel(audio)
    assert mel.shape == (51, 128)
    assert np.isfinite(mel).all()
    assert mel.dtype == np.float32


def test_estimate_grid_corrects_half_time_and_keeps_plausible_tempo():
    beats = np.arange(0, 10, 1.25)
    downbeats = np.arange(0, 10, 2.5)
    tempo, meter, interval = estimate_grid(beats, downbeats)
    assert tempo == pytest.approx(96, abs=1)
    assert meter == 4
    assert interval == pytest.approx(0.625, abs=0.02)
    # A plausible 120 BPM beat should not be doubled just because downbeats are sparse.
    tempo, meter, _ = estimate_grid(np.arange(0, 10, 0.5), np.arange(0, 10, 1.0))
    assert tempo == pytest.approx(120, abs=1)
    assert meter is None


def test_align_notes_to_grid_is_conservative():
    ai = {"beats": [0, 0.5, 1.0, 1.5], "beat_interval": 0.5}
    notes = [
        {"start": 0.03, "end": 0.4, "pitch": 60, "velocity": 80},
        {"start": 0.7, "end": 1.0, "pitch": 64, "velocity": 70},
        {"start": 2.0, "end": 2.3, "pitch": 67, "velocity": 90},
    ]
    adjusted, moved = align_notes_to_grid(notes, ai)
    assert moved == 2
    assert adjusted[0]["start"] == 0
    assert adjusted[0]["end"] == pytest.approx(0.37)
    assert adjusted[1]["start"] == 0.75
    assert adjusted[2]["start"] == 2.0


def test_refine_notes_reports_ai_alignment():
    ai = {"beats": [0, 0.5, 1.0], "beat_interval": 0.5, "tempo": 120, "meter": 4}
    raw = [{"start": 0.02, "end": 0.4, "pitch": 60, "velocity": 80}]
    notes, stats = refine_notes(raw, TranscriptionOptions(ai_assist=True, ai_align=True), 120, ai)
    assert notes[0]["start"] == 0
    assert stats["ai_aligned_notes"] == 1


@pytest.mark.skipif(not model_path().exists(), reason="AI Assist model not installed")
def test_real_beat_model_finds_synthetic_120_bpm():
    from webapp.beat import analyze_beats

    sr = 22050
    t = np.arange(sr * 12) / sr
    audio = np.zeros(t.size, dtype=np.float32)
    for beat in np.arange(0, 12, 0.5):
        i = int(beat * sr)
        env = np.exp(-np.arange(2000) / 200)
        accent = 1.0 if int(beat * 2) % 4 == 0 else 0.6
        audio[i : i + 2000] += (env * np.sin(2 * np.pi * 1000 * np.arange(2000) / sr) * accent).astype(np.float32)
    ai = analyze_beats(audio, sr)
    assert ai["model"] == "beat-this-small0"
    assert ai["beat_count"] >= 20
    assert ai["tempo"] == pytest.approx(120, abs=3)
    assert ai["beats"][1] == pytest.approx(0.5, abs=0.08)
