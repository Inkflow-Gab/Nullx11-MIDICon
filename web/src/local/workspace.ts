import { DEFAULT_OPTIONS, isActive } from '../types';
import type { Job, Note, Options, Result, Session } from '../types';
import { BROWSER_EXTENSIONS, BROWSER_MAX_BYTES, BROWSER_MAX_SECONDS, decodeAudio } from './decode';
import { estimateKey } from './notes';
import { exportMidi, libraryZip, normalizeEdits, notesCsv, notesJson, packageZip, refineNotes, safeOptions } from './midi';

type LocalRecord = Job & { audio: Blob; rawNotes: Note[]; notes: Note[]; midi: Uint8Array; sourceDuration: number; sourceTempo: number };
const DATABASE = 'midicon-browser-v1';
const cache = new Map<string, LocalRecord>();
const urls = new Map<string, string>();
const listeners = new Set<() => void>();
const cancelled = new Set<string>();
let active: { id: string; worker?: Worker; reject?: (reason: Error) => void } | null = null;
let initialization: Promise<void> | null = null;
let database: IDBDatabase | null = null;

export const browserSession: Session = {
  workspace_id: 'this-device', retention_days: 0, max_upload_mb: 100, max_duration_seconds: BROWSER_MAX_SECONDS, max_jobs: 40,
  engines: [{ id: 'basic', name: 'Basic Pitch · browser', description: 'Spotify Basic Pitch · runs privately on this device', ready: true }],
  extensions: BROWSER_EXTENSIONS, scope: 'device', authentication: 'local-device',
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('Private device storage is unavailable. Enable site storage or use the full server.')); return; }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { const store = request.result.createObjectStore('jobs', { keyPath: 'id' }); store.createIndex('created_at', 'created_at'); };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(new Error('Device storage is blocked. Allow site storage in your browser, then reload.'));
    request.onblocked = () => reject(new Error('Close other MIDICon tabs, then reload to unlock device storage.'));
  });
}
async function ready() {
  if (!initialization) initialization = (async () => {
    database = await openDatabase();
    const records = await new Promise<LocalRecord[]>((resolve, reject) => { const request = database!.transaction('jobs').objectStore('jobs').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    for (const record of records) {
      if (isActive(record)) { record.status = 'failed'; record.error = 'The page closed before conversion finished. Your audio is saved; choose Try again.'; record.stage = 'Ready for another take'; record.updated_at = Date.now() / 1000; await write(record); }
      cache.set(record.id, record); prepareUrls(record);
    }
  })().catch(error => { initialization = null; throw error; });
  await initialization;
}
function write(record: LocalRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!database) { reject(new Error('Device storage is not ready.')); return; }
    const transaction = database.transaction('jobs', 'readwrite');
    transaction.objectStore('jobs').put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error('Device storage is full or unavailable. Download your MIDI, delete old conversions, and try again.'));
    transaction.onabort = () => reject(new Error('The device-storage transaction was interrupted. Please try again.'));
  });
}
function publicJob(record: LocalRecord): Job {
  const { audio: _audio, rawNotes: _raw, notes: _notes, midi: _midi, sourceDuration: _duration, sourceTempo: _tempo, ...job } = record;
  return job;
}
function emit() { listeners.forEach(listener => listener()); }
function storageFailure(error: unknown) {
  const message = error instanceof Error ? error.message : 'Device storage is full or unavailable. Download your MIDI and delete older conversions.';
  window.dispatchEvent(new CustomEvent('midicon-storage-error', { detail: message }));
}
export function subscribeBrowserJobs(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function urlKey(id: string, format: string) { return `${id}:${format}`; }
function setUrl(id: string, format: string, data: BlobPart, type: string) {
  const key = urlKey(id, format); const previous = urls.get(key); if (previous) URL.revokeObjectURL(previous);
  urls.set(key, URL.createObjectURL(new Blob([data], { type })));
}
function prepareUrls(record: LocalRecord) {
  if (record.status !== 'completed') return;
  setUrl(record.id, 'audio', record.audio, record.audio.type || 'audio/wav');
  setUrl(record.id, 'midi', record.midi.buffer as ArrayBuffer, 'audio/midi');
  setUrl(record.id, 'json', notesJson(record.notes), 'application/json');
  setUrl(record.id, 'csv', notesCsv(record.notes), 'text/csv');
  setUrl(record.id, 'zip', packageZip(record, record.notes, record.midi), 'application/zip');
}
export function browserDownloadUrl(id: string, format = 'midi') { return urls.get(urlKey(id, format)) || ''; }
async function update(id: string, values: Partial<LocalRecord>) {
  const current = cache.get(id); if (!current) throw new Error('This conversion is no longer on this device.');
  const record = { ...current, ...values, updated_at: Date.now() / 1000 };
  await write(record); cache.set(id, record); prepareUrls(record); emit(); return publicJob(record);
}
function checkCancelled(id: string) { if (cancelled.has(id)) throw new DOMException('Conversion cancelled', 'AbortError'); }
async function capacity(bytes: number) {
  if (navigator.storage?.estimate) { const { usage = 0, quota = Infinity } = await navigator.storage.estimate(); if (quota - usage < bytes + 10 * 1024 * 1024) throw new Error('There is not enough device storage. Download and delete older conversions first.'); }
}
async function create(file: Blob, title: string, sourceType: Job['source_type'], options: Options) {
  await ready(); options = safeOptions(options);
  if (options.engine === 'piano') throw new Error('The piano specialist needs the full server. Browser mode uses Basic Pitch; choose Auto or Polyphonic.');
  if (active) throw new Error('Let the current browser conversion finish or cancel it first.');
  if (cache.size >= browserSession.max_jobs) throw new Error('Your device library is full. Download and delete an older conversion first.');
  if (file.size > BROWSER_MAX_BYTES || file.size < 32) throw new Error('Choose a nonempty audio file smaller than 100 MB.');
  await capacity(file.size);
  const now = Date.now() / 1000;
  const record: LocalRecord = { id: crypto.randomUUID(), title: title.slice(0, 160), source_type: sourceType, source_url: '', source_name: file instanceof File ? file.name : 'little-steps.wav', status: 'queued', progress: 0, stage: 'Starting on this device', detail: 'Your audio stays in this browser', error: null, options, result: null, waveform: null, events: [{ time: now, message: 'Added to this device’s queue' }], favorite: false, created_at: now, updated_at: now, completed_at: null, has_audio: false, queue_position: 1, audio: file, rawNotes: [], notes: [], midi: new Uint8Array(), sourceDuration: 0, sourceTempo: 120 };
  await write(record); cache.set(record.id, record); emit(); void run(record.id); return publicJob(record);
}
async function run(id: string) {
  const record = cache.get(id)!;
  const controller: NonNullable<typeof active> = { id }; active = controller; cancelled.delete(id);
  try {
    await update(id, { status: 'preparing', progress: 12, stage: 'Preparing your audio', detail: 'Decoding and resampling entirely on this device' });
    const decoded = await decodeAudio(record.audio, record.options); checkCancelled(id);
    await update(id, { progress: 28, waveform: decoded.waveform, has_audio: true, sourceDuration: decoded.duration, detail: `${decoded.duration.toFixed(1)} seconds prepared · loading the browser model` });
    const raw = await new Promise<{ notes: Note[]; tempo: number }>((resolve, reject) => {
      const worker = new Worker(new URL('./transcription.worker.ts', import.meta.url), { type: 'module' });
      controller.worker = worker; controller.reject = reject;
      worker.onmessage = event => {
        const message = event.data;
        if (message.type === 'progress') void update(id, { status: 'transcribing', progress: 31 + message.value * 56, stage: 'Listening for every note', detail: message.detail }).catch(reject);
        else if (message.type === 'complete') { worker.terminate(); controller.worker = undefined; resolve({ notes: message.notes, tempo: message.tempo }); }
        else if (message.type === 'error') { worker.terminate(); controller.worker = undefined; reject(new Error(message.message)); }
      };
      worker.onerror = () => { worker.terminate(); reject(new Error('The browser engine could not start. Use an up-to-date Chrome, Edge, Firefox, or Safari with WebAssembly enabled.')); };
      worker.postMessage({ audio: decoded.audio, sensitivity: record.options.sensitivity, base: new URL(import.meta.env.BASE_URL, window.location.href).href }, [decoded.audio.buffer]);
    });
    checkCancelled(id);
    await update(id, { rawNotes: raw.notes, sourceTempo: raw.tempo });
    await finishRefinement(id, record.options, raw.notes, decoded.duration, raw.tempo, false);
  } catch (error) {
    try {
      if (cancelled.has(id) || (error instanceof DOMException && error.name === 'AbortError')) await update(id, { status: 'cancelled', stage: 'Conversion cancelled', detail: 'Your audio is saved on this device. Retry whenever you’re ready.', error: null, completed_at: Date.now() / 1000 });
      else await update(id, { status: 'failed', stage: 'This one needs another take', detail: 'Your audio is saved on this device.', error: error instanceof Error ? error.message : 'Browser transcription failed. Try a shorter WAV or MP3.', completed_at: Date.now() / 1000 });
    } catch (storageError) { storageFailure(storageError); }
  } finally { controller.worker?.terminate(); if (active === controller) active = null; cancelled.delete(id); emit(); }
}
async function finishRefinement(id: string, options: Options, raw: Note[], duration: number, detectedTempo: number, refinement: boolean) {
  await update(id, { status: 'refining', progress: 90, stage: 'Putting the notes together', detail: 'Cleaning boundaries, preserving chords, and estimating key' });
  const tempo = options.tempo || detectedTempo;
  const refined = refineNotes(raw, options, tempo);
  if (!refined.notes.length) throw new Error('No confident notes were found. Try a cleaner recording, raise sensitivity, or shorten the shortest-note setting.');
  const current = cache.get(id)!;
  const result: Result = { ...refined.stats, duration, tempo, key: estimateKey(refined.notes), engine: 'basic', engine_name: 'Basic Pitch · browser', lowest_pitch: Math.min(...refined.notes.map(note => note.pitch)), highest_pitch: Math.max(...refined.notes.map(note => note.pitch)), tempo_is_estimate: !options.tempo, key_is_estimate: true, meter: '4/4 (export default)', pedal_detected: false };
  const midi = exportMidi(refined.notes, tempo, options, current.title);
  checkCancelled(id);
  await update(id, { status: 'completed', progress: 100, stage: 'Your MIDI is ready', detail: refinement ? 'Refined without running the model again' : 'Created privately on this device', result, notes: refined.notes, midi, waveform: current.waveform, has_audio: true, completed_at: Date.now() / 1000, error: null });
}
export async function browserJobs() { await ready(); return [...cache.values()].sort((a, b) => b.created_at - a.created_at).map(publicJob); }
export async function browserNotes(id: string) { await ready(); const record = cache.get(id); if (!record || record.status !== 'completed') throw new Error('The notes are not ready yet.'); return record.notes; }
export async function browserUpload(file: File, options: Options) {
  const extension = '.' + file.name.split('.').pop()?.toLowerCase();
  if (!BROWSER_EXTENSIONS.includes(extension)) throw new Error('Try MP3, WAV, M4A, MP4, FLAC, OGG, OPUS, AAC, WEBM, or AIFF.');
  return create(file, file.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim() || 'Untitled transcription', 'upload', options);
}
export async function browserDemo(options: Options) {
  const response = await fetch(new URL('demo.wav', document.baseURI));
  if (!response.ok) throw new Error('The demo could not load. Reconnect and try again.');
  return create(await response.blob(), 'Little steps · original demo', 'demo', options);
}
export async function browserCancel(id: string) {
  await ready(); const record = cache.get(id); if (!record) throw new Error('Conversion not found.');
  if (!isActive(record)) return publicJob(record);
  cancelled.add(id); active?.worker?.terminate(); active?.reject?.(new DOMException('Conversion cancelled', 'AbortError'));
  return update(id, { status: 'cancelled', stage: 'Conversion cancelled', detail: 'Your audio is saved. Retry whenever you’re ready.', completed_at: Date.now() / 1000, error: null });
}
export async function browserRetry(id: string, options?: Options) {
  await ready(); if (active) throw new Error('Let the current conversion finish first.'); const record = cache.get(id);
  if (!record || !['failed', 'cancelled'].includes(record.status)) throw new Error('Use Refine for a completed conversion.');
  const nextOptions = safeOptions(options || record.options);
  if (nextOptions.engine === 'piano') throw new Error('The piano specialist needs the full server. Choose Auto or Polyphonic.');
  await update(id, { status: 'queued', progress: 0, error: null, result: null, completed_at: null, options: nextOptions }); void run(id); return publicJob(cache.get(id)!);
}
export async function browserRefine(id: string, options: Options) {
  await ready(); if (active) throw new Error('Let the current conversion finish first.'); const source = cache.get(id);
  if (!source || source.status !== 'completed') throw new Error('Only completed conversions can be refined.');
  options = safeOptions(options);
  if (options.engine === 'piano') throw new Error('Choose Auto or Polyphonic to refine a browser conversion.');
  options.start_seconds = source.options.start_seconds; options.duration_seconds = source.options.duration_seconds;
  await capacity(source.audio.size);
  const now = Date.now() / 1000;
  const record: LocalRecord = { ...source, id: crypto.randomUUID(), title: source.title.replace(/ · refined$/, '').slice(0, 145) + ' · refined', source_type: 'refined', options, status: 'refining', progress: 90, stage: 'Applying your note settings', detail: 'Reusing the original browser analysis', result: null, favorite: false, created_at: now, updated_at: now, completed_at: now, error: null, notes: [], midi: new Uint8Array() };
  await write(record); cache.set(record.id, record); emit();
  try { await finishRefinement(record.id, options, source.rawNotes, source.sourceDuration, source.sourceTempo, true); }
  catch (error) {
    try { await update(record.id, { status: 'failed', error: error instanceof Error ? error.message : 'Refinement failed.', stage: 'Refinement needs another take' }); }
    catch (storageError) { storageFailure(storageError); }
  }
  return publicJob(cache.get(record.id)!);
}
export async function browserSaveEdit(id: string, raw: Note[], title?: string) {
  await ready(); const source = cache.get(id); if (!source || source.status !== 'completed') throw new Error('Only completed conversions can be edited.');
  const notes = normalizeEdits(raw); if (!notes.length) throw new Error('Keep at least one valid note.');
  await capacity(source.audio.size);
  const now = Date.now() / 1000; const name = title?.trim() || source.title.replace(/ · edited$/, '').slice(0, 145) + ' · edited';
  const result: Result = { ...source.result!, note_count: notes.length, raw_note_count: notes.length, merged_notes: 0, filtered_notes: 0, duration: Math.max(source.sourceDuration, ...notes.map(note => note.end)), lowest_pitch: Math.min(...notes.map(note => note.pitch)), highest_pitch: Math.max(...notes.map(note => note.pitch)), edited_from: id };
  const record: LocalRecord = { ...source, id: crypto.randomUUID(), title: name.slice(0, 160), source_type: 'edited', status: 'completed', progress: 100, stage: 'Your edited version is ready', detail: 'The original is unchanged', notes, rawNotes: notes, result, midi: exportMidi(notes, source.result!.tempo, source.options, name), favorite: false, created_at: now, updated_at: now, completed_at: now, error: null };
  await write(record); cache.set(record.id, record); prepareUrls(record); emit(); return publicJob(record);
}
export async function browserPatch(id: string, values: { title?: string; favorite?: boolean }) {
  await ready(); const current = cache.get(id); if (!current) throw new Error('Conversion not found.');
  const title = values.title?.trim().slice(0, 160) || current.title;
  const record = await update(id, { title, favorite: values.favorite ?? current.favorite });
  if (current.status === 'completed') { const full = cache.get(id)!; await update(id, { midi: exportMidi(full.notes, full.result!.tempo, full.options, title) }); }
  return record;
}
function revoke(id: string) { for (const [key, url] of urls) if (key.startsWith(`${id}:`)) { URL.revokeObjectURL(url); urls.delete(key); } }
export async function browserDelete(id: string) {
  await ready(); if (active?.id === id) throw new Error('Cancel this conversion before deleting it.');
  await new Promise<void>((resolve, reject) => { const transaction = database!.transaction('jobs', 'readwrite'); transaction.objectStore('jobs').delete(id); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
  cache.delete(id); revoke(id); emit();
}
export async function browserClear() {
  await ready(); let deleted = 0;
  for (const record of cache.values()) if (!isActive(record)) { await browserDelete(record.id); deleted++; }
  return { deleted };
}
export async function browserLibraryDownload() {
  await ready(); const records = [...cache.values()].filter(record => record.status === 'completed').sort((a, b) => b.created_at - a.created_at);
  if (!records.length) throw new Error('Convert a song first. Your library has no MIDI files yet.');
  return new Blob([libraryZip(records.map(publicJob), records) as BlobPart], { type: 'application/zip' });
}
export function browserDefaults() { return { ...DEFAULT_OPTIONS }; }
