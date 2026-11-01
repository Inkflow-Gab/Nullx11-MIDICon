import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test.afterEach(async ({ page }) => {
  await page.request.delete('/api/history', { headers: { 'X-MIDICon-Client': 'web' } }).catch(() => {});
});

test('real demo, playback, MIDI download, refinement and private history', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'From sound to keys.' })).toBeVisible();
  await page.getByRole('button', { name: 'Try a demo', exact: true }).click();
  await expect(page.getByRole('link', { name: /Download MIDI/ })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Saved to your library', { exact: true })).toBeVisible();
  await expect(page.locator('.result-meta').getByText('Piano specialist', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause preview', exact: true })).toBeVisible();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Pause preview', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: /Download MIDI/ }).click();
  const download = await downloadEvent;
  const file = await download.path();
  expect((await readFile(file!)).subarray(0, 4).toString()).toBe('MThd');
  await page.getByRole('button', { name: 'My library' }).click();
  await expect(page.locator('.song-title-button').filter({ hasText: 'Little steps · original demo' })).toBeVisible();
  await page.getByRole('button', { name: /Favorite Little steps/ }).click();
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(page.locator('.song-title-button').filter({ hasText: 'Little steps · original demo' })).toBeVisible();
  await page.getByRole('button', { name: /Rename Little steps/ }).click();
  await page.getByLabel('Conversion name').fill('My first piano idea');
  await page.getByRole('button', { name: 'Save name' }).click();
  await page.locator('.song-title-button').filter({ hasText: 'My first piano idea' }).click();
  await page.getByText('Advanced controls', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Transpose', exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'Apply & refine' }).click();
  await expect(page.getByRole('link', { name: /Download MIDI/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.preview-song strong')).toBeVisible();
  await page.getByRole('button', { name: 'My library' }).click();
  await page.getByRole('button', { name: 'All conversions' }).click();
  await page.getByRole('button', { name: /Delete My first piano idea · refined/ }).click();
  await page.getByRole('button', { name: 'Delete conversion', exact: true }).click();
  await expect(page.locator('.song-title-button').filter({ hasText: 'My first piano idea · refined' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('real audio upload, source validation, and YouTube input', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Choose audio or video file').setInputFiles(path.resolve('../webapp/assets/demo.wav'));
  await expect(page.getByText('demo.wav', { exact: true })).toBeVisible();
  await page.getByText('Trim your audio', { exact: false }).click();
  await page.getByLabel('Length (seconds)').fill('12');
  await page.getByRole('button', { name: 'Convert to piano MIDI' }).click();
  await expect(page.getByRole('link', { name: /Download MIDI/ })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('0:12', { exact: true }).first()).toBeVisible();
  await page.getByRole('tab', { name: /YouTube link/ }).click();
  await page.getByLabel('YouTube video URL').fill('https://example.com/not-youtube');
  await page.getByRole('button', { name: 'Fetch & convert to MIDI' }).click();
  await expect(page.getByRole('alert')).toContainText('public youtube.com or youtu.be link');
});

test('editable piano roll saves a new version and library batch download', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Try a demo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit notes', exact: true })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Edit notes', exact: true }).click();
  await expect(page.getByLabel('Piano roll editor')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save as new version' })).toBeDisabled();
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await page.getByRole('button', { name: 'Delete selected notes' }).click();
  await expect(page.getByText('No notes left', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save as new version' })).toBeDisabled();
  await page.getByRole('button', { name: 'Undo edit' }).click();
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await page.getByLabel('Selected note velocity').press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Save as new version' })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo edit' }).click();
  await expect(page.getByRole('button', { name: 'Save as new version' })).toBeDisabled();
  await page.getByRole('button', { name: 'Redo edit' }).click();
  await expect(page.getByRole('button', { name: 'Save as new version' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save as new version' }).click();
  await expect(page.getByText('Saved your edited version. The original stays unchanged.', { exact: true })).toBeVisible();
  await expect(page.locator('.preview-song strong')).toContainText('edited');
  await page.getByRole('button', { name: 'My library' }).click();
  await expect(page.locator('.song-title-button').filter({ hasText: 'Little steps · original demo · edited' })).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download all MIDI' }).click();
  const download = await downloadEvent;
  const file = await download.path();
  expect((await readFile(file!)).subarray(0, 2).toString()).toBe('PK');
  expect(errors).toEqual([]);
});

test('PWA manifest, service worker, offline shell, and online-only API policy', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  const manifestResponse = await page.request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest.name).toBe('Nullx MIDICon');
  expect(manifest.icons.some((icon: { sizes?: string }) => icon.sizes === '512x512')).toBeTruthy();
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toContain('127.0.0.1:3000');
  await page.evaluate(async () => { await fetch('/api/health'); });
  const apiCached = await page.evaluate(async () => {
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      if (await cache.match('/api/health')) return true;
    }
    return false;
  });
  expect(apiCached).toBeFalsy();
  expect(await page.evaluate(async () => (await caches.keys()).some(key => key.startsWith('midicon-shell')))).toBeTruthy();
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'From sound to keys.' })).toBeVisible();
  await expect(page.getByText('You’re offline.', { exact: false })).toBeVisible();
  await page.context().setOffline(false);
});

test('mobile navigation, guide, settings and no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'From sound to keys.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'How it works' }).click();
  await expect(page.getByRole('heading', { name: 'Meet your new creative shortcut.' })).toBeVisible();
  await page.locator('.topbar-avatar').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('No account needed.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
