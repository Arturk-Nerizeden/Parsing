'use strict';
const $ = id => document.getElementById(id);
let tabId;
let connected = false;
let state = { rows: [], stats: {}, status: 'idle' };
let busy = false;
const labels = { author: 'автор', mention: 'упоминание', link: 'ссылка' };
const statuses = { idle: 'Готов к запуску', running: 'Идёт сбор', done: 'Завершено', stopped: 'Остановлено', error: 'Ошибка' };
function error(text = '') { $('error').textContent = text; $('error').hidden = !text; }
function filteredRows() {
  const query = $('search').value.replace(/^@/, '').trim().toLowerCase();
  const source = $('source').value;
  return (state.rows || []).filter(row => row.username.includes(query) && (source === 'all' || row.sources.includes(source)));
}
function render() {
  const active = connected && state.status === 'running';
  $('options').disabled = active;
  $('start').disabled = !connected || active || busy;
  $('stop').disabled = !active || busy;
  $('clear').disabled = !connected || !(state.rows?.length || active) || busy;
  $('count').textContent = (state.rows?.length || 0).toLocaleString('ru');
  $('status').textContent = statuses[state.status] || 'Сохранено';
  $('status').className = `badge ${state.status}`;
  const stats = state.stats || {};
  $('progress').textContent = `${stats.messages || 0} сообщений · ${stats.authors || 0} авторов`;
  const details = [];
  if (stats.withoutUsername) details.push(`без username: ${stats.withoutUsername} авторов`);
  if (stats.unresolved) details.push(`автор не прочитан: ${stats.unresolved} сообщений`);
  if (stats.bots) details.push(`пропущено ботов: ${stats.bots}`);
  if (stats.channels) details.push(`от имени канала: ${stats.channels} сообщений`);
  $('note').textContent = [state.note, ...details].filter(Boolean).join(' · ');
  if (state.storageError) error(state.storageError);
  const rows = filteredRows();
  $('list').replaceChildren();
  for (const row of rows.slice(0, 100)) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.textContent = `@${row.username}`; a.href = `https://t.me/${row.username}`; a.target = '_blank'; a.rel = 'noopener noreferrer';
    const source = document.createElement('span'); source.textContent = row.sources.map(s => labels[s]).join(', ');
    li.append(a, source); $('list').append(li);
  }
  if (!rows.length) {
    const li = document.createElement('li'); li.className = 'empty';
    li.textContent = state.rows?.length ? 'По этому фильтру ничего не найдено.' : 'Пока пусто. Выберите чат и начните сбор.';
    $('list').append(li);
  }
  $('shown').textContent = rows.length ? `Показано ${Math.min(rows.length, 100)} из ${rows.length}. Экспорт учитывает фильтр.` : '';
  document.querySelectorAll('[data-export], #copy').forEach(button => { button.disabled = !rows.length; });
}
async function command(type, options) {
  if (busy) return;
  busy = true; error(); render();
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: `collector:${type}`, options });
    if (response?.error) throw new Error(response.error);
    if (response?.state) state = response.state;
  } catch (err) { error(err.message || 'Нет связи с Telegram. Обновите его вкладку.'); }
  finally { busy = false; render(); }
}
async function refresh() {
  if (!tabId || busy) return;
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'collector:status' });
    if (!response?.state) throw new Error();
    connected = true; state = response.state;
    $('connectionDot').classList.toggle('connected', Boolean(response.context));
    $('client').textContent = response.context ? `Telegram Web ${response.context.client}` : 'Telegram подключён';
    $('chat').textContent = response.context?.title || 'Откройте чат или комментарии';
    if (response.context?.client === 'A') $('help').textContent = 'В Web A доступны упоминания и ссылки. Для username авторов используйте web.telegram.org/k/.';
  } catch {
    connected = false;
    $('connectionDot').classList.remove('connected');
    $('client').textContent = 'Нет связи с Telegram';
    if (state.status === 'running') { state.status = 'stopped'; state.note = 'Связь с вкладкой потеряна. Показаны последние полученные результаты.'; }
  }
  render();
}
$('settings').addEventListener('submit', event => {
  event.preventDefault();
  command('start', { authors: $('authors').checked, mentions: $('mentions').checked, bots: $('bots').checked,
    auto: $('auto').checked, direction: $('direction').value, limit: Number($('limit').value) });
});
$('stop').addEventListener('click', () => command('stop'));
$('clear').addEventListener('click', () => command('clear'));
$('search').addEventListener('input', render);
$('source').addEventListener('change', render);
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(TGCollectorCore.exportData(filteredRows(), 'txt')); $('copy').textContent = 'Скопировано'; setTimeout(() => { $('copy').textContent = 'Копировать'; }, 1500); }
  catch { error('Не удалось скопировать. Используйте экспорт TXT.'); }
});
document.querySelectorAll('[data-export]').forEach(button => button.addEventListener('click', () => {
  const format = button.dataset.export;
  const mime = { csv: 'text/csv', txt: 'text/plain', json: 'application/json' }[format];
  const blob = new Blob([TGCollectorCore.exportData(filteredRows(), format)], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url;
  link.download = `telegram-usernames-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}));
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  const saved = await chrome.storage.local.get([`session:${tabId}`, 'lastSessionKey']);
  let session = saved[`session:${tabId}`];
  if (!session && saved.lastSessionKey) session = (await chrome.storage.local.get(saved.lastSessionKey))[saved.lastSessionKey];
  if (session) {
    state = { ...session, status: session.status === 'running' ? 'stopped' : session.status };
    $('chat').textContent = session.context || 'Сохранённые результаты';
    if (session.options) for (const key of ['authors', 'mentions', 'bots', 'auto']) $(key).checked = session.options[key];
  }
  await refresh();
  if (connected && state.status === 'idle' && $('client').textContent === 'Telegram Web A') {
    $('authors').checked = false; $('mentions').checked = true;
  }
  if (!connected) $('help').textContent = 'Откройте Telegram Web и выберите чат. После установки расширения обновите вкладку Telegram. Здесь можно экспортировать последние сохранённые результаты.';
  setInterval(refresh, 1000);
})().catch(() => { error('Не удалось открыть расширение. Закройте это окно и повторите.'); });
