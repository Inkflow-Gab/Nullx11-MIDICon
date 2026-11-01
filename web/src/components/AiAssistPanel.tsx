import { Activity, Check, Download, LoaderCircle, ShieldCheck, Sparkles, WandSparkles } from 'lucide-react';
import type { AiAnalysis } from '../types';

export type AiStatus = 'off' | 'ready' | 'downloading' | 'running' | 'applied' | 'error';
type Props = {
  enabled: boolean; align: boolean; status: AiStatus; ai?: AiAnalysis | null;
  busy?: boolean; canPolish?: boolean; detail?: string;
  onToggle: (value: boolean) => void; onAlign: (value: boolean) => void; onPolish: () => void;
};
const STATUS_LABEL: Record<AiStatus, string> = {
  off: 'Off · standard conversion', ready: 'Ready · model downloads on first use', downloading: 'Downloading local model…',
  running: 'Analyzing beats on this device…', applied: 'Applied to this result', error: 'AI Assist unavailable · original kept',
};

export function AiAssistPanel({ enabled, align, status, ai, busy, canPolish, detail, onToggle, onAlign, onPolish }: Props) {
  const active = enabled && status !== 'error';
  return <section className={`card ai-assist-card ${active ? 'enabled' : ''}`} aria-label="AI Assist">
    <div className="ai-assist-heading">
      <span className="ai-assist-icon"><Sparkles size={18} /></span>
      <div><h2>AI Assist</h2><span className="ai-assist-sub">Beat This! small0 · free · on-device</span></div>
      <button type="button" role="switch" aria-checked={enabled} aria-label="Enable AI Assist" className={`ai-switch ${enabled ? 'on' : ''}`} disabled={busy} onClick={() => onToggle(!enabled)}><i /></button>
    </div>
    <p className="ai-assist-copy">A real local music model listens for beats and downbeats, sharpens the tempo estimate, and can gently align note timing. It does not replace the piano transcription model, upload your audio, or train on your music.</p>
    <div className={`ai-status ${status}`} role="status">
      {status === 'downloading' || status === 'running' ? <LoaderCircle size={14} className="spin" /> : status === 'applied' ? <Check size={14} /> : status === 'error' ? <Activity size={14} /> : <ShieldCheck size={14} />}
      <span>{detail && (status === 'running' || status === 'downloading' || status === 'error') ? detail : STATUS_LABEL[status]}</span>
    </div>
    {enabled && <div className="ai-assist-options">
      <label className="ai-align-toggle"><input type="checkbox" checked={align} disabled={busy} onChange={event => onAlign(event.target.checked)} /><span><strong>Gentle timing alignment</strong><small>Nudge notes already close to the AI beat grid. Keeps duration, velocity, and expression.</small></span></label>
      <div className="ai-model-note"><Download size={13} /><span>~10 MB model, downloaded once and cached for offline use. MIT licensed.</span></div>
    </div>}
    {ai && <div className="ai-result-grid" aria-label="AI beat analysis">
      <div><span>AI tempo</span><strong>{ai.tempo ? Math.round(ai.tempo) : '—'}<small>BPM</small></strong></div>
      <div><span>Meter</span><strong>{ai.meter ? `${ai.meter}/4` : '—'}</strong></div>
      <div><span>Beats</span><strong>{ai.beat_count}</strong></div>
      <div><span>Downbeats</span><strong>{ai.downbeat_count}</strong></div>
    </div>}
    {ai && typeof ai.aligned_notes === 'number' && <p className="ai-aligned-note"><WandSparkles size={13} />{ai.aligned_notes} notes gently aligned to the beat grid.</p>}
    {canPolish && <button type="button" className="button secondary small ai-polish-button" disabled={busy} onClick={onPolish}><WandSparkles size={14} />{ai ? 'Re-run AI timing polish' : 'Polish this result with AI'}</button>}
  </section>;
}
