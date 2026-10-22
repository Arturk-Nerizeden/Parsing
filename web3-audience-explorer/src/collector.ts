import { ApiError, SorsaClient } from './api';
import type { Account, Collection, RawUser } from './types';

export interface Repository {
  putCollection(collection: Collection): Promise<void>;
  applyPage(collection: Collection, users: RawUser[], nextCursor: string | null, fetched: boolean): Promise<Collection>;
  listAccounts(collectionId: string): Promise<Account[]>;
  updateAccount(account: Account): Promise<void>;
}

export type Progress = (collection: Collection) => void;
const isAbort = (error: unknown, signal: AbortSignal) => signal.aborted || (error instanceof DOMException && error.name === 'AbortError');

export async function collectFollowers(collection: Collection, client: SorsaClient, repository: Repository,
  signal: AbortSignal, progress: Progress = () => {}): Promise<Collection> {
  if (collection.mode === 'imported') throw new Error('Imported collections cannot fetch Sorsa followers.');
  let current: Collection = { ...collection, status: 'running', error: null };
  let accountedAttempts = client.attempts;
  await repository.putCollection(current);
  progress(current);
  try {
    while (!signal.aborted) {
      if (current.total >= current.limit) {
        current = { ...current, status: current.pendingUsers.length || current.nextCursor !== null ? 'limit' : 'complete' };
        break;
      }
      if (current.pendingUsers.length) {
        current = await repository.applyPage(current, current.pendingUsers, current.nextCursor, false);
      } else if (current.hasFetched && current.nextCursor === null) {
        current = { ...current, status: 'complete' }; break;
      } else {
        const requested = current.nextCursor;
        const page = current.mode === 'followers'
          ? await client.followers(current.username!, requested, signal)
          : await client.newFollowers(current.username!, signal);
        current = { ...current, requests: current.requests + client.attempts - accountedAttempts };
        accountedAttempts = client.attempts;
        if (signal.aborted) break;
        if (page.nextCursor && (page.nextCursor === requested || current.seenCursors.includes(page.nextCursor))) {
          throw new ApiError('Sorsa repeated a pagination cursor. Collection paused to prevent a loop.', null);
        }
        current = await repository.applyPage(current, page.users, page.nextCursor, true);
      }
      progress(current);
      if (current.status === 'limit' || current.status === 'complete') break;
    }
    if (signal.aborted) current = { ...current, status: 'paused', error: null };
  } catch (error) {
    current = { ...current, requests: current.requests + client.attempts - accountedAttempts };
    current = isAbort(error, signal) ? { ...current, status: 'paused', error: null }
      : { ...current, status: 'error', error: error instanceof Error ? error.message : 'Unexpected collection error.' };
  }
  await repository.putCollection(current);
  progress(current);
  return current;
}

export async function enrichScores(collection: Collection, client: SorsaClient, repository: Repository,
  maxRequests: number, signal: AbortSignal, progress: Progress = () => {}): Promise<Collection> {
  const rows = (await repository.listAccounts(collection.id)).filter(row => !row.scoreChecked).slice(0, maxRequests);
  let current: Collection = { ...collection, status: 'running', error: null };
  let accountedAttempts = client.attempts;
  await repository.putCollection(current);
  progress(current);
  try {
    for (const row of rows) {
      if (signal.aborted) break;
      try {
        const score = await client.score(row.username, signal);
        current = { ...current, requests: current.requests + client.attempts - accountedAttempts };
        accountedAttempts = client.attempts;
        await repository.updateAccount({ ...row, score, scoreChecked: true });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          current = { ...current, requests: current.requests + client.attempts - accountedAttempts };
          accountedAttempts = client.attempts;
          await repository.updateAccount({ ...row, score: null, scoreChecked: true });
        } else throw error;
      }
      progress(current);
    }
    current = { ...current, status: collection.status === 'complete' || collection.status === 'limit' ? collection.status : 'paused' };
  } catch (error) {
    current = { ...current, requests: current.requests + client.attempts - accountedAttempts };
    current = isAbort(error, signal) ? { ...current, status: 'paused' }
      : { ...current, status: 'error', error: error instanceof Error ? error.message : 'Score lookup failed.' };
  }
  await repository.putCollection(current);
  progress(current);
  return current;
}
