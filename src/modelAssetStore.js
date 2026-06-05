const DB_NAME = 'ez3d-model-assets';
const DB_VERSION = 1;
const STORE_NAME = 'assets';

function openAssetDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withAssetStore(mode, callback) {
  return openAssetDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    let result;
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    result = callback(store);
  }));
}

export function createModelAssetId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `asset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function saveModelAsset(file, { id = createModelAssetId(), format } = {}) {
  const record = {
    id,
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    format,
    savedAt: new Date().toISOString(),
    blob: file,
  };
  await withAssetStore('readwrite', store => store.put(record));
  return record;
}

export function getModelAsset(id) {
  if (!id) return Promise.resolve(null);
  return withAssetStore('readonly', store => new Promise((resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  }));
}

export function deleteModelAsset(id) {
  if (!id) return Promise.resolve();
  return withAssetStore('readwrite', store => store.delete(id));
}

export function recordToFile(record) {
  if (!record?.blob) return null;
  return new File([record.blob], record.name, { type: record.type || 'application/octet-stream' });
}
