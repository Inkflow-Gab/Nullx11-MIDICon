from __future__ import annotations

import io
import json
import time
import zipfile
from pathlib import Path

import numpy as np
import pretty_midi
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from webapp.audio import AudioError, normalize_audio, probe_duration
from webapp.midi import export_midi, export_notes, normalize_edited_notes, refine_notes
from webapp.models import TranscriptionOptions
from webapp.store import Store
from webapp.youtube import validate_youtube_url


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr('webapp.store.DATA_DIR', tmp_path)
    (tmp_path / 'jobs').mkdir()
    return Store(tmp_path / "test.sqlite3")


def test_session_isolation_and_deletion(store):
    a, b = store.create_session(), store.create_session()
    owner = store.hash_token(a)
    job = store.create_job(owner, title="My song", source_type="upload", options={})
    assert store.list_jobs(owner)[0]["id"] == job["id"]
    assert store.list_jobs(store.hash_token(b)) == []
    assert store.get_job(store.hash_token(b), job["id"]) is None
    assert not store.delete_job(store.hash_token(b), job["id"])
    store.finish(job["id"], "cancelled")
    assert store.delete_job(owner, job["id"])
    assert store.list_jobs(owner) == []
    assert not store.session_exists("not-a-session")


def test_progress_is_persisted_and_terminal_state_is_not_overwritten(store):
    owner = store.hash_token(store.create_session())
    job = store.create_job(owner, title="Song", source_type="demo", options={})
    store.progress(job["id"], "transcribing", 50, "Listening", "Window 2 of 4", event=True)
    saved = store.get_job(owner, job["id"])
    assert saved["progress"] == 50
    assert saved["events"][-1]["message"] == "Listening"
    store.finish(job["id"], "cancelled")
    store.finish(job["id"], "completed", result={"note_count": 1})
    assert store.get_job(owner, job["id"])["status"] == "cancelled"


def test_path_traversal_rejected(store):
    with pytest.raises(ValueError):
        store.job_dir("../../etc")


@pytest.mark.parametrize("url", ["http://127.0.0.1/private", "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ", "https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ", "https://youtube.com:8000/watch?v=dQw4w9WgXcQ", "https://youtube.com/playlist?list=abcdef", "file:///etc/passwd", "https://youtu.be/short"])
def test_youtube_ssrf_and_invalid_links(url):
    with pytest.raises(ValueError):
        validate_youtube_url(url)


@pytest.mark.parametrize("url", ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=20", "https://youtu.be/dQw4w9WgXcQ", "https://m.youtube.com/shorts/dQw4w9WgXcQ", "https://music.youtube.com/watch?v=dQw4w9WgXcQ"])
def test_youtube_canonical_url(url):
    assert validate_youtube_url(url) == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


def test_cleanup_preserves_chords_and_merges_only_same_pitch():
    notes = [{"start": 0, "end": .4, "pitch": 60, "velocity": 80}, {"start": .41, "end": .8, "pitch": 60, "velocity": 70}, {"start": 0, "end": .8, "pitch": 64, "velocity": 60}, {"start": 0, "end": .8, "pitch": 67, "velocity": 50}, {"start": .9, "end": .91, "pitch": 72, "velocity": 50}]
    result, stats = refine_notes(notes, TranscriptionOptions(), 120)
    assert len(result) == 3
    assert stats["merged_notes"] == 1
    assert result[0]["end"] == .8
    assert {n["pitch"] for n in result} == {60, 64, 67}


def test_transpose_range_dynamics_and_no_overlapping_identical_pitches():
    notes = [{"start": 0, "end": 1, "pitch": 60, "velocity": 100}, {"start": .5, "end": 1.5, "pitch": 60, "velocity": 80}, {"start": 0, "end": 1, "pitch": 107, "velocity": 70}]
    result, _ = refine_notes(notes, TranscriptionOptions(transpose=2, preserve_dynamics=False, merge_gap_ms=0), 120)
    assert len(result) == 2
    assert result[0]["velocity"] == 80
    assert result[0]["end"] < result[1]["start"]
    assert result[0]["pitch"] == 62


def test_quantize_uses_explicit_tempo():
    notes = [{"start": .26, "end": .49, "pitch": 60, "velocity": 80}]
    result, _ = refine_notes(notes, TranscriptionOptions(quantize="1/4", tempo=120, min_duration_ms=20, merge_gap_ms=0), 120)
    assert result[0]["start"] == .5
    assert result[0]["end"] == 1


def test_midi_roundtrip_two_registers_and_pedal_not_faked(tmp_path):
    notes, _ = refine_notes([{"start": 0, "end": 1, "pitch": 48, "velocity": 71}, {"start": 0, "end": 1, "pitch": 72, "velocity": 92}], TranscriptionOptions(), 120)
    path = tmp_path / "test.mid"
    export_midi(notes, path, tempo=120, options=TranscriptionOptions(), title="Test")
    midi = pretty_midi.PrettyMIDI(str(path))
    assert len(midi.instruments) == 2
    assert {n.pitch for i in midi.instruments for n in i.notes} == {48, 72}
    assert all(i.program == 0 and not i.is_drum for i in midi.instruments)
    assert all(not i.control_changes for i in midi.instruments)
    assert path.read_bytes()[:4] == b"MThd"
    assert json.loads(export_notes(notes, "json"))["notes"] == notes
    assert export_notes(notes, "csv").startswith(b"start,end,pitch,velocity")


def test_invalid_settings_rejected():
    with pytest.raises(ValueError):
        TranscriptionOptions(sensitivity=100)
    with pytest.raises(ValueError):
        TranscriptionOptions(transpose=24)
    with pytest.raises(ValueError):
        TranscriptionOptions(duration_seconds=0)


def test_real_audio_decode_and_silence_detection(tmp_path):
    sr = 22050
    t = np.arange(sr * 2) / sr
    source = tmp_path / "tone.wav"
    sf.write(source, .2 * np.sin(2 * np.pi * 440 * t), sr)
    audio, duration = normalize_audio(source, tmp_path, duration=1)
    assert .99 < duration < 1.02
    assert (tmp_path / "preview.m4a").exists()
    assert probe_duration(tmp_path / "preview.m4a") > .9
    sf.write(source, np.zeros(sr), sr)
    with pytest.raises(AudioError):
        normalize_audio(source, tmp_path)


@pytest.fixture
def api(tmp_path, monkeypatch):
    # Isolate HTTP tests from the running preview and its private user data.
    import webapp.config as config
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr('webapp.store.DATA_DIR', tmp_path)
    (tmp_path / "jobs").mkdir()
    import webapp.main as main
    from webapp.pipeline import Pipeline
    store = Store(tmp_path / "api.sqlite3")
    monkeypatch.setattr(main, "store", store)
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    monkeypatch.setattr(main, "pipeline", Pipeline(store))
    with TestClient(main.app) as client:
        yield client, main


def test_api_requires_session_and_csrf_header(api):
    client, _ = api
    assert client.get('/api/jobs').status_code == 401
    assert client.get('/api/session').status_code == 200
    assert client.post('/api/demo', json={}).status_code == 403
    assert client.post('/api/demo', json={}, headers={'X-MIDICon-Client': 'web', 'Origin': 'https://evil.example'}).status_code == 403


def test_api_upload_progress_download_refine_and_owner_isolation(api, monkeypatch):
    client, main = api
    headers = {'X-MIDICon-Client': 'web'}
    client.get('/api/session')
    # Stub only neural inference in this API contract test; decoding/MIDI are real.
    def fake_transcribe(path, options, progress, cancelled):
        progress(.5, 'Test window 1 of 2')
        progress(1, 'Test window 2 of 2')
        return [{"start": .1, "end": .8, "pitch": 60, "velocity": 80}, {"start": .1, "end": .8, "pitch": 48, "velocity": 70}], 'piano'
    monkeypatch.setattr('webapp.pipeline.transcribe', fake_transcribe)
    sr = 22050; t = np.arange(sr * 2) / sr
    buffer = io.BytesIO(); sf.write(buffer, .2 * np.sin(2 * np.pi * 440 * t), sr, format='WAV')
    response = client.post('/api/jobs', files={'file': ('test.wav', buffer.getvalue(), 'audio/wav')}, data={'options': '{}'}, headers=headers)
    assert response.status_code == 202
    job_id = response.json()['id']
    for _ in range(400):
        job = client.get(f'/api/jobs/{job_id}').json()
        if job['status'] in {'completed', 'failed'}: break
        time.sleep(.05)
    assert job['status'] == 'completed', job
    assert job['result']['note_count'] == 2
    assert client.get(f'/api/jobs/{job_id}/notes').json()['notes']
    midi = client.get(f'/api/jobs/{job_id}/download/midi')
    assert midi.status_code == 200 and midi.content[:4] == b'MThd'
    package = client.get(f'/api/jobs/{job_id}/download/zip')
    assert zipfile.ZipFile(io.BytesIO(package.content)).namelist()[-1] == 'README.txt'
    assert client.get(f'/api/jobs/{job_id}/download/audio').content
    patched = client.patch(f'/api/jobs/{job_id}', json={'title': 'Renamed', 'favorite': True}, headers=headers)
    assert patched.json()['title'] == 'Renamed' and patched.json()['favorite']
    refined = client.post(f'/api/jobs/{job_id}/refine', json={'options': {'transpose': 2}}, headers=headers)
    assert refined.status_code == 202
    new_id = refined.json()['id']
    for _ in range(400):
        result = client.get(f'/api/jobs/{new_id}').json()
        if result['status'] in {'completed', 'failed'}: break
        time.sleep(.05)
    assert result['status'] == 'completed', result
    assert {n['pitch'] for n in client.get(f'/api/jobs/{new_id}/notes').json()['notes']} == {50, 62}
    with TestClient(main.app) as stranger:
        stranger.get('/api/session')
        assert stranger.get(f'/api/jobs/{job_id}').status_code == 404
        assert stranger.get(f'/api/jobs/{job_id}/download/midi').status_code == 404
        assert stranger.get('/api/jobs').json()['jobs'] == []
    assert client.delete(f'/api/jobs/{job_id}', headers=headers).status_code == 204
    assert not main.store.job_dir(job_id).exists()


def test_unsupported_upload_and_invalid_youtube_are_actionable(api):
    client, _ = api
    client.get('/api/session'); headers = {'X-MIDICon-Client': 'web'}
    assert client.post('/api/jobs', files={'file': ('test.exe', b'bad', 'application/octet-stream')}, headers=headers).status_code == 415
    assert client.post('/api/jobs/youtube', json={'url': 'http://localhost/secret'}, headers=headers).status_code == 422


def test_normalize_edited_notes_clamps_and_resolves_overlaps():
    notes = normalize_edited_notes([
        {"start": .5, "end": 1.2, "pitch": 60, "velocity": 50, "id": "client-only"},
        {"start": .1, "end": .8, "pitch": 60, "velocity": 200},
        {"start": -1, "end": .2, "pitch": 300, "velocity": 0},
        {"start": "bad", "end": 1, "pitch": 60, "velocity": 80},
    ])
    assert len(notes) == 3
    assert all("id" not in note for note in notes)
    assert notes[0]["pitch"] == 127 and notes[0]["velocity"] == 1
    same_pitch = [note for note in notes if note["pitch"] == 60]
    assert same_pitch[0]["velocity"] == 127
    assert same_pitch[0]["end"] < same_pitch[1]["start"]


def test_api_save_edit_and_library_batch_download(api, monkeypatch):
    client, main = api
    headers = {'X-MIDICon-Client': 'web'}
    client.get('/api/session')
    def fake_transcribe(path, options, progress, cancelled):
        progress(1, 'Done')
        return [{"start": .1, "end": .8, "pitch": 60, "velocity": 80}, {"start": .1, "end": .8, "pitch": 48, "velocity": 70}], 'piano'
    monkeypatch.setattr('webapp.pipeline.transcribe', fake_transcribe)
    sr = 22050; t = np.arange(sr * 2) / sr
    buffer = io.BytesIO(); sf.write(buffer, .2 * np.sin(2 * np.pi * 440 * t), sr, format='WAV')
    response = client.post('/api/jobs', files={'file': ('edit-me.wav', buffer.getvalue(), 'audio/wav')}, data={'options': '{}'}, headers=headers)
    job_id = response.json()['id']
    for _ in range(400):
        job = client.get(f'/api/jobs/{job_id}').json()
        if job['status'] in {'completed', 'failed'}: break
        time.sleep(.05)
    assert job['status'] == 'completed', job
    original_notes = client.get(f'/api/jobs/{job_id}/notes').json()['notes']
    edited_payload = {"title": "Manual piano edit", "notes": [
        {"start": .1, "end": .8, "pitch": 60, "velocity": 110, "id": "a"},
        {"start": .5, "end": 1.2, "pitch": 60, "velocity": 50, "id": "b"},
    ]}
    assert client.post(f'/api/jobs/{job_id}/save-edit', json={"notes": []}, headers=headers).status_code == 422
    saved = client.post(f'/api/jobs/{job_id}/save-edit', json=edited_payload, headers=headers)
    assert saved.status_code == 201, saved.text
    edited = saved.json()
    assert edited['source_type'] == 'edited' and edited['status'] == 'completed'
    assert edited['result']['edited_from'] == job_id and edited['result']['note_count'] == 2
    assert edited['has_audio']
    edited_notes = client.get(f"/api/jobs/{edited['id']}/notes").json()['notes']
    assert [note['velocity'] for note in edited_notes] == [110, 50]
    assert edited_notes[0]['end'] < edited_notes[1]['start']
    assert client.get(f'/api/jobs/{job_id}/notes').json()['notes'] == original_notes
    assert client.get(f"/api/jobs/{edited['id']}/download/midi").content[:4] == b'MThd'
    batch = client.get('/api/library/download')
    assert batch.status_code == 200 and batch.headers['content-type'].startswith('application/zip')
    with zipfile.ZipFile(io.BytesIO(batch.content)) as archive:
        names = archive.namelist()
        assert len([name for name in names if name.startswith('midi/') and name.endswith('.mid')]) == 2
        manifest = json.loads(archive.read('manifest.json'))
        assert {item['id'] for item in manifest['jobs']} == {job_id, edited['id']}
    with TestClient(main.app) as stranger:
        stranger.get('/api/session')
        assert stranger.post(f'/api/jobs/{job_id}/save-edit', json=edited_payload, headers=headers).status_code == 404
        assert stranger.get('/api/library/download').status_code == 409
