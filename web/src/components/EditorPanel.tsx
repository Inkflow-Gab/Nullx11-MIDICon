import { Check, MousePointer2, Redo2, Save, Trash2, Undo2, X } from 'lucide-react';
import type { Note } from '../types';
import { noteName } from '../types';

type Props = {
  notes: Note[]; selectedIds: Set<string>; dirty: boolean; busy?: boolean;
  canUndo: boolean; canRedo: boolean;
  onUndo: () => void; onRedo: () => void; onSelectAll: () => void; onClearSelection: () => void;
  onDeleteSelected: () => void; onVelocity: (velocity: number) => void; onSave: () => void; onCancel: () => void;
};

export function EditorPanel({ notes, selectedIds, dirty, busy, canUndo, canRedo, onUndo, onRedo, onSelectAll, onClearSelection, onDeleteSelected, onVelocity, onSave, onCancel }: Props) {
  const selected = notes.filter(note => note.id && selectedIds.has(note.id));
  const velocity = selected.length ? Math.round(selected.reduce((sum, note) => sum + note.velocity, 0) / selected.length) : 80;
  const summary = selected.length === 0 ? 'Click a note to select it. Shift-click to add more.' : selected.length === 1 ? `${noteName(selected[0].pitch)} · ${selected[0].start.toFixed(2)}s · velocity ${selected[0].velocity}` : `${selected.length} notes selected · average velocity ${velocity}`;
  return <div className="editor-panel" aria-label="Piano roll editor">
    <div className="editor-toolbar"><span className="editor-mode"><MousePointer2 size={14} /> Editing notes</span><div className="editor-actions"><button className="icon-button tiny" aria-label="Undo edit" disabled={!canUndo || busy} onClick={onUndo}><Undo2 size={15} /></button><button className="icon-button tiny" aria-label="Redo edit" disabled={!canRedo || busy} onClick={onRedo}><Redo2 size={15} /></button><button className="text-button" disabled={busy || notes.length === 0} onClick={onSelectAll}>Select all</button><button className="text-button" disabled={busy || selected.length === 0} onClick={onClearSelection}>Clear</button><button className="icon-button tiny danger-hover" aria-label="Delete selected notes" disabled={busy || selected.length === 0} onClick={onDeleteSelected}><Trash2 size={15} /></button></div></div>
    <div className="editor-selection"><span>{summary}</span><label className="editor-velocity"><span>Velocity</span><input aria-label="Selected note velocity" type="range" min={1} max={127} value={velocity} disabled={busy || selected.length === 0} onChange={event => onVelocity(Number(event.target.value))} /><strong>{selected.length ? velocity : '—'}</strong></label></div>
    <div className="editor-footer"><span>{notes.length} notes {dirty ? '· unsaved changes' : '· no changes yet'}</span><div><button className="button secondary small" disabled={busy} onClick={onCancel}><X size={13} />Cancel</button><button className="button primary small" disabled={busy || !dirty || notes.length === 0} onClick={onSave}>{busy ? <Check size={13} /> : <Save size={13} />}Save as new version</button></div></div>
  </div>;
}
