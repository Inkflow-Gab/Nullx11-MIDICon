import { useEffect, useState } from 'react';
import { AlertCircle, Check, Circle, Download, FileAudio, LoaderCircle, Music2, RotateCcw, X } from 'lucide-react';
import type { Job } from '../types';
import { formatTime, isActive } from '../types';

type Props = { job: Job; onCancel: () => void; onRetry: () => void; busy?: boolean };
export function Progress({ job, onCancel, onRetry, busy }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const elapsed = Math.max(0, Math.floor(((job.completed_at ? job.completed_at * 1000 : now) - job.created_at * 1000) / 1000));
  const remaining = isActive(job) && job.progress >= 8 && job.progress < 99 ? Math.max(0, Math.round(elapsed / job.progress * (100 - job.progress))) : null;
  const stages = [{ label: 'Get the audio', icon: Download, at: 3 }, { label: 'Prepare', icon: FileAudio, at: 25 }, { label: 'Transcribe', icon: Music2, at: 31 }, { label: 'Make MIDI', icon: Check, at: 89 }];
  if (job.status === 'failed' || job.status === 'cancelled') return <div className={`job-message ${job.status}`} role="status"><AlertCircle size={21} /><div><strong>{job.status === 'failed' ? 'This one needs another take.' : 'Conversion cancelled'}</strong><p>{job.error || 'No problem. Your input is still here whenever you’re ready.'}</p><button className="button secondary small" disabled={busy} onClick={onRetry}><RotateCcw size={14} /> Try again</button></div></div>;
  return <div className="conversion-progress" aria-live="polite"><div className="progress-heading"><span className="progress-spinner">{isActive(job) && <LoaderCircle size={19} className="spin" />}</span><div><strong>{job.status === 'queued' ? 'Good things are in the queue.' : job.stage}</strong><p>{job.status === 'queued' ? `Position ${job.queue_position || 1} · your conversion will start automatically` : job.detail || 'Working on your recording…'}</p></div><span className="progress-percent">{Math.round(job.progress)}<small>%</small></span></div><div className="progress-track" role="progressbar" aria-valuenow={Math.round(job.progress)} aria-valuemin={0} aria-valuemax={100} aria-label="Conversion progress"><div style={{ width: `${Math.max(1, job.progress)}%` }} /></div><div className="progress-stages">{stages.map(stage => <span key={stage.label} className={job.progress >= stage.at ? 'done' : ''}>{job.progress >= stage.at ? <Check size={12} /> : <Circle size={10} />}{stage.label}</span>)}</div><div className="progress-footer"><span>{formatTime(elapsed)} elapsed{remaining !== null ? <> <span className="dot-separator">·</span> ~{formatTime(remaining)} left</> : null} <span className="dot-separator">·</span> {job.status === 'queued' ? 'Waiting for a worker' : 'Keep this tab open'}</span><button className="text-button muted" disabled={busy} onClick={onCancel}><X size={13} />Cancel</button></div></div>;
}
