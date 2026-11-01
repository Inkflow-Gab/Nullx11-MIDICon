from __future__ import annotations

import csv
import io
import json
from pathlib import Path

import numpy as np
import pretty_midi

from .models import TranscriptionOptions


def estimate_music(audio_path: Path, notes: list[dict]) -> tuple[float, str]:
    import librosa
    audio, sr = librosa.load(audio_path, sr=16000, mono=True, duration=90)
    tempo, _ = librosa.beat.beat_track(y=audio, sr=sr, trim=False)
    bpm = float(np.asarray(tempo).reshape(-1)[0]) if np.asarray(tempo).size else 120.0
    bpm = max(40.0, min(240.0, bpm))
    histogram = np.zeros(12)
    for note in notes:
        histogram[note["pitch"] % 12] += min(3, note["end"] - note["start"])
    if not np.sum(histogram):
        return round(bpm, 1), "Unknown"
    major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    names = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"]
    scores = []
    for index, name in enumerate(names):
        for profile, mode in ((major, "major"), (minor, "minor")):
            score = float(np.corrcoef(histogram, np.roll(profile, index))[0, 1])
            scores.append((score, f"{name} {mode}"))
    return round(bpm, 1), max(scores)[1]


def refine_notes(raw_notes: list[dict], options: TranscriptionOptions, tempo: float) -> tuple[list[dict], dict]:
    original_count = len(raw_notes)
    notes = []
    for source in raw_notes:
        note = dict(source)
        note["pitch"] += options.transpose
        if options.piano_range and not 21 <= note["pitch"] <= 108:
            continue
        if not 0 <= note["pitch"] <= 127 or note["end"] <= note["start"]:
            continue
        if not options.preserve_dynamics:
            note["velocity"] = 80
        note["velocity"] = max(1, min(127, round(note["velocity"])))
        notes.append(note)
    if options.quantize != "off":
        fraction = {"1/4": 1, "1/8": 0.5, "1/16": 0.25}[options.quantize]
        grid = 60 / tempo * fraction
        for note in notes:
            note["start"] = round(note["start"] / grid) * grid
            note["end"] = max(note["start"] + grid, round(note["end"] / grid) * grid)
    if options.sustain:
        for note in notes:
            note["end"] += 0.2
    # Merge only repeated pitches with a short gap. Different simultaneous
    # pitches (chords) are never collapsed.
    notes.sort(key=lambda note: (note["pitch"], note["start"], note["end"]))
    merged: list[dict] = []
    merge_count = 0
    by_pitch: dict[int, dict] = {}
    gap = options.merge_gap_ms / 1000
    for note in notes:
        previous = by_pitch.get(note["pitch"])
        if previous and 0 <= note["start"] - previous["end"] <= gap:
            if note["end"] > previous["end"]:
                previous["end"] = note["end"]
            previous["velocity"] = max(previous["velocity"], note["velocity"])
            merge_count += 1
        else:
            current = dict(note)
            merged.append(current)
            by_pitch[note["pitch"]] = current
    minimum = options.min_duration_ms / 1000
    merged = [note for note in merged if note["end"] - note["start"] >= minimum]
    # A MIDI note-off cannot distinguish two identical overlapping pitches.
    by_pitch.clear()
    for note in merged:
        previous = by_pitch.get(note["pitch"])
        if previous:
            previous["end"] = min(previous["end"], max(previous["start"] + 0.005, note["start"] - 0.003))
        by_pitch[note["pitch"]] = note
    merged.sort(key=lambda note: (note["start"], note["pitch"]))
    for note in merged:
        for key in ("start", "end"):
            note[key] = round(note[key], 5)
    stats = {"raw_note_count": original_count, "merged_notes": merge_count, "filtered_notes": original_count - len(merged), "note_count": len(merged)}
    return merged, stats


def export_midi(notes: list[dict], path: Path, *, tempo: float, options: TranscriptionOptions, title: str) -> None:
    midi = pretty_midi.PrettyMIDI(initial_tempo=tempo)
    groups = {"Piano": []} if not options.split_tracks else {"Piano · upper register": [], "Piano · lower register": []}
    for note in notes:
        name = "Piano" if not options.split_tracks else "Piano · upper register" if note["pitch"] >= 60 else "Piano · lower register"
        groups[name].append(note)
    for name, events in groups.items():
        instrument = pretty_midi.Instrument(program=0, name=name)
        instrument.notes = [pretty_midi.Note(velocity=note["velocity"], pitch=note["pitch"], start=note["start"], end=note["end"]) for note in events]
        midi.instruments.append(instrument)
    midi.time_signature_changes = [pretty_midi.TimeSignature(4, 4, 0)]
    path.parent.mkdir(parents=True, exist_ok=True)
    midi.write(str(path))


def export_notes(notes: list[dict], format: str) -> bytes:
    if format == "json":
        return json.dumps({"format": "nullx-midicon-notes-v1", "time_unit": "seconds", "notes": notes}, indent=2).encode()
    if format == "csv":
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=["start", "end", "pitch", "velocity"])
        writer.writeheader()
        writer.writerows(notes)
        return output.getvalue().encode()
    raise ValueError("Unsupported export format")


def normalize_edited_notes(raw_notes: list[dict]) -> list[dict]:
    """Validate manual edits without re-running neural cleanup.

    Preserves the user's velocities and note boundaries, clamps invalid values,
    and resolves overlapping identical pitches so MIDI note-off events remain
    unambiguous. Extra client-only fields (for example ``id``) are dropped.
    """
    import math

    cleaned: list[dict] = []
    for source in raw_notes:
        try:
            start = float(source["start"]); end = float(source["end"])
            pitch = int(source["pitch"]); velocity = int(source.get("velocity", 80))
        except (KeyError, TypeError, ValueError):
            continue
        if not all(math.isfinite(value) for value in (start, end)):
            continue
        start = max(0.0, start)
        end = max(start + 0.005, end)
        pitch = max(0, min(127, pitch))
        velocity = max(1, min(127, velocity))
        cleaned.append({"start": start, "end": end, "pitch": pitch, "velocity": velocity})
    cleaned.sort(key=lambda note: (note["pitch"], note["start"], note["end"]))
    by_pitch: dict[int, dict] = {}
    for note in cleaned:
        previous = by_pitch.get(note["pitch"])
        if previous:
            previous["end"] = min(previous["end"], max(previous["start"] + 0.005, note["start"] - 0.003))
        by_pitch[note["pitch"]] = note
    cleaned = [note for note in cleaned if note["end"] - note["start"] >= 0.005]
    cleaned.sort(key=lambda note: (note["start"], note["pitch"]))
    for note in cleaned:
        note["start"] = round(note["start"], 5)
        note["end"] = round(note["end"], 5)
    return cleaned


def result_metadata(notes: list[dict], duration: float, tempo: float, key: str, engine: str, stats: dict) -> dict:
    return {**stats, "duration": round(duration, 3), "tempo": round(tempo, 1), "key": key, "engine": engine,
        "engine_name": "Piano specialist" if engine == "piano" else "Basic Pitch",
        "lowest_pitch": min((note["pitch"] for note in notes), default=None),
        "highest_pitch": max((note["pitch"] for note in notes), default=None),
        "tempo_is_estimate": True, "key_is_estimate": True,
        "meter": "4/4 (export default)", "pedal_detected": False}
