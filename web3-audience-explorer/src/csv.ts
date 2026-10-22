import { normalizeUsername, optionalNumber, optionalText, normalizeDate } from './model';
import type { Account } from './types';

export const COLUMNS = ['username', 'x_url', 'display_name', 'followers_count', 'sorsa_score',
  'category', 'first_seen', 'followed_at', 'tags', 'description', 'source', 'account_id'] as const;
function cell(value: unknown): string {
  let text = value == null ? '' : String(value);
  // Text cells cannot become formulas in Excel or Google Sheets.
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function csvText(accounts: Account[]): string {
  const rows = accounts.map(a => [a.username, `https://x.com/${a.username}`, a.displayName,
    a.followersCount, a.score, a.category, a.firstSeen, a.followedAt,
    a.tags.join(';'), a.description, a.source, a.id].map(cell).join(','));
  return '\uFEFF' + [COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}

// RFC 4180-style quoted fields, doubled quotes, CRLF and multiline fields.
export function parseCSV(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted) quoted = false;
      else if (field === '') quoted = true;
      else throw new Error('Malformed CSV: quote inside an unquoted field.');
    } else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\r' || char === '\n') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field); if (row.some(value => value !== '')) rows.push(row);
      row = []; field = '';
    } else field += char;
  }
  if (quoted) throw new Error('Malformed CSV: unclosed quoted field.');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function importCSV(text: string, collectionId: string): Account[] {
  const rows = parseCSV(text);
  const headers = rows.shift()?.map(value => value.trim().toLowerCase());
  if (!headers?.includes('username')) throw new Error('CSV must include a username column.');
  if (rows.length > 50_000) throw new Error('CSV import limit is 50,000 rows.');
  const result: Account[] = [];
  for (const row of rows) {
    const get = (name: string) => row[headers.indexOf(name)] || '';
    let username: string;
    try { username = normalizeUsername(get('username')); } catch { continue; }
    const id = optionalText(get('account_id'));
    const scoreText = get('sorsa_score');
    const score = scoreText.trim() === '' ? null : optionalNumber(scoreText);
    result.push({ collectionId, identity: id ? `id:${id}` : `username:${username}`, id, username,
      displayName: optionalText(get('display_name')),
      followersCount: optionalNumber(get('followers_count')), score,
      scoreChecked: score !== null,
      category: optionalText(get('category')),
      firstSeen: normalizeDate(get('first_seen')),
      followedAt: normalizeDate(get('followed_at')),
      tags: [...new Set(get('tags').split(/[;,]/).map(value => value.trim()).filter(Boolean))].slice(0, 30),
      description: optionalText(get('description')), source: 'import' });
  }
  return result;
}
