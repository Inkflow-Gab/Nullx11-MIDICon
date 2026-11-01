import type { Engine } from '../types';

/** Auto prefers the piano specialist in the browser, matching the server default. */
export function resolveBrowserEngine(engine: Engine): 'piano' | 'basic' {
  return engine === 'basic' ? 'basic' : 'piano';
}

export function browserEngineName(engine: 'piano' | 'basic') {
  return engine === 'piano' ? 'Piano specialist · browser' : 'Basic Pitch · browser';
}
