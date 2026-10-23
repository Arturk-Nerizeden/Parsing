const NAME = 'TelegramOutreachImages';
const STORE = 'photos';
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Не удалось открыть локальное хранилище картинок.'));
  });
}

function complete(db: IDBDatabase, id: string, mode: IDBTransactionMode, value?: Blob): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const request = mode === 'readonly' ? store.get(id) : value ? store.put(value, id) : store.delete(id);
    let result: Blob | null = null;
    request.onsuccess = () => { if (mode === 'readonly') result = request.result instanceof Blob ? request.result : null; };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(new Error('Не удалось сохранить картинку. Проверьте свободное место.')); };
    tx.onabort = () => { db.close(); reject(new Error('Не удалось сохранить картинку. Проверьте свободное место.')); };
  });
}

export async function readPhoto(id: string): Promise<Blob | null> {
  const db = await database();
  return complete(db, id, 'readonly');
}
export async function savePhoto(id: string, blob: Blob): Promise<void> {
  const db = await database();
  await complete(db, id, 'readwrite', blob);
}
export async function deletePhoto(id: string): Promise<void> {
  const db = await database();
  await complete(db, id, 'readwrite');
}

/** Only JPEG and PNG photo payloads; file extension and browser MIME are not trusted. */
export async function checkedPhoto(file: File): Promise<Blob> {
  if (!file.size || file.size > MAX_PHOTO_BYTES) throw new Error('Картинка должна быть не больше 5 МБ.');
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const jpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const png = header.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte);
  if (!jpeg && !png) throw new Error('Для отправки картинки выберите JPEG или PNG.');
  return new Blob([file], { type: jpeg ? 'image/jpeg' : 'image/png' });
}
