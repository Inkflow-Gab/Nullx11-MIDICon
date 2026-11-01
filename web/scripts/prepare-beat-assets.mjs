import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(web, '..');
const target = path.join(web, 'public/models/beat-this');
const server = path.join(root, '.web-data/models/beat-this');
const repo = 'loganjmoore/webxlights';
const commit = 'b0006dc0b6466bfa3f98adbec72fba187696d25c';
const modelBlob = '175cdcfe15038441b50f7b306c3ce733b5433278';
const licensePath = 'apps/web/public/models/beat-this-small0.LICENSE.txt';
const modelName = 'beat-this-small0.onnx';
const modelSha = '0d8dd8c9d59922a04f48e61848d21be316480b5d4ddef678f7b96fed56a4e512';
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'MIDICon-build', Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`AI Assist model mirror returned ${response.status}`);
  return response.json();
}
export async function prepareBeatAssets() {
  await mkdir(target, { recursive: true });
  const modelTarget = path.join(target, modelName);
  if (await exists(modelTarget) && sha(await readFile(modelTarget)) === modelSha) {
    console.log('AI Assist model already prepared.');
  } else if (await exists(path.join(server, modelName)) && sha(await readFile(path.join(server, modelName))) === modelSha) {
    await copyFile(path.join(server, modelName), modelTarget);
  } else {
    console.log('Preparing AI Assist · Beat This! small0 (~10 MB, MIT, downloaded once and cached by the browser afterward)…');
    const blob = await fetchJson(`https://api.github.com/repos/${repo}/git/blobs/${modelBlob}`);
    const data = Buffer.from(blob.content, 'base64');
    if (sha(data) !== modelSha) throw new Error('AI Assist model failed SHA-256 verification.');
    await writeFile(modelTarget, data);
  }
  const licenseTarget = path.join(target, 'LICENSE.txt');
  if (!await exists(licenseTarget)) {
    if (await exists(path.join(server, 'LICENSE.txt'))) await copyFile(path.join(server, 'LICENSE.txt'), licenseTarget);
    else {
      const meta = await fetchJson(`https://api.github.com/repos/${repo}/contents/${licensePath}?ref=${commit}`);
      await writeFile(licenseTarget, Buffer.from(meta.content, 'base64'));
    }
  }
  await writeFile(path.join(target, 'NOTICE.txt'), `Beat This! small0 ONNX export.\nModel: https://github.com/CPJKU/beat_this (Foscarin, Schlüter & Widmer, ISMIR 2024).\nWeights and upstream code: MIT, Copyright (c) 2024 Institute of Computational Perception, JKU Linz.\nONNX mirror: https://github.com/${repo}/blob/${commit}/apps/web/public/models/${modelName}\nThe mirror repository is GPL-3.0; the model file itself is MIT as stated in LICENSE.txt.\nMIDICon runs this model locally for optional beat/downbeat analysis. It does not train on your audio.\n`);
  await writeFile(path.join(target, 'README.txt'), 'Optional AI Assist model. Beat This! small0, MIT. About 10 MB. Downloaded only when AI Assist is enabled, then cached for offline reuse. See LICENSE.txt and NOTICE.txt.\n');
  console.log('AI Assist assets verified and prepared.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareBeatAssets();
