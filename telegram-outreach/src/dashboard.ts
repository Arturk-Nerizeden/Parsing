import './styles.css';
import './media.css';
import { createCampaign, exportCampaignCSV, parseContacts, renderMessage } from './domain';
import { checkedPhoto, deletePhoto, readPhoto, savePhoto } from './images';
import { recoverCampaign, runCampaign } from './queue';
import { clearSession, loadSession, loadState, saveSession, saveState } from './storage';
import { TelegramConnection } from './telegram';
import type { Campaign, Contact, LocalState, Sender } from './types';

function node<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing interface element: ${id}`);
  return found as T;
}
const input = (id: string) => node<HTMLInputElement>(id);
const button = (id: string) => node<HTMLButtonElement>(id);
const setText = (id: string, value: string) => { node(id).textContent = value; };
const on = <K extends keyof HTMLElementEventMap>(id: string, name: K, listener: (event: HTMLElementEventMap[K]) => void) =>
  node(id).addEventListener(name, listener as EventListener);

const api = new TelegramConnection();
let state: LocalState = { version: 1, campaigns: [], selectedId: null, suppressed: [] };
let contacts: Contact[] = [];
let importFormat: 'text' | 'csv' = 'text';
let image: Blob | null = null;
let imageName = '';
let imageUrl: string | null = null;
let sender: Sender | null = null;
let controller: AbortController | null = null;
let authController: AbortController | null = null;
let challengeResolve: ((answer: string) => void) | null = null;
let challengeReject: ((error: Error) => void) | null = null;
let page = 0;

function selected(): Campaign | null { return state.campaigns.find(item => item.id === state.selectedId) ?? null; }
function notice(message: string, kind: 'info' | 'warn' | 'error' = 'info') {
  const target = node('notice'); target.textContent = message; target.className = `notice ${kind === 'info' ? '' : kind}`;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Неизвестная ошибка. Повторите действие.'; }
function tagsFrom(text: string): string[] {
  const tags = [...new Set(text.split(/[,;|]/u).map(value => value.trim()).filter(Boolean))];
  if (tags.length > 10 || tags.some(tag => tag.length > 32)) throw new Error('Укажите до 10 тегов длиной не больше 32 символов.');
  return tags;
}
function report(error: unknown) { notice(errorMessage(error), 'error'); }
function run(action: () => Promise<unknown>) { void action().catch(report); }
function formatDate(value: string): string {
  return new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function chooseImageUrl(blob: Blob | null): string | null {
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = blob ? URL.createObjectURL(blob) : null;
  for (const id of ['previewImage', 'confirmImage']) {
    const element = node<HTMLImageElement>(id);
    element.classList.toggle('hidden', !imageUrl);
    if (imageUrl) element.src = imageUrl;
    else element.removeAttribute('src');
  }
  return imageUrl;
}
async function save(): Promise<void> {
  try { await saveState(state); }
  catch (error) { state = await loadState(); render(); throw error; }
  render();
}
async function setCampaign(campaign: Campaign): Promise<void> {
  state.campaigns = state.campaigns.map(item => item.id === campaign.id ? campaign : item);
  await save();
}
function statusLabel(status: string): string {
  return ({ pending: 'Ожидает', resolving: 'Поиск', sending: 'Отправка', sent: 'Отправлено',
    confirmed: 'Подтверждено вами', failed: 'Ошибка', review: 'Проверить', skipped: 'Пропущено',
    draft: 'Готово', paused: 'На паузе', running: 'Отправляется', waiting: 'Пауза Telegram', complete: 'Завершено' } as Record<string, string>)[status] ?? status;
}
function renderList() {
  const list = node('campaignList'); list.replaceChildren();
  setText('historyCount', String(state.campaigns.length));
  setText('suppressedCount', String(state.suppressed.length));
  for (const campaign of state.campaigns) {
    const item = document.createElement('button'); item.type = 'button';
    item.className = `history-item ${state.selectedId === campaign.id ? 'active' : ''}`;
    const title = document.createElement('span'); title.textContent = campaign.title;
    const subtitle = document.createElement('small');
    subtitle.textContent = `${campaign.recipients.length} контактов · ${statusLabel(campaign.status)}`;
    item.append(title, subtitle);
    item.disabled = Boolean(controller);
    item.addEventListener('click', () => run(async () => {
      state.selectedId = campaign.id; page = 0; await save();
      const savedPhoto = campaign.image ? await readPhoto(campaign.id) : null;
      chooseImageUrl(savedPhoto);
      render();
    }));
    list.append(item);
  }
}
function renderPreview() {
  const dropdown = node<HTMLSelectElement>('previewRecipient');
  const old = dropdown.value;
  dropdown.replaceChildren();
  for (const contact of contacts) {
    const option = document.createElement('option'); option.value = contact.username;
    option.textContent = `@${contact.username}${contact.firstName ? ` · ${contact.firstName}` : ''}`;
    dropdown.append(option);
  }
  if (contacts.length && contacts.some(c => c.username === old)) dropdown.value = old;
  if (!contacts.length) { const option = document.createElement('option'); option.textContent = 'Сначала добавьте контакты'; dropdown.append(option); }
  const preview = contacts.find(c => c.username === dropdown.value) ?? contacts[0];
  setText('previewUsername', preview ? `@${preview.username}` : '@username');
  try { setText('previewText', preview && input('messageInput').value ? renderMessage(input('messageInput').value, preview) : 'Здесь появится ваше сообщение.'); }
  catch { setText('previewText', 'Проверьте текст сообщения и шаблон.'); }
  const max = image ? 1024 : 4096;
  setText('messageCount', `${input('messageInput').value.length} / ${max}`);
  setText('contactBadge', `${contacts.length} контактов`);
  setText('imageName', image ? `${imageName} · ${(image.size / 1024 / 1024).toFixed(1)} МБ` : 'Не выбрана');
  button('removeImage').classList.toggle('hidden', !image);
}
function renderRows(campaign: Campaign) {
  const filter = node<HTMLSelectElement>('statusFilter').value;
  const tagSelect = node<HTMLSelectElement>('tagFilter');
  const oldTag = tagSelect.value;
  const tags = [...new Set(campaign.recipients.flatMap(row => row.tags ?? []))].sort((a, b) => a.localeCompare(b));
  tagSelect.replaceChildren();
  const allTags = document.createElement('option'); allTags.value = 'all'; allTags.textContent = 'Все теги'; tagSelect.append(allTags);
  for (const tag of tags) {
    const option = document.createElement('option'); option.value = tag; option.textContent = tag; tagSelect.append(option);
  }
  if (tags.includes(oldTag)) tagSelect.value = oldTag;
  const selectedTag = tagSelect.value;
  const rows = campaign.recipients.filter(row =>
    (filter === 'all' || row.status === filter) && (selectedTag === 'all' || row.tags?.includes(selectedTag)));
  const pages = Math.max(1, Math.ceil(rows.length / 100));
  page = Math.min(page, pages - 1);
  const start = page * 100;
  const target = node<HTMLTableSectionElement>('recipientRows'); target.replaceChildren();
  for (const row of rows.slice(start, start + 100)) {
    const tr = target.insertRow();
    const identity = tr.insertCell();
    const link = document.createElement('a'); link.href = `https://t.me/${encodeURIComponent(row.username)}`;
    link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = `@${row.username}`;
    identity.append(link);
    if (row.firstName || row.tags?.length) {
      const small = document.createElement('small');
      small.textContent = [row.firstName, ...(row.tags ?? []).map(tag => `#${tag}`)].filter(Boolean).join(' · ');
      identity.append(small);
    }
    const status = document.createElement('span'); status.className = `status ${row.status}`; status.textContent = statusLabel(row.status);
    tr.insertCell().append(status);
    tr.insertCell().textContent = row.error || (row.sentAt ? `Telegram подтвердил ${formatDate(row.sentAt)}${row.messageId ? ` · ID ${row.messageId}` : ''}` : '—');
    const actions = tr.insertCell();
    const action = (label: string, handler: () => void) => {
      const control = document.createElement('button'); control.type = 'button'; control.className = 'row-action';
      control.textContent = label; control.disabled = Boolean(controller);
      control.addEventListener('click', handler); actions.append(control);
    };
    action('Теги', () => run(async () => {
      const edited = window.prompt(`Теги для @${row.username}, через запятую`, (row.tags ?? []).join(', '));
      if (edited === null) return;
      await updateRecipient(campaign.id, row.id, { tags: tagsFrom(edited) });
    }));
    if (row.status === 'review') action('Проверено: отправлено', () => run(async () => {
      if (!window.confirm(`Вы проверили диалог с @${row.username} и нашли уже отправленное сообщение?`)) return;
      await updateRecipient(campaign.id, row.id, { status: 'confirmed', error: 'Подтверждено вручную в диалоге Telegram.' });
    }));
    if (row.status === 'failed') action('Повторить позже', () => run(() => updateRecipient(campaign.id, row.id, { status: 'pending', error: undefined })));
    if (row.status === 'pending' || row.status === 'failed' || row.status === 'review') action('Пропустить', () => run(() => updateRecipient(campaign.id, row.id, { status: 'skipped', error: 'Пропущено вручную.' })));
    if (!state.suppressed.includes(row.username)) action('Не писать', () => run(async () => {
      state.suppressed = [...state.suppressed, row.username]; await save();
      notice(`@${row.username} добавлен в список «не писать».`);
    }));
  }
  if (!rows.length) { const empty = target.insertRow().insertCell(); empty.colSpan = 4; empty.className = 'empty-row'; empty.textContent = 'Контактов с этим статусом нет.'; }
  setText('pageInfo', `${rows.length ? start + 1 : 0}–${Math.min(start + 100, rows.length)} из ${rows.length}`);
  button('prevPage').disabled = page === 0;
  button('nextPage').disabled = page >= pages - 1;
}
async function updateRecipient(campaignId: string, rowId: string, patch: Partial<Campaign['recipients'][number]>) {
  const campaign = state.campaigns.find(item => item.id === campaignId);
  if (!campaign || controller) return;
  const edited: Campaign = { ...campaign, status: 'paused', updatedAt: new Date().toISOString(),
    recipients: campaign.recipients.map(row => row.id === rowId ? { ...row, ...patch } : row) };
  await setCampaign(edited);
}
function renderCampaign(campaign: Campaign) {
  setText('campaignTitle', campaign.title);
  setText('campaignMeta', `${formatDate(campaign.createdAt)} · отправитель ${campaign.senderId ?? 'выбирается при запуске'} · интервал ${campaign.intervalSeconds} сек.${campaign.image ? ` · ${campaign.image.name}` : ''}`);
  setText('metricTotal', String(campaign.recipients.length));
  setText('metricSent', String(campaign.recipients.filter(row => row.status === 'sent' || row.status === 'confirmed').length));
  setText('metricPending', String(campaign.recipients.filter(row => row.status === 'pending' || row.status === 'resolving' || row.status === 'sending').length));
  setText('metricReview', String(campaign.recipients.filter(row => row.status === 'review').length));
  setText('metricFailed', String(campaign.recipients.filter(row => row.status === 'failed').length));
  setText('queueStatus', statusLabel(campaign.status));
  setText('queueNotice', campaign.notice || (campaign.image ? 'Картинка и подпись отправляются одним сообщением.' : 'Очередь готова.'));
  setText('savedTemplate', campaign.template);
  const pending = campaign.recipients.some(row => row.status === 'pending');
  const waiting = campaign.waitUntil !== null && campaign.waitUntil > Date.now();
  button('startQueue').disabled = Boolean(controller) || !pending || waiting;
  button('startQueue').textContent = campaign.status === 'draft' ? 'Начать отправку ↗' : 'Продолжить ↗';
  button('pauseQueue').disabled = !controller;
  button('exportQueue').disabled = Boolean(controller);
  button('deleteQueue').disabled = Boolean(controller);
  renderRows(campaign);
}
function render() {
  renderList();
  const campaign = selected();
  node('composer').classList.toggle('hidden', Boolean(campaign));
  node('campaignPanel').classList.toggle('hidden', !campaign);
  node('connectionDot').classList.toggle('connected', Boolean(sender));
  setText('accountLabel', sender ? sender.label : 'Подключить Telegram');
  button('connectButton').disabled = Boolean(controller);
  button('newCampaign').disabled = Boolean(controller);
  if (campaign) renderCampaign(campaign);
  else renderPreview();
}

async function parseInput(): Promise<Contact[]> {
  const result = parseContacts(input('contactInput').value, importFormat);
  const commonTags = tagsFrom(input('commonTags').value);
  contacts = result.contacts.map(contact => ({ ...contact,
    tags: tagsFrom([...(contact.tags ?? []), ...commonTags].join(',')) }));
  setText('importReport', `${contacts.length} уникальных контактов · ${result.duplicates} дублей · ${result.invalid.length} неверных записей${result.invalid.length ? `: ${result.invalid.slice(0, 3).join(', ')}` : ''}`);
  renderPreview();
  return contacts;
}
async function createQueue() {
  await parseInput();
  const parsed = parseContacts(input('contactInput').value, importFormat);
  if (parsed.invalid.length) throw new Error(`Исправьте неверные никнеймы: ${parsed.invalid.slice(0, 3).join(', ')}.`);
  const campaign = createCampaign(contacts, input('messageInput').value, Number(input('intervalSeconds').value));
  if (image) {
    for (const row of campaign.recipients) {
      if (renderMessage(campaign.template, row).length > 1024) throw new Error('Подпись к картинке должна быть не длиннее 1024 символов для каждого получателя.');
    }
    campaign.image = { name: imageName, mimeType: image.type as 'image/jpeg' | 'image/png', size: image.size };
    await savePhoto(campaign.id, image);
  }
  state.campaigns.unshift(campaign); state.selectedId = campaign.id; page = 0;
  await save();
  notice(`Очередь из ${campaign.recipients.length} контактов создана. Проверьте отправителя и запустите её.`);
}
async function showConfirmation() {
  const campaign = selected(); if (!campaign) return;
  if (!sender) { openAuth(); notice('Сначала подключите личный аккаунт Telegram.', 'warn'); return; }
  if (campaign.senderId && campaign.senderId !== sender.id) throw new Error('Очередь привязана к другому аккаунту Telegram.');
  if (campaign.waitUntil && campaign.waitUntil > Date.now()) { notice(`Telegram запросил паузу до ${formatDate(new Date(campaign.waitUntil).toISOString())}.`, 'warn'); return; }
  const pending = campaign.recipients.filter(row => row.status === 'pending');
  if (!pending.length) { notice('В очереди нет ожидающих контактов.', 'warn'); return; }
  if (campaign.image) {
    const saved = await readPhoto(campaign.id);
    if (!saved) throw new Error('Картинка очереди не найдена. Отправка не начата.');
    chooseImageUrl(saved);
  } else chooseImageUrl(null);
  setText('confirmSummary', `Аккаунт ${sender.label} · ${pending.length} получателей · интервал ${campaign.intervalSeconds} сек.${campaign.image ? ' · картинка' : ''}`);
  setText('confirmRecipients', pending.slice(0, 5).map(row => `@${row.username}`).join(', ') + (pending.length > 5 ? ' …' : ''));
  setText('confirmMessage', renderMessage(campaign.template, pending[0]!));
  node<HTMLDialogElement>('confirmDialog').showModal();
}
async function startSending() {
  node<HTMLDialogElement>('confirmDialog').close();
  const campaign = selected(); if (!campaign || !sender || controller) return;
  controller = new AbortController(); render();
  notice(`Отправляем сообщения от ${sender.label}. Оставьте вкладку открытой.`);
  try {
    await runCampaign(campaign, api, async updated => {
      state.campaigns = state.campaigns.map(item => item.id === updated.id ? updated : item);
      await saveState(state);
    }, { signal: controller.signal, suppressed: () => state.suppressed, loadPhoto: readPhoto,
      onProgress: updated => { state.campaigns = state.campaigns.map(item => item.id === updated.id ? updated : item); render(); } });
    notice(selected()?.notice || 'Очередь обновлена.', selected()?.status === 'complete' ? 'info' : 'warn');
  } catch (error) {
    // The durable `sending` marker is authoritative if saving an acknowledgement failed.
    try {
      state = await loadState();
      state.campaigns = state.campaigns.map(recoverCampaign);
      await saveState(state);
    } catch { /* Never retry an uncertain delivery automatically. */ }
    report(error);
  } finally { controller = null; render(); }
}

function openAuth() {
  const dialog = node<HTMLDialogElement>('authDialog');
  node('authFields').classList.toggle('hidden', Boolean(sender));
  node('challengeFields').classList.add('hidden');
  button('loginButton').classList.toggle('hidden', Boolean(sender));
  button('logoutButton').classList.toggle('hidden', !sender);
  setText('authStatus', sender ? `Подключён аккаунт ${sender.label}.` : 'Введите данные приложения Telegram и телефон.');
  if (!dialog.open) dialog.showModal();
}
function requestChallenge(kind: 'code' | 'password'): Promise<string> {
  node('challengeFields').classList.remove('hidden');
  const value = input('challengeInput'); value.value = ''; value.type = kind === 'password' ? 'password' : 'text';
  setText('challengeLabel', kind === 'password' ? 'Пароль двухэтапной проверки' : 'Код из Telegram');
  setText('challengeHelp', kind === 'password' ? 'Введите пароль Telegram для этого аккаунта.' : 'Код пришёл в Telegram или другим способом, выбранным Telegram.');
  setText('authStatus', kind === 'password' ? 'Ожидаем пароль…' : 'Ожидаем код подтверждения…');
  button('loginButton').disabled = false; button('loginButton').textContent = 'Продолжить';
  value.focus();
  return new Promise((resolve, reject) => { challengeResolve = resolve; challengeReject = reject; });
}
function closeAuth() {
  challengeReject?.(new Error('Вход отменён.'));
  challengeResolve = null; challengeReject = null;
  authController?.abort();
  node<HTMLDialogElement>('authDialog').close();
}
async function submitAuth(event: Event) {
  event.preventDefault();
  if (challengeResolve) {
    const value = input('challengeInput').value.trim();
    if (!value) { setText('authStatus', 'Введите код или пароль.'); return; }
    const resolve = challengeResolve; challengeResolve = null; challengeReject = null;
    input('challengeInput').value = ''; button('loginButton').disabled = true;
    resolve(value); return;
  }
  if (authController) return;
  authController = new AbortController(); button('loginButton').disabled = true;
  setText('authStatus', 'Подключаемся к Telegram…');
  try {
    const result = await api.login({ apiId: Number(input('apiId').value), apiHash: input('apiHash').value.trim(), phone: input('phone').value }, {
      code: () => requestChallenge('code'), password: () => requestChallenge('password'),
    }, authController.signal);
    await saveSession(result.credentials);
    sender = result.sender;
    input('apiHash').value = ''; input('phone').value = '';
    closeAuth(); render(); notice(`Подключён аккаунт ${sender.label}. Сессия действует до закрытия браузера.`);
  } catch (error) {
    setText('authStatus', errorMessage(error));
    node('authStatus').classList.add('error');
    button('loginButton').textContent = 'Получить новый код';
    node('challengeFields').classList.add('hidden');
    button('loginButton').disabled = false;
    await api.disconnect();
  } finally { authController = null; }
}
async function logout() {
  if (controller || !sender) return;
  if (!window.confirm('Выйти из Telegram в этом расширении? Очереди останутся в браузере.')) return;
  let message = 'Вы вышли из Telegram.';
  try { await api.logout(); }
  catch (error) { message = `${errorMessage(error)} Сессия удалена из расширения.`; }
  await clearSession(); sender = null; closeAuth(); render(); notice(message, 'warn');
}
async function updateSuppression() {
  const parsed = parseContacts(input('suppressionInput').value);
  if (parsed.invalid.length) { setText('suppressionError', `Исправьте: ${parsed.invalid.slice(0, 3).join(', ')}`); return; }
  state.suppressed = parsed.contacts.map(c => c.username);
  await save(); node<HTMLDialogElement>('suppressionDialog').close(); notice('Список «не писать» сохранён.');
}
async function deleteCampaign() {
  const campaign = selected(); if (!campaign || controller) return;
  if (!window.confirm(`Удалить очередь «${campaign.title}» вместе с журналом?`)) return;
  state.campaigns = state.campaigns.filter(item => item.id !== campaign.id); state.selectedId = null;
  await save();
  if (campaign.image) await deletePhoto(campaign.id);
  chooseImageUrl(image);
  notice('Очередь удалена.');
}
function exportCSV() {
  const campaign = selected(); if (!campaign) return;
  const url = URL.createObjectURL(new Blob([exportCampaignCSV(campaign)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url;
  link.download = `telegram-outreach-${campaign.id.slice(0, 8)}.csv`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
  notice('Журнал очереди сохранён в CSV.');
}

function handlers() {
  on('newCampaign', 'click', () => run(async () => {
    if (controller) return;
    state.selectedId = null; contacts = []; image = null; imageName = ''; importFormat = 'text';
    input('contactInput').value = ''; input('commonTags').value = ''; input('messageInput').value = ''; input('imageInput').value = '';
    chooseImageUrl(null); await save(); notice('Новая очередь: добавьте никнеймы и текст сообщения.');
  }));
  on('parseContacts', 'click', () => run(async () => { await parseInput(); }));
  on('contactInput', 'input', () => { contacts = []; renderPreview(); });
  on('commonTags', 'input', () => { contacts = []; renderPreview(); });
  on('importFile', 'change', () => run(async () => {
    const file = input('importFile').files?.[0]; if (!file) return;
    if (file.size > 1024 * 1024) throw new Error('CSV или TXT файл должен быть не больше 1 МБ.');
    importFormat = file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'text';
    input('contactInput').value = await file.text(); await parseInput();
  }));
  on('imageInput', 'change', () => run(async () => {
    const file = input('imageInput').files?.[0]; if (!file) return;
    const blob = await checkedPhoto(file);
    image = blob; imageName = file.name; chooseImageUrl(blob); renderPreview();
    notice(`Картинка «${file.name}» добавлена в предпросмотр. Подпись ограничена 1024 символами.`);
  }));
  on('removeImage', 'click', () => { image = null; imageName = ''; input('imageInput').value = ''; chooseImageUrl(null); renderPreview(); });
  on('messageInput', 'input', renderPreview);
  on('previewRecipient', 'change', renderPreview);
  document.querySelectorAll<HTMLButtonElement>('[data-token]').forEach(control => control.addEventListener('click', () => {
    const field = input('messageInput'); const start = field.selectionStart ?? field.value.length; const end = field.selectionEnd ?? start;
    const token = control.dataset.token ?? '';
    field.value = field.value.slice(0, start) + token + field.value.slice(end);
    field.focus(); field.setSelectionRange(start + token.length, start + token.length); renderPreview();
  }));
  on('createQueue', 'click', () => run(createQueue));
  on('startQueue', 'click', () => run(showConfirmation));
  on('confirmSend', 'click', () => run(startSending));
  on('cancelSend', 'click', () => node<HTMLDialogElement>('confirmDialog').close());
  on('pauseQueue', 'click', () => { controller?.abort(); notice('Пауза после завершения текущего запроса…', 'warn'); });
  on('exportQueue', 'click', exportCSV);
  on('deleteQueue', 'click', () => run(deleteCampaign));
  on('statusFilter', 'change', () => { page = 0; const campaign = selected(); if (campaign) renderRows(campaign); });
  on('tagFilter', 'change', () => { page = 0; const campaign = selected(); if (campaign) renderRows(campaign); });
  on('prevPage', 'click', () => { page -= 1; const campaign = selected(); if (campaign) renderRows(campaign); });
  on('nextPage', 'click', () => { page += 1; const campaign = selected(); if (campaign) renderRows(campaign); });
  on('connectButton', 'click', openAuth);
  on('closeAuth', 'click', closeAuth);
  on('authForm', 'submit', event => { void submitAuth(event); });
  on('logoutButton', 'click', () => run(logout));
  on('suppressionButton', 'click', () => {
    input('suppressionInput').value = state.suppressed.map(name => `@${name}`).join('\n');
    setText('suppressionError', ''); node<HTMLDialogElement>('suppressionDialog').showModal();
  });
  on('closeSuppression', 'click', () => node<HTMLDialogElement>('suppressionDialog').close());
  on('saveSuppression', 'click', () => run(updateSuppression));
  window.addEventListener('pagehide', () => { controller?.abort(); authController?.abort(); void api.disconnect(); });
}

async function boot() {
  state = await loadState();
  const recovered = state.campaigns.map(recoverCampaign);
  if (JSON.stringify(recovered) !== JSON.stringify(state.campaigns)) {
    state.campaigns = recovered; await saveState(state);
  }
  handlers();
  const campaign = selected();
  if (campaign?.image) chooseImageUrl(await readPhoto(campaign.id));
  render();
  if (await loadSession()) {
    notice('Восстанавливаем соединение с Telegram…');
    try {
      sender = await api.restore((await loadSession())!);
      render(); notice(`Подключён аккаунт ${sender.label}.`);
    } catch { notice('Не удалось восстановить сессию Telegram. Проверьте соединение или войдите заново.', 'warn'); }
  }
}

// Only one dashboard may edit or dispatch this browser's local queue at a time.
void navigator.locks.request('telegram-outreach-workspace', { ifAvailable: true }, async lock => {
  if (!lock) {
    node('main').setAttribute('inert', '');
    notice('Расширение уже открыто в другой вкладке. Перейдите в неё или закройте её перед продолжением.', 'warn');
    return;
  }
  try { await boot(); await new Promise<void>(() => {}); }
  catch (error) { report(error); node('main').setAttribute('inert', ''); }
});
