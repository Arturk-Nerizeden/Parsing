import { describe, expect, it, vi } from 'vitest';
import { ApiError, SorsaClient } from '../src/api';

const response = (status: number, data: unknown = {}, headers?: HeadersInit) => new Response(JSON.stringify(data), { status, headers });
describe('Sorsa requests and errors', () => {
  it('rejects an endpoint URL or malformed header value before making a request', () => {
    expect(() => new SorsaClient('https://api.sorsa.io/v3/followers')).toThrow(/endpoint URL/);
    expect(() => new SorsaClient('part-one\npart-two')).toThrow(/cannot be sent as an HTTP header/);
  });
  it('sends the key only to the fixed Sorsa host in the ApiKey header, without cookies or redirect forwarding', async () => {
    const fetcher = vi.fn(async () => response(200, { users: [], next_cursor: null }));
    await new SorsaClient('private-test-key', fetcher as typeof fetch).followers('solana', null);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.sorsa.io/v3/followers?username=solana');
    expect(init.headers).toEqual({ ApiKey: 'private-test-key' });
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
    expect(url).not.toContain('private-test-key');
  });
  it('reports a redirect without forwarding the key', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://other.example/' } }));
    await expect(new SorsaClient('key', fetcher as typeof fetch).usage()).rejects.toThrow(/redirected/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('error');
  });
  it('honors Retry-After on 429 and retries at most twice', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(429, {}, { 'Retry-After': '3' }))
      .mockResolvedValueOnce(response(429, {}, { 'Retry-After': '3' }))
      .mockResolvedValueOnce(response(200, { users: [], next_cursor: null }));
    const delays: number[] = [];
    const client = new SorsaClient('key', fetcher, async ms => { delays.push(ms); });
    await client.followers('xrp', null);
    expect(delays).toEqual([3000, 3000]);
    expect(client.attempts).toBe(3);
  });
  it.each([401, 403])('does not retry %i and gives an actionable error without echoing credentials', async status => {
    const fetcher = vi.fn().mockResolvedValue(response(status, { message: 'private-test-key' }));
    const client = new SorsaClient('private-test-key', fetcher);
    await expect(client.followers('xrp', null)).rejects.toMatchObject({ status });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await client.followers('xrp', null).catch(error => expect((error as ApiError).message).not.toContain('private-test-key'));
  });
  it('retries network failures twice and reports a pause without leaking the key', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('private-test-key leaked by upstream'));
    const client = new SorsaClient('private-test-key', fetcher, async () => {});
    await expect(client.followers('xrp', null)).rejects.toThrow(/before an HTTP response/);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('treats a quota response as a snapshot, preserving only documented values', async () => {
    const client = new SorsaClient('key', vi.fn().mockResolvedValue(response(200, {
      key_requests: 4, remaining_requests: 96, total_requests: 100, valid_until: '2026-12-01T00:00:00Z'
    })));
    expect((await client.usage()).remaining_requests).toBe(96);
  });
});
