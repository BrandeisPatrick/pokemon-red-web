// Versioned JSON save slots in localStorage (or any Storage-like object, for tests).
//
// Stored envelope: {"format":"pokered-web-save","version":N,"savedAt":ISO,"data":...}
// load() migrates older versions through `migrations[fromVersion](data) -> data` and
// refuses (returns null) data from a newer version or anything that fails to parse.

export const SAVE_FORMAT = 'pokered-web-save';

export class SaveStore {
  /**
   * @param {object} [o]
   * @param {string} [o.key='pokered-web:save']
   * @param {number} [o.version=1]
   * @param {Storage|{getItem:Function,setItem:Function,removeItem:Function}} [o.storage]
   * @param {Record<number,(data:any)=>any>} [o.migrations] upgrade data from version k to k+1
   */
  constructor({ key = 'pokered-web:save', version = 1, storage, migrations = {} } = {}) {
    this.key = key;
    this.version = version;
    this.storage = storage === undefined ? safeLocalStorage() : storage;
    this.migrations = migrations;
    /** last error message (for UI / debugging) */
    this.lastError = null;
  }

  /** @returns {boolean} true if written */
  save(data) {
    if (!this.storage) { this.lastError = 'no storage available'; return false; }
    try {
      const envelope = { format: SAVE_FORMAT, version: this.version, savedAt: new Date().toISOString(), data };
      this.storage.setItem(this.key, JSON.stringify(envelope));
      this.lastError = null;
      return true;
    } catch (err) {
      this.lastError = String(err && err.message || err);
      return false;
    }
  }

  /** @returns {any|null} the saved data (migrated to the current version) or null */
  load() {
    const env = this._read();
    if (!env) return null;
    let { version, data } = env;
    if (version > this.version) { this.lastError = `save is from a newer version (${version})`; return null; }
    while (version < this.version) {
      const up = this.migrations[version];
      if (!up) { this.lastError = `no migration from version ${version}`; return null; }
      data = up(data);
      version++;
    }
    this.lastError = null;
    return data;
  }

  /** @returns {{version:number, savedAt:string}|null} */
  info() {
    const env = this._read();
    return env ? { version: env.version, savedAt: env.savedAt } : null;
  }

  exists() {
    return this._read() !== null;
  }

  clear() {
    if (this.storage) {
      try { this.storage.removeItem(this.key); } catch { /* ignore */ }
    }
  }

  /** @private */
  _read() {
    if (!this.storage) return null;
    let raw;
    try { raw = this.storage.getItem(this.key); } catch { return null; }
    if (raw == null) return null;
    try {
      const env = JSON.parse(raw);
      if (!env || env.format !== SAVE_FORMAT || typeof env.version !== 'number') {
        this.lastError = 'not a save file';
        return null;
      }
      return env;
    } catch {
      this.lastError = 'corrupt save data';
      return null;
    }
  }
}

/** In-memory Storage replacement (node tests, private browsing fallbacks). */
export class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

function safeLocalStorage() {
  try {
    const s = globalThis.localStorage;
    return s || null;
  } catch {
    return null;
  }
}
