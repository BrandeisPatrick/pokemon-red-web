// Persistent bit flags of the save: event flags (wEventFlags), toggleable "missable" objects
// (wToggleableObjectFlags), obtained hidden items / coins, and the saved wStatusFlags bytes.
//
// Interface contract used by the overworld (do not change):
//   state.flags       — { get(name): boolean, set(name, value=true), clear(name) }
//   state.missables   — { isHidden(index): boolean, hide(index), show(index) }
//   state.hiddenItems — { has(key): boolean, add(key) }

import { getGameData } from '../pokemon/data.js';

/** Fixed-size bit array (bit i = byte i>>3, bit i&7 — the game's FlagAction layout). */
export class BitArray {
  /** @param {number} size bits */
  constructor(size) {
    this.size = size;
    this.bytes = new Uint8Array(Math.ceil(size / 8));
  }

  _check(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this.size) throw new RangeError(`bit ${i} out of range 0..${this.size - 1}`);
  }

  get(i) { this._check(i); return (this.bytes[i >> 3] & (1 << (i & 7))) !== 0; }

  set(i, value = true) {
    this._check(i);
    if (value) this.bytes[i >> 3] |= 1 << (i & 7);
    else this.bytes[i >> 3] &= ~(1 << (i & 7)) & 0xff;
  }

  clear(i) { this.set(i, false); }

  /** @returns {number[]} indices of set bits, ascending */
  indices() {
    const out = [];
    for (let i = 0; i < this.size; i++) if (this.bytes[i >> 3] & (1 << (i & 7))) out.push(i);
    return out;
  }

  count() { return this.indices().length; }

  /** Lowercase hex of the bytes (2 chars per byte). */
  toHex() { return Array.from(this.bytes, (b) => b.toString(16).padStart(2, '0')).join(''); }

  /** Load from a list of set indices or a hex string. */
  load(src) {
    this.bytes.fill(0);
    if (typeof src === 'string') {
      for (let i = 0; i < this.bytes.length && 2 * i + 1 < src.length; i++) this.bytes[i] = parseInt(src.substr(2 * i, 2), 16) || 0;
    } else if (Array.isArray(src)) {
      for (const i of src) this.set(i, true);
    }
    return this;
  }
}

// ------------------------------------------------------------------------------- event flags

/**
 * wEventFlags: 2560 bits named by constants/event_constants.asm (data/event_flags.json).
 * Names are the pret constants ("EVENT_GOT_STARTER"); aliases (INDIGO_PLATEAU_EVENTS_START/END)
 * and raw bit indices are accepted too. Unknown names throw (typos are bugs).
 */
export class EventFlags {
  /**
   * @param {{set?:number[]|string}} [o] initially set bits (indices or hex)
   */
  constructor(o = {}, gd = getGameData()) {
    this._gd = gd;
    this.bits = new BitArray(gd.eventFlags.numEvents);
    if (o.set) this.bits.load(o.set);
  }

  /** Bit index of a flag name, alias or index. */
  indexOf(name) {
    if (typeof name === 'number') {
      if (!Number.isInteger(name) || name < 0 || name >= this.bits.size) throw new RangeError(`event bit ${name} out of range`);
      return name;
    }
    const i = this._gd.eventIndex(name);
    if (i === undefined) throw new Error(`unknown event flag ${JSON.stringify(name)}`);
    return i;
  }

  /** @returns {boolean} */
  get(name) { return this.bits.get(this.indexOf(name)); }

  /** Set (or with value=false clear) a flag. */
  set(name, value = true) { this.bits.set(this.indexOf(name), !!value); }

  clear(name) { this.bits.set(this.indexOf(name), false); }

  /** True if `name` is a known flag name/alias. */
  isKnown(name) { return typeof name === 'number' ? name >= 0 && name < this.bits.size : this._gd.eventIndex(name) !== undefined; }

  /** SetEventRange (inclusive). */
  setRange(start, end) {
    for (let i = this.indexOf(start); i <= this.indexOf(end); i++) this.bits.set(i, true);
  }

  /** ResetEventRange (inclusive), e.g. clearRange('INDIGO_PLATEAU_EVENTS_START', 'INDIGO_PLATEAU_EVENTS_END'). */
  clearRange(start, end) {
    for (let i = this.indexOf(start); i <= this.indexOf(end); i++) this.bits.set(i, false);
  }

  /** Names of the set flags (unnamed bits as numbers). */
  setNames() { return this.bits.indices().map((i) => this._gd.eventName(i) ?? i); }

  /** Save form: ascending indices of the set bits. */
  toJSON() { return this.bits.indices(); }

  /** @param {number[]|string|{set:number[]}} o */
  static fromJSON(o, gd = getGameData()) {
    if (o instanceof EventFlags) return new EventFlags({ set: o.toJSON() }, gd);
    return new EventFlags({ set: Array.isArray(o) || typeof o === 'string' ? o : (o && o.set) || [] }, gd);
  }
}

// ------------------------------------------------------------------------- toggleable objects

/** wToggleableObjectFlags is flag_array $100. */
export const MAX_TOGGLEABLE_OBJECTS = 256;

/**
 * Hide/show state of the 228 toggleable ("missable") objects (data/toggleable_objects.json):
 * bit set = hidden. Indices are the TOGGLE_* constants' values (0-based); the const name is
 * accepted too. A new game hides every object with initiallyVisible = false
 * (InitializeToggleableObjectsFlags).
 */
export class Missables {
  constructor(o = {}, gd = getGameData()) {
    this._gd = gd;
    this.bits = new BitArray(MAX_TOGGLEABLE_OBJECTS);
    if (o.hidden) this.bits.load(o.hidden);
  }

  /** The new-game state. */
  static initial(gd = getGameData()) {
    const m = new Missables({}, gd);
    for (const obj of gd.toggleableObjects.objects) if (!obj.initiallyVisible) m.bits.set(obj.index, true);
    return m;
  }

  _index(x) {
    if (typeof x === 'number') return x;
    return this._gd.toggleable(x).index;
  }

  /** @returns {boolean} the object is hidden (not drawn, not solid, not talkable) */
  isHidden(index) { return this.bits.get(this._index(index)); }

  /** HideObject. */
  hide(index) { this.bits.set(this._index(index), true); }

  /** ShowObject. */
  show(index) { this.bits.set(this._index(index), false); }

  /** Save form: ascending indices of hidden objects. */
  toJSON() { return this.bits.indices(); }

  static fromJSON(o, gd = getGameData()) {
    if (o instanceof Missables) return new Missables({ hidden: o.toJSON() }, gd);
    return new Missables({ hidden: Array.isArray(o) || typeof o === 'string' ? o : (o && o.hidden) || [] }, gd);
  }
}

// ------------------------------------------------------------------------------ hidden items

/**
 * Obtained hidden items and hidden coins (wObtainedHiddenItemsFlags / wObtainedHiddenCoinsFlags).
 * The overworld decides the key; any string/number works (keys are compared as strings).
 * Recommended canonical keys — the ROM's flag bit, i.e. the row of HiddenItemCoords /
 * HiddenCoinCoords (= the `flagIndex` of data/maps/<Map>.json hiddenObjects):
 *   hiddenItemKey('item', flagIndex) → "item:<n>",  hiddenItemKey('coin', flagIndex) → "coin:<n>"
 */
export class HiddenItems {
  constructor(keys = []) {
    /** @type {Set<string>} */
    this.keys = new Set((keys || []).map(String));
  }

  has(key) { return this.keys.has(String(key)); }
  add(key) { this.keys.add(String(key)); }
  delete(key) { return this.keys.delete(String(key)); }
  get size() { return this.keys.size; }

  /** ROM-style accessors on the canonical keys. */
  hasItem(flagIndex) { return this.has(hiddenItemKey('item', flagIndex)); }
  addItem(flagIndex) { this.add(hiddenItemKey('item', flagIndex)); }
  hasCoins(flagIndex) { return this.has(hiddenItemKey('coin', flagIndex)); }
  addCoins(flagIndex) { this.add(hiddenItemKey('coin', flagIndex)); }

  /** Save form: sorted keys. */
  toJSON() { return [...this.keys].sort(); }

  static fromJSON(o) {
    return new HiddenItems(o instanceof HiddenItems ? o.toJSON() : Array.isArray(o) ? o : []);
  }
}

/** Canonical hidden item / coin key. @param {'item'|'coin'} kind */
export function hiddenItemKey(kind, flagIndex) {
  return `${kind}:${flagIndex}`;
}

// ------------------------------------------------------------------------------ status flags

/** The saved bit-flag bytes kept in GameState.statusFlags (constants/ram_constants.asm). */
export const STATUS_FLAG_BYTES = Object.freeze([
  'wStatusFlags1', 'wStatusFlags2', 'wStatusFlags3', 'wStatusFlags4', 'wStatusFlags5',
  'wStatusFlags6', 'wStatusFlags7', 'wElite4Flags', 'wMovementFlags',
]);

/**
 * Named bits of the saved status bytes, by BIT_ constant: e.g. get('BIT_GOT_OLD_ROD'),
 * set('BIT_GAVE_SAFFRON_GUARDS_DRINK'), get('BIT_STARTED_ELITE_4'), get('BIT_ALWAYS_ON_BIKE').
 * Most bits are transient engine state; they are kept because the original saves them.
 */
export class StatusFlags {
  constructor(values = {}, gd = getGameData()) {
    this._gd = gd;
    /** @type {Record<string, number>} byte values */
    this.bytes = {};
    this._bit = new Map();
    for (const label of STATUS_FLAG_BYTES) {
      this.bytes[label] = (values[label] || 0) & 0xff;
      const group = gd.eventFlags.bitFlags[label];
      if (!group) continue;
      for (const b of group.bits) this._bit.set(b.name, { label, bit: b.bit });
    }
  }

  _loc(name) {
    const n = name.startsWith('BIT_') ? name : `BIT_${name}`;
    const loc = this._bit.get(n);
    if (!loc) throw new Error(`unknown status flag ${JSON.stringify(name)}`);
    return loc;
  }

  get(name) {
    const { label, bit } = this._loc(name);
    return (this.bytes[label] & (1 << bit)) !== 0;
  }

  set(name, value = true) {
    const { label, bit } = this._loc(name);
    if (value) this.bytes[label] |= 1 << bit;
    else this.bytes[label] &= ~(1 << bit) & 0xff;
  }

  clear(name) { this.set(name, false); }

  toJSON() { return { ...this.bytes }; }

  static fromJSON(o, gd = getGameData()) {
    return new StatusFlags(o instanceof StatusFlags ? o.toJSON() : o || {}, gd);
  }
}

// ------------------------------------------------------------------------------------ badges

/** Badge names in bit order (BOULDERBADGE = bit 0 ... EARTHBADGE = bit 7). */
export function badgeNames(gd = getGameData()) {
  return gd.eventFlags.badges.map((b) => b.name);
}

/** Bit mask of a badge name ("BOULDERBADGE" or "BIT_BOULDERBADGE"). */
export function badgeMask(name, gd = getGameData()) {
  const n = String(name).replace(/^BIT_/, '');
  const b = gd.eventFlags.badges.find((x) => x.name === n);
  if (!b) throw new Error(`unknown badge ${JSON.stringify(name)}`);
  return b.mask;
}
