// Game data access: loads the generated JSON in data/ (fetch in the browser, fs in node) and
// indexes it. Everything else in src/pokemon and src/game reads data through getGameData().
//
//   await loadGameData();               // browser: fetch relative to this module; node: fs
//   const gd = getGameData();           // synchronous after the load
//   gd.species(1) === gd.species('BULBASAUR') === gd.speciesByIndex(153)
//
// No DOM. The only environment-specific code is the default JSON reader below.

/** Files loaded by loadGameData, keyed by the property they become on GameData.raw. */
export const DATA_FILES = Object.freeze({
  pokemon: 'data/pokemon.json',
  moves: 'data/moves.json',
  types: 'data/types.json',
  items: 'data/items.json',
  growthRates: 'data/growth_rates.json',
  encounters: 'data/wild/encounters.json',
  fishing: 'data/wild/fishing.json',
  trainers: 'data/trainers.json',
  trainerClasses: 'data/trainer_classes.json',
  events: 'data/events.json',
  pokedex: 'data/pokedex.json',
  eventFlags: 'data/event_flags.json',
  toggleableObjects: 'data/toggleable_objects.json',
  mapsMeta: 'data/maps_meta.json',
  mapIndex: 'data/map_index.json',
  tilesets: 'data/tilesets/index.json',
  statModifiers: 'data/battle/stat_modifiers.json',
  battleConstants: 'data/battle/constants.json',
  effectLists: 'data/battle/effect_lists.json',
  moveEffects: 'data/battle/move_effects.json',
  trainerAi: 'data/battle/trainer_ai.json',
  statNames: 'data/battle/stat_names.json',
});

/** Project root (the directory that contains data/), resolved from this module's URL. */
const ROOT_URL = new URL('../../', import.meta.url);

let current = null;
let loading = null;

/**
 * Load and index every data file. Resolves to the GameData singleton (also returned by
 * getGameData() afterwards). Concurrent calls share one load.
 * @param {object} [o]
 * @param {(url:string)=>Promise<any>} [o.fetchImpl] custom fetch: may resolve to a Response
 *   (anything with .json()), a JSON string, or the parsed object
 * @param {string|URL} [o.base] URL/path prefix of the project root (default: this module's ../../)
 * @param {Record<string,string>} [o.files] override DATA_FILES entries
 * @param {boolean} [o.force] reload even if already loaded
 * @returns {Promise<GameData>}
 */
export function loadGameData({ fetchImpl, base, files, force = false } = {}) {
  if (current && !force) return Promise.resolve(current);
  if (loading && !force) return loading;
  const list = { ...DATA_FILES, ...(files || {}) };
  const read = makeReader(fetchImpl, base);
  loading = (async () => {
    const entries = await Promise.all(Object.entries(list).map(async ([key, path]) => {
      try {
        return [key, await read(path)];
      } catch (err) {
        throw new Error(`loadGameData: cannot load ${path}: ${err && err.message ? err.message : err}`);
      }
    }));
    current = new GameData(Object.fromEntries(entries));
    return current;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

/** @returns {GameData} the loaded data (throws if loadGameData has not finished) */
export function getGameData() {
  if (!current) throw new Error('game data not loaded: await loadGameData() first');
  return current;
}

/** @returns {boolean} */
export function hasGameData() {
  return current !== null;
}

/** Install a GameData (tests, or data built elsewhere). Pass null to unload. */
export function setGameData(gd) {
  current = gd;
  loading = null;
  return gd;
}

function makeReader(fetchImpl, base) {
  const root = base === undefined ? ROOT_URL : base;
  const resolve = (path) => {
    if (root instanceof URL) return new URL(path, root);
    const s = String(root);
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return new URL(path, s.endsWith('/') ? s : s + '/');
    return (s === '' || s.endsWith('/') ? s : s + '/') + path;
  };
  if (fetchImpl) {
    return async (path) => {
      const target = resolve(path);
      const res = await fetchImpl(String(target));
      if (res && typeof res.json === 'function') {
        if (res.ok === false) throw new Error(`HTTP ${res.status}`);
        return res.json();
      }
      return typeof res === 'string' ? JSON.parse(res) : res;
    };
  }
  return async (path) => {
    const target = resolve(path);
    const url = target instanceof URL ? target : null;
    if (url && url.protocol === 'file:') {
      const { readFile } = await import('node:fs/promises');
      return JSON.parse(await readFile(url, 'utf8'));
    }
    if (typeof fetch !== 'function') throw new Error('no fetch available; pass fetchImpl');
    const res = await fetch(String(target));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
}

// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{hp:number, atk:number, def:number, spd:number, spc:number}} StatBlock
 * @typedef {object} SpeciesData   one entry of data/pokemon.json
 * @property {number} dex
 * @property {number} id            internal index
 * @property {string} const
 * @property {string} name
 * @property {StatBlock} baseStats
 * @property {[string,string]} types
 * @property {number} catchRate
 * @property {number} baseExp
 * @property {string} growthRate    MEDIUM_FAST ...
 * @property {string[]} startMoves
 * @property {{level:number, move:string}[]} learnset
 * @property {object[]} evolutions
 * @property {string[]} tmhm
 * @typedef {object} MoveData       one entry of data/moves.json
 * @property {number} id
 * @property {string} const
 * @property {string} name
 * @property {string} type
 * @property {'physical'|'special'} category
 * @property {number} power
 * @property {number} accuracy
 * @property {number} accuracyByte
 * @property {number} pp
 * @property {string} effect
 * @property {boolean} highCrit
 * @typedef {object} ItemData       data/items.json items[] / machines[] / floors[]
 */

const lower = (s) => String(s).toLowerCase();

export class GameData {
  /** @param {Record<string, any>} raw parsed JSON keyed like DATA_FILES */
  constructor(raw) {
    this.raw = raw;

    // --- species
    /** @type {SpeciesData[]} sorted by dex */
    this.pokemon = raw.pokemon;
    this._speciesByDex = new Map();
    this._speciesById = new Map();
    this._speciesByKey = new Map();
    for (const s of this.pokemon) {
      this._speciesByDex.set(s.dex, s);
      this._speciesById.set(s.id, s);
      this._speciesByKey.set(lower(s.const), s);
      if (!this._speciesByKey.has(lower(s.name))) this._speciesByKey.set(lower(s.name), s);
    }

    // --- moves
    /** @type {MoveData[]} */
    this.moves = raw.moves;
    this._moveById = new Map();
    this._moveByKey = new Map();
    for (const m of this.moves) {
      this._moveById.set(m.id, m);
      this._moveByKey.set(lower(m.const), m);
    }
    for (const m of this.moves) if (!this._moveByKey.has(lower(m.name))) this._moveByKey.set(lower(m.name), m);

    // --- types
    this.typeList = raw.types.types;
    this.typeChart = raw.types.chart;
    this.typeMatchups = raw.types.matchups;
    this.specialThreshold = raw.types.specialThreshold;
    this._typeByKey = new Map();
    this._typeById = new Map();
    for (const t of this.typeList) {
      this._typeByKey.set(lower(t.const), t);
      this._typeById.set(t.id, t);
    }

    // --- items (regular, machines, floors)
    this.items = raw.items.items;
    this.machines = raw.items.machines;
    this.floors = raw.items.floors;
    this._itemById = new Map();
    this._itemByKey = new Map();
    for (const it of [...this.items, ...this.machines, ...this.floors]) {
      this._itemById.set(it.id, it);
      this._itemByKey.set(lower(it.const), it);
    }
    for (const it of [...this.items, ...this.machines]) {
      if (!this._itemByKey.has(lower(it.name))) this._itemByKey.set(lower(it.name), it);
    }
    this._machineByMove = new Map(this.machines.map((m) => [m.move, m]));

    // --- growth rates
    this._growth = new Map();
    for (const r of raw.growthRates.rates) {
      this._growth.set(r.name, r);
      this._growth.set(r.const, r);
    }

    // --- trainers
    this.trainerClasses = raw.trainerClasses;
    this._classByKey = new Map();
    this._classById = new Map();
    for (const c of this.trainerClasses) {
      this._classByKey.set(lower(c.const), c);
      this._classById.set(c.id, c);
    }
    this.trainers = raw.trainers;

    // --- wild
    this.encounters = raw.encounters;
    this.fishing = raw.fishing;

    // --- events / pokedex / flags / objects / maps
    this.events = raw.events;
    this.pokedex = raw.pokedex;
    this.eventFlags = raw.eventFlags;
    this._eventIndex = new Map(raw.eventFlags.events.map((e) => [e.name, e.index]));
    this._eventName = new Map(raw.eventFlags.events.map((e) => [e.index, e.name]));
    this.toggleableObjects = raw.toggleableObjects;
    this._toggleByConst = new Map(raw.toggleableObjects.objects.map((o) => [o.const, o]));
    this.mapsMeta = raw.mapsMeta;
    this.mapIndex = raw.mapIndex;
    this._mapByKey = new Map();
    this._mapById = new Map();
    for (const m of raw.mapIndex.maps) {
      this._mapById.set(m.id, m);
      if (m.const) this._mapByKey.set(m.const, m);
      if (m.name && !this._mapByKey.has(m.name)) this._mapByKey.set(m.name, m);
    }
    this.tilesets = raw.tilesets;

    // --- battle tables
    this.battle = {
      statModifiers: raw.statModifiers,
      constants: raw.battleConstants,
      effectLists: raw.effectLists,
      moveEffects: raw.moveEffects,
      trainerAi: raw.trainerAi,
      statNames: raw.statNames,
    };
  }

  // ---------------- species

  /**
   * Species lookup. Accepts a dex number (1-151), a const ("BULBASAUR"), a display name
   * ("NIDORAN♀", case-insensitive), a species entry, or an object {dex}|{id}|{const}|{species}
   * ({id} = internal index). Throws on unknown input. Plain numbers are ALWAYS dex numbers;
   * use speciesByIndex() for internal indexes.
   * @returns {SpeciesData}
   */
  species(x) {
    const s = this.findSpecies(x);
    if (!s) throw new Error(`unknown species ${JSON.stringify(x)}`);
    return s;
  }

  /** Like species() but returns undefined instead of throwing. */
  findSpecies(x) {
    if (x == null) return undefined;
    if (typeof x === 'number') return this._speciesByDex.get(x);
    if (typeof x === 'string') {
      if (/^\d+$/.test(x)) return this._speciesByDex.get(Number(x));
      return this._speciesByKey.get(lower(x));
    }
    if (typeof x === 'object') {
      if (typeof x.dex === 'number') return this._speciesByDex.get(x.dex);
      if (typeof x.id === 'number' && x.baseStats === undefined) return this._speciesById.get(x.id);
      if (typeof x.species === 'number' || typeof x.species === 'string') return this.findSpecies(x.species);
      if (typeof x.const === 'string') return this.findSpecies(x.const);
    }
    return undefined;
  }

  /** @param {number} dex */
  speciesByDex(dex) { return this.species(Number(dex)); }

  /** @param {number} id internal index (constants/pokemon_constants.asm) */
  speciesByIndex(id) {
    const s = this._speciesById.get(id);
    if (!s) throw new Error(`no species with internal index ${id}`);
    return s;
  }

  /** @param {string} c e.g. "MR_MIME" */
  speciesByConst(c) { return this.species(String(c)); }

  /** Internal index → dex number (0 for MissingNo / non-dex indexes). */
  dexFromIndex(id) { return this.pokedex.dexOrder[id - 1] || 0; }

  /** Dex number → internal index. */
  indexFromDex(dex) { return this.speciesByDex(dex).id; }

  /** @returns {number} dex number of any species reference */
  dexOf(x) { return this.species(x).dex; }

  // ---------------- moves

  /** Move by id (1-165), const ("PSYCHIC_M") or display name. Throws on unknown input. */
  move(x) {
    const m = this.findMove(x);
    if (!m) throw new Error(`unknown move ${JSON.stringify(x)}`);
    return m;
  }

  findMove(x) {
    if (x == null) return undefined;
    if (typeof x === 'number') return this._moveById.get(x);
    if (typeof x === 'object') return x.const ? this.findMove(x.const) : (x.move ? this.findMove(x.move) : undefined);
    return this._moveByKey.get(lower(x));
  }

  // ---------------- items

  /** Item by id, const ("POKE_BALL", "TM_MEGA_PUNCH", "HM_CUT", "FLOOR_1F") or display name. */
  item(x) {
    const it = this.findItem(x);
    if (!it) throw new Error(`unknown item ${JSON.stringify(x)}`);
    return it;
  }

  findItem(x) {
    if (x == null) return undefined;
    if (typeof x === 'number') return this._itemById.get(x);
    if (typeof x === 'object') return x.const ? this.findItem(x.const) : (x.item ? this.findItem(x.item) : undefined);
    const s = String(x);
    const m = /^(TM|HM)(\d\d)$/i.exec(s);
    if (m) {
      const n = Number(m[2]);
      return this.machines.find((it) => (m[1].toUpperCase() === 'TM' ? it.tm === n : it.hm === n));
    }
    return this._itemByKey.get(lower(s));
  }

  /** The TM/HM item that teaches `move` (const), or undefined. */
  machineForMove(move) { return this._machineByMove.get(this.move(move).const); }

  // ---------------- types

  /** Type entry by const ("PSYCHIC_TYPE") or id. */
  type(x) {
    const t = typeof x === 'number' ? this._typeById.get(x) : this._typeByKey.get(lower(x));
    if (!t) throw new Error(`unknown type ${JSON.stringify(x)}`);
    return t;
  }

  /** Display name of a type const ("PSYCHIC_TYPE" → "PSYCHIC"). */
  typeName(x) { return this.type(x).name; }

  // ---------------- growth

  /** Growth rate entry by name ("MEDIUM_SLOW") or const ("GROWTH_MEDIUM_SLOW"). */
  growthRate(x) {
    const r = this._growth.get(String(x));
    if (!r) throw new Error(`unknown growth rate ${JSON.stringify(x)}`);
    return r;
  }

  // ---------------- trainers

  /** Trainer class by const ("BROCK", "OPP_BROCK"), id (1-47) or {oppId}. */
  trainerClass(x) {
    let c;
    if (typeof x === 'number') c = this._classById.get(x >= 200 ? x - 200 : x);
    else if (x && typeof x === 'object') c = this.trainerClass(x.oppId ?? x.id ?? x.const);
    else c = this._classByKey.get(lower(String(x).replace(/^OPP_/i, '')));
    if (!c) throw new Error(`unknown trainer class ${JSON.stringify(x)}`);
    return c;
  }

  /** Raw party entry parties[CLASS][n-1] (n = 1-based party number as in map objects). */
  trainerPartyData(cls, partyIndex) {
    const c = this.trainerClass(cls);
    const list = this.trainers.parties[c.const] || [];
    const p = list[partyIndex - 1];
    if (!p) throw new Error(`trainer ${c.const} has no party ${partyIndex}`);
    return p;
  }

  // ---------------- wild

  /** Wild encounter tables of a map const ("ROUTE_1") or null when the map has none. */
  wildTable(map) {
    const m = this.findMap(map);
    return (m && this.encounters.maps[m.const]) || null;
  }

  /** Super Rod group of a map, or null ("Looks like there's nothing here"). */
  superRodGroup(map) {
    const m = this.findMap(map);
    if (!m) return null;
    const entry = this.fishing.superRod.maps[m.const];
    const name = entry && (typeof entry === 'string' ? entry : entry.group);
    return name ? { name, ...this.fishing.superRod.groups[name] } : null;
  }

  // ---------------- maps

  /** Map entry of data/map_index.json by const ("PALLET_TOWN"), name ("PalletTown") or id. */
  map(x) {
    const m = this.findMap(x);
    if (!m) throw new Error(`unknown map ${JSON.stringify(x)}`);
    return m;
  }

  findMap(x) {
    if (x == null) return undefined;
    if (typeof x === 'number') return this._mapById.get(x);
    if (typeof x === 'object') return this.findMap(x.const ?? x.map ?? x.id);
    return this._mapByKey.get(String(x));
  }

  // ---------------- flags / objects

  /** Bit index of an event flag name ("EVENT_GOT_STARTER") or an alias; undefined if unknown. */
  eventIndex(name) {
    if (this._eventIndex.has(name)) return this._eventIndex.get(name);
    return this.eventFlags.aliases[name];
  }

  /** Name of an event bit, or undefined for an unnamed bit. */
  eventName(index) { return this._eventName.get(index); }

  /** Toggleable ("missable") object by index (0-based) or const ("TOGGLE_PALLET_TOWN_OAK"). */
  toggleable(x) {
    const o = typeof x === 'number' ? this.toggleableObjects.objects[x] : this._toggleByConst.get(x);
    if (!o) throw new Error(`unknown toggleable object ${JSON.stringify(x)}`);
    return o;
  }
}
