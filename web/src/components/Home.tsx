import { ArrowRight, ArrowUpRight, AudioLines, Check, FolderOpen, KeyboardMusic, Lightbulb, LockKeyhole, Music2, SlidersHorizontal, Sparkles, WandSparkles } from 'lucide-react';
import type { Job } from '../types';
import { formatTime } from '../types';

type Props = {
  browserMode: boolean;
  busy: boolean;
  completedCount: number;
  recent: Job[];
  onStudio: () => void;
  onDemo: () => void;
  onLibrary: () => void;
  onGuide: () => void;
  onOpen: (job: Job) => void;
};

export function Home({ browserMode, busy, completedCount, recent, onStudio, onDemo, onLibrary, onGuide, onOpen }: Props) {
  const features = [
    { icon: LockKeyhole, title: browserMode ? 'Private by default' : 'A workspace of your own', text: browserMode ? 'Audio is decoded and transcribed inside this browser. Nothing is uploaded to a MIDICon server.' : 'A private browser session keeps your conversions separate, with server-side retention you control.' },
    { icon: AudioLines, title: 'Real neural listening', text: browserMode ? 'The piano specialist and Basic Pitch run locally through WebAssembly, finding precise onsets, offsets, and dynamics.' : 'Choose the piano specialist or polyphonic Basic Pitch, with real progress at every stage.' },
    { icon: Sparkles, title: 'Optional AI Assist', text: 'A free local Beat This! model finds the beat grid, sharpens tempo, and can gently align timing. You choose when it runs.' },
    { icon: SlidersHorizontal, title: 'A canvas, not a cage', text: 'Edit the piano roll, save new versions, transpose, quantize, and refine without starting over.' },
    { icon: FolderOpen, title: 'Ready for your DAW', text: 'Export standard MIDI, note JSON, CSV, or a complete ZIP. Take your whole library with you.' },
  ];
  return <div className="home-page">
    <section className="home-hero">
      <div className="home-hero-copy">
        <span className="eyebrow"><span /> NULLX MIDICON · {browserMode ? 'BROWSER STUDIO' : 'FULL STUDIO'}</span>
        <h1>Your next idea is<br />already in the sound<span className="heading-dot">.</span></h1>
        <p>Turn a short loop or a full-length track into playable piano MIDI. Hear it, shape it, and make it unmistakably yours.</p>
        <div className="home-hero-actions">
          <button className="button primary" onClick={onStudio}><WandSparkles size={17} />Open the studio<ArrowRight size={16} /></button>
          <button className="button secondary" disabled={busy} onClick={onDemo}><Music2 size={16} />Try the original demo</button>
        </div>
        <div className="home-hero-meta">
          <span><Check size={13} />No account needed</span>
          <span><Check size={13} />{browserMode ? 'Runs on this device' : 'Two neural engines'}</span>
          <span><Check size={13} />Long clips · up to 10 min</span>
        </div>
      </div>
      <div className="home-hero-art" aria-hidden="true">
        <div className="home-art-card">
          <div className="home-art-top"><span><KeyboardMusic size={16} />From sound to keys</span><i /></div>
          <div className="home-wave">{Array.from({ length: 42 }, (_, i) => <span key={i} style={{ height: `${18 + Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.21)) * 72}%` }} />)}</div>
          <div className="home-roll">{Array.from({ length: 26 }, (_, i) => <i key={i} style={{ left: `${(i * 13) % 88}%`, top: `${12 + (i * 29) % 70}%`, width: `${9 + (i % 4) * 5}%` }} className={i % 3 === 0 ? 'teal' : ''} />)}</div>
          <div className="home-keys">{Array.from({ length: 14 }, (_, i) => <span key={i} className={[1, 3, 6, 8, 10, 13].includes(i) ? 'black' : ''} />)}</div>
          <div className="home-art-bottom"><span><Sparkles size={13} />{browserMode ? 'Piano specialist · on-device' : 'Piano specialist + Basic Pitch'}</span><b>MIDI ready</b></div>
        </div>
        <span className="home-art-note note-one"><Music2 size={20} /></span>
        <span className="home-art-note note-two"><AudioLines size={18} /></span>
      </div>
    </section>

    <section className="home-mode card">
      <span className="home-mode-icon">{browserMode ? <LockKeyhole size={21} /> : <Sparkles size={21} />}</span>
      <div>
        <h2>{browserMode ? 'You’re in the browser studio' : 'You’re in the full studio'}</h2>
        <p>{browserMode ? 'GitHub Pages hosts the app; your device does the listening. Convert up to 10 minutes / 100 MB with the piano specialist or Basic Pitch. The piano model downloads once, then works offline. YouTube import needs the full MIDICon server.' : 'Upload longer audio, import permitted YouTube videos, and choose between the piano specialist and polyphonic Basic Pitch.'}</p>
      </div>
      <button className="text-button" onClick={onGuide}>Compare modes <ArrowUpRight size={14} /></button>
    </section>

    <section className="home-features">
      {features.map(feature => <article className="card home-feature" key={feature.title}><span><feature.icon size={21} /></span><h3>{feature.title}</h3><p>{feature.text}</p></article>)}
    </section>

    <section className="home-flow">
      <div className="section-heading"><div><h2>Three small steps. One new possibility.</h2><p>From “what if” to a MIDI file you can actually play.</p></div><button className="text-button" onClick={onGuide}>Read the guide <ArrowRight size={14} /></button></div>
      <div className="home-steps">
        {[{ n: '01', title: 'Bring a sound', text: 'Drop in a recording or start with our original piano demo.' }, { n: '02', title: 'Let it listen', text: 'Follow real transcription progress as notes appear on the canvas.' }, { n: '03', title: 'Make it yours', text: 'Edit, refine, compare, and export to the tools you already love.' }].map(step => <div className="home-step" key={step.n}><span>{step.n}</span><h3>{step.title}</h3><p>{step.text}</p></div>)}
      </div>
    </section>

    <section className="home-recent card">
      <div className="section-heading"><div><h2>{completedCount ? 'Pick up where you left off' : 'Your library starts with one song'}</h2><p>{completedCount ? `${completedCount} completed ${completedCount === 1 ? 'conversion' : 'conversions'} in this workspace.` : 'Convert a demo or your own audio, and it will be waiting here.'}</p></div><button className="text-button" onClick={onLibrary}>Open library <ArrowUpRight size={14} /></button></div>
      {recent.length ? <div className="home-recent-list">{recent.slice(0, 3).map(job => <button key={job.id} onClick={() => onOpen(job)}><span className="source-icon"><Music2 size={17} /></span><span><strong>{job.title}</strong><small>{job.result ? `${job.result.note_count} notes · ${formatTime(job.result.duration)} · ${job.result.engine_name}` : job.stage}</small></span><ArrowRight size={15} /></button>)}</div> : <div className="home-recent-empty"><Lightbulb size={20} /><span>Try the demo first. It’s an original, synthesized piano piece—no third-party recording.</span><button className="button secondary small" disabled={busy} onClick={onDemo}>Try demo</button></div>}
    </section>
  </div>;
}
