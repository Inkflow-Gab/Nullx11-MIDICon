export type Engine = 'auto' | 'piano' | 'basic';
export type CleanupProfile = 'light' | 'balanced' | 'clean';
export type Options = {
  engine: Engine; sensitivity: number; min_duration_ms: number; merge_gap_ms: number;
  cleanup: CleanupProfile;
  transpose: number; quantize: 'off' | '1/4' | '1/8' | '1/16'; tempo: number | null;
  sustain: boolean; preserve_dynamics: boolean; split_tracks: boolean; piano_range: boolean;
  ai_assist: boolean; ai_align: boolean;
  start_seconds: number; duration_seconds: number | null;
};
export type AiAnalysis = {
  model: 'beat-this-small0'; model_name: string; license: 'MIT';
  beats: number[]; downbeats: number[]; tempo: number | null; meter: number | null;
  beat_interval: number | null; beat_count: number; downbeat_count: number; aligned_notes?: number;
};
export const DEFAULT_OPTIONS: Options = {
  engine: 'auto', sensitivity: 60, min_duration_ms: 30, merge_gap_ms: 20,
  cleanup: 'balanced',
  transpose: 0, quantize: 'off', tempo: null, sustain: false,
  preserve_dynamics: true, split_tracks: true, piano_range: true,
  ai_assist: false, ai_align: false,
  start_seconds: 0, duration_seconds: null,
};
export type Note = { start: number; end: number; pitch: number; velocity: number; id?: string };
export type JobStatus = 'queued' | 'downloading' | 'preparing' | 'transcribing' | 'refining' | 'completed' | 'failed' | 'cancelled';
export type Result = {
  note_count: number; raw_note_count: number; merged_notes: number; filtered_notes: number;
  duration: number; tempo: number; key: string; engine: string; engine_name: string;
  lowest_pitch: number | null; highest_pitch: number | null;
  tempo_is_estimate: boolean; key_is_estimate: boolean; meter: string; pedal_detected: boolean;
  ai?: AiAnalysis | null; ai_aligned_notes?: number; ai_error?: string | null;
  edited_from?: string;
};
export type Job = {
  id: string; title: string; source_type: 'upload' | 'youtube' | 'demo' | 'refined' | 'edited';
  source_url: string; source_name: string; status: JobStatus; progress: number;
  stage: string; detail: string; error: string | null; options: Options;
  result: Result | null; waveform: number[] | null;
  events: { time: number; message: string }[]; favorite: boolean;
  created_at: number; updated_at: number; completed_at: number | null;
  has_audio: boolean; queue_position: number;
};
export type Session = {
  workspace_id: string; retention_days: number; max_upload_mb: number;
  max_duration_seconds: number; max_jobs: number;
  engines: { id: string; name: string; description: string; ready: boolean }[];
  extensions: string[]; scope: string; authentication: string;
};
export const ACTIVE_STATUSES: JobStatus[] = ['queued', 'downloading', 'preparing', 'transcribing', 'refining'];
export const isActive = (job: Job) => ACTIVE_STATUSES.includes(job.status);
export const noteName = (pitch: number) => ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'][pitch % 12] + (Math.floor(pitch / 12) - 1);
export const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
export const fileSize = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
