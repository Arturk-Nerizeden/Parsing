/* Shared, dependency-free parsing and export. No Telegram state is accessed here. */
(function (root) {
  'use strict';
  const RESERVED = new Set(['joinchat', 'addstickers', 'addemoji', 'addtheme', 'addlist',
    'share', 'proxy', 'socks', 'login', 'confirmphone', 'setlanguage', 'invoice',
    'boost', 'giftcode', 'contact', 'iv', 'c', 's', 'a', 'k', 'm', 'nft', 'stars', 'bg']);
  function normalize(value) {
    if (typeof value !== 'string') return null;
    const name = value.trim().replace(/^@/, '');
    // Four-character collectible usernames are possible; display names are never guessed.
    return /^[a-z][a-z0-9_]{3,31}$/i.test(name) ? name.toLowerCase() : null;
  }
  function fromUrl(value) {
    if (typeof value !== 'string') return null;
    let url;
    try { url = new URL(/^(?:t\.me|telegram\.me|telegram\.dog)\//i.test(value) ? `https://${value}` : value); }
    catch { return null; }
    if (url.username || url.password || url.port) return null;
    let name;
    if (url.protocol === 'tg:' && url.hostname === 'resolve') {
      name = url.searchParams.get('domain');
    } else if (['http:', 'https:'].includes(url.protocol)
      && ['t.me', 'telegram.me', 'telegram.dog', 'www.t.me'].includes(url.hostname.toLowerCase())) {
      const parts = url.pathname.split('/').filter(Boolean);
      name = parts[0] === 's' ? parts[1] : parts[0];
    } else return null;
    const normalized = normalize(name);
    return normalized && !RESERVED.has(normalized) ? normalized : null;
  }
  function extract(text = '', hrefs = []) {
    const found = new Map();
    const add = (username, kind) => {
      if (username) found.set(`${kind}:${username}`, { username, kind });
    };
    // Do not turn email addresses or longer malformed handles into usernames.
    for (const match of text.matchAll(/(?<![\p{L}\p{N}_@/])@([a-z][a-z0-9_]{3,31})(?![\p{L}\p{N}_])/giu)) {
      add(normalize(match[1]), 'mention');
    }
    for (const href of hrefs) add(fromUrl(href), 'link');
    for (const match of text.matchAll(/(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/[^\s<>"']+|tg:\/\/resolve\?[^\s<>"']+/gi)) {
      if (match.index && /[\w.@/]/.test(text[match.index - 1])) continue;
      add(fromUrl(match[0].replace(/[),.;!?]+$/, '')), 'link');
    }
    return [...found.values()];
  }
  class Results {
    constructor() { this.rows = new Map(); this.occurrences = new Set(); }
    add(item, context, messageId) {
      const username = normalize(item.username);
      if (!username || !['author', 'mention', 'link'].includes(item.kind)) return;
      const key = `${username}|${item.kind}|${messageId}`;
      if (this.occurrences.has(key)) return;
      this.occurrences.add(key);
      let row = this.rows.get(username);
      if (!row) {
        if (this.rows.size >= 10000) return;
        row = { username, url: `https://t.me/${username}`, sources: [], peerIds: [],
          context, occurrences: 0, messageIds: [] };
        this.rows.set(username, row);
      }
      if (!row.sources.includes(item.kind)) row.sources.push(item.kind);
      if (item.peerId && !row.peerIds.includes(item.peerId)) row.peerIds.push(item.peerId);
      if (row.messageIds.length < 20 && !row.messageIds.includes(messageId)) row.messageIds.push(messageId);
      row.occurrences++;
    }
    list() { return [...this.rows.values()].sort((a, b) => a.username.localeCompare(b.username)); }
  }
  function safeCell(value) {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }
  function exportData(rows, format) {
    if (format === 'txt') return rows.map(r => `@${r.username}`).join('\n') + (rows.length ? '\n' : '');
    if (format === 'json') return JSON.stringify(rows, null, 2);
    if (format !== 'csv') throw new Error('Unknown export format');
    const columns = ['username', 'url', 'sources', 'peer_ids', 'context', 'occurrences', 'message_ids'];
    return '\uFEFF' + [columns.join(','), ...rows.map(r => [r.username, r.url, r.sources.join(';'),
      r.peerIds.join(';'), r.context, r.occurrences, r.messageIds.join(';')].map(safeCell).join(','))].join('\r\n');
  }
  const api = { normalize, fromUrl, extract, Results, exportData };
  root.TGCollectorCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
