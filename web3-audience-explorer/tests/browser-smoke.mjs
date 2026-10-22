import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const dist = resolve('dist');
const server = createServer((req, res) => {
  const path = resolve(dist, decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname).slice(1));
  if (!path.startsWith(dist + '/') || !['.js', '.css', '.html', '.json'].some(extension => path.endsWith(extension))) {
    res.writeHead(404).end(); return;
  }
  try {
    const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html';
    res.writeHead(200, { 'Content-Type': type }); res.end(readFileSync(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Test server unavailable');
const profile = mkdtempSync(join(tmpdir(), 'web3-audience-test-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: { ...process.env, XDG_CACHE_HOME: join(profile, 'cache'), XDG_CONFIG_HOME: join(profile, 'config') }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const calls = [];
  let quotaCalls = 0;
  await page.exposeFunction('__mockSorsa', (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.host, 'api.sorsa.io');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    if (init.headers) assert.deepEqual(Object.keys(init.headers), ['ApiKey']);
    calls.push(parsed.pathname);
    if (!init.headers) {
      assert.equal(parsed.pathname, '/v3/key-usage-info');
      return { status: 401, body: { message: 'missing key in request header' } };
    }
    if (init.headers.ApiKey === 'invalid-diagnostic-key') {
      assert.equal(parsed.pathname, '/v3/key-usage-info');
      return { status: 403, body: { message: 'invalid key' } };
    }
    assert.equal(init.headers.ApiKey, 'test-key');
    if (parsed.pathname === '/v3/key-usage-info' && ++quotaCalls > 1) return { networkError: 'net::ERR_BLOCKED_BY_CLIENT' };
    const body = parsed.pathname.endsWith('/followers') ?
      parsed.searchParams.has('next_cursor') ? { users: [{ id: '3', username: 'carol', display_name: 'Carol', followers_count: 9 }], next_cursor: null }
        : { users: [{ id: '1', username: 'alice', display_name: 'Alice', followers_count: 1500, description: 'DeFi builder' },
          { id: '2', username: 'bob', display_name: 'Bob', followers_count: 30 }], next_cursor: 12 }
      : parsed.pathname.endsWith('/new-followers-7d') ? { users: [{ id: '4', username: 'newuser', display_name: 'New User', followerDate: '2026-10-20T12:00:00Z' }] }
      : parsed.pathname.endsWith('/score') ? { score: parsed.searchParams.get('username') === 'alice' ? 2.5 : 1.25 }
      : { key_requests: 4, remaining_requests: 96, total_requests: 100, valid_until: '2026-12-01T00:00:00Z' };
    return { status: 200, body };
  });
  await page.addInitScript(() => {
    const values = {};
    const networkErrorListeners = [];
    window.chrome ||= {};
    window.chrome.webRequest = { onErrorOccurred: { addListener(listener) { networkErrorListeners.push(listener); } } };
    window.chrome.storage = { session: {
      async get(key) { return key in values ? { [key]: values[key] } : {}; },
      async set(items) { Object.assign(values, items); },
      async remove(key) { delete values[key]; }
    } };
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, init) => {
      if (new URL(String(url)).host !== 'api.sorsa.io') return realFetch(url, init);
      const response = await window.__mockSorsa(String(url), init);
      if (response.networkError) {
        for (const listener of networkErrorListeners) listener({ initiator: location.origin, error: response.networkError });
        throw new TypeError('Failed to fetch');
      }
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'Content-Type': 'application/json' } });
    };
  });
  await page.goto(`http://127.0.0.1:${address.port}/dashboard.html`);
  await page.locator('#testConnection').click();
  await page.waitForFunction(() => document.querySelector('#connectionResult')?.textContent?.includes('HTTP 403 with an invalid test key through the normal API client'));
  await page.locator('#apiKey').fill('test-key');
  await page.locator('#saveKey').click();
  await page.locator('#checkQuota').click();
  await page.waitForFunction(() => document.querySelector('#metricQuota')?.textContent === '96');
  await page.locator('#target').fill('xrp');
  await page.locator('#limit').fill('4');
  await page.locator('#startButton').click();
  await page.waitForFunction(() => document.querySelector('#metricCollected')?.textContent === '3')
    .catch(async error => { throw new Error(`${error.message}; notice=${await page.locator('#notice').textContent()}; calls=${JSON.stringify(calls)}; pageErrors=${JSON.stringify(errors)}`); });
  assert.equal(await page.locator('#accountsBody tr').count(), 3);
  assert.deepEqual(calls.filter(path => path === '/v3/followers'), ['/v3/followers', '/v3/followers']);
  await page.locator('#scoreLimit').fill('2');
  await page.locator('#enrichButton').click();
  await page.waitForFunction(() => document.querySelector('#metricRequests')?.textContent === '4');
  await page.locator('#minScore').fill('2');
  await page.waitForFunction(() => document.querySelector('#filterCount')?.textContent?.startsWith('1 matches'));
  const event = page.waitForEvent('download');
  await page.locator('#exportButton').click();
  const download = await event;
  const csv = readFileSync(await download.path(), 'utf8');
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('alice'));
  assert.ok(!csv.includes('bob'));
  await page.locator('#importFile').setInputFiles({ name: 'research.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.waitForFunction(() => document.querySelector('#currentTitle')?.textContent?.startsWith('Imported'));
  assert.equal(await page.locator('#metricCollected').textContent(), '1');
  await page.locator('#minScore').fill('');
  await page.locator('input[name="mode"][value="new7d"]').check();
  await page.locator('#target').fill('solana');
  await page.locator('#startButton').click();
  await page.waitForFunction(() => document.querySelector('#currentTitle')?.textContent?.includes('@solana')
    && document.querySelector('#metricCollected')?.textContent === '1');
  assert.ok(calls.includes('/v3/new-followers-7d'));
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/dashboard.png', fullPage: true });
  await page.locator('#checkQuota').click();
  await page.waitForFunction(() => document.querySelector('#notice')?.textContent?.includes('net::ERR_BLOCKED_BY_CLIENT'));
  assert.deepEqual(errors, []);
  console.log('Browser smoke passed: collection, cursor, scores, filters, CSV export/import and new-followers mode.');
} finally {
  await context?.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
