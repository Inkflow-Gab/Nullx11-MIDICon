import { useEffect, useRef, useState } from 'react';
import { Grid3X3, Minus, Plus, ScanLine } from 'lucide-react';
import type { Note } from '../types';
import { noteName } from '../types';

type Props = {
  notes: Note[]; duration: number; currentTime: number; onSeek: (time: number) => void;
  loading?: boolean; editable?: boolean; selectedIds?: Set<string>;
  onSelectNote?: (id: string | null, additive: boolean) => void;
  onChangeNotes?: (notes: Note[]) => void;
  beats?: number[]; downbeats?: number[];
};
type Drag = { mode: 'move' | 'left' | 'right'; ids: Set<string>; startTime: number; startPitch: number; original: Note[]; moved: boolean };
const DEMO: Note[] = Array.from({ length: 34 }, (_, i) => ({ start: (i % 12) * 0.62 + Math.floor(i / 12) * 0.18, end: (i % 12) * 0.62 + 0.35 + (i % 3) * 0.16, pitch: [60, 64, 67, 72, 67, 64, 57, 60, 64, 69, 64, 60][i % 12] + (i > 23 ? -12 : 0), velocity: 65 + i % 40 }));

export function PianoRoll({ notes, duration, currentTime, onSeek, loading, editable = false, selectedIds, onSelectNote, onChangeNotes, beats, downbeats }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const previewRef = useRef<Note[] | null>(null);
  const [preview, setPreview] = useState<Note[] | null>(null);
  const [cursor, setCursor] = useState('default');
  const [width, setWidth] = useState(500);
  const [zoom, setZoom] = useState(1);
  const [viewStart, setViewStart] = useState(0);
  const [showBeatGrid, setShowBeatGrid] = useState(true);
  const hasBeatGrid = !!beats?.length;
  const height = 248, keyboardHeight = 43, labelWidth = 32;
  const activeNotes = preview || notes;
  const empty = activeNotes.length === 0;
  const displayNotes = empty && !editable ? DEMO : activeNotes;
  const displayDuration = empty ? 8 : Math.max(duration, 1);
  const lowest = empty ? 45 : Math.max(21, Math.min(...notes.map(n => n.pitch)) - 3);
  const highest = empty ? 77 : Math.min(108, Math.max(lowest + 23, ...notes.map(n => n.pitch)) + 3);
  const pitchCount = highest - lowest + 1;
  const plotHeight = height - keyboardHeight - 24;
  const plotWidth = width - labelWidth;
  const scale = plotWidth / 8 * zoom;
  const maxStart = Math.max(0, displayDuration - plotWidth / scale);
  const start = currentTime > viewStart + plotWidth / scale - 0.3 ? Math.min(maxStart, Math.max(0, currentTime - 1)) : Math.min(viewStart, maxStart);
  const rowHeight = plotHeight / pitchCount;

  useEffect(() => {
    if (!wrapperRef.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.floor(entries[0].contentRect.width)));
    observer.observe(wrapperRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!editable) { setViewStart(0); setZoom(1); setPreview(null); previewRef.current = null; dragRef.current = null; } }, [notes, editable]);

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
    if (hasBeatGrid && showBeatGrid) {
      const down = new Set(downbeats || []);
      const visibleEnd = start + plotWidth / scale;
      for (const beat of beats!) {
        if (beat < start - 0.05 || beat > visibleEnd + 0.05) continue;
        const x = labelWidth + (beat - start) * scale;
        const isDown = down.has(beat);
        ctx.strokeStyle = isDown ? 'rgba(118,84,207,.34)' : 'rgba(118,84,207,.14)';
        ctx.lineWidth = isDown ? 1.2 : 0.7;
        ctx.beginPath(); ctx.moveTo(x, 24); ctx.lineTo(x, height - keyboardHeight); ctx.stroke();
      }
    }
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
      if (editable && selected && w > 14) {
        ctx.fillStyle = 'rgba(255,255,255,.55)';
        ctx.fillRect(x + 1, y + 2, 2, Math.max(2, rowHeight - 5));
        ctx.fillRect(x + w - 3, y + 2, 2, Math.max(2, rowHeight - 5));
      }
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
    const active = new Set(activeNotes.filter(n => n.start <= currentTime && n.end > currentTime).map(n => n.pitch));
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
  }, [width, displayNotes, activeNotes, notes, currentTime, start, scale, lowest, highest, empty, zoom, editable, selectedIds, rowHeight, hasBeatGrid, showBeatGrid, beats, downbeats]);

  function point(event: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    return { x, y, time: start + (x - labelWidth) / scale, pitch: highest - Math.floor((y - 24) / rowHeight), pitchFloat: highest - (y - 24) / rowHeight };
  }
  function hitNote(time: number, y: number) {
    for (let index = activeNotes.length - 1; index >= 0; index--) {
      const note = activeNotes[index];
      const ny = 24 + (highest - note.pitch) * rowHeight;
      if (time >= note.start && time <= note.end && y >= ny && y <= ny + rowHeight) return { note, id: note.id ?? String(index), ny };
    }
    return null;
  }
  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const { x, y, time, pitchFloat } = point(event);
    if (x < labelWidth || y > height - keyboardHeight || y < 24) return;
    if (!editable) { onSeek(Math.max(0, Math.min(duration, time))); return; }
    const hit = hitNote(time, y);
    if (!hit) { onSelectNote?.(null, event.shiftKey); return; }
    onSelectNote?.(hit.id, event.shiftKey);
    const ids = selectedIds?.has(hit.id) && !event.shiftKey ? new Set(selectedIds) : new Set([hit.id]);
    const edge = 6 / scale;
    const mode = time - hit.note.start <= edge ? 'left' : hit.note.end - time <= edge ? 'right' : 'move';
    dragRef.current = { mode, ids, startTime: time, startPitch: pitchFloat, original: notes.filter(note => note.id && ids.has(note.id)), moved: false };
    previewRef.current = notes;
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const { x, y, time, pitchFloat } = point(event);
    const drag = dragRef.current;
    if (!editable) { if (event.buttons === 1 && x >= labelWidth && y <= height - keyboardHeight) onSeek(Math.max(0, Math.min(duration, time))); return; }
    if (!drag) {
      if (x < labelWidth || y > height - keyboardHeight || y < 24) { setCursor('default'); return; }
      const hit = hitNote(time, y);
      if (!hit) { setCursor('crosshair'); return; }
      const edge = 6 / scale;
      setCursor(time - hit.note.start <= edge || hit.note.end - time <= edge ? 'ew-resize' : 'grab');
      return;
    }
    const dt = time - drag.startTime;
    const dp = Math.round(pitchFloat - drag.startPitch);
    if (Math.abs(dt) * scale > 3 || dp !== 0) drag.moved = true;
    const next = notes.map(note => {
      if (!note.id || !drag.ids.has(note.id)) return note;
      const original = drag.original.find(item => item.id === note.id) || note;
      if (drag.mode === 'move') {
        const startTime = Math.max(0, original.start + dt);
        return { ...note, start: startTime, end: startTime + (original.end - original.start), pitch: Math.max(0, Math.min(127, original.pitch + dp)) };
      }
      if (drag.mode === 'left') return { ...note, start: Math.max(0, Math.min(original.end - 0.03, original.start + dt)) };
      return { ...note, end: Math.max(original.start + 0.03, original.end + dt) };
    });
    previewRef.current = next; setPreview(next); setCursor(drag.mode === 'move' ? 'grabbing' : 'ew-resize');
  }
  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    if (drag?.moved && previewRef.current) onChangeNotes?.(previewRef.current);
    previewRef.current = null; setPreview(null); setCursor('default');
  }
  function handleDoubleClick(event: React.MouseEvent<HTMLCanvasElement>) {
    if (!editable || !onChangeNotes) return;
    const { x, y, time, pitch } = point(event);
    if (x < labelWidth || y > height - keyboardHeight || y < 24 || pitch < 0 || pitch > 127) return;
    if (hitNote(time, y)) return;
    const start = Math.max(0, time);
    onChangeNotes([...notes, { id: crypto.randomUUID(), start, end: start + 0.3, pitch, velocity: 80 }]);
  }

  return <div className="piano-roll" ref={wrapperRef}>
    <div className="roll-tools"><span><i className="legend-dot purple" /> Upper register <i className="legend-dot teal" /> Lower register{hasBeatGrid && <em className="roll-ai-hint"> · AI beat grid</em>}{editable && <em className="roll-edit-hint"> · drag to move · edges resize · double-click adds</em>}</span><div>{hasBeatGrid && <button className={`icon-button tiny ${showBeatGrid ? 'active' : ''}`} aria-label="Toggle AI beat grid" aria-pressed={showBeatGrid} title="Toggle AI beat grid" onClick={() => setShowBeatGrid(value => !value)}><Grid3X3 size={13} /></button>}<button className="icon-button tiny" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom(z => Math.max(1, z - 0.5))}><Minus size={13} /></button><button className="icon-button tiny" aria-label="Fit piano roll" onClick={() => { setZoom(1); setViewStart(0); onSeek(0); }}><ScanLine size={13} /></button><button className="icon-button tiny" aria-label="Zoom in" disabled={zoom >= 4} onClick={() => setZoom(z => Math.min(4, z + 0.5))}><Plus size={13} /></button></div></div>
    <div className="roll-canvas-wrap"><canvas ref={canvasRef} className={editable ? 'editable' : undefined} style={{ width: '100%', height, cursor: editable ? cursor : 'pointer', touchAction: editable ? 'none' : 'pan-y' }} aria-label={editable ? `Editable piano roll with ${notes.length} notes. Drag notes to move, drag edges to resize, double-click to add.` : empty ? 'Illustrative piano roll. Convert a song to see your actual notes.' : `Piano roll with ${notes.length} notes. Click to seek.`} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp} onDoubleClick={handleDoubleClick} />
      {empty && <div className="roll-empty"><span className="roll-empty-icon"><ScanLine size={21} /></span><strong>{editable ? 'No notes left' : loading ? 'Finding your notes…' : 'A little sound. A whole new canvas.'}</strong><span>{editable ? 'Double-click to add a note, or undo to restore.' : loading ? 'Your piano roll is on its way.' : 'Your notes will come to life right here.'}</span></div>}
    </div>
    {!empty && zoom > 1 && <input className="roll-scrubber" aria-label="Scroll through piano roll" type="range" min={0} max={maxStart} step={0.1} value={start} onChange={event => { const value = Number(event.target.value); setViewStart(value); onSeek(value); }} />}
  </div>;
}
