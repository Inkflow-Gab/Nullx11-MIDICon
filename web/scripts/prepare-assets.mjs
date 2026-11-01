import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(web, '..');
const publicDir = path.join(web, 'public');
await Promise.all(['models', 'ort'].map(dir => mkdir(path.join(publicDir, dir), { recursive: true })));
await copyFile(path.join(root, 'webapp/assets/basic-pitch.onnx'), path.join(publicDir, 'models/basic-pitch.onnx'));
await copyFile(path.join(root, 'webapp/assets/demo.wav'), path.join(publicDir, 'demo.wav'));
for (const name of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
  await copyFile(path.join(web, 'node_modules/onnxruntime-web/dist', name), path.join(publicDir, 'ort', name));
}
await copyFile(path.join(web, 'licenses/ORT-LICENSE.txt'), path.join(publicDir, 'ort/LICENSE'));
await copyFile(path.join(root, 'webapp/vendor/basic_pitch/LICENSE'), path.join(publicDir, 'models/LICENSE'));
await copyFile(path.join(root, 'webapp/vendor/basic_pitch/NOTICE'), path.join(publicDir, 'models/NOTICE'));
const hash = await crypto.subtle.digest('SHA-256', await readFile(path.join(publicDir, 'models/basic-pitch.onnx'))).catch(() => null);
// Node 18 lacks global crypto in some environments; the pinned model is also verified by the test suite.
if (hash) console.log('Basic Pitch model SHA-256:', Buffer.from(hash).toString('hex'));
await writeFile(path.join(publicDir, 'models/README.txt'), 'Basic Pitch ONNX model from Spotify Basic Pitch. Apache-2.0. See LICENSE and NOTICE.\n');
console.log('Prepared local browser model, demo, and ONNX Runtime WebAssembly assets.');
if (process.env.MIDICON_PIANO_ASSETS !== '0') {
  const { preparePianoAssets } = await import('./prepare-piano-assets.mjs');
  await preparePianoAssets();
}
if (process.env.MIDICON_BEAT_ASSETS !== '0') {
  const { prepareBeatAssets } = await import('./prepare-beat-assets.mjs');
  await prepareBeatAssets();
}
