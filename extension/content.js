(() => {
  'use strict';
  const Core = globalThis.TGCollectorCore;
  const DOM = globalThis.TGCollectorDOM;
  let state = { status: 'idle', rows: [], stats: {}, note: 'Откройте чат или комментарии под постом.' };
  let controller;
  let running;
  const ready = chrome.runtime.sendMessage({ type: 'collector:load' }).then(async ({ session } = {}) => {
    if (session) {
      state = { ...session, status: session.status === 'running' ? 'stopped' : session.status };
      if (session.status === 'running') {
        state.note = 'Вкладка была перезагружена. Сохранённые результаты доступны; запустите новый сбор.';
        await save();
      }
    }
  }).catch(() => {});

  async function save() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'collector:save', session: state });
      state.storageError = response?.error || '';
    } catch { state.storageError = 'Результаты не сохранены. Экспортируйте их до закрытия вкладки.'; }
  }
  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException('Stopped', 'AbortError'));
      const abort = () => { clearTimeout(timer); reject(new DOMException('Stopped', 'AbortError')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  function bridge(messages = [], signal) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', listener); signal?.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(new DOMException('Stopped', 'AbortError')); };
      const listener = event => {
        if (event.source !== window || event.origin !== location.origin
          || event.data?.type !== 'tg-username-collector:response:v1' || event.data.id !== id) return;
        cleanup(); resolve(event.data);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Telegram не ответил. Обновите вкладку и повторите сбор.')); }, 3000);
      window.addEventListener('message', listener);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      window.postMessage({ type: 'tg-username-collector:request:v1', id,
        messages: messages.map(({ mid, peerId }) => ({ mid, peerId })) }, location.origin);
    });
  }
  function validateContext(initial) {
    const current = DOM.locate();
    if (!current || current.root !== initial.root || current.token !== initial.token) {
      const error = new Error('Чат, ветка комментариев или аккаунт изменились. Сбор остановлен; результаты сохранены.');
      error.name = 'ContextChanged'; throw error;
    }
    return current;
  }
  async function collect(context, options, signal) {
    const results = new Core.Results();
    const seen = new Map();
    const actors = new Map();
    let identity;
    let idleRounds = 0;
    let previousPosition;
    function checkIdentity(answer) {
      if (identity && (answer.account !== identity.account || answer.scope !== identity.scope
        || (options.authors && !answer.available))) {
        const error = new Error('Аккаунт, ветка или доступ к данным Telegram изменились. Сбор остановлен.');
        error.name = 'ContextChanged'; throw error;
      }
    }
    function snapshot() {
      state.rows = results.list();
      state.stats = { messages: seen.size,
        authors: [...actors.values()].filter(a => a.status === 'found' && (options.bots || !a.isBot)).length,
        withoutUsername: [...actors.values()].filter(a => a.status === 'no-username').length,
        unresolved: [...seen.values()].filter(status => status === 'unresolved').length,
        bots: [...actors.values()].filter(a => a.isBot && !options.bots).length,
        channels: [...seen.values()].filter(status => status === 'non-user').length };
    }
    try {
      if (context.client === 'K') {
        const probe = await bridge([], signal);
        if (options.authors && !probe.available) throw new Error('Авторы доступны в Telegram Web K. Откройте web.telegram.org/k/ или включите только упоминания. Если уже открыт Web K — его интерфейс мог измениться.');
        identity = probe;
      }
      while (!signal.aborted) {
        if (identity) checkIdentity(await bridge([], signal));
        validateContext(context);
        const before = seen.size;
        let loaded = DOM.messages(context);
        if (options.direction === 'up') loaded.reverse();
        // Revisit unresolved cached authors while retaining counts for virtualized messages.
        const todo = [];
        let budget = options.limit - seen.size;
        for (const message of loaded) {
          if (seen.has(message.key)) {
            if (options.authors && seen.get(message.key) === 'unresolved') todo.push(message);
          } else if (budget > 0) { todo.push(message); budget--; }
        }
        for (let index = 0; index < todo.length; index += 500) {
          const batch = todo.slice(index, index + 500);
          const answer = options.authors ? await bridge(batch, signal) : null;
          validateContext(context);
          if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
          if (answer) checkIdentity(answer);
          const authors = new Map((answer?.authors || []).map(a => [a.key, a]));
          for (const message of batch) {
            if (options.mentions) for (const item of Core.extract(message.text, message.hrefs)) {
              results.add(item, context.title, message.key);
            }
            const author = authors.get(message.key);
            seen.set(message.key, options.authors ? author?.status || 'unresolved' : 'text');
            if (author?.peerId) actors.set(author.peerId, author);
            if (author?.status === 'found' && (options.bots || !author.isBot)) {
              for (const username of author.usernames || []) results.add({ username, kind: 'author', peerId: author.peerId }, context.title, message.key);
            }
          }
          snapshot();
        }
        snapshot();
        state.note = options.auto ? 'Собираю сообщения. Можно закрыть это окно; вкладку Telegram оставьте открытой.' : 'Загруженные сообщения обработаны.';
        await save();
        if (seen.size >= options.limit || state.rows.length >= 10000) {
          state.note = 'Достигнут установленный лимит. Обработана часть истории.'; break;
        }
        if (!options.auto) {
          if (!seen.size) state.note = 'Загруженных сообщений нет. Откройте переписку или комментарии и повторите сбор.';
          break;
        }
        const scroll = context.scroll;
        if (!scroll) throw new Error('Не найдена область прокрутки. Выключите автопрокрутку и собирайте загруженные сообщения.');
        const position = Math.round(scroll.scrollTop);
        idleRounds = seen.size === before && position === previousPosition ? idleRounds + 1 : 0;
        previousPosition = position;
        if (idleRounds >= 5) {
          state.note = 'Новые сообщения больше не подгружаются. Полнота истории не гарантируется.'; break;
        }
        const step = Math.max(200, Math.round(scroll.clientHeight * 0.8));
        scroll.scrollBy({ top: options.direction === 'down' ? step : -step, behavior: 'instant' });
        // Trigger the client's lazy loader even when already at the scroll boundary.
        scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait(1400, signal);
      }
      state.status = signal.aborted ? 'stopped' : 'done';
      if (signal.aborted) state.note = 'Остановлено. Собранные результаты сохранены.';
    } catch (error) {
      state.rows = results.list();
      state.status = ['AbortError', 'ContextChanged'].includes(error.name) ? 'stopped' : 'error';
      state.note = error.name === 'AbortError' ? 'Остановлено. Собранные результаты сохранены.' : error.message;
    } finally {
      snapshot();
      state.finishedAt = new Date().toISOString();
      await save();
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !message?.type?.startsWith('collector:')) return;
    (async () => {
      await ready;
      if (message.type === 'collector:status') {
        const context = DOM.locate();
        return { state, context: context ? { client: context.client, title: context.title } : null };
      }
      if (message.type === 'collector:stop') {
        controller?.abort(); await running; return { state };
      }
      if (message.type === 'collector:clear') {
        controller?.abort(); await running;
        state = { status: 'idle', rows: [], stats: {}, note: 'Результаты удалены с этого устройства для этой вкладки.' };
        await save(); return { state };
      }
      if (message.type === 'collector:start') {
        if (state.status === 'running') throw new Error('Сбор уже выполняется.');
        const context = DOM.locate();
        if (!context) throw new Error('Откройте чат или комментарии в Telegram Web K / A.');
        const raw = message.options || {};
        const options = { authors: Boolean(raw.authors), mentions: Boolean(raw.mentions),
          bots: Boolean(raw.bots), auto: Boolean(raw.auto), direction: raw.direction === 'down' ? 'down' : 'up',
          limit: Math.max(1, Math.min(10000, Math.trunc(Number(raw.limit) || 1000))) };
        if (!options.authors && !options.mentions) throw new Error('Выберите авторов или упоминания.');
        if (options.authors && context.client !== 'K') throw new Error('Для сбора авторов откройте Telegram Web K.');
        state = { status: 'running', rows: [], stats: {}, options, context: context.title,
          client: context.client, startedAt: new Date().toISOString(), note: 'Начинаю сбор…' };
        controller = new AbortController();
        running = collect(context, options, controller.signal);
        return { state };
      }
      throw new Error('Неизвестная команда.');
    })().then(reply).catch(error => reply({ error: error.message }));
    return true;
  });
})();
