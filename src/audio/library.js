// Lookup helpers over data/audio/index.json (pure JS, shared by audio.js, the worklet and
// offline.js).
//
// Names are matched leniently: "MUSIC_PALLET_TOWN", "PALLET_TOWN", "pallet_town",
// "Music_PalletTown", "Pallet Town" all resolve to the same song; SFX likewise
// ("SFX_PRESS_AB", "press_ab", "SFX_Press_AB_1", ...).

/**
 * @typedef {{name: string, title: string, bank: number, id: number|null, label: string,
 *   file: string, channels: number[], category?: string, synthetic?: boolean,
 *   playsAs?: string, unused?: boolean}} SoundEntry
 * @typedef {{name: string, base: string, bank: number, id: number, file: string,
 *   entries: Object<string, string>, routine: string, title: string}} VariantEntry
 * @typedef {{index: number, species: string|null, dex: number|null, name: string,
 *   baseCry: number, sfx: string, sfxId: number, pitch: number, length: number}} CryEntry
 */

/** Normalise a sound name for lookup. */
export function normName(s) {
  return String(s)
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([A-Za-z])(\d)/g, '$1_$2')
    .replace(/[\s\-.]+/g, '_')
    .toUpperCase()
    .replace(/_+/g, '_')
    .replace(/^(MUSIC|SFX)_/, '');
}

function keysFor(entry) {
  const keys = new Set();
  keys.add(normName(entry.name));
  if (entry.label) {
    keys.add(normName(entry.label));
    keys.add(normName(entry.label.replace(/_[123]$/, '')));
  }
  if (entry.title) keys.add(normName(entry.title));
  if (entry.file) keys.add(normName(entry.file.replace(/^.*\//, '').replace(/\.json$/, '').replace(/^\d_/, '')));
  // also the digit-joined form ("CITIES1")
  for (const k of [...keys]) keys.add(k.replace(/_(\d)/g, '$1'));
  return keys;
}

export class AudioLibrary {
  /** @param {any} index parsed data/audio/index.json */
  constructor(index) {
    this.index = index;
    this.engine = index.engine;
    /** @type {Map<string, SoundEntry|VariantEntry>} */
    this.musicByKey = new Map();
    /** bank -> key -> entry */
    this.sfxByKey = { 1: new Map(), 2: new Map(), 3: new Map() };
    /** bank -> id -> entry (real headers only) */
    this.byId = { 1: new Map(), 2: new Map(), 3: new Map() };
    for (const e of index.music) {
      for (const k of keysFor(e)) if (!this.musicByKey.has(k)) this.musicByKey.set(k, e);
      if (e.id != null) this.byId[e.bank].set(e.id, e);
    }
    for (const v of index.variants || []) {
      const ve = { ...v, variant: true };
      for (const k of keysFor(v)) if (!this.musicByKey.has(k)) this.musicByKey.set(k, ve);
    }
    for (const e of index.sfx) {
      for (const k of keysFor(e)) if (!this.sfxByKey[e.bank].has(k)) this.sfxByKey[e.bank].set(k, e);
      if (e.id != null && !e.synthetic) this.byId[e.bank].set(e.id, e);
    }
    this.cries = index.cries || [];
    this.criesByDex = new Map();
    this.criesBySpecies = new Map();
    for (const c of this.cries) {
      if (c.dex != null && !this.criesByDex.has(c.dex)) this.criesByDex.set(c.dex, c);
      if (c.species) this.criesBySpecies.set(c.species, c);
    }
    this.maps = index.maps || [];
    this.mapsByName = new Map(this.maps.map((m) => [m.map, m]));
  }

  /**
   * Resolve a song: name (any spelling), {bank, id}, or a numeric id in `bank`.
   * @returns {SoundEntry|VariantEntry|null}
   */
  music(spec, bank) {
    if (spec == null) return null;
    if (typeof spec === 'object') {
      if (spec.name) return this.music(spec.name);
      return this.byId[spec.bank]?.get(spec.id) || null;
    }
    if (typeof spec === 'number') {
      if (bank) return this.byId[bank].get(spec) || null;
      for (const b of [1, 2, 3]) {
        const e = this.byId[b].get(spec);
        if (e && this.index.music.includes(e)) return e;
      }
      return null;
    }
    return this.musicByKey.get(normName(spec)) || null;
  }

  /**
   * Resolve an SFX name. Prefers `preferBank` (the bank whose engine is running, which is
   * what the game does), else the first bank that has it. Accepts "2:SFX_BALL_TOSS".
   * @returns {SoundEntry|null}
   */
  sfx(spec, preferBank = 1) {
    if (spec == null) return null;
    if (typeof spec === 'object') {
      if (spec.name) return this.sfx(spec.name, spec.bank || preferBank);
      return this.byId[spec.bank]?.get(spec.id) || null;
    }
    if (typeof spec === 'number') return this.byId[preferBank].get(spec) || null;
    let s = String(spec);
    const m = /^([123])\s*:\s*(.+)$/.exec(s);
    if (m) {
      return this.sfxByKey[+m[1]].get(normName(m[2])) || null;
    }
    const key = normName(s);
    const order = [preferBank, 1, 2, 3].filter((b, i, a) => b && a.indexOf(b) === i);
    for (const b of order) {
      const e = this.sfxByKey[b].get(key);
      if (e) return e;
    }
    return null;
  }

  /**
   * Cry row. Numbers are Pokédex numbers (1-151); use {index: n} for the internal index,
   * or a species constant / name ("PIKACHU", "Pikachu").
   * @returns {CryEntry|null}
   */
  cry(spec) {
    if (spec == null) return null;
    if (typeof spec === 'object') {
      if (spec.index != null) return this.cries[spec.index - 1] || null;
      if (spec.dex != null) return this.criesByDex.get(spec.dex) || null;
      if (spec.species) return this.cry(spec.species);
      return null;
    }
    if (typeof spec === 'number') return this.criesByDex.get(spec) || null;
    const key = normName(spec).replace(/_/g, '');
    for (const c of this.cries) {
      if (!c.species) continue;
      if (c.species.replace(/_/g, '') === key || normName(c.name).replace(/_/g, '') === key) return c;
    }
    return null;
  }

  /** The SFX entry (in `bank`) of a cry row. */
  crySfx(cry, bank = 1) {
    return this.byId[bank].get(cry.sfxId) || null;
  }

  /** data/maps/songs.asm: map constant name ("PALLET_TOWN") or map id -> song entry. */
  songForMap(map) {
    const row = typeof map === 'number' ? this.maps[map] : this.mapsByName.get(normName(map)) ||
      this.mapsByName.get(String(map).toUpperCase());
    if (!row) return null;
    return this.byId[row.bank].get(row.musicId) || null;
  }

  /** Files needed to play `entry` (the bank's drum kit comes with any song). */
  filesFor(entry) {
    const files = new Set();
    if (!entry) return files;
    files.add(entry.file);
    if (entry.variant || this.index.music.includes(entry)) {
      for (const e of this.index.sfx) {
        if (e.bank === entry.bank && e.category === 'noise_instrument') files.add(e.file);
      }
    }
    return files;
  }
}
