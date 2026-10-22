import { describe, expect, it, vi } from 'vitest';
import { testConnection } from '../src/diagnostics';

describe('connection check', () => {
  it('checks no-key and fixed invalid-key requests without using a real key', async () => {
    const fetcher = vi.fn(async () => new Response('{"message":"missing key in request header"}', { status: 401 }));
    const result = await testConnection(fetcher as typeof fetch);
    expect(result.reachable).toBe(true);
    expect(result.message).toContain('HTTP 401 without a key and HTTP 401 with an invalid test key');
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.sorsa.io/v3/key-usage-info');
    expect(init.headers).toBeUndefined();
    expect(init.credentials).toBe('omit');
    expect((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toEqual({ ApiKey: 'invalid-diagnostic-key' });
  });

  it('reports a blocked extension request without exposing the browser error', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('secret browser detail'));
    const result = await testConnection(fetcher);
    expect(result.reachable).toBe(false);
    expect(result.message).not.toContain('secret browser detail');
  });

  it('distinguishes a blocked ApiKey header from general connectivity', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const result = await testConnection(fetcher);
    expect(result.reachable).toBe(true);
    expect(result.message).toContain('test ApiKey header failed');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
