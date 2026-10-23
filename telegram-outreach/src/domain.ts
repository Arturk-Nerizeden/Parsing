import type { Campaign, Contact } from './types';

export const MAX_CONTACTS = 1000;
export const MAX_MESSAGE_LENGTH = 4096;

const USERNAME = /^[a-z][a-z0-9_]{0,31}$/i;
const NON_USER_LINKS = new Set([
  'addemoji', 'addlist', 'addstickers', 'bg', 'boost', 'c', 'confirmphone',
  'contact', 'giftcode', 'invoice', 'iv', 'joinchat', 'login', 'm', 'proxy',
  's', 'setlanguage', 'share', 'socks',
]);

/** Store usernames without @, lowercased for case-insensitive Telegram identity. */
export function normalizeUsername(input: string): string {
  let value = input.trim();
  if (/^(?:https?:\/\/|(?:www\.)?(?:t\.me|telegram\.me)\/)/i.test(value)) {
    const link = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me'].includes(link.hostname.toLowerCase())
      || link.username || link.password || link.port || link.search || link.hash) {
      throw new Error(`Invalid Telegram username: ${input}`);
    }
    const path = link.pathname.replace(/^\//, '').replace(/\/$/, '');
    if (NON_USER_LINKS.has(path.toLowerCase())) {
      throw new Error(`Telegram link does not identify a user: ${input}`);
    }
    value = path;
  } else if (value.startsWith('@')) {
    value = value.slice(1);
  }
  // Collectible Telegram usernames can be shorter than five characters. Actual
  // existence and whether the peer is a user are checked by the Telegram gateway.
  if (!USERNAME.test(value)) throw new Error(`Invalid Telegram username: ${input}`);
  return value.toLowerCase();
}

/** RFC 4180 records, also accepting LF line endings commonly produced by tools. */
function readCSV(input: string): string[][] {
  const source = input.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  const finishField = () => { row.push(field); field = ''; closedQuote = false; };
  const finishRecord = () => { finishField(); records.push(row); row = []; };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; }
        else { quoted = false; closedQuote = true; }
      } else field += character;
      continue;
    }
    if (character === ',') { finishField(); continue; }
    if (character === '\r' || character === '\n') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      finishRecord();
      continue;
    }
    if (closedQuote) throw new Error('Malformed CSV: unexpected text after a closing quote.');
    if (character === '"') {
      if (field) throw new Error('Malformed CSV: quote inside an unquoted field.');
      quoted = true;
    } else field += character;
  }
  if (quoted) throw new Error('Malformed CSV: unclosed quoted field.');
  if (field || row.length || closedQuote) finishRecord();
  return records;
}

export interface ParsedContacts {
  contacts: Contact[];
  duplicates: number;
  invalid: string[];
}

/** Invalid entries are reported, never silently dropped; malformed CSV throws. */
export function parseContacts(text: string, format: 'text' | 'csv' = 'text'): ParsedContacts {
  let entries: { username: string; firstName: string; source: string; tags?: string[] }[];
  if (format === 'csv') {
    const records = readCSV(text).filter((record) => record.some((value) => value.trim()));
    if (!records.length) return { contacts: [], duplicates: 0, invalid: [] };
    const headers = records[0]!.map((header) => header.trim().toLowerCase());
    const usernameColumns = headers.flatMap((header, index) =>
      ['username', 'telegram', 'telegram_username'].includes(header) ? [index] : []);
    if (usernameColumns.length !== 1) {
      throw new Error('CSV must have exactly one username, telegram, or telegram_username column.');
    }
    const usernameColumn = usernameColumns[0]!;
    const firstNameColumn = ['first_name', 'display_name', 'name']
      .map((alias) => headers.indexOf(alias)).find((index) => index >= 0) ?? -1;
    const tagsColumn = headers.indexOf('tags');
    entries = records.slice(1).map((record, index) => {
      if (record.length !== headers.length) {
        throw new Error(`Malformed CSV: row ${index + 2} has ${record.length} columns; expected ${headers.length}.`);
      }
      const username = record[usernameColumn]!.trim();
      return {
        username,
        firstName: firstNameColumn >= 0 ? record[firstNameColumn]!.trim() : '',
        tags: tagsColumn >= 0 ? [...new Set(record[tagsColumn]!.split(/[,;|]/u).map(tag => tag.trim()).filter(Boolean))] : undefined,
        source: username || `CSV row ${index + 2}: missing username`,
      };
    });
  } else {
    entries = text.replace(/^\uFEFF/, '').split(/[\s,;]+/u).filter(Boolean)
      .map((username) => ({ username, firstName: '', source: username }));
  }
  if (entries.length > MAX_CONTACTS) throw new Error(`A campaign supports at most ${MAX_CONTACTS} contact entries.`);
  const result: ParsedContacts = { contacts: [], duplicates: 0, invalid: [] };
  const seen = new Set<string>();
  for (const entry of entries) {
    let username: string;
    try { username = normalizeUsername(entry.username); }
    catch { result.invalid.push(entry.source); continue; }
    if (seen.has(username)) { result.duplicates += 1; continue; }
    seen.add(username);
    result.contacts.push({ username, firstName: entry.firstName, ...(entry.tags?.length ? { tags: entry.tags } : {}) });
  }
  return result;
}

/** {{username}} and a missing {{first_name}} both render the public @handle. */
export function renderMessage(template: string, contact: Contact): string {
  const unsupported = template.replace(/{{username}}|{{first_name}}/g, '');
  if (unsupported.includes('{{') || unsupported.includes('}}')) {
    throw new Error('Only {{username}} and {{first_name}} placeholders are supported.');
  }
  const username = `@${normalizeUsername(contact.username)}`;
  const firstName = contact.firstName.trim() || username;
  // A function replacement preserves literal $ sequences in user-provided names.
  const message = template.replace(/{{username}}|{{first_name}}/g,
    (token) => token === '{{username}}' ? username : firstName);
  if (!message.trim()) throw new Error('Message must not be empty.');
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Message exceeds ${MAX_MESSAGE_LENGTH} UTF-16 code units.`);
  }
  return message;
}

/** Telegram uses a signed 64-bit random_id to deduplicate retries of a send. */
function randomMessageId(used: Set<string>): string {
  let value: string;
  do {
    const words = crypto.getRandomValues(new Uint32Array(2));
    value = BigInt.asIntN(64, (BigInt(words[0]!) << 32n) | BigInt(words[1]!)).toString();
  } while (value === '0' || used.has(value));
  used.add(value);
  return value;
}

export function createCampaign(contacts: Contact[], template: string, intervalSeconds: number): Campaign {
  if (!contacts.length || contacts.length > MAX_CONTACTS) {
    throw new Error(`Select between 1 and ${MAX_CONTACTS} contacts.`);
  }
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 3600) {
    throw new Error('The interval must be between 1 and 3600 seconds.');
  }
  const seen = new Set<string>();
  const normalized = contacts.map((contact) => {
    const username = normalizeUsername(contact.username);
    if (seen.has(username)) throw new Error(`Duplicate contact: @${username}`);
    seen.add(username);
    const result = { username, firstName: contact.firstName.trim(), ...(contact.tags?.length ? { tags: [...new Set(contact.tags)] } : {}) };
    renderMessage(template, result);
    return result;
  });
  const createdAt = new Date().toISOString();
  const usedRandomIds = new Set<string>();
  return {
    id: crypto.randomUUID(),
    title: `Рассылка ${createdAt.slice(0, 10)}`,
    template,
    createdAt,
    updatedAt: createdAt,
    senderId: null,
    status: 'draft',
    intervalSeconds,
    waitUntil: null,
    notice: '',
    recipients: normalized.map((contact) => ({
      ...contact, id: crypto.randomUUID(), randomId: randomMessageId(usedRandomIds), status: 'pending',
    })),
  };
}

function csvCell(value: string): string {
  // Quoting alone does not stop spreadsheet formula execution. Prefix cells
  // beginning with formula operators (even after whitespace) or control chars.
  const safe = /^[\t\r\n]|^\s*[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** UTF-8 BOM + CRLF CSV suitable for spreadsheet import. */
export function exportCampaignCSV(campaign: Campaign): string {
  const rows: string[][] = [['username', 'first_name', 'tags', 'status', 'error', 'message_id', 'sent_at', 'message']];
  for (const recipient of campaign.recipients) {
    rows.push([
      recipient.username, recipient.firstName, recipient.tags?.join(', ') ?? '', recipient.status, recipient.error ?? '',
      recipient.messageId ?? '', recipient.sentAt ?? '', recipient.text ?? renderMessage(campaign.template, recipient),
    ]);
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
