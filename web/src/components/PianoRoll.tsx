import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, ScanLine } from 'lucide-react';
import type { Note } from '../types';
import { noteName } from '../types';

type Props = { notes: Note[]; duration: number; currentTime: number; onSeek: (time: number) => void; loading?: boolean; editable?: boolean; selectedIds?: Set<string>; onSelectNote?: (id: string | null, additive: boolean) => void };
const DEMO: Note[] = Array.from({ length: 34 }, (_, i) => ({ start: (i % 12) * 0.62 + Math.floor(i / 12) * 0.18, end: (i % 12) * 0.62 + 0.35 + (i % 3) * 0.16, pitch: [60, 64, 67, 72, 67, 64, 57, 60, 64, 69, 64, 60][i % 12] + (i > 23 ? -12 : 0), velocity: 65 + i % 40 }));

export function PianoRoll({ notes, duration, currentTime, onSeek, loading, editable = false, selectedIds, onSelectNote }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(500);
  const [zoom, setZoom] = useState(1);
  const [viewStart, setViewStart] = useState(0);
  const height = 248, keyboardHeight = 43, labelWidth = 32;
  const empty = notes.length === 0;
  const displayNotes = empty && !editable ? DEMO : notes;
  const displayDuration = empty ? 8 : Math.max(duration, 1);
  const lowest = empty ? 45 : Math.max(21, Math.min(...notes.map(n => n.pitch)) - 3);
  const highest = empty ? 77 : Math.min(108, Math.max(lowest + 23, ...notes.map(n => n.pitch)) + 3);
  const pitchCount = highest - lowest + 1;
  const plotHeight = height - keyboardHeight - 24;
  const plotWidth = width - labelWidth;
  const scale = plotWidth / 8 * zoom;
  const maxStart = Math.max(0, displayDuration - plotWidth / scale);
  const start = currentTime > viewStart + plotWidth / scale - 0.3 ? Math.min(maxStart, Math.max(0, currentTime - 1)) : Math.min(viewStart, maxStart);

  useEffect(() => {
    if (!wrapperRef.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.floor(entries[0].contentRect.width)));
    observer.observe(wrapperRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!editable) { setViewStart(0); setZoom(1); } }, [notes, editable]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr; canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#faf9fd'; ctx.fillRect(0, 0, width, height);
    const rowHeight = plotHeight / pitchCount;
    for (let pitch = lowest; pitch <= highest; pitch++) {
      const y = 24 + (highest - pitch) * rowHeight;
      const black = [1, 3, 6, 8, 10].includes(pitch % 12);
      ctx.fillStyle = black ? '#f3f1f8' : '#faf9fd';
      ctx.fillRect(labelWidth, y, plotWidth, rowHeight);
      ctx.strokeStyle = pitch % 12 === 0 ? '#e5e0ee' : '#eeebf4';
      ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(labelWidth, y + rowHeight); ctx.lineTo(width, y + rowHeight); ctx.stroke();
      if (pitch % 12 === 0) { ctx.fillStyle = '#9c96aa'; ctx.font = '9px "DM Sans", sans-serif'; ctx.fillText(noteName(pitch), 6, y + rowHeight + 3); }
    }
    const tick = zoom > 2 ? 1 : 2;
    for (let second = Math.ceil(start / tick) * tick; second < start + plotWidth / scale + tick; second += tick) {
      const x = labelWidth + (second - start) * scale;
      ctx.strokeStyle = '#e9e5f1'; ctx.beginPath(); ctx.moveTo(x, 24); ctx.lineTo(x, height - keyboardHeight); ctx.stroke();
      ctx.fillStyle = '#aaa4b6'; ctx.font = '9px "DM Sans", sans-serif'; ctx.fillText(`${Math.floor(second / 60)}:${(second % 60).toString().padStart(2, '0')}`, x + 4, 15);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(labelWidth, 24, plotWidth, plotHeight); ctx.clip();
    displayNotes.forEach((note, index) => {
      if (note.end < start || note.start > start + plotWidth / scale || note.pitch < lowest || note.pitch > highest) return;
      const x = labelWidth + (note.start - start) * scale;
      const y = 24 + (highest - note.pitch) * rowHeight + 0.7;
      const w = Math.max(3, (note.end - note.start) * scale - 1);
      const id = note.id ?? String(index);
      const selected = editable && selectedIds?.has(id);
      ctx.globalAlpha = selected ? 1 : empty ? 0.3 + (note.velocity % 20) / 100 : 0.55 + note.velocity / 280;
      ctx.fillStyle = selected ? '#5b3fa0' : note.pitch >= 60 ? '#967ce0' : '#73b5ad';
      ctx.beginPath(); ctx.roundRect(x, y, w, Math.max(2.5, rowHeight - 1.4), 2); ctx.fill();
      if (selected) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.4; ctx.stroke(); }
    });
    ctx.restore(); ctx.globalAlpha = 1;
    if (!empty) {
      const x = labelWidth + (currentTime - start) * scale;
      if (x >= labelWidth && x <= width) { ctx.strokeStyle = '#7654cf'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, height - keyboardHeight); ctx.stroke(); ctx.fillStyle = '#7654cf'; ctx.beginPath(); ctx.moveTo(x - 4, 19); ctx.lineTo(x + 4, 19); ctx.lineTo(x, 25); ctx.fill(); }
    }
    const keyY = height - keyboardHeight;
    const whiteCount = Array.from({ length: pitchCount }, (_, i) => lowest + i).filter(p => ![1, 3, 6, 8, 10].includes(p % 12)).length;
    const keyWidth = plotWidth / whiteCount;
    let whiteIndex = 0;
    const active = new Set(notes.filter(n => n.start <= currentTime && n.end > currentTime).map(n => n.pitch));
    for (let pitch = lowest; pitch <= highest; pitch++) {
      if ([1, 3, 6, 8, 10].includes(pitch % 12)) continue;
      const x = labelWidth + whiteIndex * keyWidth;
      ctx.fillStyle = active.has(pitch) ? '#bba6ee' : '#fff'; ctx.fillRect(x, keyY, keyWidth, keyboardHeight);
      ctx.strokeStyle = '#e3dfe9'; ctx.lineWidth = 0.7; ctx.strokeRect(x, keyY, keyWidth, keyboardHeight);
      if (pitch % 12 === 0 && keyWidth > 12) { ctx.fillStyle = '#b2aabb'; ctx.font = '8px sans-serif'; ctx.fillText(noteName(pitch), x + 2, height - 6); }
      whiteIndex++;
    }
    whiteIndex = 0;
    for (let pitch = lowest; pitch <= highest; pitch++) {
      if (![1, 3, 6, 8, 10].includes(pitch % 12)) { whiteIndex++; continue; }
      const x = labelWidth + whiteIndex * keyWidth - keyWidth * 0.29;
      ctx.fillStyle = active.has(pitch) ? '#8a65d5' : '#3d374b';
      ctx.beginPath(); ctx.roundRect(x, keyY, keyWidth * 0.58, keyboardHeight * 0.62, [0, 0, 2, 2]); ctx.fill();
    }
    ctx.fillStyle = '#f5f3f9'; ctx.fillRect(0, keyY, labelWidth, keyboardHeight);
  }, [width, displayNotes, notes, currentTime, start, scale, lowest, highest, empty, zoom, editable, selectedIds]);

  const rowHeight = plotHeight / pitchCount;
  function seek(event: React.PointerEvent<HTMLCanvasElement>) {
    if (empty && !editable) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    if (x < labelWidth || y > height - keyboardHeight) return;
    const time = start + (x - labelWidth) / scale;
    if (editable) {
      let hit: string | null = null;
      for (let index = displayNotes.length - 1; index >= 0; index--) {
        const note = displayNotes[index];
        const ny = 24 + (highest - note.pitch) * rowHeight;
        if (time >= note.start && time <= note.end && y >= ny && y <= ny + rowHeight) { hit = note.id ?? String(index); break; }
      }
      onSelectNote?.(hit, event.shiftKey);
      return;
    }
    onSeek(Math.max(0, Math.min(duration, time)));
  }

  return <div className="piano-roll" ref={wrapperRef}>
    <div className="roll-tools"><span><i className="legend-dot purple" /> Upper register <i className="legend-dot teal" /> Lower register</span><div><button className="icon-button tiny" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom(z => Math.max(1, z - 0.5))}><Minus size={13} /></button><button className="icon-button tiny" aria-label="Fit piano roll" onClick={() => { setZoom(1); setViewStart(0); onSeek(0); }}><ScanLine size={13} /></button><button className="icon-button tiny" aria-label="Zoom in" disabled={zoom >= 4} onClick={() => setZoom(z => Math.min(4, z + 0.5))}><Plus size={13} /></button></div></div>
    <div className="roll-canvas-wrap"><canvas ref={canvasRef} className={editable ? 'editable' : undefined} style={{ width: '100%', height }} aria-label={editable ? `Editable piano roll with ${notes.length} notes. Click a note to select it.` : empty ? 'Illustrative piano roll. Convert a song to see your actual notes.' : `Piano roll with ${notes.length} notes. Click to seek.`} onPointerDown={seek} onPointerMove={event => { if (!editable && event.buttons === 1) seek(event); }} />
      {empty && <div className="roll-empty"><span className="roll-empty-icon"><ScanLine size={21} /></span><strong>{editable ? 'No notes left' : loading ? 'Finding your notes…' : 'A little sound. A whole new canvas.'}</strong><span>{editable ? 'Undo to restore notes, or cancel editing.' : loading ? 'Your piano roll is on its way.' : 'Your notes will come to life right here.'}</span></div>}
    </div>
    {!empty && zoom > 1 && <input className="roll-scrubber" aria-label="Scroll through piano roll" type="range" min={0} max={maxStart} step={0.1} value={start} onChange={event => { const value = Number(event.target.value); setViewStart(value); onSeek(value); }} />}
  </div>;
}
