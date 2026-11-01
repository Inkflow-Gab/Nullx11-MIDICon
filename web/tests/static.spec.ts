import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Run against a static server that maps /Nullx11-MIDICon/ to web/dist.
test.describe.configure({ timeout: 240_000 });

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
