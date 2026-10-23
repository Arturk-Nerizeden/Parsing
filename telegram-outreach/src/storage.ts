import type { LocalState, SessionCredentials } from './types';

const STATE_KEY = 'telegramOutreach.v1';
const SESSION_KEY = 'telegramOutreach.session';
export async function loadState(): Promise<LocalState> {
  const saved = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] as LocalState | undefined;
  if (!saved) return { version: 1, campaigns: [], selectedId: null, suppressed: [] };
  if (saved.version !== 1 || !Array.isArray(saved.campaigns) || !Array.isArray(saved.suppressed)) {
    throw new Error('Не удалось прочитать локальные данные. Сохранённые данные не перезаписаны.');
  }
  return saved;
}
export async function saveState(state: LocalState): Promise<void> {
  try { await chrome.storage.local.set({ [STATE_KEY]: state }); }
  catch { throw new Error('Не удалось сохранить очередь. Возможно, закончилось место. Экспортируйте и удалите старые очереди перед продолжением.'); }
}
export async function loadSession(): Promise<SessionCredentials | null> {
  const saved = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] as SessionCredentials | undefined;
  return saved && typeof saved.session === 'string' && typeof saved.apiHash === 'string' && Number.isSafeInteger(saved.apiId) ? saved : null;
}
export async function saveSession(credentials: SessionCredentials): Promise<void> {
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.set({ [SESSION_KEY]: credentials });
}
export async function clearSession(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
}
