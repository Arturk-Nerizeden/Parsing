import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { SorsaClient } from '../src/api';
import { collectFollowers } from '../src/collector';
import { createCollection } from '../src/model';
import * as store from '../src/storage';
import type { Collection } from '../src/types';

const user = (id: string, username: string) => ({ id, username, display_name: username, followers_count: 123 });
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });
const fakeClient = (pages: Record<string, unknown>, calls: string[]) => new SorsaClient('test-key', vi.fn(async (url: string) => {
  const parsed = new URL(url);
  const cursor = parsed.searchParams.get('next_cursor') || 'first';
  calls.push(`${parsed.pathname}?${parsed.searchParams.toString()}`);
  return json(pages[cursor]);
}) as typeof fetch, async () => {});

describe('documented follower endpoints and safe checkpoints', () => {
  it('paginates until no cursor, deduplicates stable IDs and saves the final cursor atomically', async () => {
    const calls: string[] = [];
    const client = fakeClient({
      first: { users: [user('1', 'alice'), user('2', 'bob')], next_cursor: 100 },
      100: { users: [user('2', 'bob'), user('3', 'carol')], next_cursor: 200 },
      200: { users: [user('4', 'david')], next_cursor: null }
    }, calls);
    const collection = createCollection('solana', 'followers', 10);
    const result = await collectFollowers(collection, client, store, new AbortController().signal);
    expect(result.status).toBe('complete');
    expect(result.total).toBe(4);
    expect(result.pages).toBe(3);
    expect(result.nextCursor).toBeNull();
    expect((await store.listAccounts(result.id)).map(a => a.username).sort()).toEqual(['alice', 'bob', 'carol', 'david']);
    expect((await store.getCollection(result.id))?.nextCursor).toBeNull();
    expect(calls).toEqual(['/v3/followers?username=solana', '/v3/followers?username=solana&next_cursor=100',
      '/v3/followers?username=solana&next_cursor=200']);
  });

  it('stops mid-page at the unique limit and resumes pending records before the next API request', async () => {
    const calls: string[] = [];
    const client = fakeClient({ first: { users: [user('1', 'alpha'), user('2', 'beta')], next_cursor: 200 },
      200: { users: [user('3', 'gamma')], next_cursor: null } }, calls);
    const collection = createCollection('xrp', 'followers', 1);
    const first = await collectFollowers(collection, client, store, new AbortController().signal);
    expect(first.status).toBe('limit');
    expect(first.total).toBe(1);
    expect(first.pendingUsers).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const second = await collectFollowers({ ...first, limit: 3 }, client, store, new AbortController().signal);
    expect(second.status).toBe('complete');
    expect(second.total).toBe(3);
    expect(second.pendingUsers).toHaveLength(0);
    expect(calls).toHaveLength(2);
  });

  it('refuses repeated cursors and leaves a recoverable checkpoint', async () => {
    const calls: string[] = [];
    const client = fakeClient({ first: { users: [user('1', 'alpha')], next_cursor: 9 },
      9: { users: [user('2', 'beta')], next_cursor: 9 } }, calls);
    const result = await collectFollowers(createCollection('asterium', 'followers', 10), client, store, new AbortController().signal);
    expect(result.status).toBe('error');
    expect(result.nextCursor).toBe('9');
    expect(result.total).toBe(1);
    expect((await store.listAccounts(result.id)).map(a => a.username)).toEqual(['alpha']);
  });

  it('calls new-followers-7d separately, without a cursor, and never invents first-seen or category', async () => {
    const calls: string[] = [];
    const client = fakeClient({ first: { users: [{ ...user('7', 'newuser'), followerDate: '2026-10-21T10:00:00Z' }] } }, calls);
    const result = await collectFollowers(createCollection('xrp', 'new7d', 100), client, store, new AbortController().signal);
    expect(result.status).toBe('complete');
    expect(calls).toEqual(['/v3/new-followers-7d?username=xrp']);
    const account = (await store.listAccounts(result.id))[0]!;
    expect(account.followedAt).toBe('2026-10-21T10:00:00Z');
    expect(account.firstSeen).toBeNull();
    expect(account.category).toBeNull();
    expect(account.score).toBeNull();
  });

  it('keeps the last saved page when stopped during the next HTTP call', async () => {
    const abort = new AbortController();
    let requests = 0;
    const client = new SorsaClient('test-key', vi.fn(async (_url: string, init?: RequestInit) => {
      requests++;
      if (requests === 1) return json({ users: [user('1', 'alpha')], next_cursor: 2 });
      abort.abort();
      throw init?.signal?.reason;
    }) as typeof fetch, async () => {});
    const result = await collectFollowers(createCollection('xrp', 'followers', 100), client, store, abort.signal);
    expect(result.status).toBe('paused');
    expect(result.total).toBe(1);
    expect(result.nextCursor).toBe('2');
    expect((await store.getCollection(result.id))?.nextCursor).toBe('2');
  });

  it('preserves int64 numeric cursor beyond JavaScript safe integers', async () => {
    const client = new SorsaClient('test-key', vi.fn(async () => new Response(
      '{"users":[],"next_cursor":9876543210123456789}', { status: 200 })) as typeof fetch);
    const page = await client.followers('xrp', null);
    expect(page.nextCursor).toBe('9876543210123456789');
  });
});
