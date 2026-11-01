import type { Job, Note, Options, Session } from './types';
import * as local from './local/workspace';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
const apiBase = new URL('api/', document.baseURI).href;
const serverMarker = `midicon-server:${apiBase}`;
type WorkspaceMode = 'browser' | 'server';
let modePromise: Promise<WorkspaceMode> | null = null;
async function detectMode(): Promise<WorkspaceMode> {
  const requested = new URLSearchParams(location.search).get('mode');
  if (requested === 'browser') return 'browser';
  if (requested !== 'server' && location.hostname.endsWith('.github.io')) return 'browser';
  try {
    const response = await fetch(`${apiBase}health`, { signal: AbortSignal.timeout(4000), cache: 'no-store', credentials: 'same-origin' });
    const body = await response.json();
    if (Array.isArray(body.engines) && typeof body.inference === 'string') { localStorage.setItem(serverMarker, 'yes'); return 'server'; }
  } catch { /* A static host has no Python API. */ }
  if (requested === 'server' || (!navigator.onLine && localStorage.getItem(serverMarker) === 'yes')) return 'server';
  return 'browser';
}
function mode() { if (!modePromise) modePromise = detectMode(); return modePromise; }
export async function isBrowserWorkspace() { return (await mode()) === 'browser'; }
export const subscribeBrowserJobs = local.subscribeBrowserJobs;

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET') headers.set('X-MIDICon-Client', 'web');
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(`${apiBase}${path.replace(/^\//, '')}`, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    let message = `Something went wrong (${response.status}). Please try again.`;
    try { const body = await response.json(); if (typeof body.detail === 'string') message = body.detail; } catch { /* Non-JSON proxy error */ }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export async function getSession(): Promise<Session> { return await isBrowserWorkspace() ? local.browserSession : api<Session>('/session'); }
export async function getJobs(): Promise<Job[]> { return await isBrowserWorkspace() ? local.browserJobs() : api<{ jobs: Job[] }>('/jobs').then(data => data.jobs); }
export async function getNotes(id: string): Promise<Note[]> { return await isBrowserWorkspace() ? local.browserNotes(id) : api<{ notes: Note[] }>(`/jobs/${id}/notes`).then(data => data.notes); }
let resolvedMode: WorkspaceMode | null = null;
void mode().then(value => { resolvedMode = value; });
export function downloadUrl(id: string, format = 'midi') {
  if (resolvedMode === 'browser') return local.browserDownloadUrl(id, format);
  return `${apiBase}jobs/${id}/download/${format}`;
}
// The resolved mode is kept synchronously for native audio/download elements.
export const audioUrl = (id: string) => downloadUrl(id, 'audio');
export async function createYouTube(url: string, options: Options) {
  if (await isBrowserWorkspace()) throw new Error('YouTube imports need the full MIDICon server. Upload the audio you have permission to use, or open your server studio from Settings.');
  return api<Job>('/jobs/youtube', { method: 'POST', body: JSON.stringify({ url, options }) });
}
export async function createDemo(options: Options) { return await isBrowserWorkspace() ? local.browserDemo(options) : api<Job>('/demo', { method: 'POST', body: JSON.stringify({ options }) }); }
export async function cancelJob(id: string) { return await isBrowserWorkspace() ? local.browserCancel(id) : api<Job>(`/jobs/${id}/cancel`, { method: 'POST' }); }
export async function retryJob(id: string, options?: Options) { return await isBrowserWorkspace() ? local.browserRetry(id, options) : api<Job>(`/jobs/${id}/retry`, { method: 'POST', ...(options ? { body: JSON.stringify(options) } : {}) }); }
export async function refineJob(id: string, options: Options) { return await isBrowserWorkspace() ? local.browserRefine(id, options) : api<Job>(`/jobs/${id}/refine`, { method: 'POST', body: JSON.stringify({ options }) }); }
export async function aiAssistJob(id: string, align = true) {
  if (await isBrowserWorkspace()) return local.browserAiAssist(id, align);
  const job = await api<Job>(`/jobs/${id}`);
  return api<Job>(`/jobs/${id}/refine`, { method: 'POST', body: JSON.stringify({ options: { ...job.options, ai_assist: true, ai_align: align } }) });
}
export async function patchJob(id: string, values: { title?: string; favorite?: boolean }) { return await isBrowserWorkspace() ? local.browserPatch(id, values) : api<Job>(`/jobs/${id}`, { method: 'PATCH', body: JSON.stringify(values) }); }
export async function deleteJob(id: string) { if (await isBrowserWorkspace()) return local.browserDelete(id); return api<void>(`/jobs/${id}`, { method: 'DELETE' }); }
export async function clearHistory() { return await isBrowserWorkspace() ? local.browserClear() : api<{ deleted: number }>('/history', { method: 'DELETE' }); }
export async function saveEdit(id: string, notes: Note[], title?: string) {
  const clean = notes.map(({ id: _id, ...note }) => note);
  return await isBrowserWorkspace() ? local.browserSaveEdit(id, clean, title) : api<Job>(`/jobs/${id}/save-edit`, { method: 'POST', body: JSON.stringify({ notes: clean, title }) });
}
export function openServerStudio() {
  const value = window.prompt('Open your full MIDICon server\nEnter its HTTPS root URL. Your browser library stays on this device.', 'https://');
  if (!value || value === 'https://') return;
  try { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); window.open(url.href, '_blank', 'noopener,noreferrer'); }
  catch { window.alert('Enter a valid HTTPS server URL without a username or password.'); }
}
export async function downloadLibrary() {
  let blob: Blob;
  if (await isBrowserWorkspace()) blob = await local.browserLibraryDownload();
  else { const response = await fetch(`${apiBase}library/download`, { credentials: 'same-origin' }); if (!response.ok) throw new Error('The library download is not ready. Complete a conversion first.'); blob = await response.blob(); }
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `midicon-library-${new Date().toISOString().slice(0, 10)}.zip`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function uploadAudio(file: File, options: Options, onProgress: (value: number) => void): { promise: Promise<Job>; abort: () => void } {
  let browser = false; let localId = ''; let aborted = false;
  const promise = (async () => {
    browser = await isBrowserWorkspace();
    if (browser) {
      const job = await local.browserUpload(file, options); localId = job.id;
      if (aborted) { await local.browserCancel(job.id); throw new DOMException('Conversion cancelled', 'AbortError'); }
      onProgress(100); return job;
    }
    return uploadToServer(file, options, onProgress, request => { serverRequest = request; if (aborted) request.abort(); });
  })();
  let serverRequest: { abort: () => void } | null = null;
  return { promise, abort: () => { aborted = true; serverRequest?.abort(); if (localId) void local.browserCancel(localId).catch(() => {}); } };
}
function uploadToServer(file: File, options: Options, onProgress: (value: number) => void, register: (request: { abort: () => void }) => void): Promise<Job> {
  const xhr = new XMLHttpRequest();
  register(xhr);
  return new Promise<Job>((resolve, reject) => {
    const form = new FormData(); form.append('file', file); form.append('options', JSON.stringify(options));
    xhr.open('POST', `${apiBase}jobs`); xhr.setRequestHeader('X-MIDICon-Client', 'web'); xhr.withCredentials = true; xhr.timeout = 10 * 60 * 1000;
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onload = () => { try { const body = JSON.parse(xhr.responseText); if (xhr.status >= 200 && xhr.status < 300) resolve(body); else reject(new ApiError(typeof body.detail === 'string' ? body.detail : 'The upload failed. Please try again.', xhr.status)); } catch { reject(new ApiError('The server could not accept this upload. Please try again.', xhr.status)); } };
    xhr.onerror = () => reject(new ApiError('The connection was interrupted. Check your connection and try again.', 0));
    xhr.ontimeout = () => reject(new ApiError('The upload timed out. Try a smaller file or a faster connection.', 0));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    xhr.send(form);
  });
}
