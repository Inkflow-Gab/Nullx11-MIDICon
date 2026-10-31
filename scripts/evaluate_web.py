#!/usr/bin/env python3
"""Reproducible sanity check on the upstream paired Bach audio/MIDI example.

This is ONE reference clip, not a claim of general accuracy. Reports raw note
onset F1 (50 ms tolerance), full note F1 (50 ms onset + 20% offset tolerance),
and the default cleanup's effect. Also measures the non-overlapping chunk
baseline. Downloads only the small upstream resource archive when necessary.
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

import mir_eval
import numpy as np
import pretty_midi

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from webapp.audio import normalize_audio
from webapp.config import DATA_DIR, MODEL_DIR
from webapp.midi import refine_notes
from webapp.models import TranscriptionOptions
from webapp.transcription import piano_available, transcribe

COMMIT = '1ade7dcd4348add669a67c6e6282456c8c6633bd'


def arrays(notes):
    return np.array([[n['start'], n['end']] for n in notes]), np.array([n['pitch'] for n in notes])


def score(reference, estimated):
    ri, rp = arrays(reference); ei, ep = arrays(estimated)
    onset = mir_eval.transcription.precision_recall_f1_overlap(ri, rp, ei, ep, onset_tolerance=.05, offset_ratio=None)
    full = mir_eval.transcription.precision_recall_f1_overlap(ri, rp, ei, ep, onset_tolerance=.05, offset_ratio=.2)
    return {'onset_precision': onset[0], 'onset_recall': onset[1], 'onset_f1': onset[2], 'note_f1': full[2], 'notes': len(estimated)}


def nonoverlap_baseline(audio):
    import onnxruntime as ort
    from webapp.vendor.kong_postprocessing import RegressionPostProcessor
    options = ort.SessionOptions(); options.intra_op_num_threads = 2
    session = ort.InferenceSession(str(MODEL_DIR / 'model.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
    keys = ['reg_onset_output', 'reg_offset_output', 'frame_output', 'velocity_output']
    outputs = {key: [] for key in keys}
    for start in range(0, len(audio), 40000):
        chunk = audio[start:start + 40000]
        chunk = np.pad(chunk, (0, 40000 - len(chunk)))
        for key, value in zip(keys, session.run(keys, {'waveform': chunk[None, :]})):
            outputs[key].append(value[0, :250])
    frames = int(len(audio) / 160)
    outputs = {key: np.concatenate(value)[:frames] for key, value in outputs.items()}
    processor = RegressionPostProcessor(100, 88, .3, .3, .15, .2)
    events, _ = processor.output_dict_to_midi_events(outputs)
    return [{'start': e['onset_time'], 'end': e['offset_time'], 'pitch': e['midi_note'], 'velocity': e['velocity']} for e in events]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=float, default=20)
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--skip-basic', action='store_true')
    args = parser.parse_args()
    if not piano_available():
        raise SystemExit('Install the piano model with scripts/setup_web_models.py first.')
    directory = DATA_DIR / 'evaluation'; directory.mkdir(parents=True, exist_ok=True)
    audio_path = directory / 'cut_bach.mp3'; midi_path = directory / 'cut_bach.mid'
    if not audio_path.exists() or not midi_path.exists():
        if args.archive:
            blob = args.archive.read_bytes()
        else:
            with urllib.request.urlopen(f'https://codeload.github.com/bytedance/piano_transcription/tar.gz/{COMMIT}', timeout=60) as response:
                blob = response.read(10 * 1024 * 1024)
        with tarfile.open(fileobj=io.BytesIO(blob), mode='r:gz') as archive:
            for member in archive.getmembers():
                if member.name.endswith(('resources/cut_bach.mp3', 'resources/cut_bach.mid')):
                    content = archive.extractfile(member)
                    if content:
                        (directory / Path(member.name).name).write_bytes(content.read())
    wav, duration = normalize_audio(audio_path, directory, duration=args.seconds)
    reference_midi = pretty_midi.PrettyMIDI(str(midi_path))
    reference = [{'start': n.start, 'end': min(n.end, duration), 'pitch': n.pitch} for instrument in reference_midi.instruments for n in instrument.notes if n.start < duration - .1]
    report = {'clip': 'Upstream cut_bach.mp3 / cut_bach.mid', 'commit': COMMIT, 'duration': duration, 'onset_tolerance_ms': 50, 'offset_ratio': .2, 'warning': 'One paired reference clip; not a general accuracy claim.', 'engines': {}}
    for engine in (['piano'] if args.skip_basic else ['piano', 'basic']):
        start = time.perf_counter()
        notes, used = transcribe(wav, TranscriptionOptions(engine=engine), lambda *_: None, lambda: False)
        cleaned, _ = refine_notes(notes, TranscriptionOptions(), 120)
        report['engines'][engine] = {'raw': score(reference, notes), 'default_cleanup': score(reference, cleaned), 'inference_seconds': round(time.perf_counter() - start, 2)}
    from webapp.audio import load_audio
    start = time.perf_counter(); baseline = nonoverlap_baseline(load_audio(wav))
    report['nonoverlap_baseline'] = {**score(reference, baseline), 'inference_seconds': round(time.perf_counter() - start, 2)}
    report['reference_notes'] = len(reference)
    (directory / 'results.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
