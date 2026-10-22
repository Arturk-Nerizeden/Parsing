import type { Account, Collection, Mode, RawUser } from './types';

export function normalizeUsername(value: string): string {
  const username = value.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) throw new Error('Enter a valid X username (1–15 letters, digits, or underscores).');
  return username.toLowerCase();
}

export function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function optionalNumber(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

export function normalizeDate(value: unknown): string | null {
  const text = optionalText(value);
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

export function fromSorsa(user: RawUser, collectionId: string, mode: Mode): Account | null {
  const rawName = optionalText(user.username);
  if (!rawName) return null;
  let username: string;
  try { username = normalizeUsername(rawName); } catch { return null; }
  const id = typeof user.id === 'string' || typeof user.id === 'number' ? String(user.id) : null;
  return {
    collectionId,
    identity: id ? `id:${id}` : `username:${username}`,
    id,
    username,
    displayName: optionalText(user.display_name),
    followersCount: optionalNumber(user.followers_count),
    description: optionalText(user.description),
    score: null,
    scoreChecked: false,
    category: null,
    firstSeen: null,
    followedAt: mode === 'new7d' ? normalizeDate(user.followerDate) : null,
    tags: [],
    source: 'sorsa'
  };
}

export function mergeAccount(old: Account, next: Account): Account {
  return {
    ...old, ...next,
    displayName: next.displayName ?? old.displayName,
    followersCount: next.followersCount ?? old.followersCount,
    description: next.description ?? old.description,
    score: next.score ?? old.score,
    scoreChecked: next.scoreChecked || old.scoreChecked,
    category: next.category ?? old.category,
    firstSeen: next.firstSeen ?? old.firstSeen,
    followedAt: next.followedAt ?? old.followedAt,
    tags: [...new Set([...old.tags, ...next.tags])]
  };
}

export function createCollection(username: string, mode: Exclude<Mode, 'imported'>, limit: number): Collection {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), title: `@${username} · ${mode === 'followers' ? 'All followers' : 'New followers (7 days)'}`,
    username, mode, status: 'paused', createdAt: now, updatedAt: now, limit, total: 0, pages: 0, requests: 0,
    nextCursor: null, pendingUsers: [], hasFetched: false, seenCursors: [], error: null };
}

export interface Filters {
  minFollowers?: number | null;
  maxFollowers?: number | null;
  minScore?: number | null;
  maxScore?: number | null;
  tag?: string;
  keyword?: string;
}
export function filterAccounts(accounts: Account[], filters: Filters): Account[] {
  const tag = filters.tag?.trim().toLowerCase();
  const keyword = filters.keyword?.trim().toLowerCase();
  return accounts.filter(account => {
    if (filters.minFollowers != null && (account.followersCount == null || account.followersCount < filters.minFollowers)) return false;
    if (filters.maxFollowers != null && (account.followersCount == null || account.followersCount > filters.maxFollowers)) return false;
    if (filters.minScore != null && (account.score == null || account.score < filters.minScore)) return false;
    if (filters.maxScore != null && (account.score == null || account.score > filters.maxScore)) return false;
    if (tag && !account.tags.some(value => value.toLowerCase().includes(tag))) return false;
    if (keyword && ![account.username, account.displayName, account.description, account.category]
      .some(value => value?.toLowerCase().includes(keyword))) return false;
    return true;
  });
}
