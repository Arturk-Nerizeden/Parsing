import type { RawUser, Usage } from './types';

const BASE = 'https://api.sorsa.io/v3/';
export type Fetcher = typeof fetch;
export type Sleeper = (ms: number, signal?: AbortSignal) => Promise<void>;

export class ApiError extends Error {
  constructor(message: string, public readonly status: number | null, public readonly retryAfter: number | null = null) {
    super(message);
    this.name = 'ApiError';
  }
}

export const sleep: Sleeper = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal?.reason); };
  signal?.addEventListener('abort', abort, { once: true });
});

export function retryDelay(header: string | null, attempt: number): number {
  const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : null;
  const date = header && seconds === null ? Date.parse(header) : NaN;
  const milliseconds = seconds !== null ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : 1000 * 2 ** attempt;
  return Math.max(1000, Math.min(60_000, milliseconds));
}

export function parseUsersResponse(body: unknown, endpoint: 'followers' | 'new7d'):
  { users: RawUser[]; nextCursor: string | null } {
  if (!body || typeof body !== 'object' || !('users' in body) || !Array.isArray(body.users)) {
    throw new ApiError('Sorsa returned an unexpected response shape. No cursor was advanced.', null);
  }
  const cursor = 'next_cursor' in body ? body.next_cursor : null;
  if (endpoint === 'new7d') return { users: body.users as RawUser[], nextCursor: null };
  if (cursor !== null && cursor !== undefined && cursor !== '' && !/^\d+$/.test(String(cursor))) {
    throw new ApiError('Sorsa returned an invalid pagination cursor. No cursor was advanced.', null);
  }
  return { users: body.users as RawUser[], nextCursor: cursor === null || cursor === undefined || cursor === '' ? null : String(cursor) };
}

function errorForStatus(status: number): string {
  if (status === 401) return '401: API key rejected. Enter a valid Sorsa key.';
  if (status === 403) return '403: This key or plan cannot access this endpoint, or quota is exhausted. Check Sorsa usage.';
  if (status === 429) return '429: Sorsa rate limit persisted after retries. Collection paused; try Resume later.';
  if (status === 400) return '400: Sorsa rejected the request parameters.';
  if (status === 404) return '404: Account or endpoint not found.';
  if (status >= 500) return `${status}: Sorsa server error after retries. Collection paused.`;
  return `${status}: Sorsa request failed. Collection paused.`;
}

export class SorsaClient {
  attempts = 0;
  constructor(private readonly key: string, private readonly fetcher: Fetcher = fetch,
    private readonly sleeper: Sleeper = sleep, private readonly onAttempt?: () => Promise<void>) {
    if (!key.trim()) throw new Error('Enter your Sorsa API key.');
    if (/^https?:\/\//i.test(key.trim())) throw new Error('This looks like an endpoint URL. Paste your Sorsa API key instead.');
    try { new Headers({ ApiKey: key }); }
    catch { throw new Error('The API key cannot be sent as an HTTP header. Paste a single-line Sorsa key without extra characters.'); }
  }

  private async get(endpoint: 'followers' | 'new-followers-7d' | 'score' | 'key-usage-info',
    params: Record<string, string> = {}, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(endpoint, BASE);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) throw signal.reason;
      await this.onAttempt?.();
      this.attempts++;
      let response: Response;
      try {
        response = await this.fetcher(url.toString(), {
          method: 'GET', headers: { ApiKey: this.key, Accept: 'application/json' },
          credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (attempt < 2) { await this.sleeper(1000 * 2 ** attempt, signal); continue; }
        throw new ApiError('Network error reaching api.sorsa.io. Check connection and extension host permission; collection is paused.', null);
      }
      if (response.ok) {
        try {
          const text = await response.text();
          const body: unknown = JSON.parse(text);
          if (endpoint === 'followers' && body && typeof body === 'object') {
            // OpenAPI declares int64: preserve a cursor beyond JS safe integer range.
            const exact = text.match(/"next_cursor"\s*:\s*(-?\d+)(?=\s*[,}])/);
            if (exact) (body as Record<string, unknown>).next_cursor = exact[1];
          }
          return body;
        }
        catch { throw new ApiError('Sorsa returned invalid JSON. No cursor was advanced.', response.status); }
      }
      const retryAfter = response.status === 429 ? retryDelay(response.headers.get('Retry-After'), attempt) : null;
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await this.sleeper(retryAfter ?? 1000 * 2 ** attempt, signal);
        continue;
      }
      throw new ApiError(errorForStatus(response.status), response.status, retryAfter);
    }
    throw new ApiError('Sorsa request failed.', null);
  }

  async followers(username: string, cursor: string | null, signal?: AbortSignal) {
    return parseUsersResponse(await this.get('followers', cursor ? { username, next_cursor: cursor } : { username }, signal), 'followers');
  }

  async newFollowers(username: string, signal?: AbortSignal) {
    return parseUsersResponse(await this.get('new-followers-7d', { username }, signal), 'new7d');
  }

  async score(username: string, signal?: AbortSignal): Promise<number | null> {
    const body = await this.get('score', { username }, signal);
    if (!body || typeof body !== 'object' || !('score' in body) || typeof body.score !== 'number' || !Number.isFinite(body.score)) {
      throw new ApiError('Sorsa returned an invalid score response.', null);
    }
    return body.score;
  }

  async usage(signal?: AbortSignal): Promise<Usage> {
    const body = await this.get('key-usage-info', {}, signal);
    if (!body || typeof body !== 'object') throw new ApiError('Sorsa returned an invalid quota response.', null);
    const b = body as Record<string, unknown>;
    const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    return { key_requests: count(b.key_requests), remaining_requests: count(b.remaining_requests),
      total_requests: count(b.total_requests), valid_until: typeof b.valid_until === 'string' ? b.valid_until : null };
  }
}
