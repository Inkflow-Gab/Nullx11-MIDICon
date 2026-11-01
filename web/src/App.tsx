import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, AudioLines, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3, CloudUpload, FileAudio, FolderOpen, Headphones, KeyboardMusic, Lightbulb, Link2, LoaderCircle, Menu, Music2, Plus, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, Upload, WandSparkles, X } from 'lucide-react';
import { cancelJob, clearHistory, createDemo, createYouTube, deleteJob, downloadUrl, getJobs, getNotes, getSession, libraryDownloadUrl, patchJob, refineJob, retryJob, saveEdit, uploadAudio } from './api';
import { DEFAULT_OPTIONS, fileSize, formatTime, isActive } from './types';
import type { Job, Note, Options, Session } from './types';
import { PianoRoll } from './components/PianoRoll';
import { EditorPanel } from './components/EditorPanel';
import { Player } from './components/Player';
import { SettingsPanel } from './components/SettingsPanel';
import { Progress } from './components/Progress';
import { History } from './components/History';
import { Guide } from './components/Guide';
import { Dialog } from './components/Dialog';
import { isStandaloneDisplay, type BeforeInstallPromptEvent } from './pwa';

type Route = 'studio' | 'library' | 'guide';
type Modal = { type: 'settings' | 'about' | 'clear' } | { type: 'rename' | 'delete'; job: Job } | null;
const getRoute = (): Route => { const route = window.location.hash.slice(1); return route === 'library' || route === 'guide' ? route : 'studio'; };
function storedOptions(): Options { try { return { ...DEFAULT_OPTIONS, ...JSON.parse(localStorage.getItem('midicon-options') || '{}') }; } catch { return { ...DEFAULT_OPTIONS }; } }

export default function App() {
  const [route, setRoute] = useState<Route>(getRoute);
  const [session, setSession] = useState<Session | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notesCache, setNotesCache] = useState<Record<string, Note[]>>({});
  const [notesLoading, setNotesLoading] = useState(false);
  const [options, setOptions] = useState<Options>(storedOptions);
  const [tab, setTab] = useState<'upload' | 'youtube'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [rename, setRename] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(() => { const value = Number(localStorage.getItem('midicon-volume') ?? 0.55); return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.55; });
  const [editMode, setEditMode] = useState(false);
  const [draftNotes, setDraftNotes] = useState<Note[]>([]);
  const [selectedNotes, setSelectedNotes] = useState<Set<string>>(new Set());
  const [undoStack, setUndoStack] = useState<Note[][]>([]);
  const [redoStack, setRedoStack] = useState<Note[][]>([]);
  const [savingEdit, setSavingEdit] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandaloneDisplay);
  const [offline, setOffline] = useState(() => !navigator.onLine);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadRequest = useRef<{ abort: () => void } | null>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const selectedJob = jobs.find(job => job.id === selectedId) || null;
  const notes = selectedId ? notesCache[selectedId] || [] : [];
  const completed = selectedJob?.status === 'completed';
  const displayNotes = editMode ? draftNotes : notes;
  const editDirty = editMode && JSON.stringify(draftNotes.map(({ id: _id, ...note }) => note)) !== JSON.stringify(notes.map(({ id: _id, ...note }) => note));
  const completedCount = jobs.filter(job => job.status === 'completed').length;
  const activeIds = jobs.filter(isActive).map(job => job.id).join(',');
  const notify = useCallback((message: string) => setToast(message), []);

  const navigate = useCallback((next: Route) => { window.location.hash = next; setRoute(next); setMobileNav(false); window.scrollTo({ top: 0, behavior: 'smooth' }); }, []);
  useEffect(() => { const handler = () => setRoute(getRoute()); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, []);
  useEffect(() => { let live = true; getSession().then(async value => { if (!live) return; setSession(value); const items = await getJobs(); if (!live) return; setJobs(items); const saved = localStorage.getItem(`midicon-selected-${value.workspace_id}`); const initial = items.find(job => job.id === saved) || items.find(isActive) || items.find(job => job.status === 'completed'); if (initial) { setSelectedId(initial.id); setOptions(initial.options); } }).catch(() => { if (live) setConnectionError('The studio server is not reachable. Start the API server, then refresh to reconnect.'); }); return () => { live = false; }; }, []);
  useEffect(() => { localStorage.setItem('midicon-options', JSON.stringify(options)); }, [options]);
  useEffect(() => { localStorage.setItem('midicon-volume', String(volume)); }, [volume]);
  useEffect(() => { if (session && selectedId) localStorage.setItem(`midicon-selected-${session.workspace_id}`, selectedId); }, [selectedId, session]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 4200); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!session || !activeIds) return;
    const sources = activeIds.split(',').map(id => {
      const source = new EventSource(`/api/jobs/${id}/events`);
      source.addEventListener('job', event => {
        const job = JSON.parse((event as MessageEvent).data) as Job;
        setJobs(previous => previous.map(item => item.id === job.id ? job : item));
        if (!isActive(job)) { source.close(); void getJobs().then(setJobs).catch(() => {}); if (job.status === 'completed') notify('Your piano MIDI is ready. Make it yours.'); }
      });
      return source;
    });
    // SSE is primary; polling recovers from a sleeping tab or interrupted proxy.
    const timer = window.setInterval(() => { void getJobs().then(setJobs).catch(() => {}); }, 4000);
    return () => { sources.forEach(source => source.close()); window.clearInterval(timer); };
  }, [activeIds, session?.workspace_id, notify]);
  useEffect(() => {
    if (!selectedJob || selectedJob.status !== 'completed' || notesCache[selectedJob.id]) return;
    let live = true; setNotesLoading(true);
    getNotes(selectedJob.id).then(value => { if (live) setNotesCache(previous => ({ ...previous, [selectedJob.id]: value })); }).catch(err => { if (live) setError(err.message); }).finally(() => { if (live) setNotesLoading(false); });
    return () => { live = false; };
  }, [selectedJob?.id, selectedJob?.status]);
  useEffect(() => () => uploadRequest.current?.abort(), []);
  useEffect(() => {
    const onPrompt = (event: Event) => { event.preventDefault(); setInstallPrompt(event as BeforeInstallPromptEvent); };
    const onInstalled = () => { setInstalled(true); setInstallPrompt(null); notify('MIDICon installed. Launch it from your home screen or desktop.'); };
    const onUpdate = () => notify('A new MIDICon version is ready. Refresh to update.');
    const onOnline = () => setOffline(false);
    const onOffline = () => setOffline(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    window.addEventListener('midicon-sw-update', onUpdate);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      window.removeEventListener('midicon-sw-update', onUpdate);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [notify]);
  async function installApp() {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === 'accepted') notify('Installing MIDICon…');
    } finally {
      setInstallPrompt(null);
    }
  }

  function acceptFile(value: File | undefined) {
    if (!value) return;
    setError('');
    const extension = '.' + value.name.split('.').pop()?.toLowerCase();
    if (!(session?.extensions || DEFAULT_EXTENSIONS).includes(extension)) { setError('That format is not supported. Try MP3, WAV, M4A, MP4, or FLAC.'); return; }
    if (value.size > (session?.max_upload_mb || 100) * 1024 * 1024) { setError(`That file is a little too big. The limit is ${session?.max_upload_mb || 100} MB.`); return; }
    if (value.size < 32) { setError('This file looks empty. Please choose a recording with audio.'); return; }
    setFile(value); setTab('upload');
  }
  function addJob(job: Job) { setJobs(previous => [job, ...previous.filter(item => item.id !== job.id)]); setSelectedId(job.id); setError(''); navigate('studio'); }
  async function convert() {
    if (busy || !session) return;
    setError(''); setBusy(true); setUploadProgress(0);
    try {
      if (tab === 'upload') {
        if (!file) { setError('Choose a song first, or try our original demo.'); return; }
        const request = uploadAudio(file, options, setUploadProgress); uploadRequest.current = request;
        const job = await request.promise; addJob(job); setFile(null);
      } else { const job = await createYouTube(url.trim(), options); addJob(job); }
    } catch (err) { if (!(err instanceof DOMException && err.name === 'AbortError')) setError(err instanceof Error ? err.message : 'The conversion could not start.'); }
    finally { setBusy(false); uploadRequest.current = null; }
  }
  async function tryDemo() { if (busy || !session) return; setBusy(true); setError(''); try { addJob(await createDemo(options)); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }
  async function action(callback: () => Promise<unknown>, success?: string) {
    if (busy) return; setBusy(true); setError('');
    try { await callback(); if (success) notify(success); } catch (err) { notify((err as Error).message); } finally { setBusy(false); }
  }
  function openJob(job: Job) { setSelectedId(job.id); setOptions(job.options); navigate('studio'); }
  function cancelEdit() { setEditMode(false); setDraftNotes([]); setSelectedNotes(new Set()); setUndoStack([]); setRedoStack([]); }
  useEffect(() => { cancelEdit(); }, [selectedId]);
  function beginEdit() {
    if (!selectedJob || !completed || notes.length === 0) return;
    setDraftNotes(notes.map((note, index) => ({ ...note, id: note.id || `${selectedJob.id}-${index}` })));
    setSelectedNotes(new Set()); setUndoStack([]); setRedoStack([]); setEditMode(true);
  }
  function commitDraft(next: Note[]) { setUndoStack(previous => [...previous.slice(-29), draftNotes]); setRedoStack([]); setDraftNotes(next); }
  function undoEdit() { if (!undoStack.length) return; const previous = undoStack[undoStack.length - 1]; setRedoStack(stack => [...stack, draftNotes]); setUndoStack(stack => stack.slice(0, -1)); setDraftNotes(previous); setSelectedNotes(new Set()); }
  function redoEdit() { if (!redoStack.length) return; const next = redoStack[redoStack.length - 1]; setUndoStack(stack => [...stack, draftNotes]); setRedoStack(stack => stack.slice(0, -1)); setDraftNotes(next); setSelectedNotes(new Set()); }
  function selectNote(id: string | null, additive: boolean) {
    if (!id) { if (!additive) setSelectedNotes(new Set()); return; }
    setSelectedNotes(previous => { const next = new Set(additive ? previous : []); if (additive && next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function deleteSelected() { if (!selectedNotes.size) return; commitDraft(draftNotes.filter(note => !note.id || !selectedNotes.has(note.id))); setSelectedNotes(new Set()); }
  function setSelectionVelocity(velocity: number) { if (!selectedNotes.size) return; commitDraft(draftNotes.map(note => note.id && selectedNotes.has(note.id) ? { ...note, velocity } : note)); }
  async function saveEditedVersion() {
    if (!selectedJob || !editDirty || draftNotes.length === 0 || savingEdit) return;
    setSavingEdit(true);
    try { const job = await saveEdit(selectedJob.id, draftNotes); addJob(job); notify('Saved your edited version. The original stays unchanged.'); cancelEdit(); }
    catch (err) { notify((err as Error).message); }
    finally { setSavingEdit(false); }
  }
  useEffect(() => {
    if (!editMode) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redoEdit(); else undoEdit(); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redoEdit(); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelected(); }
      else if (event.key === 'Escape') cancelEdit();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editMode, draftNotes, selectedNotes, undoStack, redoStack]);
  async function refine() {
    if (!selectedJob || busy) return; setBusy(true); setError('');
    try { const job = await refineJob(selectedJob.id, options); addJob(job); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function confirmModal() {
    if (!modal) return;
    if (modal.type === 'rename') {
      if (!rename.trim()) return;
      await action(async () => { const job = await patchJob(modal.job.id, { title: rename.trim() }); setJobs(previous => previous.map(item => item.id === job.id ? job : item)); setModal(null); }, 'A new name. The same good idea.');
    } else if (modal.type === 'delete') {
      await action(async () => { await deleteJob(modal.job.id); setJobs(previous => previous.filter(item => item.id !== modal.job.id)); if (selectedId === modal.job.id) setSelectedId(null); setModal(null); }, 'Conversion and its files deleted.');
    } else if (modal.type === 'clear') {
      await action(async () => { await clearHistory(); const remaining = await getJobs(); setJobs(remaining); if (!remaining.some(job => job.id === selectedId)) setSelectedId(null); setNotesCache({}); setModal(null); }, 'Your conversion history has been cleared.');
    }
  }
  const historyProps = { jobs, onOpen: openJob, onViewAll: () => navigate('library'), onFavorite: (job: Job) => void action(async () => { const updated = await patchJob(job.id, { favorite: !job.favorite }); setJobs(previous => previous.map(item => item.id === job.id ? updated : item)); }), onRename: (job: Job) => { setRename(job.title); setModal({ type: 'rename', job }); }, onDelete: (job: Job) => setModal({ type: 'delete', job }), retentionDays: session?.retention_days || 7 };

  return <div className="app-shell">
    {mobileNav && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
      <a className="brand" href="#studio" onClick={() => navigate('studio')} aria-label="Nullx MIDICon home"><span className="brand-mark"><KeyboardMusic size={25} strokeWidth={1.7} /></span><span className="brand-wordmark">nullx<span>MIDICon</span></span></a>
      <div className="workspace-label">YOUR CREATIVE SPACE</div>
      <nav className="main-nav" aria-label="Main navigation"><button className={route === 'studio' ? 'active' : ''} onClick={() => navigate('studio')}><AudioLines size={19} /><span>Studio</span><span className="nav-active-dot" /></button><button className={route === 'library' ? 'active' : ''} onClick={() => navigate('library')}><FolderOpen size={18} /><span>My library</span><span className="nav-count">{jobs.length}</span></button><button className={route === 'guide' ? 'active' : ''} onClick={() => navigate('guide')}><Lightbulb size={18} /><span>How it works</span><ArrowUpRight size={13} className="nav-arrow" /></button></nav>
      <div className="sidebar-divider" /><button className="sidebar-settings" onClick={() => setModal({ type: 'settings' })}><Settings2 size={17} />Workspace settings</button>
      <div className="sidebar-bottom"><div className="sidebar-note"><div className="mini-keys" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i} className={[1, 3, 6].includes(i) ? 'black' : ''} />)}<Music2 size={18} className="floating-note" /></div><h3>Good music deserves<br />a second life.</h3><p>Make something that<br />could only come from you.</p><button onClick={() => navigate('guide')}>Find your inspiration <ArrowUpRight size={13} /></button></div><button className="workspace-profile" onClick={() => setModal({ type: 'settings' })}><span className="avatar">Y</span><span><strong>Your workspace</strong><small><span className="tiny-dot" /> Just for you</small></span><ChevronDown size={14} /></button></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={21} /></button><span>Workspace</span><ChevronRight size={13} /><strong>{route === 'studio' ? 'Studio' : route === 'library' ? 'My library' : 'How it works'}</strong></div><div className="topbar-right"><span className={`system-status ${offline || connectionError || (session && !session.engines.length) ? 'offline' : ''}`}><i />{offline ? 'Offline' : connectionError ? 'Server offline' : session ? session.engines.length ? 'Ready when you are' : 'Model setup needed' : 'Connecting to studio'}</span>{installPrompt && !installed && <button className="icon-button" aria-label="Install MIDICon app" title="Install MIDICon" onClick={() => void installApp()}><ArrowDownToLine size={18} /></button>}<span className="topbar-divider" /><button className="icon-button" aria-label="Help and tips" onClick={() => navigate('guide')}><CircleHelp size={19} /></button><button className="topbar-avatar" aria-label="Workspace settings" onClick={() => setModal({ type: 'settings' })}>Y</button></div></header>
      <main className="main-content">
        {offline && <div className="connection-banner" role="status"><CloudUpload size={19} /><span>You’re offline. The cached app shell can open, but conversion, history, and downloads need the server.</span></div>}
        {connectionError && <div className="connection-banner" role="alert"><CloudUpload size={19} /><span>{connectionError}</span><button className="text-button" onClick={() => window.location.reload()}>Reconnect</button></div>}
        {route === 'studio' && <>
          <div className="page-heading studio-heading"><div><div className="eyebrow"><span /> A NEW WAY TO MAKE IT YOURS</div><h1>From sound to keys<span className="heading-dot">.</span></h1><p>Turn a song you love into MIDI you can make your own.</p></div><div className="heading-pill"><Sparkles size={14} /><span>Big ideas start with a little audio</span></div></div>
          <div className="studio-grid"><div className="input-column">
            <section className="card upload-card"><div className="card-heading"><div className="heading-with-icon"><span className="step-number">01</span><h2>Bring your sound</h2></div><span className="format-badge">AUDIO → PIANO MIDI</span></div>
              <div className="input-tabs" role="tablist" aria-label="Audio source"><button role="tab" aria-selected={tab === 'upload'} className={tab === 'upload' ? 'active' : ''} onClick={() => { setTab('upload'); setError(''); }}><Upload size={15} />Upload audio</button><button role="tab" aria-selected={tab === 'youtube'} className={tab === 'youtube' ? 'active' : ''} onClick={() => { setTab('youtube'); setError(''); }}><Link2 size={16} />YouTube link<span className="new-badge">NEW</span></button></div>
              <input ref={fileInput} type="file" className="sr-only" accept={(session?.extensions || DEFAULT_EXTENSIONS).join(',')} onChange={event => { acceptFile(event.target.files?.[0]); event.target.value = ''; }} aria-label="Choose audio or video file" />
              {tab === 'upload' ? <div className={`dropzone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); if (!busy) acceptFile(event.dataTransfer.files[0]); }}>
                {file ? <><span className="upload-icon selected-file-icon"><FileAudio size={26} /></span><h3 className="selected-file-name">{file.name}</h3><p>{fileSize(file.size)} <span className="dot-separator">·</span> Ready for a new interpretation</p><div className="file-actions"><button className="button secondary small" disabled={busy} onClick={() => fileInput.current?.click()}>Choose another</button><button className="icon-button" disabled={busy} aria-label="Remove selected file" onClick={() => setFile(null)}><X size={17} /></button></div></> : <><span className="upload-icon"><CloudUpload size={28} strokeWidth={1.6} /><span className="upload-icon-plus"><Plus size={10} /></span></span><h3>{dragging ? 'Drop it like it’s a song.' : 'Drop your song here'}</h3><p>That melody in your head? Let’s get it on the keys.</p><button className="button browse-button" disabled={busy || !session} onClick={() => fileInput.current?.click()}><Plus size={15} />Browse files</button><span className="dropzone-formats">MP3, WAV, M4A, MP4, FLAC + more</span></>}
                <span className="dropzone-limit">Up to {session?.max_upload_mb || 100} MB <i /> {Math.round((session?.max_duration_seconds || 600) / 60)} minutes of audio</span>
              </div> : <div className="youtube-input"><span className="youtube-icon"><Link2 size={26} /></span><h3>A good song is just a link away.</h3><p>Paste a YouTube video. We’ll take care of the audio.</p><label className="youtube-url-field"><Link2 size={17} /><input type="url" aria-label="YouTube video URL" placeholder="https://www.youtube.com/watch?v=…" value={url} disabled={busy} onChange={event => setUrl(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void convert(); }} />{url && <button className="icon-button tiny" aria-label="Clear YouTube link" onClick={() => setUrl('')}><X size={14} /></button>}</label><span className="youtube-hint"><ShieldCheck size={13} /> Public videos · only music you have permission to use</span></div>}
              {file && <details className="trim-settings"><summary>Trim your audio <span>Optional</span><ChevronDown size={14} /></summary><div className="settings-grid"><label className="field-label">Start at (seconds)<input type="number" min={0} max={600} step={0.1} value={options.start_seconds} onChange={event => setOptions({ ...options, start_seconds: Number(event.target.value) })} /></label><label className="field-label">Length (seconds)<input type="number" min={0.2} max={session?.max_duration_seconds || 600} step={0.1} placeholder="Full song" value={options.duration_seconds ?? ''} onChange={event => setOptions({ ...options, duration_seconds: event.target.value ? Number(event.target.value) : null })} /></label></div><p className="field-hint">A shorter, focused clip is a great way to get cleaner notes.</p></details>}
              {error && <div className="form-error" role="alert"><CircleHelp size={16} /><span>{error}</span><button className="icon-button tiny" aria-label="Dismiss error" onClick={() => setError('')}><X size={13} /></button></div>}
              {busy && tab === 'upload' && file && <div className="upload-progress"><span>Uploading your song… {uploadProgress}%</span><button className="text-button" onClick={() => uploadRequest.current?.abort()}>Cancel</button><div><i style={{ width: `${uploadProgress}%` }} /></div></div>}
              <button className="button primary convert-button" disabled={busy || !session || !session.engines.length || (tab === 'upload' ? !file : !url.trim())} onClick={() => void convert()}>{busy ? <LoaderCircle size={17} className="spin" /> : <WandSparkles size={17} />}<span>{busy ? tab === 'upload' && file ? `Uploading · ${uploadProgress}%` : 'Starting your conversion…' : tab === 'youtube' ? 'Fetch & convert to MIDI' : 'Convert to piano MIDI'}</span>{!busy && <ArrowRight size={17} />}</button>
              <div className="upload-footer"><span><ShieldCheck size={12} />Your audio stays in your workspace</span><button className="text-button" disabled={busy || !session} onClick={() => void tryDemo()}>Try a demo <ArrowUpRight size={13} /></button></div>
            </section>
            <div ref={settingsRef} className="settings-anchor"><div className="step-label"><span className="step-number">02</span> A FEW FINISHING TOUCHES</div><SettingsPanel options={options} onChange={setOptions} session={session} disabled={busy} lockedEngine={!!completed} />{completed && selectedJob?.has_audio && <div className="refine-bar"><span>Already have a result? Skip the re-upload.</span><button className="button secondary small" disabled={busy || JSON.stringify(options) === JSON.stringify(selectedJob.options)} onClick={() => void refine()}><SlidersHorizontal size={14} />Apply & refine</button></div>}</div>
          </div>
          <div className="preview-column" ref={previewRef}><section className="card preview-card"><div className="card-heading"><div className="heading-with-icon"><KeyboardMusic size={18} /><h2>Your piano canvas</h2></div><span className={`preview-badge ${completed ? 'ready' : ''}`}>{completed ? <><span /> MIDI READY</> : 'THE GOOD PART'}</span></div>
            {selectedJob && <div className="preview-song"><span className="preview-song-icon"><Music2 size={17} /></span><div><strong>{selectedJob.title}</strong><span>{selectedJob.source_type === 'youtube' ? 'From YouTube' : selectedJob.source_type === 'demo' ? 'An original, synthesized piano demo' : selectedJob.source_type === 'refined' ? 'Your refined interpretation' : selectedJob.source_type === 'edited' ? 'Your manually edited version' : 'From your audio upload'}</span></div>{selectedJob.favorite && <Music2 size={14} />}</div>}
            {selectedJob && isActive(selectedJob) && <Progress job={selectedJob} busy={busy} onCancel={() => void action(async () => { const job = await cancelJob(selectedJob.id); setJobs(previous => previous.map(item => item.id === job.id ? job : item)); }, 'Conversion cancelled.')} onRetry={() => void action(async () => { const job = await retryJob(selectedJob.id, options); setJobs(previous => previous.map(item => item.id === job.id ? job : item)); })} />}
            {selectedJob && ['failed', 'cancelled'].includes(selectedJob.status) && <Progress job={selectedJob} busy={busy} onCancel={() => {}} onRetry={() => void action(async () => { const job = await retryJob(selectedJob.id, options); setJobs(previous => previous.map(item => item.id === job.id ? job : item)); })} />}
            {editMode && <EditorPanel notes={draftNotes} selectedIds={selectedNotes} dirty={editDirty} busy={savingEdit} canUndo={undoStack.length > 0} canRedo={redoStack.length > 0} onUndo={undoEdit} onRedo={redoEdit} onSelectAll={() => setSelectedNotes(new Set(draftNotes.map(note => note.id!).filter(Boolean)))} onClearSelection={() => setSelectedNotes(new Set())} onDeleteSelected={deleteSelected} onVelocity={setSelectionVelocity} onSave={() => void saveEditedVersion()} onCancel={cancelEdit} />}
            <PianoRoll notes={displayNotes} duration={selectedJob?.result?.duration || 0} currentTime={currentTime} onSeek={setCurrentTime} loading={!!selectedJob && isActive(selectedJob)} editable={editMode} selectedIds={selectedNotes} onSelectNote={selectNote} />
            <Player job={selectedJob} notes={displayNotes} currentTime={currentTime} onSeek={setCurrentTime} volume={volume} onVolume={setVolume} />
            {completed && selectedJob?.result ? <><div className="result-stats"><div><span>Notes found</span><strong>{selectedJob.result.note_count.toLocaleString()}<Music2 size={14} /></strong></div><div><span>Duration</span><strong>{formatTime(selectedJob.result.duration)}<Clock3 size={14} /></strong></div><div><span>Est. tempo</span><strong>{Math.round(selectedJob.result.tempo)}<small>BPM</small></strong></div></div><div className="result-meta"><span><span className="tiny-dot" />{selectedJob.result.engine_name}</span><span>Est. key: {selectedJob.result.key}</span></div><div className="download-row"><a className="button primary" href={downloadUrl(selectedJob.id)} download onClick={() => notify('Your MIDI download is starting.')}><ArrowDownToLine size={17} />Download MIDI<span className="download-extension">.mid</span></a><details className="export-menu"><summary className="button secondary" aria-label="More download formats"><ChevronDown size={17} /></summary><div><span>TAKE IT WITH YOU</span><a href={downloadUrl(selectedJob.id, 'zip')} download><FolderOpen size={15} /><span>Complete package<small>MIDI + notes + settings</small></span><b>.zip</b></a><a href={downloadUrl(selectedJob.id, 'json')} download><AudioLines size={15} /><span>Note events</span><b>.json</b></a><a href={downloadUrl(selectedJob.id, 'csv')} download><FileAudio size={15} /><span>Spreadsheet</span><b>.csv</b></a></div></details></div><div className="result-bottom"><span><CheckCircle2 size={12} /> Saved to your library</span><div className="result-bottom-actions">{!editMode && notes.length > 0 && <button className="text-button" disabled={busy || savingEdit} onClick={beginEdit}><SlidersHorizontal size={12} />Edit notes</button>}<button className="text-button" onClick={() => { settingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); settingsRef.current?.querySelector('details')?.setAttribute('open', ''); }}>Fine-tune result <ArrowUpRight size={12} /></button></div></div></> : <div className="preview-unlock"><span className="unlock-icon"><Headphones size={19} /></span><div><strong>Hear it. Shape it. Make it yours.</strong><p>Playback and downloads unlock after your conversion.</p></div></div>}
            {notesLoading && <div className="notes-loading"><LoaderCircle size={13} className="spin" />Loading your notes…</div>}
          </section><aside className="tip-card"><span className="tip-icon"><Lightbulb size={19} /></span><div><h3>A little tip for a cleaner canvas</h3><p>Solo piano recordings shine brightest. Full songs can bring a few extra notes along for the ride.</p><button className="text-button" onClick={() => navigate('guide')}>Get the best results <ArrowRight size={13} /></button></div></aside><div className="privacy-line"><ShieldCheck size={13} /><span>Private by design. Creative by nature.</span></div></div></div>
          <History {...historyProps} compact />
        </>}
        {route === 'library' && <><div className="page-heading"><div><div className="eyebrow"><span /> YOUR IDEAS, ALL TOGETHER</div><h1>A library of possibilities<span className="heading-dot">.</span></h1><p>Every conversion, every variation. Ready for your next chapter.</p></div><div className="heading-actions">{completedCount > 0 && <a className="button secondary" href={libraryDownloadUrl} download onClick={() => notify('Your library download is starting.')}><ArrowDownToLine size={16} />Download all MIDI</a>}<button className="button primary" onClick={() => navigate('studio')}><Plus size={17} />New transcription</button></div></div><div className="library-notice"><ShieldCheck size={17} /><span>This is your private browser workspace. Download your favorites—files are kept for {session?.retention_days || 7} days.</span><button className="text-button" onClick={() => setModal({ type: 'settings' })}>Manage <ArrowUpRight size={13} /></button></div><History {...historyProps} /></>}
        {route === 'guide' && <Guide onStart={() => navigate('studio')} />}
        <footer className="page-footer"><span><KeyboardMusic size={15} />Made for the music in you.</span><div><button onClick={() => navigate('guide')}>Tips & limitations</button><i /><button onClick={() => setModal({ type: 'about' })}>About MIDICon</button><span className="footer-version">v1.0</span></div></footer>
      </main>
    </div>
    {toast && <div className="toast" role="status"><CheckCircle2 size={18} /><span>{toast}</span><button className="icon-button tiny" aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div>}
    {modal && <Dialog title={modal.type === 'settings' ? 'Your workspace, your way.' : modal.type === 'rename' ? 'Give it a new name' : modal.type === 'delete' ? 'Delete this conversion?' : modal.type === 'clear' ? 'Start with a clean library?' : 'A little sound. A lot of possibility.'} onClose={() => setModal(null)}>
      {modal.type === 'settings' && <div className="workspace-settings"><div className="workspace-identity"><span className="avatar large">Y</span><div><strong>Your private workspace</strong><span>Browser session · {session?.workspace_id || 'connecting'}</span></div><ShieldCheck size={22} /></div><p className="dialog-description">No account needed. A private cookie keeps this browser's history separate from everyone else's. It is not a cross-device account.</p><label className="slider-field"><span>Preview volume <strong>{Math.round(volume * 100)}%</strong></span><input aria-label="Workspace preview volume" type="range" min={0} max={1} step={0.01} value={volume} onChange={event => setVolume(Number(event.target.value))} /></label><div className="saved-settings-note"><CheckCircle2 size={16} /><span>Your last-used transcription settings are saved automatically in this browser.</span></div><div className="pwa-install-box">{installed ? <div className="saved-settings-note"><CheckCircle2 size={16} /><span>MIDICon is installed as an app on this device.</span></div> : installPrompt ? <button className="button secondary full-width" onClick={() => void installApp()}><ArrowDownToLine size={15} />Install MIDICon app</button> : <p className="dialog-footnote">Want an app-like shortcut? Use your browser’s “Install app” or “Add to Home Screen” option. On iPhone/iPad: Share → Add to Home Screen.</p>}</div><div className="settings-info"><div><span>File retention</span><strong>{session?.retention_days || 7} days</strong></div><div><span>Storage</span><strong>This MIDICon server</strong></div><div><span>Transcription</span><strong>{session?.engines.map(engine => engine.name).join(' + ') || 'Not connected'}</strong></div></div><div className="privacy-warning"><ShieldCheck size={17} /><p>Clearing browser cookies loses access to this workspace. Download important files before clearing history or changing browsers.</p></div><button className="button danger-outline full-width" disabled={busy || !jobs.some(job => !isActive(job))} onClick={() => setModal({ type: 'clear' })}><Trash2 size={15} />Clear conversion history</button><p className="dialog-footnote">Active conversions are kept. Completed, failed, and cancelled items and their files are deleted.</p></div>}
      {modal.type === 'rename' && <form onSubmit={event => { event.preventDefault(); void confirmModal(); }}><p className="dialog-description">A name that makes this idea easy to find again.</p><label className="field-label">Conversion name<input autoFocus maxLength={160} value={rename} onChange={event => setRename(event.target.value)} required /></label><div className="dialog-actions"><button type="button" className="button secondary" onClick={() => setModal(null)}>Keep it as is</button><button className="button primary" disabled={busy || !rename.trim()} type="submit">Save name <Check size={15} /></button></div></form>}
      {(modal.type === 'delete' || modal.type === 'clear') && <><div className="delete-illustration"><Trash2 size={27} /></div><p className="dialog-description">{modal.type === 'delete' ? <>“{modal.job.title}” and its MIDI, audio, and note files will be permanently removed from this server.</> : 'All completed, failed, and cancelled conversions and their files will be permanently removed. Active conversions will stay in the queue.'}</p><p className="dialog-footnote">Download anything you want to keep first. This cannot be undone.</p><div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={() => setModal(null)}>Keep my music</button><button className="button danger" disabled={busy} onClick={() => void confirmModal()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}{modal.type === 'clear' ? 'Clear history' : 'Delete conversion'}</button></div></>}
      {modal.type === 'about' && <div className="about-dialog"><span className="brand-mark large"><KeyboardMusic size={33} /></span><h3>Nullx MIDICon</h3><p>An open creative workspace for turning recordings into playable piano MIDI. Built on the original instrument-agnostic research toolkit, with a piano-specialist engine and Spotify Basic Pitch.</p><div className="about-features"><span><Check size={14} />Real neural transcription</span><span><Check size={14} />Private browser history</span><span><Check size={14} />MIDI, JSON & CSV exports</span><span><Check size={14} />Open research attribution</span></div><p className="dialog-footnote">Automatic transcription is an estimate, not a perfect score. Clean solo piano works best. See the guide for model credits and limitations.</p><button className="button primary full-width" onClick={() => { setModal(null); navigate('guide'); }}>Explore the guide <ArrowRight size={15} /></button></div>}
    </Dialog>}
  </div>;
}
const DEFAULT_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.mp4', '.flac', '.ogg', '.opus', '.aac', '.webm', '.aiff', '.aif', '.mov', '.wma'];
