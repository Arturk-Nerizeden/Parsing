'use strict';
// The worker only persists per-tab results. Capturing lives in the content script,
// so closing the popup or suspending this worker cannot interrupt a run.
let writes = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!sender.tab?.id || !sender.url?.startsWith('https://web.telegram.org/')) return;
  const key = `session:${sender.tab.id}`;
  if (message.type === 'collector:load') {
    writes.then(() => chrome.storage.local.get(key)).then(data => reply({ session: data[key] || null }))
      .catch(() => reply({ error: 'Не удалось прочитать сохранённые результаты.' }));
    return true;
  }
  if (message.type !== 'collector:save') return;
  writes = writes.catch(() => {}).then(async () => {
    const session = message.session;
    if (!session || !Array.isArray(session.rows) || session.rows.length > 10000) throw new Error('Invalid session');
    await chrome.storage.local.set({ [key]: { ...session, tabId: sender.tab.id, savedAt: Date.now() }, lastSessionKey: key });
    // Bound local retention to eight tabs; the current run is never evicted.
    const all = await chrome.storage.local.get(null);
    const old = Object.entries(all).filter(([name]) => name.startsWith('session:') && name !== key)
      .sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0)).slice(7).map(([name]) => name);
    if (old.length) await chrome.storage.local.remove(old);
  });
  writes.then(() => reply({ ok: true })).catch(() => reply({ error: 'Не удалось сохранить результаты. Экспортируйте их до закрытия вкладки.' }));
  return true;
});
