const PROBE_URL = 'https://api.sorsa.io/v3/key-usage-info';

export type ConnectionResult = { reachable: boolean; message: string };

// A request without a key tests the extension's access to the actual API host.
// An HTTP error such as "missing key" is a successful connectivity result.
export async function testConnection(fetcher: typeof fetch = fetch): Promise<ConnectionResult> {
  try {
    const response = await fetcher(PROBE_URL, {
      method: 'GET', credentials: 'omit', redirect: 'error',
      referrerPolicy: 'no-referrer', cache: 'no-store', signal: AbortSignal.timeout(10_000)
    });
    await response.body?.cancel();
    return { reachable: true, message: `Sorsa replied HTTP ${response.status} to a request without a key. Extension access works. If Check quota still fails, the request with the ApiKey header is being blocked or redirected.` };
  } catch {
    return { reachable: false, message: 'The extension cannot reach api.sorsa.io even without a key. In chrome://extensions → Web3 Audience Explorer → Details, allow site access to api.sorsa.io, reload the extension, then retry. If access is already allowed, check VPN, proxy, or browser blockers.' };
  }
}
