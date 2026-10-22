/* Runs in the page world. Only reads cached authors for messages present in the DOM.
   There is deliberately no arbitrary method dispatch or access to authentication storage. */
(() => {
  'use strict';
  const REQUEST = 'tg-username-collector:request:v1';
  const RESPONSE = 'tg-username-collector:response:v1';
  const numeric = value => typeof value === 'string' && /^-?\d{1,20}$/.test(value);
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.type !== REQUEST || typeof data.id !== 'string' || data.id.length > 80) return;
    const proxy = window.apiManagerProxy;
    const available = location.pathname.startsWith('/k/')
      && typeof proxy?.getMessageByPeer === 'function' && typeof proxy?.getPeer === 'function';
    const chat = window.appImManager?.chat;
    const response = { type: RESPONSE, id: data.id, available,
      account: String(window.rootScope?.myId || ''),
      scope: chat ? `${chat.peerId || ''}:${chat.threadId || ''}:${chat.monoforumThreadId || ''}:${chat.type || ''}` : '',
      authors: [] };
    if (available && Array.isArray(data.messages)) {
      const rendered = new Set([...document.querySelectorAll('.bubbles .bubble[data-mid][data-peer-id]')]
        .filter(el => !el.closest('.bubbles-remover'))
        .map(el => `${el.dataset.peerId}:${el.dataset.mid}`));
      for (const item of data.messages.slice(0, 500)) {
        if (!item || !numeric(item.peerId) || !numeric(item.mid)
          || !rendered.has(`${item.peerId}:${item.mid}`)) continue;
        const result = { key: `${item.peerId}:${item.mid}`, status: 'unresolved' };
        try {
          const message = proxy.getMessageByPeer(Number(item.peerId), Number(item.mid));
          const fromId = message?.fromId ?? message?.from_id?.user_id;
          if (fromId && Number(fromId) < 0) result.status = 'non-user';
          else if (fromId && Number(fromId) > 0) {
            result.peerId = String(fromId);
            const user = proxy.getPeer(Number(fromId));
            if (user?._ === 'user' && !user.pFlags?.deleted) {
              const usernames = Array.isArray(user.usernames)
                ? user.usernames.filter(u => u.pFlags?.active).map(u => u.username)
                : [user.username];
              result.usernames = [...new Set(usernames.filter(u => typeof u === 'string'
                && /^[a-z][a-z0-9_]{3,31}$/i.test(u)))].slice(0, 30);
              result.isBot = Boolean(user.pFlags?.bot);
              result.status = result.usernames.length ? 'found' : 'no-username';
            }
          }
        } catch { /* Unknown client shape is reported as unresolved, never as success. */ }
        response.authors.push(result);
      }
    }
    window.postMessage(response, location.origin);
  });
})();
