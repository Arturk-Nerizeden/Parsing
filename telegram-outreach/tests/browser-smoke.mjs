import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const dist = resolve('dist');
const server = createServer((request, response) => {
  const path = resolve(dist, decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname).slice(1));
  if (!path.startsWith(dist + '/')) { response.writeHead(404).end(); return; }
  const mime = path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css'
    : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.wasm') ? 'application/wasm' : null;
  if (!mime) { response.writeHead(404).end(); return; }
  try { response.writeHead(200, { 'Content-Type': mime }); response.end(readFileSync(path)); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Local test server unavailable.');
const profile = mkdtempSync(join(tmpdir(), 'telegram-outreach-test-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: { ...process.env, XDG_CACHE_HOME: join(profile, 'cache'), XDG_CONFIG_HOME: join(profile, 'config') }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const makeArea = prefix => ({
      async get(key) { const saved = localStorage.getItem(`${prefix}.${key}`); return saved ? { [key]: JSON.parse(saved) } : {}; },
      async set(values) { for (const [key, value] of Object.entries(values)) localStorage.setItem(`${prefix}.${key}`, JSON.stringify(value)); },
      async remove(key) { localStorage.removeItem(`${prefix}.${key}`); },
      async setAccessLevel() {}
    });
    window.chrome = { storage: { local: makeArea('local'), session: makeArea('session') } };
  });
  const url = `http://127.0.0.1:${address.port}/dashboard.html`;
  await page.goto(url);
  await page.locator('#contactInput').fill('@alice\n@Alice\n@bob');
  await page.locator('#commonTags').fill('партнёры');
  await page.locator('#parseContacts').click();
  assert.match(await page.locator('#importReport').textContent(), /2 уникальных контактов · 1 дублей/);
  await page.locator('#messageInput').fill('Здравствуйте, {{first_name}}! {{username}}');
  assert.match(await page.locator('#previewText').textContent(), /@alice/);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9mLq0AAAAASUVORK5CYII=', 'base64');
  await page.locator('#imageInput').setInputFiles({ name: 'picture.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => document.querySelector('#imageName')?.textContent?.includes('picture.png'));
  assert.equal(await page.locator('#previewImage').isVisible(), true);
  await page.locator('#createQueue').click();
  await page.waitForFunction(() => document.querySelector('#metricTotal')?.textContent === '2');
  assert.match(await page.locator('#campaignMeta').textContent(), /picture.png/);
  await page.locator('#tagFilter').selectOption('партнёры');
  assert.equal(await page.locator('#recipientRows tr').count(), 2);
  const media = await page.evaluate(async () => {
    const id = JSON.parse(localStorage.getItem('local.telegramOutreach.v1')).campaigns[0].id;
    return await new Promise((done, reject) => {
      const opened = indexedDB.open('TelegramOutreachImages', 1);
      opened.onerror = () => reject(opened.error);
      opened.onsuccess = () => {
        const request = opened.result.transaction('photos').objectStore('photos').get(id);
        request.onsuccess = () => done({ size: request.result?.size, mime: request.result?.type });
        request.onerror = () => reject(request.error);
      };
    });
  });
  assert.deepEqual(media, { size: png.length, mime: 'image/png' });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#metricTotal')?.textContent === '2');
  assert.match(await page.locator('#campaignMeta').textContent(), /picture.png/);
  await page.locator('#startQueue').click();
  assert.equal(await page.locator('#authDialog').evaluate(node => node.open), true);
  assert.equal(await page.locator('#confirmDialog').evaluate(node => node.open), false);
  await page.locator('#closeAuth').click();
  const downloadReady = page.waitForEvent('download');
  await page.locator('#exportQueue').click();
  const download = await downloadReady;
  const csv = readFileSync(await download.path(), 'utf8');
  assert.ok(csv.startsWith('\uFEFF') && csv.includes('alice') && csv.includes('bob'));
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/dashboard.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Browser smoke passed: import, deduplication, image preview/storage, reload, auth gate, CSV export. No Telegram message was sent.');
} finally {
  await context?.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
