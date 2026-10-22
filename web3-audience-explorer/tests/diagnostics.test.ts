import { describe, expect, it, vi } from 'vitest';
import { testConnection } from '../src/diagnostics';

describe('connection check', () => {
  it('treats an unauthenticated HTTP response as reachable and sends no key', async () => {
    const fetcher = vi.fn(async () => new Response('{"message":"missing key in request header"}', { status: 401 }));
    const result = await testConnection(fetcher as typeof fetch);
    expect(result.reachable).toBe(true);
    expect(result.message).toContain('HTTP 401');
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.sorsa.io/v3/key-usage-info');
    expect(init.headers).toBeUndefined();
    expect(init.credentials).toBe('omit');
  });

  it('reports a blocked extension request without exposing the browser error', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('secret browser detail'));
    const result = await testConnection(fetcher);
    expect(result.reachable).toBe(false);
    expect(result.message).not.toContain('secret browser detail');
  });
});
