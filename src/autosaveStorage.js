export const AUTOSAVE_KEY = 'ez3d.autosave.v1';

export function readAutosaveDraft(storage = localStorage) {
  try {
    const raw = storage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    return snapshot?.schema === 'ez3d.project' ? snapshot : null;
  } catch (err) {
    console.warn('Ez3d autosave read failed:', err);
    return null;
  }
}

export function writeAutosaveDraft(snapshot, storage = localStorage) {
  try {
    storage.setItem(AUTOSAVE_KEY, JSON.stringify(snapshot));
    return true;
  } catch (err) {
    console.warn('Ez3d autosave failed:', err);
    return false;
  }
}

export function clearAutosaveDraftStorage(storage = localStorage) {
  storage.removeItem(AUTOSAVE_KEY);
}
