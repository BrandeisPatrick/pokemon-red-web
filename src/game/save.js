// Save / load / delete through src/engine/storage.js (versioned localStorage envelope), plus
// export to / import from a JSON file. Everything is a pure function over the serialized form
// except downloadSave(), the single DOM helper.

import { SaveStore } from '../engine/storage.js';
import { GameState, SAVE_SCHEMA_VERSION } from './state.js';

export const SAVE_KEY = 'pokered-web:save';
export const EXPORT_FORMAT = 'pokered-web-export';

/**
 * Upgrades of older save data: MIGRATIONS[k](data) turns schema k into k+1. None yet
 * (schema 1 is the first).
 * @type {Record<number, (data:any)=>any>}
 */
export const MIGRATIONS = {};

/**
 * A SaveStore for game saves (same key and envelope as window.game.storage).
 * @param {{storage?:Storage|object|null, key?:string}} [o] storage: localStorage by default,
 *   MemoryStorage in tests
 */
export function createSaveStore({ storage, key = SAVE_KEY } = {}) {
  return new SaveStore({ key, version: SAVE_SCHEMA_VERSION, storage, migrations: MIGRATIONS });
}

/** GameState → plain JSON data (what goes in the envelope). */
export function serializeState(state) {
  return state instanceof GameState ? state.toJSON() : GameState.fromJSON(state).toJSON();
}

/** Plain JSON data (current schema) → GameState. */
export function deserializeState(data) {
  return GameState.fromJSON(data);
}

/** Run MIGRATIONS from `version` up to SAVE_SCHEMA_VERSION. Throws on a gap or newer data. */
export function migrate(data, version) {
  if (version > SAVE_SCHEMA_VERSION) throw new Error(`save is from a newer version (${version})`);
  let d = data;
  for (let v = version; v < SAVE_SCHEMA_VERSION; v++) {
    const up = MIGRATIONS[v];
    if (!up) throw new Error(`no migration from save version ${v}`);
    d = up(d);
  }
  return { ...d, version: SAVE_SCHEMA_VERSION };
}

/**
 * Write the game to the store.
 * @returns {{ok:boolean, error?:string}}
 */
export function saveGame(state, store = createSaveStore()) {
  const ok = store.save(serializeState(state));
  return ok ? { ok: true } : { ok: false, error: store.lastError || 'save failed' };
}

/**
 * Read the game from the store (migrated).
 * @returns {GameState|null} null when there is no (valid) save — see store.lastError
 */
export function loadGame(store = createSaveStore()) {
  const data = store.load();
  if (!data) return null;
  try {
    return deserializeState({ ...data, version: SAVE_SCHEMA_VERSION });
  } catch (err) {
    store.lastError = String(err && err.message ? err.message : err);
    return null;
  }
}

/** @returns {boolean} a save exists */
export function hasSave(store = createSaveStore()) {
  return store.exists();
}

/** @returns {{version:number, savedAt:string}|null} */
export function saveInfo(store = createSaveStore()) {
  return store.info();
}

/** Delete the save. */
export function deleteSave(store = createSaveStore()) {
  store.clear();
}

/**
 * Export a game as a self-describing JSON string (for a download).
 * @returns {string}
 */
export function exportSave(state, { now = new Date() } = {}) {
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: SAVE_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    data: serializeState(state),
  }, null, 1);
}

/**
 * Import a game from exported JSON text (or the already parsed object). Accepts the export
 * format, the localStorage envelope ({format:'pokered-web-save', version, data}) or bare state
 * data. Older versions are migrated.
 * @returns {GameState}
 * @throws on invalid input
 */
export function importSave(textOrObject) {
  let obj = textOrObject;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      throw new Error('not a save file (invalid JSON)');
    }
  }
  if (!obj || typeof obj !== 'object') throw new Error('not a save file');
  let data;
  let version;
  if (obj.format === EXPORT_FORMAT || obj.format === 'pokered-web-save') {
    if (typeof obj.version !== 'number' || !obj.data) throw new Error('not a save file (missing version/data)');
    data = obj.data;
    version = obj.version;
  } else if (typeof obj.version === 'number' && Array.isArray(obj.party)) {
    data = obj;
    version = obj.version;
  } else {
    throw new Error('not a save file');
  }
  return deserializeState(migrate(data, version));
}

/**
 * Read a File/Blob chosen by the player and import it.
 * @param {{text:()=>Promise<string>}} file
 * @returns {Promise<GameState>}
 */
export async function readSaveFile(file) {
  return importSave(await file.text());
}

/** Suggested download name, e.g. "pokered-RED-2026-10-09.json". */
export function exportFileName(state, now = new Date()) {
  const safe = String(state.playerName || 'save').replace(/[^A-Za-z0-9_-]+/g, '_') || 'save';
  return `pokered-${safe}-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * DOM helper (browser only): download the exported save as a .json file.
 * @param {GameState} state
 * @param {{filename?:string, document?:Document}} [o]
 */
export function downloadSave(state, { filename, document: doc = globalThis.document } = {}) {
  if (!doc || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    throw new Error('downloadSave needs a browser document');
  }
  const blob = new Blob([exportSave(state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename || exportFileName(state);
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
