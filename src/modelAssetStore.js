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

function normalizeFiles(input) {
  if (!input) return [];
  if (input instanceof File) return [input];
  return Array.from(input).filter(file => file instanceof File);
}

function filePath(file) {
  return file.webkitRelativePath || file.name;
}

export async function saveModelAsset(input, { id = createModelAssetId(), format, mainFileName } = {}) {
  const files = normalizeFiles(input);
  const mainFile = files.find(file => file.name === mainFileName || filePath(file) === mainFileName) || files[0];
  if (!mainFile) throw new Error('No model files to save.');

  const record = {
    id,
    name: mainFile.name,
    type: mainFile.type || 'application/octet-stream',
    size: files.reduce((total, file) => total + file.size, 0),
    format,
    mainFileName: mainFile.name,
    savedAt: new Date().toISOString(),
    blob: mainFile,
    files: files.map(file => ({
      name: file.name,
      path: filePath(file),
      type: file.type || 'application/octet-stream',
      size: file.size,
      blob: file,
      isMain: file === mainFile,
    })),
  };
  await withAssetStore('readwrite', store => store.put(record));
  return record;
}

export async function saveModelAssetRecord(record) {
  const files = recordToFiles(record);
  if (!files.length) return null;
  return saveModelAsset(files, { id: record.id, format: record.format, mainFileName: record.mainFileName || record.name });
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

export function clearModelAssets() {
  return withAssetStore('readwrite', store => store.clear());
}

export function recordToFile(record) {
  if (!record?.blob) return null;
  return new File([record.blob], record.name, { type: record.type || 'application/octet-stream' });
}

export function recordToFiles(record) {
  if (Array.isArray(record?.files) && record.files.length) {
    return record.files
      .filter(file => file?.blob)
      .map(file => new File([file.blob], file.path || file.name, { type: file.type || 'application/octet-stream' }));
  }
  const file = recordToFile(record);
  return file ? [file] : [];
}
