(() => {
  'use strict';
  const visible = el => Boolean(el?.isConnected && el.getClientRects().length
    && getComputedStyle(el).visibility !== 'hidden'
    && !el.closest('[aria-hidden="true"], .bubbles-remover, .bubbles-remover-container'));
  const lastVisible = nodes => [...nodes].filter(visible).at(-1);
  function locate() {
    const client = location.pathname.startsWith('/k/') ? 'K' : location.pathname.startsWith('/a/') ? 'A' : null;
    if (!client) return null;
    let root;
    if (client === 'K') {
      root = lastVisible(document.querySelectorAll('.chat.active .bubbles'))
        || lastVisible(document.querySelectorAll('.chat .bubbles'));
    } else {
      root = lastVisible(document.querySelectorAll('#MiddleColumn .Transition_slide-active > .MessageList'))
        || lastVisible(document.querySelectorAll('#MiddleColumn .MessageList'));
    }
    if (!root) return null;
    const container = client === 'K' ? root.closest('.chat') : document.querySelector('#MiddleColumn');
    const title = (container?.querySelector(client === 'K'
      ? '.chat-info .peer-title, .topbar .peer-title' : '.ChatInfo .title, .MiddleHeader .title')?.textContent || 'Открытый чат').trim();
    const first = root.querySelector('.bubble[data-peer-id]');
    const peerId = first?.dataset.peerId || '';
    const scroll = client === 'K' ? root.querySelector('.scrollable-y') : root;
    return { root, client, title, peerId, scroll,
      token: `${location.pathname}${location.search}${location.hash}|${peerId}|${container?.dataset.type || ''}|${title}` };
  }
  function messages(context) {
    const selector = context.client === 'K' ? '.bubble[data-mid][data-peer-id]' : '.Message[data-message-id]';
    return [...context.root.querySelectorAll(selector)]
      .filter(el => visible(el) && !el.closest('.bubbles-remover'))
      .map(el => {
        const mid = context.client === 'K' ? el.dataset.mid : el.dataset.messageId;
        const peerId = el.dataset.peerId || context.peerId;
        const body = el.querySelector(context.client === 'K' ? '.message' : '.text-content');
        const clone = body?.cloneNode(true);
        clone?.querySelectorAll('.reply, .reply-message, .reply-wrapper, .message-title, .time, .MessageMeta, .reactions, .webpage').forEach(node => node.remove());
        return { mid, peerId, key: `${peerId}:${mid}`, text: clone?.textContent || '',
          hrefs: clone ? [...clone.querySelectorAll('a[href]')].map(a => a.getAttribute('href')) : [] };
      });
  }
  globalThis.TGCollectorDOM = { locate, messages };
})();
