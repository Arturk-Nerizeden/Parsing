const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { mkdtemp, rm, mkdir, readFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { webK, webA } = require('./fixtures.cjs');
let browser, worker, profile;
const options = { authors: true, mentions: true, bots: false, auto: false, limit: 1000, direction: 'down' };
before(async () => {
  profile = await mkdtemp(path.join(os.tmpdir(), 'tg-collector-test-'));
  const extension = path.resolve(__dirname, '../extension');
  browser = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    env: { ...process.env, XDG_CACHE_HOME: path.join(profile, 'cache'), XDG_CONFIG_HOME: path.join(profile, 'config') },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox'],
  });
  worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
});
after(async () => { await browser?.close(); if (profile) await rm(profile, { recursive: true, force: true }); });
async function fixture(client = 'K') {
  const page = await browser.newPage();
  await page.route('https://web.telegram.org/**', route => route.fulfill({ contentType: 'text/html', body: client === 'K' ? webK() : webA() }));
  await page.goto(`https://web.telegram.org/${client.toLowerCase()}/#-100`);
  const id = await worker.evaluate(async () => (await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0]?.id);
  // Content scripts run at document_idle; wait for their runtime listener.
  for (let n = 0; n < 40; n++) {
    try { if ((await send(id, 'status')).state) return { page, id }; } catch {}
    await page.waitForTimeout(50);
  }
  throw new Error('Extension content script did not start');
}
async function send(id, action, config) {
  return worker.evaluate(async ({ id, action, config }) => chrome.tabs.sendMessage(id, { type: `collector:${action}`, options: config }), { id, action, config });
}
async function done(page, id) {
  for (let n = 0; n < 100; n++) {
    const { state } = await send(id, 'status');
    if (state.status !== 'running') return state;
    await page.waitForTimeout(100);
  }
  throw new Error('Collection did not finish');
}

test('loaded Web K comments resolve authors, aliases and forwarding correctly; results survive reload', async () => {
  const { page, id } = await fixture();
  await send(id, 'start', options);
  const state = await done(page, id);
  assert.equal(state.status, 'done', state.note);
  assert.deepEqual(state.rows.map(r => r.username), ['alice_user', 'bob_alias', 'bob_user', 'linked_user', 'mention_one']);
  assert.equal(state.stats.messages, 6);
  assert.equal(state.stats.authors, 2);
  assert.equal(state.stats.withoutUsername, 1);
  assert.equal(state.stats.unresolved, 1);
  assert.equal(state.stats.bots, 1);
  assert.equal(state.stats.channels, 1);
  await page.reload(); await page.waitForTimeout(250);
  assert.equal((await send(id, 'status')).state.rows.length, 5);
  await send(id, 'clear');
  assert.equal((await send(id, 'status')).state.rows.length, 0);
  await page.close();
});
test('strict message limit and author-only bot setting', async () => {
  const { page, id } = await fixture();
  await send(id, 'start', { ...options, mentions: false, bots: true, limit: 4 });
  const state = await done(page, id);
  assert.equal(state.stats.messages, 4);
  assert.deepEqual(state.rows.map(r => r.username), ['alice_user', 'bob_alias', 'bob_user', 'helper_bot']);
  await page.close();
});
test('autoscroll collects lazy-loaded messages, deduplicates and can stop promptly', async () => {
  const { page, id } = await fixture();
  await page.evaluate(() => {
    let added = false;
    document.querySelector('.scrollable-y').addEventListener('scroll', () => {
      if (!added) { added = true; window.appendMessage(7, 'Later_author'); }
    });
  });
  await send(id, 'start', { ...options, auto: true });
  await page.waitForTimeout(1900);
  const response = await send(id, 'stop');
  assert.equal(response.state.status, 'stopped');
  assert.equal(response.state.stats.messages, 7);
  assert.ok(response.state.rows.some(row => row.username === 'later_author'));
  assert.equal(response.state.rows.find(row => row.username === 'alice_user').occurrences, 1);
  await page.close();
});
test('changing chat aborts before reading the other chat', async () => {
  const { page, id } = await fixture();
  await send(id, 'start', { ...options, auto: true });
  await page.waitForTimeout(200);
  await page.evaluate(() => { location.hash = '#-200'; window.appendMessage(8, 'Other_chat_user'); });
  const state = await done(page, id);
  assert.equal(state.status, 'stopped');
  assert.ok(state.note.includes('изменились'));
  assert.ok(!state.rows.some(row => row.username === 'other_chat_user'));
  await page.close();
});
test('changing account aborts a run even if the chat URL stays the same', async () => {
  const { page, id } = await fixture();
  await send(id, 'start', { ...options, auto: true });
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.rootScope.myId = 888; window.appendMessage(8, 'Another_account'); });
  const state = await done(page, id);
  assert.equal(state.status, 'stopped');
  assert.ok(!state.rows.some(row => row.username === 'another_account'));
  await page.close();
});
test('Web A supports text extraction and explicitly rejects unsupported author mode', async () => {
  const { page, id } = await fixture('A');
  assert.match((await send(id, 'start', options)).error, /Web K/);
  await send(id, 'start', { ...options, authors: false });
  const state = await done(page, id);
  assert.deepEqual(state.rows.map(r => r.username), ['linked_user', 'public_user']);
  await page.close();
});
test('missing internal cache is a reported error rather than false author success', async () => {
  const { page, id } = await fixture();
  await page.evaluate(() => { delete window.apiManagerProxy; });
  await send(id, 'start', options);
  const state = await done(page, id);
  assert.equal(state.status, 'error');
  assert.match(state.note, /интерфейс мог измениться/);
  await page.close();
});
test('real extension popup filters, downloads and renders without script errors', async () => {
  const { page, id } = await fixture();
  await send(id, 'start', options); await done(page, id);
  const extensionId = new URL(worker.url()).host;
  const popup = await browser.newPage();
  const errors = []; popup.on('pageerror', err => errors.push(err.message));
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForFunction(() => document.getElementById('count').textContent === '5');
  await popup.selectOption('#source', 'author');
  assert.equal(await popup.locator('#list li').count(), 3);
  const downloaded = popup.waitForEvent('download');
  await popup.click('[data-export="txt"]');
  const download = await downloaded;
  const file = await readFile(await download.path(), 'utf8');
  assert.equal(file.trim().split('\n').length, 3);
  assert.ok(!file.includes('mention_one'));
  await mkdir(path.resolve(__dirname, '../test-results'), { recursive: true });
  await popup.setViewportSize({ width: 440, height: 850 });
  await popup.screenshot({ path: path.resolve(__dirname, '../test-results/popup.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await popup.close(); await page.close();
});
