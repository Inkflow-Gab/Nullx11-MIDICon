import * as ort from 'onnxruntime-web/wasm';
import { decodeNotes, estimateTempo, FFT_HOP, FRAME_COUNT, OVERLAP, SAMPLE_RATE, STRIDE, TRIM, UNWRAPPED_FRAMES, WINDOW_SAMPLES } from './notes';
import { decodePianoNotes, PIANO_FPS, PIANO_FRAMES, PIANO_SAMPLE_RATE, PIANO_STRIDE, PIANO_USABLE, PIANO_WINDOW, pianoThresholds } from './piano';
import type { AiAnalysis, Note } from '../types';
import { BEAT_BORDER, BEAT_CHUNK, BEAT_HOP, BEAT_MODEL_KEY, BEAT_MODEL_SHA256, BEAT_N_MELS, BEAT_SAMPLE_RATE, beatChunkStarts, buildAiAnalysis, logMel, resampleToBeatRate } from './beat';

type Engine = 'piano' | 'basic';
const sessions = new Map<Engine, ort.InferenceSession>();
let beatSession: ort.InferenceSession | null = null;
const hashes: Record<string, string> = {
  'models/basic-pitch.onnx': '2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec',
  'models/piano/model.onnx': 'bcbbfeff7950e9d2665336b60105b4767e9d7b8de1de14ce607c616b72668414',
  'models/piano/kong_notes_2s5_fp32.onnx.data': '21e9437c5f4c55737126e13778c804faff4b2eca49a9a7cc4ea49fd99804f001',
  [BEAT_MODEL_KEY]: BEAT_MODEL_SHA256,
};
const progress = (value: number, detail: string) => self.postMessage({ type: 'progress', value, detail });
const aiProgress = (value: number, detail: string) => self.postMessage({ type: 'progress', value, detail, ai: true });
const clock = (value: number) => `${Math.floor(value / 60)}:${Math.floor(value % 60).toString().padStart(2, '0')}`;

function configureOrt(base: string) {
  ort.env.wasm.numThreads = 1; // GitHub Pages does not require cross-origin isolation.
  ort.env.wasm.proxy = false; // Already inside our dedicated worker.
  ort.env.wasm.wasmPaths = {
    mjs: new URL('ort/ort-wasm-simd-threaded.mjs', base).href,
    wasm: new URL('ort/ort-wasm-simd-threaded.wasm', base).href,
  };
  ort.env.logLevel = 'error';
}

async function fetchVerified(url: URL, key: string, label: string, onProgress?: (fraction: number) => void) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} could not be downloaded. Reconnect and try again.`);
  const total = Number(response.headers.get('content-length') || 0);
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onProgress && total) onProgress(Math.min(1, received / total));
    }
  } else {
    chunks.push(new Uint8Array(await response.arrayBuffer()));
    received = chunks[0].length;
  }
  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== hashes[key]) throw new Error(`${label} failed its integrity check. Refresh the page and try again.`);
  return buffer;
}

async function loadSession(engine: Engine, base: string) {
  const existing = sessions.get(engine);
  if (existing) return existing;
  configureOrt(base);
  let session: ort.InferenceSession;
  if (engine === 'basic') {
    progress(0, 'Loading Basic Pitch · about 11 MB on the first conversion');
    const model = await fetchVerified(new URL('models/basic-pitch.onnx', base), 'models/basic-pitch.onnx', 'The browser model');
    progress(0.03, 'Preparing the in-browser transcription engine');
    session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', intraOpNumThreads: 1, interOpNumThreads: 1 });
  } else {
    progress(0, 'Loading piano specialist · about 85 MB once, then cached for offline use');
    const graph = await fetchVerified(new URL('models/piano/model.onnx', base), 'models/piano/model.onnx', 'The piano model');
    const data = await fetchVerified(new URL('models/piano/kong_notes_2s5_fp32.onnx.data', base), 'models/piano/kong_notes_2s5_fp32.onnx.data', 'The piano model weights', fraction => progress(fraction * 0.04, `Downloading piano specialist · ${Math.round(fraction * 100)}%`));
    progress(0.05, 'Preparing the piano specialist engine');
    session = await ort.InferenceSession.create(graph, {
      executionProviders: ['wasm'], graphOptimizationLevel: 'all', intraOpNumThreads: 1, interOpNumThreads: 1,
      externalData: [{ path: 'kong_notes_2s5_fp32.onnx.data', data }],
    });
  }
  sessions.set(engine, session);
  return session;
}

async function loadBeatSession(base: string) {
  if (beatSession) return beatSession;
  configureOrt(base);
  aiProgress(0, 'Loading AI Assist · Beat This! small0 (~10 MB once, then cached offline)');
  const model = await fetchVerified(new URL(BEAT_MODEL_KEY, base), BEAT_MODEL_KEY, 'The AI Assist model', fraction => aiProgress(fraction * 0.15, `Downloading AI Assist · ${Math.round(fraction * 100)}%`));
  aiProgress(0.18, 'Preparing the local beat/downbeat model');
  beatSession = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', intraOpNumThreads: 1, interOpNumThreads: 1 });
  return beatSession;
}

async function analyzeBeats(audio: Float32Array, sampleRate: number, base: string): Promise<AiAnalysis | null> {
  const session = await loadBeatSession(base);
  aiProgress(0.2, 'AI Assist · preparing log-mel features');
  const signal = resampleToBeatRate(audio, sampleRate);
  const { mel, frames } = logMel(signal);
  if (frames < BEAT_SAMPLE_RATE / 2 / BEAT_HOP) return null;
  const beatLogits = new Float32Array(frames).fill(-1000);
  const downLogits = new Float32Array(frames).fill(-1000);
  const starts = beatChunkStarts(frames);
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index];
    const left = Math.max(0, -start), right = Math.max(0, Math.min(BEAT_BORDER, start + BEAT_CHUNK - frames));
    const from = Math.max(start, 0), to = Math.min(start + BEAT_CHUNK, frames);
    const pieceFrames = left + (to - from) + right;
    const piece = new Float32Array(pieceFrames * BEAT_N_MELS);
    piece.set(mel.subarray(from * BEAT_N_MELS, to * BEAT_N_MELS), left * BEAT_N_MELS);
    const input = new ort.Tensor('float32', piece, [1, pieceFrames, BEAT_N_MELS]);
    const output = await session.run({ spect: input }, ['beat', 'downbeat']);
    const beat = output.beat.data as Float32Array;
    const down = output.downbeat.data as Float32Array;
    const target = start + BEAT_BORDER;
    const count = Math.min(pieceFrames - 2 * BEAT_BORDER, frames - target);
    if (count > 0) {
      beatLogits.set(beat.subarray(BEAT_BORDER, BEAT_BORDER + count), target);
      downLogits.set(down.subarray(BEAT_BORDER, BEAT_BORDER + count), target);
    }
    for (const value of Object.values(output)) value.dispose();
    input.dispose();
    aiProgress(0.25 + 0.7 * (index + 1) / starts.length, `AI Assist · beat window ${index + 1}/${starts.length}`);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  aiProgress(0.98, 'AI Assist · picking beats and downbeats');
  const ai = buildAiAnalysis(beatLogits, downLogits);
  return ai.beat_count >= 3 ? ai : null;
}

async function transcribeBasic(audio: Float32Array, sensitivity: number, base: string) {
  const engine = await loadSession('basic', base);
  const padded = new Float32Array(OVERLAP / 2 + audio.length);
  padded.set(audio, OVERLAP / 2);
  const windows = Math.ceil(padded.length / STRIDE);
  const frameCount = Math.floor(audio.length / FFT_HOP);
  const frames = new Float32Array(windows * UNWRAPPED_FRAMES * 88);
  const onsets = new Float32Array(frames.length);
  const chunk = new Float32Array(WINDOW_SAMPLES);
  for (let index = 0; index < windows; index++) {
    chunk.fill(0);
    chunk.set(padded.subarray(index * STRIDE, Math.min(padded.length, index * STRIDE + WINDOW_SAMPLES)));
    const input = new ort.Tensor('float32', chunk, [1, WINDOW_SAMPLES, 1]);
    const output = await engine.run({ 'serving_default_input_2:0': input }, ['StatefulPartitionedCall:1', 'StatefulPartitionedCall:2']);
    const note = output['StatefulPartitionedCall:1'].data as Float32Array;
    const onset = output['StatefulPartitionedCall:2'].data as Float32Array;
    frames.set(note.subarray(TRIM * 88, (FRAME_COUNT - TRIM) * 88), index * UNWRAPPED_FRAMES * 88);
    onsets.set(onset.subarray(TRIM * 88, (FRAME_COUNT - TRIM) * 88), index * UNWRAPPED_FRAMES * 88);
    for (const value of Object.values(output)) value.dispose();
    input.dispose();
    const heard = Math.min(audio.length / SAMPLE_RATE, (index + 1) * UNWRAPPED_FRAMES * FFT_HOP / SAMPLE_RATE);
    progress((index + 1) / windows, `Listening in your browser · ${clock(heard)} of ${clock(audio.length / SAMPLE_RATE)} · window ${index + 1}/${windows}`);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  progress(0.96, 'Separating note onsets, sustain, and dynamics');
  const notes: Note[] = decodeNotes(frames.subarray(0, frameCount * 88), onsets.subarray(0, frameCount * 88), frameCount, Math.max(0.2, 0.8 - sensitivity * 0.005), 0.3, 1);
  return { notes, tempo: estimateTempo(audio, SAMPLE_RATE) };
}

async function transcribePiano(audio: Float32Array, sensitivity: number, base: string) {
  const engine = await loadSession('piano', base);
  const frames = Math.max(PIANO_USABLE, Math.ceil(audio.length / PIANO_SAMPLE_RATE * PIANO_FPS));
  const size = frames * 88;
  const regOnset = new Float32Array(size);
  const regOffset = new Float32Array(size);
  const frame = new Float32Array(size);
  const velocity = new Float32Array(size);
  const weight = new Float32Array(frames);
  const taper = new Float32Array(PIANO_FRAMES);
  for (let i = 0; i < PIANO_FRAMES; i++) taper[i] = Math.max(Math.min(i, PIANO_FRAMES - i) / Math.floor(PIANO_FRAMES / 2), 0.025);
  const windows = Math.max(1, Math.ceil(Math.max(audio.length - PIANO_WINDOW, 0) / PIANO_STRIDE) + 1);
  const chunk = new Float32Array(PIANO_WINDOW);
  const thresholds = pianoThresholds(sensitivity);
  for (let index = 0; index < windows; index++) {
    const start = index * PIANO_STRIDE;
    chunk.fill(0);
    chunk.set(audio.subarray(start, Math.min(audio.length, start + PIANO_WINDOW)));
    const input = new ort.Tensor('float32', chunk, [1, PIANO_WINDOW]);
    const output = await engine.run({ waveform: input }, ['reg_onset_output', 'reg_offset_output', 'frame_output', 'velocity_output']);
    const first = Math.floor(start / PIANO_SAMPLE_RATE * PIANO_FPS);
    const last = Math.min(first + PIANO_USABLE, frames);
    const count = last - first;
    if (count > 0) {
      const outputs = [regOnset, regOffset, frame, velocity];
      const keys = ['reg_onset_output', 'reg_offset_output', 'frame_output', 'velocity_output'];
      for (let o = 0; o < outputs.length; o++) {
        const data = output[keys[o]].data as Float32Array;
        const sum = outputs[o];
        for (let i = 0; i < count; i++) {
          const w = taper[i];
          const target = (first + i) * 88;
          const source = i * 88;
          for (let pitch = 0; pitch < 88; pitch++) sum[target + pitch] += data[source + pitch] * w;
        }
      }
      for (let i = 0; i < count; i++) weight[first + i] += taper[i];
    }
    for (const value of Object.values(output)) value.dispose();
    input.dispose();
    const heard = Math.min(audio.length / PIANO_SAMPLE_RATE, (start + PIANO_WINDOW) / PIANO_SAMPLE_RATE);
    progress((index + 1) / windows, `Piano specialist · ${clock(heard)} of ${clock(audio.length / PIANO_SAMPLE_RATE)} · window ${index + 1}/${windows}`);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  for (let i = 0; i < frames; i++) {
    const w = Math.max(weight[i], 1e-8);
    for (let pitch = 0; pitch < 88; pitch++) {
      const index = i * 88 + pitch;
      regOnset[index] /= w; regOffset[index] /= w; frame[index] /= w; velocity[index] /= w;
    }
  }
  progress(0.96, 'Regressing precise piano onsets, offsets, and dynamics');
  const notes = decodePianoNotes(regOnset, regOffset, frame, velocity, frames, thresholds.onset, thresholds.offset, thresholds.frame);
  return { notes, tempo: estimateTempo(audio, PIANO_SAMPLE_RATE) };
}

type TranscribeMessage = { type?: 'transcribe'; audio: Float32Array; sensitivity: number; base: string; engine: Engine; ai_assist?: boolean };
type BeatsMessage = { type: 'beats'; audio: Float32Array; sampleRate: number; base: string };
self.onmessage = (event: MessageEvent<TranscribeMessage | BeatsMessage>) => {
  const message = event.data;
  const fail = (error: unknown) => self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Browser transcription failed. Try a shorter WAV or MP3.' });
  if (message.type === 'beats') {
    analyzeBeats(message.audio, message.sampleRate, message.base).then(ai => self.postMessage({ type: 'beats-complete', ai })).catch(fail);
    return;
  }
  const { audio, sensitivity, base, engine, ai_assist } = message;
  const run = engine === 'piano' ? transcribePiano : transcribeBasic;
  const sampleRate = engine === 'piano' ? PIANO_SAMPLE_RATE : SAMPLE_RATE;
  run(audio, sensitivity, base).then(async ({ notes, tempo }) => {
    let ai: AiAnalysis | null = null;
    let aiError: string | null = null;
    if (ai_assist) {
      try { ai = await analyzeBeats(audio, sampleRate, base); if (!ai) aiError = 'No steady beat was found. The standard conversion is kept.'; }
      catch (error) { aiError = error instanceof Error ? error.message : 'The local beat model could not run. The standard conversion is kept.'; }
    }
    self.postMessage({ type: 'complete', notes, tempo, ai, aiError });
  }).catch(fail);
};
