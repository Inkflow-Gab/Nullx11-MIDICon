/*
 * Browser note decoder adapted from Spotify Basic Pitch note_creation.py.
 * Copyright 2022 Spotify AB. Apache-2.0; see public/models/LICENSE and NOTICE.
 * This port implements polyphonic onset/frame decoding and the melodia pass;
 * pitch-bend synthesis and the Python audio/MIDI dependencies are not used.
 */
import type { Note } from '../types';
export const SAMPLE_RATE = 22050;
export const FFT_HOP = 256;
export const WINDOW_SAMPLES = SAMPLE_RATE * 2 - FFT_HOP;
export const OVERLAP = 30 * FFT_HOP;
export const STRIDE = WINDOW_SAMPLES - OVERLAP;
export const FRAME_COUNT = 172;
export const TRIM = 15;
export const UNWRAPPED_FRAMES = FRAME_COUNT - 2 * TRIM;

export function decodeNotes(frames: Float32Array, onsets: Float32Array, count: number, onsetThreshold: number, frameThreshold = 0.3, minNoteLength = 3): Note[] {
  const width = 88, energyTolerance = 11;
  if (count < 2 || frames.length !== count * width || onsets.length !== frames.length) throw new Error('The model returned an invalid note matrix.');
  const activation = new Float32Array(onsets);
  // Infer re-articulations from positive changes in adjacent frame activations.
  let maxOnset = 0, maxDiff = 0;
  const differences = new Float32Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    maxOnset = Math.max(maxOnset, activation[i]);
    if (i < 2) continue;
    const a = frames[i] - frames[i - width];
    const b = frames[i] - frames[i - 2 * width];
    const value = Math.max(0, Math.min(a, b));
    differences[i] = value;
    maxDiff = Math.max(maxDiff, value);
  }
  if (maxDiff > 0) for (let i = 0; i < activation.length; i++) activation[i] = Math.max(activation[i], maxOnset * differences[i] / maxDiff);
  const peaks: number[] = [];
  for (let t = 1; t < count - 1; t++) for (let p = 0; p < width; p++) {
    const i = t * width + p;
    if (activation[i] >= onsetThreshold && activation[i] > activation[i - width] && activation[i] > activation[i + width]) peaks.push(i);
  }
  const remaining = new Float32Array(frames);
  const notes: Note[] = [];
  const clear = (from: number, to: number, pitch: number) => {
    for (let t = from; t < to; t++) for (let p = Math.max(0, pitch - 1); p <= Math.min(width - 1, pitch + 1); p++) remaining[t * width + p] = 0;
  };
  const average = (from: number, to: number, pitch: number) => {
    let sum = 0;
    for (let t = from; t < to; t++) sum += frames[t * width + pitch];
    return sum / Math.max(1, to - from);
  };
  const add = (from: number, to: number, pitch: number) => {
    if (to - from <= minNoteLength) return;
    const start = frameTime(from), end = frameTime(to);
    notes.push({ start, end, pitch: pitch + 21, velocity: Math.max(1, Math.min(127, Math.round(average(from, to, pitch) * 127))) });
  };
  for (let index = peaks.length - 1; index >= 0; index--) {
    const peak = peaks[index], from = Math.floor(peak / width), pitch = peak % width;
    let t = from + 1, quiet = 0;
    while (t < count - 1 && quiet < energyTolerance) { if (remaining[t * width + pitch] < frameThreshold) quiet++; else quiet = 0; t++; }
    const to = t - quiet;
    if (to - from <= minNoteLength) continue;
    clear(from, to, pitch);
    add(from, to, pitch);
  }
  // Recover sustained energy not assigned by an onset, suppressing adjacent bins.
  for (;;) {
    let maximum = frameThreshold, peak = -1;
    for (let i = 0; i < remaining.length; i++) if (remaining[i] > maximum) { maximum = remaining[i]; peak = i; }
    if (peak < 0) break;
    const middle = Math.floor(peak / width), pitch = peak % width;
    remaining[peak] = 0;
    let t = middle + 1, quiet = 0;
    while (t < count - 1 && quiet < energyTolerance) {
      const i = t * width + pitch;
      if (remaining[i] < frameThreshold) quiet++; else quiet = 0;
      remaining[i] = 0;
      if (pitch < width - 1) remaining[i + 1] = 0;
      if (pitch > 0) remaining[i - 1] = 0;
      t++;
    }
    const to = t - 1 - quiet;
    t = middle - 1; quiet = 0;
    while (t > 0 && quiet < energyTolerance) {
      const i = t * width + pitch;
      if (remaining[i] < frameThreshold) quiet++; else quiet = 0;
      remaining[i] = 0;
      if (pitch < width - 1) remaining[i + 1] = 0;
      if (pitch > 0) remaining[i - 1] = 0;
      t--;
    }
    const from = t + 1 + quiet;
    add(from, to, pitch);
  }
  return notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

export function frameTime(frame: number): number {
  // Matches the vendored server decoder's window-offset compensation.
  const windowOffset = (FFT_HOP / SAMPLE_RATE) * (FRAME_COUNT - WINDOW_SAMPLES / FFT_HOP) + 0.0018;
  return frame * FFT_HOP / SAMPLE_RATE - windowOffset * Math.floor(frame / FRAME_COUNT);
}

export function estimateKey(notes: Note[]): string {
  const histogram = Array(12).fill(0) as number[];
  for (const note of notes) histogram[note.pitch % 12] += Math.min(3, note.end - note.start);
  const major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minor = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const names = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const correlation = (profile: number[], shift: number) => {
    const mean = histogram.reduce((a, b) => a + b, 0) / 12;
    const profileMean = profile.reduce((a, b) => a + b, 0) / 12;
    let numerator = 0, a2 = 0, b2 = 0;
    for (let i = 0; i < 12; i++) { const a = histogram[i] - mean, b = profile[(i - shift + 12) % 12] - profileMean; numerator += a * b; a2 += a * a; b2 += b * b; }
    return numerator / Math.sqrt(a2 * b2 || 1);
  };
  let best = -Infinity, key = 'Unknown';
  names.forEach((name, shift) => { for (const [profile, mode] of [[major, 'major'], [minor, 'minor']] as const) { const score = correlation([...profile], shift); if (score > best) { best = score; key = `${name} ${mode}`; } } });
  return key;
}

export function estimateTempo(audio: Float32Array): number {
  const envelope: number[] = [];
  for (let i = 0; i < audio.length; i += FFT_HOP) {
    let sum = 0; const end = Math.min(audio.length, i + FFT_HOP);
    for (let j = i; j < end; j++) sum += audio[j] * audio[j];
    envelope.push(Math.sqrt(sum / (end - i)));
  }
  const flux = envelope.map((value, i) => Math.max(0, value - (envelope[i - 1] || 0)));
  let best = 0, tempo = 120;
  for (let lag = 37; lag <= 129; lag++) {
    let score = 0, normalizer = 0;
    for (let i = lag; i < flux.length; i++) { score += flux[i] * flux[i - lag]; normalizer += flux[i] * flux[i] + flux[i - lag] * flux[i - lag]; }
    const bpm = 60 / (lag * FFT_HOP / SAMPLE_RATE);
    score = score / (normalizer || 1) * (1 - 0.08 * Math.abs(Math.log2(bpm / 110)));
    if (score > best) { best = score; tempo = bpm; }
  }
  return Math.round(tempo * 10) / 10;
}
