import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Run against a static server that maps /Nullx11-MIDICon/ to web/dist.
test.describe.configure({ timeout: 300_000 });

function longWav(seconds = 120): Buffer {
  const rate = 22050, count = rate * seconds;
  const data = Buffer.alloc(44 + count * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + count * 2, 4); data.write('WAVE', 8);
  data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(count * 2, 40);
  const scale = [60, 64, 67, 72, 67, 64, 57, 60];
  for (let i = 0; i < count; i++) {
    const t = i / rate, step = Math.floor(t / 0.5), local = t - step * 0.5;
    const midi = scale[step % scale.length] + (step % 16 >= 8 ? -12 : 0);
    const f = 440 * 2 ** ((midi - 69) / 12);
    const env = Math.min(1, local / 0.01) * Math.exp(-local * 3.2);
    const sample = (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(4 * Math.PI * f * t) + 0.12 * Math.sin(6 * Math.PI * f * t)) * env * 0.28;
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sample * 32767))), 44 + i * 2);
  }
  return data;
}

test('static subpath: real on-device demo, downloads, persistence, editing, and offline conversion', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./?mode=browser#studio');
  await expect(page.getByRole('heading', { name: 'From sound to keys.' })).toBeVisible();
  await expect(page.locator('.mode-banner')).toContainText('Browser studio');
  await page.getByRole('button', { name: 'Try a demo', exact: true }).click();
  await expect(page.getByRole('link', { name: /Download MIDI/ })).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await expect(page.locator('.result-meta')).toContainText('Basic Pitch · browser');
  const noteCount = await page.locator('.result-stats strong').first().innerText();
  expect(parseInt(noteCount.replace(/[^0-9]/g, ''), 10)).toBeGreaterThan(0);

  const midiEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: /Download MIDI/ }).click();
  const midi = await midiEvent;
  expect((await readFile((await midi.path())!)).subarray(0, 4).toString()).toBe('MThd');

  await page.getByRole('button', { name: 'Edit notes', exact: true }).click();
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await page.getByLabel('Selected note velocity').press('ArrowRight');
  await page.getByRole('button', { name: 'Save as new version' }).click();
  await expect(page.locator('.preview-song strong')).toContainText('edited');

  await page.goto('./?mode=browser#library');
  await expect(page.locator('.song-title-button').filter({ hasText: 'Little steps · original demo' })).toHaveCount(2);
  const zipEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download all MIDI' }).click();
  const zip = await zipEvent;
  const zipBytes = new Uint8Array(await readFile((await zip.path())!));
  expect(Buffer.from(zipBytes.subarray(0, 2)).toString()).toBe('PK');
  const { unzipSync, strFromU8 } = await import('fflate');
  const entries = unzipSync(zipBytes);
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  expect(manifest.format).toBe('nullx-midicon-library-v1');
  expect(manifest.jobs.length).toBeGreaterThanOrEqual(2);
  expect(Object.keys(entries).filter(name => name.endsWith('.mid')).length).toBeGreaterThanOrEqual(2);

  // The service worker must have cached the model/runtime/demo for offline reuse.
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const cached = await page.evaluate(async () => {
    const wanted = ['models/basic-pitch.onnx', 'ort/ort-wasm-simd-threaded.wasm', 'demo.wav'];
    const found: Record<string, boolean> = {};
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      for (const path of wanted) if (await cache.match(new URL(path, document.baseURI).href)) found[path] = true;
    }
    return found;
  });
  expect(cached['models/basic-pitch.onnx']).toBeTruthy();
  expect(cached['ort/ort-wasm-simd-threaded.wasm']).toBeTruthy();
  expect(cached['demo.wav']).toBeTruthy();

  await context.setOffline(true);
  await page.goto('./?mode=browser#studio');
  await expect(page.getByRole('heading', { name: 'From sound to keys.' })).toBeVisible();
  await page.getByRole('button', { name: 'Try a demo', exact: true }).click();
  await expect(page.getByRole('link', { name: /Download MIDI/ })).toBeVisible({ timeout: 180_000 });
  await context.setOffline(false);
  expect(errors).toEqual([]);
});

test('static subpath: long 2-minute clip converts on device with live progress', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./?mode=browser#studio');
  await page.getByLabel('Choose audio or video file').setInputFiles({ name: 'long-take.wav', mimeType: 'audio/wav', buffer: longWav(120) });
  await expect(page.locator('.selected-file-name')).toHaveText('long-take.wav');
  await expect(page.locator('.long-clip-note')).toBeVisible();
  await page.getByRole('button', { name: 'Convert on this device' }).click();
  await expect(page.locator('.preview-card .conversion-progress')).toBeVisible();
  await expect(page.getByRole('link', { name: /Download MIDI/ })).toBeVisible({ timeout: 240_000 });
  await expect(page.locator('.result-stats').getByText('2:00', { exact: true })).toBeVisible();
  const notes = parseInt((await page.locator('.result-stats strong').first().innerText()).replace(/[^0-9]/g, ''), 10);
  expect(notes).toBeGreaterThan(80);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: /Download MIDI/ }).click();
  const download = await downloadEvent;
  expect((await readFile((await download.path())!)).subarray(0, 4).toString()).toBe('MThd');
  expect(errors).toEqual([]);
});

test('static subpath: long clip can be cancelled without losing the input', async ({ page }) => {
  await page.goto('./?mode=browser#studio');
  await page.getByLabel('Choose audio or video file').setInputFiles({ name: 'cancel-take.wav', mimeType: 'audio/wav', buffer: longWav(120) });
  await page.getByRole('button', { name: 'Convert on this device' }).click();
  await expect(page.locator('.preview-card .conversion-progress')).toBeVisible();
  await expect.poll(async () => Number(await page.locator('.preview-card .progress-track').getAttribute('aria-valuenow').catch(() => '0')), { timeout: 120_000 }).toBeGreaterThan(30);
  await page.locator('.preview-card .conversion-progress').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.preview-card .job-message.cancelled')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('static subpath: pages, server-only YouTube notice, and mobile layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./?mode=browser#home');
  await expect(page.getByRole('heading', { name: /Your next idea is/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Open the studio' }).click();
  await expect(page.getByRole('heading', { name: 'From sound to keys.' })).toBeVisible();
  await page.getByRole('tab', { name: /YouTube link/ }).click();
  await expect(page.getByRole('button', { name: 'Open full server' })).toBeVisible();
  await expect(page.locator('.youtube-hint')).toContainText('Open your server');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'How it works' }).click();
  await expect(page.getByRole('heading', { name: 'Meet your new creative shortcut.' })).toBeVisible();
  await expect(page.getByText('Two ways to run MIDICon')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
