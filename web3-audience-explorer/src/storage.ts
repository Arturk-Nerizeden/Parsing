import { fromSorsa, mergeAccount } from './model';
import type { Account, Collection, RawUser } from './types';

const DB_NAME = 'web3-audience-explorer';
const DB_VERSION = 1;
const req = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const completed = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error || new Error('Database transaction aborted.'));
  tx.onerror = () => reject(tx.error || new Error('Database transaction failed.'));
});
let opening: Promise<IDBDatabase> | undefined;
export function database(): Promise<IDBDatabase> {
  return opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('collections', { keyPath: 'id' });
      const accounts = db.createObjectStore('accounts', { keyPath: ['collectionId', 'identity'] });
      accounts.createIndex('byCollection', 'collectionId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other extension tabs and retry opening local storage.'));
  });
}

export async function putCollection(collection: Collection): Promise<void> {
  const db = await database();
  const tx = db.transaction('collections', 'readwrite');
  const done = completed(tx);
  tx.objectStore('collections').put({ ...collection, updatedAt: new Date().toISOString() });
  await done;
}

export async function getCollection(id: string): Promise<Collection | undefined> {
  const tx = (await database()).transaction('collections', 'readonly');
  return req(tx.objectStore('collections').get(id));
}

export async function listCollections(): Promise<Collection[]> {
  const tx = (await database()).transaction('collections', 'readonly');
  const rows = await req<Collection[]>(tx.objectStore('collections').getAll());
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listAccounts(collectionId: string): Promise<Account[]> {
  const tx = (await database()).transaction('accounts', 'readonly');
  return req<Account[]>(tx.objectStore('accounts').index('byCollection').getAll(collectionId));
}

export async function updateAccount(account: Account): Promise<void> {
  const tx = (await database()).transaction('accounts', 'readwrite');
  const done = completed(tx);
  tx.objectStore('accounts').put(account);
  await done;
}

// Accounts and cursor share one transaction. A reload can only resume before or
// after the page, never with a cursor that skipped unsaved accounts.
export async function applyPage(collection: Collection, users: RawUser[], nextCursor: string | null,
  fetched: boolean): Promise<Collection> {
  const tx = (await database()).transaction(['accounts', 'collections'], 'readwrite');
  const done = completed(tx);
  const accounts = tx.objectStore('accounts');
  const collections = tx.objectStore('collections');
  try {
    let total = collection.total;
    let index = 0;
    const seen = new Set<string>();
    for (; index < users.length; index++) {
      const user = users[index];
      if (!user) continue;
      const account = fromSorsa(user, collection.id, collection.mode);
      if (!account || seen.has(account.identity)) continue;
      seen.add(account.identity);
      const old = await req<Account | undefined>(accounts.get([collection.id, account.identity]));
      if (!old && total >= collection.limit) break;
      accounts.put(old ? mergeAccount(old, account) : account);
      if (!old) total++;
    }
    const next: Collection = { ...collection, total, nextCursor,
      pendingUsers: users.slice(index), hasFetched: collection.hasFetched || fetched,
      pages: collection.pages + (fetched ? 1 : 0), updatedAt: new Date().toISOString() };
    if (fetched && collection.nextCursor) next.seenCursors = [...collection.seenCursors, collection.nextCursor].slice(-100);
    next.status = total >= collection.limit && (next.pendingUsers.length > 0 || nextCursor !== null) ? 'limit'
      : next.pendingUsers.length === 0 && nextCursor === null ? 'complete' : 'running';
    collections.put(next);
    await done;
    return next;
  } catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
}

export async function importAccounts(collection: Collection, imported: Account[]): Promise<Collection> {
  const tx = (await database()).transaction(['accounts', 'collections'], 'readwrite');
  const done = completed(tx);
  const store = tx.objectStore('accounts');
  try {
    let total = 0;
    const seen = new Set<string>();
    for (const account of imported) {
      if (seen.has(account.identity)) continue;
      seen.add(account.identity);
      const old = await req<Account | undefined>(store.get([collection.id, account.identity]));
      store.put(old ? mergeAccount(old, account) : account);
      if (!old) total++;
    }
    const next = { ...collection, total, status: 'complete' as const, updatedAt: new Date().toISOString() };
    tx.objectStore('collections').put(next);
    await done;
    return next;
  } catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
}

export async function deleteCollection(id: string): Promise<void> {
  const tx = (await database()).transaction(['accounts', 'collections'], 'readwrite');
  const done = completed(tx);
  const accounts = tx.objectStore('accounts');
  const index = accounts.index('byCollection');
  await new Promise<void>((resolve, reject) => {
    const cursor = index.openKeyCursor(IDBKeyRange.only(id));
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return resolve();
      accounts.delete(row.primaryKey);
      row.continue();
    };
  });
  tx.objectStore('collections').delete(id);
  await done;
}
