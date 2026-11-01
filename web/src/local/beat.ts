/*
 * Local Beat This! small0 front end and beat-grid helpers.
 * Model: CPJKU Beat This! (Foscarin, Schlüter & Widmer, ISMIR 2024), MIT.
 * The log-mel constants mirror beat_this.preprocessing.LogMelSpect; the peak
 * picker is a conservative NMS variant of the upstream minimal postprocessor.
 * This file contains no network calls and no training: it only prepares audio
 * for the optional, already-downloaded ONNX model and interprets its outputs.
 */
import type { AiAnalysis } from '../types';

export const BEAT_SAMPLE_RATE = 22050;
export const BEAT_FPS = 50;
export const BEAT_N_FFT = 1024;
export const BEAT_HOP = 441;
export const BEAT_N_MELS = 128;
export const BEAT_CHUNK = 1500;
export const BEAT_BORDER = 6;
export const BEAT_MODEL_BYTES = 10_555_591;
export const BEAT_MODEL_KEY = 'models/beat-this/beat-this-small0.onnx';
export const BEAT_MODEL_SHA256 = '0d8dd8c9d59922a04f48e61848d21be316480b5d4ddef678f7b96fed56a4e512';

const F_MIN = 30, F_MAX = 11000, N_BINS = BEAT_N_FFT / 2 + 1;
const SLANEY_HZ_PER_MEL = 200 / 3;
const SLANEY_MIN_LOG_MEL = 15;
const SLANEY_LOG_STEP = Math.log(6.4) / 27;

function hzToMel(hz: number) { return hz < 1000 ? hz / SLANEY_HZ_PER_MEL : SLANEY_MIN_LOG_MEL + Math.log(hz / 1000) / SLANEY_LOG_STEP; }
function melToHz(mel: number) { return mel < SLANEY_MIN_LOG_MEL ? mel * SLANEY_HZ_PER_MEL : 1000 * Math.exp(SLANEY_LOG_STEP * (mel - SLANEY_MIN_LOG_MEL)); }

type Filterbank = { bandStart: Uint32Array; bins: Uint32Array; weights: Float64Array };
let filterbank: Filterbank | null = null;
function slaneyFilterbank(): Filterbank {
  if (filterbank) return filterbank;
  const nyquist = BEAT_SAMPLE_RATE / 2;
  const melMin = hzToMel(F_MIN), melMax = hzToMel(F_MAX);
  const edges = Array.from({ length: BEAT_N_MELS + 2 }, (_, i) => melToHz(melMin + (melMax - melMin) * i / (BEAT_N_MELS + 1)));
  const bandStart = new Uint32Array(BEAT_N_MELS + 1);
  const bins: number[] = [], weights: number[] = [];
  for (let m = 0; m < BEAT_N_MELS; m++) {
    bandStart[m] = bins.length;
    const left = edges[m], center = edges[m + 1], right = edges[m + 2];
    const norm = 2 / (right - left);
    for (let b = 0; b < N_BINS; b++) {
      const hz = b * nyquist / (N_BINS - 1);
      const weight = Math.max(0, Math.min((hz - left) / (center - left), (right - hz) / (right - center))) * norm;
      if (weight > 0) { bins.push(b); weights.push(weight); }
    }
  }
  bandStart[BEAT_N_MELS] = bins.length;
  filterbank = { bandStart, bins: Uint32Array.from(bins), weights: Float64Array.from(weights) };
  return filterbank;
}

function createFft(size: number) {
  const bits = Math.log2(size);
  const reversed = new Uint32Array(size);
  for (let i = 0; i < size; i++) { let r = 0; for (let b = 0, v = i; b < bits; b++, v >>>= 1) r = (r << 1) | (v & 1); reversed[i] = r; }
  const cos = new Float64Array(size / 2), sin = new Float64Array(size / 2);
  for (let k = 0; k < size / 2; k++) { cos[k] = Math.cos(-2 * Math.PI * k / size); sin[k] = Math.sin(-2 * Math.PI * k / size); }
  return (real: Float64Array, imag: Float64Array) => {
    for (let i = 0; i < size; i++) { const j = reversed[i]; if (j <= i) continue; const tr = real[i]; real[i] = real[j]; real[j] = tr; const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti; }
    for (let span = 2; span <= size; span <<= 1) {
      const half = span >> 1, stride = size / span;
      for (let start = 0; start < size; start += span) for (let k = 0; k < half; k++) {
        const a = start + k, b = a + half, wr = cos[k * stride], wi = sin[k * stride];
        const tr = wr * real[b] - wi * imag[b], ti = wr * imag[b] + wi * real[b];
        real[b] = real[a] - tr; imag[b] = imag[a] - ti; real[a] += tr; imag[a] += ti;
      }
    }
  };
}

export function resampleToBeatRate(audio: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === BEAT_SAMPLE_RATE) return audio;
  const ratio = BEAT_SAMPLE_RATE / sampleRate;
  const length = Math.max(1, Math.round(audio.length * ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i / ratio, left = Math.floor(position), fraction = position - left;
    const a = audio[Math.min(audio.length - 1, left)] || 0;
    const b = audio[Math.min(audio.length - 1, left + 1)] || a;
    out[i] = a + (b - a) * fraction;
  }
  return out;
}

function reflectedSample(signal: Float32Array, index: number) {
  const last = signal.length - 1;
  let i = index < 0 ? -index : index;
  if (i > last) i = 2 * last - i;
  return signal[Math.min(last, Math.max(0, i))] ?? 0;
}

export function logMel(signal: Float32Array): { mel: Float32Array; frames: number } {
  const frames = signal.length ? 1 + Math.floor(signal.length / BEAT_HOP) : 0;
  const mel = new Float32Array(frames * BEAT_N_MELS);
  if (!frames) return { mel, frames };
  const { bandStart, bins, weights } = slaneyFilterbank();
  const window = Float64Array.from({ length: BEAT_N_FFT }, (_, i) => 0.5 * (1 - Math.cos(2 * Math.PI * i / BEAT_N_FFT)));
  const fft = createFft(BEAT_N_FFT);
  const real = new Float64Array(BEAT_N_FFT), imag = new Float64Array(BEAT_N_FFT);
  const magnitude = new Float64Array(N_BINS);
  const scale = 1 / Math.sqrt(BEAT_N_FFT), pad = BEAT_N_FFT / 2;
  for (let t = 0; t < frames; t++) {
    const start = t * BEAT_HOP - pad;
    for (let i = 0; i < BEAT_N_FFT; i++) real[i] = reflectedSample(signal, start + i) * window[i];
    imag.fill(0); fft(real, imag);
    for (let b = 0; b < N_BINS; b++) magnitude[b] = Math.hypot(real[b], imag[b]) * scale;
    const row = t * BEAT_N_MELS;
    for (let m = 0; m < BEAT_N_MELS; m++) {
      let energy = 0;
      for (let j = bandStart[m]; j < bandStart[m + 1]; j++) energy += magnitude[bins[j]] * weights[j];
      mel[row + m] = Math.log1p(1000 * energy);
    }
  }
  return { mel, frames };
}

export function beatChunkStarts(frames: number): number[] {
  const stride = BEAT_CHUNK - 2 * BEAT_BORDER;
  const starts: number[] = [];
  for (let start = -BEAT_BORDER; start < frames - BEAT_BORDER; start += stride) starts.push(start);
  if (!starts.length) starts.push(-BEAT_BORDER);
  if (frames > stride) starts[starts.length - 1] = frames - (BEAT_CHUNK - BEAT_BORDER);
  return starts;
}

export function pickPeaks(logits: Float32Array, threshold = 0, minDistance = 0.18): number[] {
  const candidates: { value: number; time: number }[] = [];
  for (let i = 0; i < logits.length; i++) if (logits[i] > threshold) candidates.push({ value: logits[i], time: i / BEAT_FPS });
  candidates.sort((a, b) => b.value - a.value || a.time - b.time);
  const kept: number[] = [];
  for (const candidate of candidates) if (kept.every(time => Math.abs(time - candidate.time) > minDistance)) kept.push(candidate.time);
  return kept.sort((a, b) => a - b);
}

function medianInterval(times: number[]): number | null {
  if (times.length < 3) return null;
  const diffs: number[] = [];
  for (let i = 1; i < times.length; i++) { const d = times[i] - times[i - 1]; if (d > 0.15 && d < 6) diffs.push(d); }
  if (!diffs.length) return null;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

export function estimateGrid(beats: number[], downbeats: number[]): { tempo: number | null; meter: number | null; beat_interval: number | null } {
  let interval = medianInterval(beats);
  if (interval == null) return { tempo: null, meter: null, beat_interval: null };
  let bpm = 60 / interval;
  while (bpm < 55 && interval > 0.12) { interval /= 2; bpm *= 2; }
  while (bpm > 215) { interval *= 2; bpm /= 2; }
  let meter: number | null = null;
  const bar = medianInterval(downbeats);
  if (bar != null) { const ratio = bar / interval, nearest = Math.round(ratio); if ((nearest === 3 || nearest === 4) && Math.abs(ratio - nearest) < 0.25) meter = nearest; }
  return { tempo: Math.round(bpm * 10) / 10, meter, beat_interval: Math.round(interval * 1e5) / 1e5 };
}

export function buildAiAnalysis(beatLogits: Float32Array, downLogits: Float32Array): AiAnalysis {
  const beats = pickPeaks(beatLogits, 0, 0.18);
  let downbeats = pickPeaks(downLogits, 0, 0.5);
  if (beats.length) {
    const snapped = downbeats.map(time => beats.reduce((best, beat) => Math.abs(beat - time) < Math.abs(best - time) ? beat : best, beats[0]));
    downbeats = [...new Set(snapped)].sort((a, b) => a - b);
  }
  const grid = estimateGrid(beats, downbeats);
  const round = (values: number[]) => values.map(value => Math.round(value * 1e4) / 1e4);
  return { model: 'beat-this-small0', model_name: 'Beat This! small0 · local', license: 'MIT', beats: round(beats), downbeats: round(downbeats), ...grid, beat_count: beats.length, downbeat_count: downbeats.length };
}
