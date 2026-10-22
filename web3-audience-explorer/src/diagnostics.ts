import { ApiError, SorsaClient } from './api';

const PROBE_URL = 'https://api.sorsa.io/v3/key-usage-info';

export type ConnectionResult = { reachable: boolean; severity: 'info' | 'warn' | 'error'; message: string };

const options = (): RequestInit => ({
  method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
  cache: 'no-store', signal: AbortSignal.timeout(10_000)
});

// The second request uses a fixed invalid value, never the user's stored key.
// HTTP 4xx means the request reached Sorsa; a rejected fetch means it did not.
export async function testConnection(fetcher: typeof fetch = fetch): Promise<ConnectionResult> {
  let status: number;
  try {
    const response = await fetcher(PROBE_URL, options());
    status = response.status;
    await response.text().catch(() => '');
  } catch {
    return { reachable: false, severity: 'error', message: 'The extension cannot reach api.sorsa.io even without a key. In chrome://extensions → Web3 Audience Explorer → Details, allow site access to api.sorsa.io, reload the extension, then retry. If access is already allowed, check VPN, proxy, or browser blockers.' };
  }
  try { await new SorsaClient('invalid-diagnostic-key', fetcher).usage(); }
  catch (error) {
    if (error instanceof ApiError && error.status !== null) {
      return { reachable: true, severity: 'info', message: `Sorsa replied HTTP ${status} without a key and HTTP ${error.status} with an invalid test key through the normal API client. The extension request path works; check the saved key value if Check quota fails.` };
    }
    return { reachable: true, severity: 'warn', message: `Sorsa replied HTTP ${status} without a key, but the normal API client could not get an HTTP response with a harmless test key. Your saved key was not used. The extension request settings or a browser rule are blocking this path.` };
  }
  return { reachable: true, severity: 'info', message: `Sorsa replied HTTP ${status} without a key and accepted the fixed test value. The extension request path works.` };
}
