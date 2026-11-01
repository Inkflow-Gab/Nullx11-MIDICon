import type { Options } from '../types';
import { SAMPLE_RATE } from './notes';

export const BROWSER_MAX_SECONDS = 90;
export const BROWSER_MAX_BYTES = 25 * 1024 * 1024;
export const BROWSER_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.mp4', '.flac', '.ogg', '.opus', '.aac', '.webm', '.aiff', '.aif'];

async function probe(blob: Blob): Promise<number> {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(); audio.preload = 'metadata';
  try {
    return await new Promise<number>((resolve, reject) => {
      const timer = window.setTimeout(() => finish(new Error('This audio format could not be read by your browser. Try WAV, MP3, M4A, or MP4 with AAC audio.')), 15000);
      const finish = (error?: Error) => { clearTimeout(timer); audio.onloadedmetadata = null; audio.onerror = null; if (error) reject(error); else resolve(audio.duration); };
      audio.onloadedmetadata = () => finish();
      audio.onerror = () => finish(new Error('This audio format could not be read by your browser. Try WAV, MP3, M4A, or MP4 with AAC audio.'));
      audio.src = url;
    });
  } finally { audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); }
}

export async function decodeAudio(blob: Blob, options: Options): Promise<{ audio: Float32Array; duration: number; waveform: number[] }> {
  const total = await probe(blob);
  if (!Number.isFinite(total) || total < 0.15) throw new Error('Use a recording with at least 0.15 seconds of readable audio.');
  if (total > BROWSER_MAX_SECONDS + 0.1) throw new Error('Browser mode supports up to 90 seconds. Use a shorter clip here, or the full server for longer audio.');
  if (options.start_seconds >= total) throw new Error('The trim start is after the end of the audio.');
  const duration = Math.min(options.duration_seconds || total - options.start_seconds, total - options.start_seconds, BROWSER_MAX_SECONDS);
  if (duration < 0.15) throw new Error('Choose at least 0.15 seconds of audio.');
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const offline = new OfflineAudioContext(1, Math.ceil(duration * SAMPLE_RATE), SAMPLE_RATE);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination);
    source.start(0, options.start_seconds, duration);
    const rendered = await offline.startRendering();
    const audio = new Float32Array(rendered.getChannelData(0));
    let peak = 0;
    for (const sample of audio) peak = Math.max(peak, Math.abs(sample));
    if (peak < 0.0001) throw new Error('This recording appears to be silent. Try a file with audible music.');
    const waveform = Array.from({ length: 160 }, (_, index) => {
      const from = Math.floor(index * audio.length / 160), to = Math.floor((index + 1) * audio.length / 160);
      let value = 0;
      for (let i = from; i < to; i += 8) value = Math.max(value, Math.abs(audio[i]));
      return value / peak;
    });
    return { audio, duration: audio.length / SAMPLE_RATE, waveform };
  } catch (error) {
    if (error instanceof Error && /silent|Choose at least/.test(error.message)) throw error;
    throw new Error('Your browser could not decode this file. Try a WAV, MP3, M4A, or MP4 with AAC audio.');
  } finally { await context.close(); }
}
