const PROBE_URL = 'https://api.sorsa.io/v3/key-usage-info';

export type ConnectionResult = { reachable: boolean; severity: 'info' | 'warn' | 'error'; message: string };

const options = (headers?: HeadersInit): RequestInit => ({
  method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
  cache: 'no-store', signal: AbortSignal.timeout(10_000), headers
});

// The second request uses a fixed invalid value, never the user's stored key.
// HTTP 4xx means the request reached Sorsa; a rejected fetch means it did not.
export async function testConnection(fetcher: typeof fetch = fetch): Promise<ConnectionResult> {
  let status: number;
  try {
    const response = await fetcher(PROBE_URL, options());
    status = response.status;
    await response.body?.cancel();
  } catch {
    return { reachable: false, severity: 'error', message: 'The extension cannot reach api.sorsa.io even without a key. In chrome://extensions → Web3 Audience Explorer → Details, allow site access to api.sorsa.io, reload the extension, then retry. If access is already allowed, check VPN, proxy, or browser blockers.' };
  }
  try {
    const response = await fetcher(PROBE_URL, options({ ApiKey: 'invalid-diagnostic-key' }));
    const keyedStatus = response.status;
    await response.body?.cancel();
    return { reachable: true, severity: 'info', message: `Sorsa replied HTTP ${status} without a key and HTTP ${keyedStatus} with an invalid test key. The ApiKey header reaches Sorsa. If your real key still causes a network error, check that you pasted a single-line Sorsa key rather than a URL.` };
  } catch {
    return { reachable: true, severity: 'warn', message: `Sorsa replied HTTP ${status} without a key, but the request with a harmless test ApiKey header failed before any HTTP response. Your key was not used. A browser rule, proxy, redirect, or Sorsa's handling of this header may be blocking the request.` };
  }
}
