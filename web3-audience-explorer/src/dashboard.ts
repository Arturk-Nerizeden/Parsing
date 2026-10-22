import { ApiError, SorsaClient } from './api';
import { collectFollowers, enrichScores } from './collector';
import { csvText, importCSV } from './csv';
import { testConnection } from './diagnostics';
import { createCollection, filterAccounts, normalizeUsername } from './model';
import type { Filters } from './model';
import * as repository from './storage';
import type { Account, Collection, Mode, Usage } from './types';

const el = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing interface element: ${id}`);
  return element as T;
};
const text = (id: string, value: string) => { el(id).textContent = value; };
const input = (id: string) => el<HTMLInputElement>(id);
const button = (id: string) => el<HTMLButtonElement>(id);
let selected: Collection | null = null;
let accounts: Account[] = [];
let quota: Usage | null = null;
let hasKey = false;
let controller: AbortController | null = null;
let activity: 'collection' | 'scores' | null = null;
let tablePage = 0;
let noticeText = 'Ready to research with the documented Sorsa endpoints.';
let noticeKind: 'info' | 'warn' | 'error' = 'info';

const statuses: Record<Collection['status'], string> = {
  paused: 'Paused · resume from the saved cursor', running: 'Collecting · safe to stop after this request',
  complete: 'Complete', limit: 'Limit reached · raise the limit to resume', error: 'Paused after an error · cursor saved'
};
function notice(message: string, kind: 'info' | 'warn' | 'error' = 'info') {
  noticeText = message; noticeKind = kind;
  const node = el('notice'); node.textContent = noticeText;
  node.className = `notice ${noticeKind === 'info' ? '' : noticeKind}`;
}
function formatNumber(value: number | null | undefined): string { return value == null ? '—' : new Intl.NumberFormat('en-US').format(value); }
function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}
async function key(): Promise<string | null> {
  const data = await chrome.storage.session.get('sorsaApiKey');
  return typeof data.sorsaApiKey === 'string' && data.sorsaApiKey ? data.sorsaApiKey : null;
}
async function client(): Promise<SorsaClient> {
  const value = await key();
  if (!value) { el('settingsPanel').classList.remove('hidden'); throw new Error('Add your Sorsa API key in API settings first.'); }
  return new SorsaClient(value);
}
function filters(): Filters {
  const number = (id: string) => input(id).value.trim() ? Number(input(id).value) : null;
  return { minFollowers: number('minFollowers'), maxFollowers: number('maxFollowers'),
    minScore: number('minScore'), maxScore: number('maxScore'),
    tag: input('tagFilter').value, keyword: input('keyword').value };
}
function filtered(): Account[] { return filterAccounts(accounts, filters()); }
function updateButtons() {
  const running = Boolean(controller);
  button('startButton').disabled = running;
  button('stopButton').disabled = !running;
  button('resumeButton').disabled = running || !selected || selected.mode === 'imported' || selected.status === 'complete';
  button('enrichButton').disabled = running || !selected || accounts.every(row => row.scoreChecked);
  button('exportButton').disabled = !selected || !filtered().length;
  button('deleteButton').disabled = running || !selected;
  button('saveKey').disabled = running;
  button('forgetKey').disabled = running;
  button('checkQuota').disabled = running;
  button('testConnection').disabled = running;
}
function renderStats() {
  text('metricCollected', formatNumber(selected?.total));
  text('metricPages', formatNumber(selected?.pages));
  text('metricRequests', formatNumber(selected?.requests));
  text('metricQuota', formatNumber(quota?.remaining_requests));
  text('quotaDetail', quota?.valid_until ? `snapshot · valid until ${formatDate(quota.valid_until)}` : quota ? 'snapshot at last check' : 'check on demand');
  text('keyBadge', hasKey ? 'Key in this session' : 'API key needed');
  el('keyBadge').classList.toggle('ready', hasKey);
  text('currentTitle', selected?.title || 'No collection selected');
  text('currentSubtitle', selected ? `${statuses[selected.status]} · updated ${formatDate(selected.updatedAt)}`
    : 'Start a search or choose a saved collection.');
  updateButtons();
}
function renderTable() {
  const values = filtered();
  const pages = Math.max(1, Math.ceil(values.length / 100));
  tablePage = Math.min(tablePage, pages - 1);
  const start = tablePage * 100;
  const shown = values.slice(start, start + 100);
  text('filterCount', `${formatNumber(values.length)} matches · ${formatNumber(accounts.length)} in collection`);
  text('pageDetail', shown.length ? `Showing ${start + 1}–${start + shown.length} of ${values.length}` : 'Showing 0');
  button('prevPage').disabled = tablePage <= 0;
  button('nextPage').disabled = tablePage >= pages - 1;
  const body = el<HTMLTableSectionElement>('accountsBody');
  body.replaceChildren();
  if (!shown.length) {
    const row = body.insertRow();
    const cell = row.insertCell(); cell.colSpan = 7; cell.className = 'empty-table';
    cell.textContent = accounts.length ? 'No accounts match these filters.' : 'Your results will appear here.';
  }
  for (const account of shown) {
    const row = body.insertRow();
    const identity = row.insertCell();
    const link = document.createElement('a');
    link.className = 'account-link'; link.textContent = `@${account.username}`;
    link.href = `https://x.com/${encodeURIComponent(account.username)}`;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    const name = document.createElement('div'); name.className = 'account-name';
    name.textContent = account.displayName || 'Display name unavailable';
    identity.append(link, name);
    const fields = [formatNumber(account.followersCount), account.score == null ? '—' : String(account.score),
      account.category || '—', formatDate(account.firstSeen), formatDate(account.followedAt)];
    fields.forEach((field, index) => {
      const cell = row.insertCell(); cell.textContent = field;
      if (field === '—') cell.className = 'muted';
      if (index === 1 && field !== '—') cell.className = 'score';
      if (index === 2 && account.source === 'sorsa') cell.title = 'Sorsa does not provide a per-account category for this endpoint.';
      if (index === 3 && account.source === 'sorsa') cell.title = 'Sorsa does not provide a first-seen timestamp for this endpoint.';
    });
    const tags = row.insertCell(); tags.className = 'tags-cell';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'tag-button';
    edit.textContent = account.tags.length ? account.tags.join(', ') : '+ Add tag';
    edit.title = 'Edit local research tags';
    edit.addEventListener('click', async () => {
      if (controller) return;
      const value = window.prompt('Local tags, separated by commas:', account.tags.join(', '));
      if (value === null) return;
      const updated: Account = { ...account, tags: [...new Set(value.split(',').map(tag => tag.trim()).filter(Boolean))].slice(0, 30) };
      try { await repository.updateAccount(updated); await loadAccounts(); }
      catch { notice('Could not save local tags.', 'error'); }
    });
    tags.append(edit);
  }
  updateButtons();
}
async function loadAccounts() {
  if (!selected) { accounts = []; renderTable(); return; }
  const id = selected.id;
  const result = await repository.listAccounts(id);
  if (selected?.id === id) { accounts = result; renderTable(); }
}
async function renderCollectionList() {
  const collections = await repository.listCollections();
  text('collectionCount', String(collections.length));
  const list = el('collectionList'); list.replaceChildren();
  for (const collection of collections) {
    const item = document.createElement('button'); item.type = 'button';
    item.className = `collection-item ${selected?.id === collection.id ? 'active' : ''}`;
    const title = document.createElement('span'); title.textContent = collection.title;
    const subtitle = document.createElement('small'); subtitle.textContent = `${formatNumber(collection.total)} accounts · ${formatDate(collection.updatedAt)}`;
    item.append(title, subtitle);
    item.addEventListener('click', async () => {
      if (controller) { notice('Stop the active task before switching collections.', 'warn'); return; }
      await selectCollection(collection.id);
    });
    list.append(item);
  }
}
async function selectCollection(id: string) {
  selected = await repository.getCollection(id) || null;
  if (selected?.status === 'running') {
    selected = { ...selected, status: 'paused', error: 'Extension tab closed during the last run. Resume from the saved cursor.' };
    await repository.putCollection(selected);
  }
  if (selected) {
    input('target').value = selected.username || '';
    input('limit').value = String(selected.limit);
    const mode = document.querySelector<HTMLInputElement>(`input[name="mode"][value="${selected.mode}"]`);
    if (mode) mode.checked = true;
    notice(selected.error || statuses[selected.status], selected.error ? 'error' : 'info');
  }
  tablePage = 0;
  await loadAccounts(); renderStats(); await renderCollectionList();
}
async function checkQuota() {
  try {
    quota = await (await client()).usage();
    renderStats();
    notice(quota.remaining_requests === null ? 'Sorsa did not return a remaining-request count.'
      : `${formatNumber(quota.remaining_requests)} Sorsa API requests remain as of this check.`, 'info');
  } catch (error) { showError(error); }
}
function showError(error: unknown) {
  notice(error instanceof Error ? error.message : 'Unexpected error. Check your connection and try again.', 'error');
}
async function perform(kind: 'collection' | 'scores', initial: Collection, api: SorsaClient, maxScoreRequests?: number) {
  controller = new AbortController(); activity = kind;
  renderStats();
  try {
    const progress = (collection: Collection) => {
      if (selected?.id !== collection.id) return;
      selected = collection;
      renderStats();
      if (kind === 'collection') void loadAccounts().catch(() => {});
    };
    const final = kind === 'collection'
      ? await collectFollowers(initial, api, repository, controller.signal, progress)
      : await enrichScores(initial, api, repository, maxScoreRequests || 25, controller.signal, progress);
    if (selected?.id === final.id) {
      selected = final; await loadAccounts();
      const message = final.error || (kind === 'scores'
        ? 'Score lookup batch finished. Missing scores are not estimated.' : statuses[final.status]);
      notice(message, final.error ? 'error' : final.status === 'limit' ? 'warn' : 'info');
    }
  } catch (error) { showError(error); }
  finally { controller = null; activity = null; renderStats(); await renderCollectionList(); }
}
async function startNew(event: SubmitEvent) {
  event.preventDefault();
  if (controller) return;
  try {
    const username = normalizeUsername(input('target').value);
    const mode = document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value as Mode | undefined;
    const limit = Number(input('limit').value);
    if ((mode !== 'followers' && mode !== 'new7d') || !Number.isInteger(limit) || limit < 1 || limit > 50_000) {
      throw new Error('Choose a mode and a collection limit from 1 to 50,000.');
    }
    const api = await client();
    if (quota?.remaining_requests === 0) throw new Error('Sorsa reports zero requests remaining. Check your quota before starting.');
    const collection = createCollection(username, mode, limit);
    await repository.putCollection(collection);
    selected = collection; accounts = []; tablePage = 0;
    renderTable(); renderStats(); await renderCollectionList();
    notice('Fetching the first page from Sorsa. You can stop safely at any time.');
    await perform('collection', collection, api);
  } catch (error) { showError(error); }
}
async function resume() {
  if (!selected || controller || selected.mode === 'imported') return;
  try {
    const api = await client();
    const limit = Number(input('limit').value);
    if (!Number.isInteger(limit) || limit < selected.total || limit > 50_000) throw new Error('Set a limit between the current account count and 50,000.');
    if (selected.status === 'limit' && limit <= selected.total) throw new Error('Increase the limit to collect more accounts.');
    const updated = { ...selected, limit, error: null };
    await repository.putCollection(updated); selected = updated;
    await perform('collection', updated, api);
  } catch (error) { showError(error); }
}
async function scores() {
  if (!selected || controller) return;
  try {
    const max = Number(input('scoreLimit').value);
    if (!Number.isInteger(max) || max < 1 || max > 500) throw new Error('Choose 1–500 score lookups. Each can cost one API request.');
    if (quota?.remaining_requests === 0) throw new Error('Sorsa reports zero requests remaining. Check your quota.');
    const api = await client();
    notice(`Requesting up to ${max} documented /score lookups, one per account.`);
    await perform('scores', selected, api, max);
  } catch (error) { showError(error); }
}
function exportCSV() {
  if (!selected) return;
  const rows = filtered();
  if (!rows.length) return;
  const blob = new Blob([csvText(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `web3-audience-${selected.username || 'imported'}-${selected.mode}-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  notice(`Exported ${formatNumber(rows.length)} filtered accounts. The saved collection remains available locally.`);
}
async function importFile() {
  const file = input('importFile').files?.[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { notice('CSV file exceeds the 10 MB import limit.', 'error'); return; }
  try {
    const now = new Date().toISOString();
    const collection: Collection = { id: crypto.randomUUID(), title: `Imported · ${file.name.slice(0, 55)}`,
      username: null, mode: 'imported', status: 'paused', createdAt: now, updatedAt: now, limit: 50_000,
      total: 0, pages: 0, requests: 0, nextCursor: null, pendingUsers: [], hasFetched: true, seenCursors: [], error: null };
    const rows = importCSV(await file.text(), collection.id);
    if (!rows.length) throw new Error('No valid X usernames found in the CSV file.');
    await repository.importAccounts(collection, rows);
    await selectCollection(collection.id);
    notice(`Imported ${formatNumber(selected?.total)} unique accounts. Imported categories and dates are labeled as CSV data.`);
  } catch (error) { showError(error); }
  finally { input('importFile').value = ''; }
}
async function removeSelected() {
  if (!selected || controller || !window.confirm(`Delete ${selected.title} and all its locally saved accounts?`)) return;
  await repository.deleteCollection(selected.id);
  selected = null; accounts = []; renderStats(); renderTable(); await renderCollectionList();
  notice('Local collection deleted. Previously downloaded CSV files are unchanged.');
}

function wire() {
  button('settingsToggle').addEventListener('click', () => el('settingsPanel').classList.toggle('hidden'));
  button('settingsClose').addEventListener('click', () => el('settingsPanel').classList.add('hidden'));
  button('saveKey').addEventListener('click', async () => {
    if (controller) return;
    const value = input('apiKey').value.trim();
    if (!value) { notice('Paste your Sorsa API key first.', 'warn'); return; }
    await chrome.storage.session.set({ sorsaApiKey: value });
    input('apiKey').value = ''; hasKey = true; quota = null; renderStats();
    notice('Sorsa key available for this browser session. It is not included in collections or exports.');
    el('settingsPanel').classList.add('hidden');
  });
  button('forgetKey').addEventListener('click', async () => {
    if (controller) return;
    await chrome.storage.session.remove('sorsaApiKey'); hasKey = false; quota = null; renderStats();
    notice('Sorsa key removed from session storage.');
  });
  el<HTMLFormElement>('collectForm').addEventListener('submit', event => void startNew(event));
  button('resumeButton').addEventListener('click', () => void resume());
  button('enrichButton').addEventListener('click', () => void scores());
  button('stopButton').addEventListener('click', () => { controller?.abort(); notice(`Stopping ${activity === 'scores' ? 'score lookups' : 'collection'} at a safe checkpoint…`, 'warn'); });
  button('checkQuota').addEventListener('click', () => void checkQuota());
  button('testConnection').addEventListener('click', async () => {
    const control = button('testConnection');
    control.disabled = true;
    text('connectionResult', 'Testing extension access to the Sorsa API without a key…');
    try {
      const result = await testConnection();
      text('connectionResult', result.message);
      notice(result.message, result.reachable ? 'info' : 'error');
    } finally { updateButtons(); }
  });
  button('exportButton').addEventListener('click', exportCSV);
  input('importFile').addEventListener('change', () => void importFile());
  button('deleteButton').addEventListener('click', () => void removeSelected().catch(showError));
  button('newCollectionNav').addEventListener('click', () => input('target').focus());
  button('prevPage').addEventListener('click', () => { tablePage--; renderTable(); });
  button('nextPage').addEventListener('click', () => { tablePage++; renderTable(); });
  for (const id of ['keyword', 'tagFilter', 'minFollowers', 'maxFollowers', 'minScore', 'maxScore']) {
    input(id).addEventListener('input', () => { tablePage = 0; renderTable(); });
  }
}

async function initialize() {
  wire();
  hasKey = Boolean(await key());
  const saved = await repository.listCollections();
  if (saved[0]) await selectCollection(saved[0].id);
  else { renderStats(); renderTable(); await renderCollectionList(); }
  if (!hasKey) el('settingsPanel').classList.remove('hidden');
}
initialize().catch(showError);
