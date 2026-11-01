import type { Note } from '../types';

// Browser port of the MIT-licensed Kong regression post-processor used by the
// server engine. See webapp/vendor/kong_postprocessing.py and NOTICE.md.
export const PIANO_SAMPLE_RATE = 16000;
export const PIANO_WINDOW = 40000;
export const PIANO_STRIDE = 20000;
export const PIANO_FPS = 100;
export const PIANO_FRAMES = 251;
export const PIANO_USABLE = 250;
export const PIANO_BEGIN_NOTE = 21;
export const PIANO_KEYS = 88;

export function pianoThresholds(sensitivity: number) {
  const onset = Math.max(0.15, 0.6 - sensitivity * 0.005);
  return { onset, offset: onset, frame: Math.max(0.1, onset / 2) };
}

function binarize(prediction: Float32Array, frames: number, threshold: number, onset: boolean): number[][] {
  const binary = new Uint8Array(frames * PIANO_KEYS);
  for (let pitch = 0; pitch < PIANO_KEYS; pitch++) {
    for (let i = 1; i < frames - 1; i++) {
      const index = i * PIANO_KEYS + pitch;
      const previous = prediction[index - PIANO_KEYS];
      const current = prediction[index];
      const next = prediction[index + PIANO_KEYS];
      const neighbourMax = Math.max(previous, current);
      if (neighbourMax < threshold) continue;
      if (onset ? current < next : current <= next) continue;
      binary[index] = 1;
    }
  }
  const events: number[][] = Array.from({ length: PIANO_KEYS }, () => []);
  for (let pitch = 0; pitch < PIANO_KEYS; pitch++) {
    for (let i = 1; i < frames - 1; i++) {
      const index = i * PIANO_KEYS + pitch;
      if (!binary[index]) continue;
      const left = prediction[index - PIANO_KEYS];
      const middle = prediction[index];
      const right = prediction[index + PIANO_KEYS];
      const denominator = left - 2 * middle + right;
      const shift = denominator ? 0.5 * (left - right) / denominator : 0;
      events[pitch].push(i + (shift > 0 ? shift + 1 : shift));
    }
  }
  return events;
}

export function decodePianoNotes(
  regOnset: Float32Array, regOffset: Float32Array, frame: Float32Array, velocity: Float32Array,
  frames: number, onsetThreshold: number, offsetThreshold: number, frameThreshold: number,
): Note[] {
  const onsets = binarize(regOnset, frames, onsetThreshold, true);
  const offsets = binarize(regOffset, frames, offsetThreshold, false);
  const notes: Note[] = [];
  const at = (array: Float32Array, i: number, pitch: number) => array[Math.max(0, Math.min(frames - 1, i)) * PIANO_KEYS + pitch];
  const push = (pitch: number, startFrame: number, endFrame: number) => {
    const first = Math.max(0, Math.floor(startFrame));
    const last = Math.min(frames - 1, Math.floor(endFrame));
    let active = false;
    let sum = 0;
    let count = 0;
    let peakVelocity = 0;
    for (let i = first; i <= last; i++) {
      if (at(frame, i, pitch) > frameThreshold) active = true;
      const value = at(velocity, i, pitch);
      peakVelocity = Math.max(peakVelocity, value);
      sum += value;
      count++;
    }
    if (!active || peakVelocity <= 0 || endFrame <= startFrame) return;
    notes.push({
      start: startFrame / PIANO_FPS,
      end: Math.min(frames - 1, endFrame) / PIANO_FPS,
      pitch: pitch + PIANO_BEGIN_NOTE,
      velocity: Math.max(1, Math.min(127, Math.round((sum / Math.max(1, count)) * 128))),
    });
  };
  for (let pitch = 0; pitch < PIANO_KEYS; pitch++) {
    const onsetTimes = onsets[pitch];
    const offsetTimes = offsets[pitch];
    let offsetIndex = 0;
    let begin: number | null = null;
    for (const onset of onsetTimes) {
      while (offsetIndex < offsetTimes.length && offsetTimes[offsetIndex] < onset) offsetIndex++;
      const finish = offsetTimes[offsetIndex] ?? frames - 1;
      let beginFrame = Math.floor(onset);
      let finishFrame = Math.floor(finish);
      if (at(frame, beginFrame, pitch) <= frameThreshold && at(frame, beginFrame + 1, pitch) > frameThreshold) beginFrame++;
      if (at(frame, finishFrame, pitch) <= frameThreshold && at(frame, finishFrame - 1, pitch) > frameThreshold) finishFrame--;
      if (begin !== null && finishFrame > beginFrame) push(pitch, begin, finish);
      begin = onset;
    }
    if (begin !== null) push(pitch, begin, frames - 1);
  }
  return notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}
