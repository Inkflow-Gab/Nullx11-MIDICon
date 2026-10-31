"""Opt-in real neural smoke tests. RUN_REAL_MODEL_TESTS=1 pytest tests/web/test_real_models.py.

The bundled demo is an original piano-like recording, not a real acoustic piano.
These tests verify that the actual models and exports run; they are not an
accuracy benchmark. See scripts/evaluate_web.py for the paired reference clip.
"""
import os
from pathlib import Path
import pytest

from webapp.models import TranscriptionOptions
from webapp.transcription import choose_engine, transcribe

pytestmark = pytest.mark.skipif(os.environ.get('RUN_REAL_MODEL_TESTS') != '1', reason='Opt-in real model test')


@pytest.mark.parametrize('engine', ['piano', 'basic'])
def test_real_demo_produces_expected_pitches(engine):
    if engine == 'piano' and choose_engine('auto') != 'piano':
        pytest.skip('Piano weights not installed')
    path = Path(__file__).resolve().parents[2] / 'webapp' / 'assets' / 'demo.wav'
    notes, used = transcribe(path, TranscriptionOptions(engine=engine), lambda *_: None, lambda: False)
    assert used == engine
    detected = {note['pitch'] for note in notes}
    assert {45, 57, 60, 64, 69, 76}.issubset(detected), detected
    assert len(notes) > 30
    assert all(0 <= note['start'] < note['end'] <= 22 for note in notes)
    assert all(1 <= note['velocity'] <= 127 for note in notes)
