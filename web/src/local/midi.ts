import { zipSync, strToU8 } from 'fflate';
import type { AiAnalysis, Job, Note, Options } from '../types';
import { DEFAULT_OPTIONS } from '../types';

const clamp = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
export function safeOptions(input: Partial<Options> = {}): Options {
  const o = { ...DEFAULT_OPTIONS, ...input };
  return { ...o,
    engine: o.engine === 'piano' ? 'piano' : o.engine === 'basic' ? 'basic' : 'auto',
    sensitivity: clamp(o.sensitivity, 10, 90, 60), min_duration_ms: clamp(o.min_duration_ms, 20, 1000, 30), merge_gap_ms: clamp(o.merge_gap_ms, 0, 500, 20),
    cleanup: o.cleanup === 'light' ? 'light' : o.cleanup === 'clean' ? 'clean' : 'balanced',
    transpose: Math.round(clamp(o.transpose, -12, 12, 0)), quantize: ['off', '1/4', '1/8', '1/16'].includes(o.quantize) ? o.quantize : 'off',
    tempo: o.tempo == null ? null : clamp(o.tempo, 40, 240, 120), start_seconds: clamp(o.start_seconds, 0, 3600, 0),
    duration_seconds: o.duration_seconds == null ? null : clamp(o.duration_seconds, 0.2, 600, 90),
    sustain: !!o.sustain, preserve_dynamics: !!o.preserve_dynamics, split_tracks: !!o.split_tracks, piano_range: !!o.piano_range,
    ai_assist: !!o.ai_assist, ai_align: !!o.ai_assist && !!o.ai_align,
  };
}

export function alignNotesToGrid(notes: Note[], ai: AiAnalysis, tolerance = 0.085): { notes: Note[]; moved: number } {
  const interval = ai.beat_interval;
  if (!ai.beats.length || !interval || interval <= 0) return { notes, moved: 0 };
  const step = interval / 2;
  const first = ai.beats[0];
  const last = Math.max(ai.beats[ai.beats.length - 1], ...notes.map(note => note.end)) + step;
  const grid: number[] = [];
  for (let time = first; time <= last + 1e-6; time += step) grid.push(time);
  let moved = 0;
  const adjusted = notes.map(note => {
    let best = grid[0], distance = Math.abs(note.start - best);
    for (const time of grid) { const d = Math.abs(note.start - time); if (d < distance) { distance = d; best = time; } }
    const delta = best - note.start;
    if (Math.abs(delta) > tolerance || best < 0) return note;
    if (Math.abs(delta) > 1e-9) moved++;
    const duration = note.end - note.start;
    return { ...note, start: Math.round(best * 1e5) / 1e5, end: Math.round(Math.max(best + 0.005, best + duration) * 1e5) / 1e5 };
  });
  return { notes: adjusted, moved };
}

export function refineNotes(raw: Note[], options: Options, tempo: number, ai?: AiAnalysis | null) {
  const profile = options.cleanup || 'balanced';
  const minimum = Math.max(options.min_duration_ms, profile === 'clean' ? 60 : 0) / 1000;
  const gap = Math.max(options.merge_gap_ms, profile === 'clean' ? 35 : 0) / 1000;
  let notes = raw.map(note => ({ start: note.start, end: note.end, pitch: note.pitch + options.transpose, velocity: options.preserve_dynamics ? Math.max(1, Math.min(127, Math.round(note.velocity))) : 80 }))
    .filter(note => note.end > note.start && note.pitch >= 0 && note.pitch <= 127 && (!options.piano_range || (note.pitch >= 21 && note.pitch <= 108)));
  if (options.quantize !== 'off') {
    const grid = 60 / tempo * ({ '1/4': 1, '1/8': 0.5, '1/16': 0.25 }[options.quantize]);
    notes = notes.map(note => { const start = Math.round(note.start / grid) * grid; return { ...note, start, end: Math.max(start + grid, Math.round(note.end / grid) * grid) }; });
  }
  if (options.sustain) notes.forEach(note => { note.end += 0.2; });
  notes.sort((a, b) => a.pitch - b.pitch || a.start - b.start || a.end - b.end);
  const merged: Note[] = []; let mergeCount = 0; let previous: Note | undefined;
  for (const note of notes) {
    if (previous?.pitch === note.pitch && note.start - previous.end >= -0.012 && note.start - previous.end <= gap) { previous.end = Math.max(previous.end, note.end); previous.velocity = Math.max(previous.velocity, note.velocity); mergeCount++; }
    else { previous = { ...note }; merged.push(previous); }
  }
  let cleaned = merged.filter(note => note.end - note.start >= minimum);
  if (profile === 'clean') {
    // Remove only very weak, very short artifacts; kept conservative so quiet
    // real notes are not discarded just for being soft.
    cleaned = cleaned.filter(note => !(note.velocity < 16 && note.end - note.start < 0.12));
    // Suppress likely harmonic ghosts: a much weaker upper partial sitting on
    // top of a stronger fundamental for most of its life. Real octave melody
    // notes usually have comparable velocity and survive this test.
    const lower = cleaned.filter(note => note.velocity >= 24).sort((a, b) => b.velocity - a.velocity);
    cleaned = cleaned.filter(note => {
      const duration = note.end - note.start;
      if (duration < 0.05 || note.velocity >= 40) return true;
      for (const base of lower) {
        if (base === note || base.pitch >= note.pitch) continue;
        const interval = note.pitch - base.pitch;
        if (interval !== 12 && interval !== 19 && interval !== 24 && interval !== 28) continue;
        if (note.velocity > base.velocity * 0.55) continue;
        const overlap = Math.min(note.end, base.end) - Math.max(note.start, base.start);
        if (overlap >= duration * 0.7 && base.end - base.start >= duration * 0.8) return false;
      }
      return true;
    });
  }
  previous = undefined;
  for (const note of cleaned) { if (previous?.pitch === note.pitch) previous.end = Math.min(previous.end, Math.max(previous.start + 0.005, note.start - 0.003)); previous = note; }
  let result = cleaned.filter(note => note.end - note.start >= 0.005).sort((a, b) => a.start - b.start || a.pitch - b.pitch).map(note => ({ ...note, start: Math.round(note.start * 1e5) / 1e5, end: Math.round(note.end * 1e5) / 1e5 }));
  let aligned = 0;
  if (ai && options.ai_align) { const polish = alignNotesToGrid(result, ai); result = polish.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch); aligned = polish.moved; }
  return { notes: result, stats: { raw_note_count: raw.length, merged_notes: mergeCount, filtered_notes: raw.length - result.length, note_count: result.length, ...(ai ? { ai_aligned_notes: aligned } : {}) } };
}

export function normalizeEdits(raw: Note[]): Note[] {
  const notes = raw.filter(note => [note.start, note.end, note.pitch, note.velocity].every(Number.isFinite)).map(note => ({ start: Math.max(0, note.start), end: Math.max(note.start + 0.005, note.end), pitch: Math.round(Math.max(0, Math.min(127, note.pitch))), velocity: Math.round(Math.max(1, Math.min(127, note.velocity))) })).sort((a, b) => a.pitch - b.pitch || a.start - b.start);
  let previous: Note | undefined;
  for (const note of notes) { if (previous?.pitch === note.pitch) previous.end = Math.min(previous.end, Math.max(previous.start + 0.005, note.start - 0.003)); previous = note; }
  return notes.filter(note => note.end - note.start >= 0.005).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

const variable = (value: number) => {
  const bytes = [value & 127];
  while ((value >>>= 7)) bytes.unshift((value & 127) | 128);
  return bytes;
};
const uint32 = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const uint16 = (value: number) => [(value >>> 8) & 255, value & 255];
const text = (value: string) => Array.from(new TextEncoder().encode(value));
function track(events: number[][]) {
  const data = events.flat();
  return [...text('MTrk'), ...uint32(data.length), ...data];
}
export function exportMidi(notes: Note[], tempo: number, options: Options, title: string): Uint8Array {
  const ticks = 480;
  const micros = Math.round(60_000_000 / tempo);
  const conductor = [[0, 0xff, 0x03, ...variable(text(title).length), ...text(title)], [0, 0xff, 0x51, 3, (micros >> 16) & 255, (micros >> 8) & 255, micros & 255], [0, 0xff, 0x58, 4, 4, 2, 24, 8], [0, 0xff, 0x2f, 0]];
  const groups: { name: string; notes: Note[] }[] = options.split_tracks ? [{ name: 'Piano - upper register', notes: notes.filter(note => note.pitch >= 60) }, { name: 'Piano - lower register', notes: notes.filter(note => note.pitch < 60) }] : [{ name: 'Piano', notes }];
  const tracks = [track(conductor)];
  for (const group of groups) {
    const events: { tick: number; off: boolean; data: number[] }[] = [{ tick: 0, off: false, data: [0xff, 0x03, ...variable(text(group.name).length), ...text(group.name)] }, { tick: 0, off: false, data: [0xc0, 0] }];
    for (const note of group.notes) {
      const start = Math.max(0, Math.round(note.start * tempo / 60 * ticks));
      const end = Math.max(start + 1, Math.round(note.end * tempo / 60 * ticks));
      events.push({ tick: start, off: false, data: [0x90, note.pitch, note.velocity] }, { tick: end, off: true, data: [0x80, note.pitch, 0] });
    }
    events.sort((a, b) => a.tick - b.tick || Number(b.off) - Number(a.off));
    let last = 0;
    const encoded = events.map(event => { const delta = variable(event.tick - last); last = event.tick; return [...delta, ...event.data]; });
    encoded.push([0, 0xff, 0x2f, 0]);
    tracks.push(track(encoded));
  }
  return new Uint8Array([...text('MThd'), ...uint32(6), ...uint16(1), ...uint16(tracks.length), ...uint16(ticks), ...tracks.flat()]);
}

export const notesJson = (notes: Note[]) => JSON.stringify({ format: 'nullx-midicon-notes-v1', time_unit: 'seconds', notes }, null, 2);
export const notesCsv = (notes: Note[]) => 'start,end,pitch,velocity\n' + notes.map(note => [note.start, note.end, note.pitch, note.velocity].join(',')).join('\n');
export const safeStem = (title: string) => title.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'transcription';
export function packageZip(job: Job, notes: Note[], midi: Uint8Array) {
  const stem = safeStem(job.title);
  return zipSync({
    [`${stem}.mid`]: midi, [`${stem}.json`]: strToU8(notesJson(notes)), [`${stem}.csv`]: strToU8(notesCsv(notes)),
    'transcription-settings.json': strToU8(JSON.stringify({ options: job.options, result: job.result }, null, 2)),
    'README.txt': strToU8(`Nullx MIDICon\nAutomatic transcription is an estimate, not a verified score. Tempo/key are estimates; meter defaults to 4/4 unless AI Assist reports a 3/4 or 4/4 estimate. Upper/lower tracks split at C4, not by hand.\nTranscription models: Kong piano specialist (CC BY 4.0) and/or Spotify Basic Pitch (Apache-2.0).\n${job.result?.ai ? 'AI Assist: Beat This! small0 (MIT), run locally for beat/downbeat analysis. https://github.com/CPJKU/beat_this\n' : ''}`),
  }, { level: 6 });
}
export function libraryZip(jobs: Job[], records: { notes: Note[]; midi: Uint8Array }[]) {
  const files: Record<string, Uint8Array> = {}; const manifest: unknown[] = []; const used = new Set<string>();
  jobs.forEach((job, index) => {
    const stem = safeStem(job.title); let name = stem, suffix = 1;
    while (used.has(name)) name = `${stem}-${++suffix}`;
    used.add(name);
    files[`midi/${name}.mid`] = records[index].midi;
    files[`notes/${name}.json`] = strToU8(notesJson(records[index].notes));
    manifest.push({ id: job.id, title: job.title, midi: `midi/${name}.mid`, notes: `notes/${name}.json`, result: job.result, options: job.options });
  });
  files['manifest.json'] = strToU8(JSON.stringify({ format: 'nullx-midicon-library-v1', jobs: manifest }, null, 2));
  files['README.txt'] = strToU8('Nullx MIDICon browser library. MIDI is an estimate, not a verified score. See manifest.json for settings and estimates.');
  return zipSync(files, { level: 6 });
}
