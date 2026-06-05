import { clearAutosaveDraftStorage, readAutosaveDraft, writeAutosaveDraft } from './autosaveStorage.js';

export class AutosaveCoordinator {
  constructor({ debounceMs = 700, isReady = () => true, createSnapshot }) {
    this.debounceMs = debounceMs;
    this.isReady = isReady;
    this.createSnapshot = createSnapshot;
    this.timer = null;
    this.suspended = false;
  }

  setSuspended(value) {
    this.suspended = value;
  }

  isSuspended() {
    return this.suspended;
  }

  queue() {
    if (this.suspended || !this.isReady()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  flush() {
    if (this.suspended || !this.isReady()) return null;
    clearTimeout(this.timer);
    const snapshot = this.createSnapshot();
    writeAutosaveDraft(snapshot);
    return snapshot;
  }

  read() {
    return readAutosaveDraft();
  }

  clear() {
    clearTimeout(this.timer);
    clearAutosaveDraftStorage();
  }
}
