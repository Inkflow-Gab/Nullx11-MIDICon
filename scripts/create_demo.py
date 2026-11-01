#!/usr/bin/env python3
"""Create an original, deterministic piano-like demo; no external recording."""
from pathlib import Path
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
SR = 22050
BPM = 96
BEAT = 60 / BPM


def main():
    events = []
    chords = [(45, [57, 60, 64, 69]), (41, [53, 57, 60, 65]), (48, [55, 60, 64, 67]), (43, [55, 59, 62, 67])]
    melodies = [[76, 74, 72, 69], [72, 71, 69, 65], [67, 72, 76, 74], [71, 69, 67, 62]]
    for repeat in range(2):
        for bar, (bass, chord) in enumerate(chords):
            offset = (repeat * 4 + bar) * 4 * BEAT
            events.append((offset, 3.6 * BEAT, bass, 65))
            for step in range(8):
                events.append((offset + step * BEAT / 2, BEAT * 0.85, chord[step % 4], 45 + (step % 3) * 4))
            for step, pitch in enumerate(melodies[bar]):
                events.append((offset + step * BEAT, BEAT * 0.9, pitch, 74 - step * 3))
    duration = 32 * BEAT + 1.8
    audio = np.zeros(int(SR * duration), dtype=np.float64)
    for start, length, pitch, velocity in events:
        t = np.arange(int(length * SR)) / SR
        frequency = 440 * 2 ** ((pitch - 69) / 12)
        envelope = (1 - np.exp(-t * 180)) * np.exp(-t * 2.5) * np.minimum(1, (length - t) / 0.08)
        tone = np.sin(2 * np.pi * frequency * t) + 0.32 * np.sin(2 * np.pi * frequency * 2.002 * t) * np.exp(-t * 3) + 0.13 * np.sin(2 * np.pi * frequency * 3.006 * t) * np.exp(-t * 5)
        sample = tone * envelope * velocity / 127 * 0.14
        first = int(start * SR)
        audio[first:first + len(sample)] += sample
    audio = np.tanh(audio * 1.15) * 0.88
    destination = ROOT / "webapp" / "assets" / "demo.wav"
    destination.parent.mkdir(parents=True, exist_ok=True)
    sf.write(destination, audio, SR, subtype="PCM_16")
    print(f"Original demo: {destination} ({duration:.1f}s)")


if __name__ == "__main__":
    main()
