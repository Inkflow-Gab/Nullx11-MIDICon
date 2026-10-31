import type { Job, Options, Session } from './types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET') headers.set('X-MIDICon-Client', 'web');
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    let message = `Something went wrong (${response.status}). Please try again.`;
    try { const body = await response.json(); if (typeof body.detail === 'string') message = body.detail; } catch { /* Non-JSON proxy error */ }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export const getSession = () => api<Session>('/session');
export const getJobs = () => api<{ jobs: Job[] }>('/jobs').then(data => data.jobs);
export const getNotes = (id: string) => api<{ notes: import('./types').Note[] }>(`/jobs/${id}/notes`).then(data => data.notes);
export const downloadUrl = (id: string, format = 'midi') => `/api/jobs/${id}/download/${format}`;
export const audioUrl = (id: string) => downloadUrl(id, 'audio');
export const createYouTube = (url: string, options: Options) => api<Job>('/jobs/youtube', { method: 'POST', body: JSON.stringify({ url, options }) });
export const createDemo = (options: Options) => api<Job>('/demo', { method: 'POST', body: JSON.stringify({ options }) });
export const cancelJob = (id: string) => api<Job>(`/jobs/${id}/cancel`, { method: 'POST' });
export const retryJob = (id: string, options?: Options) => api<Job>(`/jobs/${id}/retry`, { method: 'POST', ...(options ? { body: JSON.stringify(options) } : {}) });
export const refineJob = (id: string, options: Options) => api<Job>(`/jobs/${id}/refine`, { method: 'POST', body: JSON.stringify({ options }) });
export const patchJob = (id: string, values: { title?: string; favorite?: boolean }) => api<Job>(`/jobs/${id}`, { method: 'PATCH', body: JSON.stringify(values) });
export const deleteJob = (id: string) => api<void>(`/jobs/${id}`, { method: 'DELETE' });
export const clearHistory = () => api<{ deleted: number }>('/history', { method: 'DELETE' });
export const saveEdit = (id: string, notes: import('./types').Note[], title?: string) => api<Job>(`/jobs/${id}/save-edit`, { method: 'POST', body: JSON.stringify({ notes: notes.map(({ id: _id, ...note }) => note), title }) });
export const libraryDownloadUrl = '/api/library/download';

export function uploadAudio(file: File, options: Options, onProgress: (value: number) => void): { promise: Promise<Job>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Job>((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    form.append('options', JSON.stringify(options));
    xhr.open('POST', '/api/jobs');
    xhr.setRequestHeader('X-MIDICon-Client', 'web');
    xhr.withCredentials = true;
    xhr.timeout = 10 * 60 * 1000;
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new ApiError(typeof body.detail === 'string' ? body.detail : 'The upload failed. Please try again.', xhr.status));
      } catch { reject(new ApiError('The server could not accept this upload. Please try again.', xhr.status)); }
    };
    xhr.onerror = () => reject(new ApiError('The connection was interrupted. Check your connection and try again.', 0));
    xhr.ontimeout = () => reject(new ApiError('The upload timed out. Try a smaller file or a faster connection.', 0));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}
