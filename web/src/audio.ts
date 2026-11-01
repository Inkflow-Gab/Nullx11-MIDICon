import type { Note } from './types';

/** Small local piano-like synth. No remote soundfont or audio leaves the browser. */
export class PianoPreview {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices = new Map<number, { oscillators: OscillatorNode[]; gain: GainNode }>();
  private timer: number | null = null;
  private startedAt = 0;
  private offset = 0;
  private index = 0;
  private notes: Note[] = [];
  private running = false;
  private volume = 0.55;
  onTick: ((time: number) => void) | null = null;
  onEnd: (() => void) | null = null;

  async play(notes: Note[], from = 0) {
    await this.stop();
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.volume * 0.55;
      const compressor = this.context.createDynamicsCompressor();
      compressor.threshold.value = -14;
      compressor.ratio.value = 5;
      this.master.connect(compressor);
      compressor.connect(this.context.destination);
    }
    await this.context.resume();
    this.notes = [...notes].sort((a, b) => a.start - b.start);
    this.offset = from;
    this.startedAt = this.context.currentTime;
    this.index = this.notes.findIndex(note => note.start >= from);
    if (this.index < 0) this.index = this.notes.length;
    this.running = true;
    // Resume sustained notes when seeking into the middle of a piece.
    this.notes.forEach((note, index) => {
      if (note.start < from && note.end > from + 0.03) this.voice(note, Math.min(0.8, note.end - from), index);
    });
    const tick = () => {
      if (!this.context || !this.running) return;
      const now = this.context.currentTime - this.startedAt + this.offset;
      while (this.index < this.notes.length && this.notes[this.index].start <= now + 0.1) {
        const note = this.notes[this.index];
        const delay = Math.max(0, note.start - now);
        if (note.end > now) this.voice(note, note.end - note.start, this.index, delay);
        this.index++;
      }
      this.onTick?.(now);
      const end = this.notes.length ? Math.max(...this.notes.map(note => note.end)) : 0;
      if (now >= end + 0.3) { void this.stop(); this.onEnd?.(); return; }
      this.timer = window.setTimeout(tick, 35);
    };
    tick();
  }

  private voice(note: Note, duration: number, id: number, delay = 0) {
    if (!this.context || !this.master) return;
    const ctx = this.context;
    const start = ctx.currentTime + delay;
    const end = start + Math.max(0.06, duration);
    const gain = ctx.createGain();
    const frequency = 440 * 2 ** ((note.pitch - 69) / 12);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(note.velocity / 127 * 0.28, start + 0.007);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, note.velocity / 127 * 0.09), start + 0.35);
    gain.gain.exponentialRampToValueAtTime(0.001, end + 0.22);
    gain.connect(this.master);
    const oscillators = [1, 2, 3, 4].map((harmonic, index) => {
      const oscillator = ctx.createOscillator();
      const partial = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency * harmonic * (1 + index * 0.0003);
      partial.gain.value = [1, 0.28, 0.12, 0.045][index];
      oscillator.connect(partial); partial.connect(gain);
      oscillator.start(start); oscillator.stop(end + 0.25);
      return oscillator;
    });
    this.voices.set(id, { oscillators, gain });
    oscillators[0].onended = () => { gain.disconnect(); this.voices.delete(id); };
  }

  setVolume(value: number) {
    this.volume = value;
    if (this.master && this.context) this.master.gain.setTargetAtTime(value * 0.55, this.context.currentTime, 0.03);
  }

  async stop() {
    this.running = false;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    for (const { oscillators, gain } of this.voices.values()) {
      for (const oscillator of oscillators) { try { oscillator.stop(); } catch { /* already ended */ } }
      gain.disconnect();
    }
    this.voices.clear();
  }

  dispose() { void this.stop(); void this.context?.close(); }
}
