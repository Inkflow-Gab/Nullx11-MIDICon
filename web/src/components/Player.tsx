import { useEffect, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { PianoPreview } from '../audio';
import { audioUrl } from '../api';
import type { Job, Note } from '../types';
import { formatTime } from '../types';

type Props = { job: Job | null; notes: Note[]; onSeek: (time: number) => void; currentTime: number; volume: number; onVolume: (volume: number) => void };
export function Player({ job, notes, onSeek, currentTime, volume, onVolume }: Props) {
  const synth = useRef<PianoPreview | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<'midi' | 'original'>('midi');
  const [error, setError] = useState('');
  const timeRef = useRef(0);
  const ready = job?.status === 'completed' && notes.length > 0;
  const duration = job?.result?.duration || 0;
  timeRef.current = currentTime;
  useEffect(() => {
    let disposed = false;
    const player = new PianoPreview(); synth.current = player;
    player.onTick = time => { if (!disposed) onSeek(time); };
    player.onEnd = () => { if (!disposed) { setPlaying(false); onSeek(0); } };
    const element = new Audio(); audio.current = element; element.preload = 'none';
    element.ontimeupdate = () => { if (!disposed) onSeek(element.currentTime); };
    element.onended = () => { if (!disposed) { setPlaying(false); onSeek(0); } };
    element.onerror = () => { if (!disposed && element.getAttribute('src')) { setError('Audio preview is unavailable. The MIDI preview and downloads still work.'); setPlaying(false); } };
    return () => { disposed = true; player.dispose(); element.pause(); element.removeAttribute('src'); element.load(); };
  }, []);
  useEffect(() => { synth.current?.setVolume(volume); if (audio.current) audio.current.volume = volume; }, [volume]);
  useEffect(() => {
    void synth.current?.stop(); if (audio.current) { audio.current.pause(); audio.current.removeAttribute('src'); }
    setPlaying(false); setError(''); onSeek(0); setMode('midi');
    if (audio.current && job?.has_audio && job.status === 'completed') { audio.current.src = audioUrl(job.id); audio.current.load(); }
  }, [job?.id, job?.status]);
  useEffect(() => { if (!ready && playing) { void synth.current?.stop(); audio.current?.pause(); setPlaying(false); } }, [ready, playing]);

  async function toggle() {
    if (!ready || !job) return;
    if (playing) { await synth.current?.stop(); audio.current?.pause(); setPlaying(false); return; }
    setError('');
    const from = timeRef.current >= duration - 0.1 ? 0 : timeRef.current;
    try {
      if (mode === 'original' && job.has_audio && audio.current) { audio.current.currentTime = from; await audio.current.play(); }
      else await synth.current?.play(notes, from);
      setPlaying(true);
    } catch { setError('Playback was blocked. Press play again, or try the MIDI preview.'); setPlaying(false); }
  }
  async function switchMode(next: 'midi' | 'original') {
    if (next === mode) return;
    await synth.current?.stop(); audio.current?.pause(); setPlaying(false); setMode(next);
  }
  async function seek(time: number) {
    onSeek(time); timeRef.current = time;
    if (audio.current && job?.has_audio) audio.current.currentTime = time;
    if (playing && mode === 'midi') await synth.current?.play(notes, time);
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.code === 'Space' && ready && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(target.tagName) && !target.isContentEditable && !document.querySelector('[role="dialog"]')) { event.preventDefault(); void toggle(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [ready, playing, mode, notes, duration]);

  return <div className="player">
    <div className="player-source"><span>LISTEN TO</span><div className="segmented small"><button className={mode === 'midi' ? 'selected' : ''} onClick={() => void switchMode('midi')}>Piano MIDI</button><button className={mode === 'original' ? 'selected' : ''} disabled={!job?.has_audio} onClick={() => void switchMode('original')}>Original</button></div></div>
    <div className="playback-row"><button className="play-button" disabled={!ready} onClick={() => void toggle()} aria-label={playing ? 'Pause preview' : 'Play preview'}>{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button><button className="icon-button restart" disabled={!ready} aria-label="Restart preview" onClick={() => void seek(0)}><RotateCcw size={15} /></button><span className="play-time">{formatTime(currentTime)}</span><input type="range" aria-label="Playback position" min={0} max={duration || 1} step={0.05} value={Math.min(currentTime, duration)} disabled={!ready} onChange={event => void seek(Number(event.target.value))} style={{ '--range-progress': `${duration ? currentTime / duration * 100 : 0}%` } as React.CSSProperties} /><span className="play-time muted">{formatTime(duration)}</span><button className="icon-button volume-button" aria-label={volume ? 'Mute preview' : 'Unmute preview'} onClick={() => onVolume(volume ? 0 : 0.55)}>{volume ? <Volume2 size={17} /> : <VolumeX size={17} />}</button></div>
    {error && <p className="inline-error">{error}</p>}
    <p className="preview-disclaimer">{mode === 'midi' ? 'Synthesized piano preview · your DAW may sound different' : 'Original audio · compare it with your transcription'}</p>
  </div>;
}
