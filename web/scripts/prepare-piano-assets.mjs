import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(web, '..');
const target = path.join(web, 'public/models/piano');
const cache = path.join(web, '.model-cache/piano');
const server = path.join(root, '.web-data/models/kong-piano');
const mirror = 'https://codeload.github.com/pratham-jain33/kongML-optimized/tar.gz/921b86b73c72161892ee414048792d50de77fafe';
const graphName = 'model.onnx';
const dataName = 'kong_notes_2s5_fp32.onnx.data';
const hashes = {
  [graphName]: 'bcbbfeff7950e9d2665336b60105b4767e9d7b8de1de14ce607c616b72668414',
  [dataName]: '21e9437c5f4c55737126e13778c804faff4b2eca49a9a7cc4ea49fd99804f001',
};
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function valid(dir) {
  for (const [name, expected] of Object.entries(hashes)) {
    const file = path.join(dir, name);
    if (!await exists(file)) return false;
    if (sha(await readFile(file)) !== expected) return false;
  }
  return true;
}
async function copyFrom(dir) {
  await mkdir(target, { recursive: true });
  for (const name of Object.keys(hashes)) await copyFile(path.join(dir, name), path.join(target, name));
}
export function extractTar(buffer) {
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const full = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeText || '0', 8);
    const type = String.fromCharCode(header[156]);
    offset += 512;
    if ((type === '0' || type === '\0') && size >= 0) {
      files.set(full, buffer.subarray(offset, offset + size));
      offset += Math.ceil(size / 512) * 512;
    }
  }
  return files;
}
async function downloadAndAssemble() {
  console.log('Preparing browser piano specialist (~85 MB, downloaded once and cached by the browser afterward)…');
  let archive;
  if (process.env.MIDICON_PIANO_ARCHIVE) {
    archive = await readFile(process.env.MIDICON_PIANO_ARCHIVE);
  } else {
    const response = await fetch(mirror, { headers: { 'User-Agent': 'MIDICon-build' } });
    if (!response.ok) throw new Error(`Piano model mirror returned ${response.status}`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  if (archive.length > 140 * 1024 * 1024) throw new Error('Piano model mirror is unexpectedly large.');
  const files = extractTar(gunzipSync(archive));
  const graph = [...files.entries()].find(([name]) => name.endsWith(`models/kong_notes_2s5_fp32.onnx`));
  if (!graph) throw new Error('Piano model graph missing from mirror.');
  const shards = [];
  for (const suffix of ['aa', 'ab', 'ac', 'ad', 'ae', 'af', 'ag', 'ah', 'ai', 'aj']) {
    const entry = [...files.entries()].find(([name]) => name.endsWith(`${dataName}.part-${suffix}`));
    if (!entry) throw new Error(`Piano model shard ${suffix} missing from mirror.`);
    shards.push(entry[1]);
  }
  const data = Buffer.concat(shards);
  if (sha(graph[1]) !== hashes[graphName] || sha(data) !== hashes[dataName]) throw new Error('Piano model mirror failed SHA-256 verification.');
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, graphName), graph[1]);
  await writeFile(path.join(cache, dataName), data);
}
export async function preparePianoAssets() {
  if (await valid(target)) { console.log('Piano specialist assets already prepared.'); return; }
  if (await valid(server)) await copyFrom(server);
  else if (await valid(cache)) await copyFrom(cache);
  else { await downloadAndAssemble(); await copyFrom(cache); }
  await copyFile(path.join(root, 'webapp/vendor/KONG-MIT-LICENSE.txt'), path.join(target, 'KONG-MIT-LICENSE.txt'));
  await copyFile(path.join(root, 'webapp/vendor/NOTICE.md'), path.join(target, 'NOTICE.md'));
  await writeFile(path.join(target, 'README.txt'), 'Kong piano specialist ONNX weights, CC BY 4.0. Post-processing MIT. See NOTICE.md and KONG-MIT-LICENSE.txt. Downloaded once per browser and cached for offline reuse.\n');
  console.log('Piano specialist assets verified and prepared.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await preparePianoAssets();
