import * as ort from 'onnxruntime-web/wasm';
import { decodeNotes, estimateTempo, FFT_HOP, FRAME_COUNT, OVERLAP, SAMPLE_RATE, STRIDE, TRIM, UNWRAPPED_FRAMES, WINDOW_SAMPLES } from './notes';
import type { Note } from '../types';

let session: ort.InferenceSession | null = null;
const expectedModelHash = '2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec';
const progress = (value: number, detail: string) => self.postMessage({ type: 'progress', value, detail });

async function loadSession(base: string) {
  if (session) return session;
  progress(0, 'Loading Basic Pitch · about 11 MB on the first conversion');
  ort.env.wasm.numThreads = 1; // GitHub Pages does not require cross-origin isolation.
  ort.env.wasm.proxy = false; // Already inside our dedicated worker.
  ort.env.wasm.wasmPaths = {
    mjs: new URL('ort/ort-wasm-simd-threaded.mjs', base).href,
    wasm: new URL('ort/ort-wasm-simd-threaded.wasm', base).href,
  };
  ort.env.logLevel = 'error';
  const response = await fetch(new URL('models/basic-pitch.onnx', base));
  if (!response.ok) throw new Error('The browser model could not be downloaded. Reconnect and try again.');
  const model = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', model);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== expectedModelHash) throw new Error('The browser model failed its integrity check. Refresh the page and try again.');
  progress(0.03, 'Preparing the in-browser transcription engine');
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', intraOpNumThreads: 1, interOpNumThreads: 1 });
  return session;
}

async function transcribe(audio: Float32Array, sensitivity: number, base: string) {
  const engine = await loadSession(base);
  const padded = new Float32Array(OVERLAP / 2 + audio.length);
  padded.set(audio, OVERLAP / 2);
  const windows = Math.ceil(padded.length / STRIDE);
  const frameCount = Math.floor(audio.length * SAMPLE_RATE / FFT_HOP / SAMPLE_RATE);
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
    const total = audio.length / SAMPLE_RATE;
    const clock = (value: number) => `${Math.floor(value / 60)}:${Math.floor(value % 60).toString().padStart(2, '0')}`;
    progress((index + 1) / windows, `Listening in your browser · ${clock(heard)} of ${clock(total)} · window ${index + 1}/${windows}`);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  progress(0.96, 'Separating note onsets, sustain, and dynamics');
  // Keep the raw decode unfiltered so later refinement can recover shorter notes.
  const notes: Note[] = decodeNotes(frames.subarray(0, frameCount * 88), onsets.subarray(0, frameCount * 88), frameCount, Math.max(0.2, 0.8 - sensitivity * 0.005), 0.3, 1);
  self.postMessage({ type: 'complete', notes, tempo: estimateTempo(audio) });
}

self.onmessage = (event: MessageEvent<{ audio: Float32Array; sensitivity: number; base: string }>) => {
  transcribe(event.data.audio, event.data.sensitivity, event.data.base).catch(error => {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Browser transcription failed. Try a shorter WAV or MP3.' });
  });
};
