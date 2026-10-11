// Loading and indexing of everything the overworld reads from data/ and assets/.
// The loader functions are injected so the same code runs in the browser (engine Assets /
// fetch + gfx.loadIndexed) and in node tests (fs + PNG decoder). Every file is fetched once.

/** @typedef {import('../engine/gfx.js').IndexedImage} IndexedImage */

const COMMON_FILES = {
  mapIndex: 'data/map_index.json',
  tilesetIndex: 'data/tilesets/index.json',
  sprites: 'data/sprites.json',
  sgb: 'data/sgb_palettes.json',
  meta: 'data/maps_meta.json',
  toggleables: 'data/toggleable_objects.json',
  owGfx: 'data/overworld_gfx.json',
  wild: 'data/wild/encounters.json',
  commonText: 'data/text/common.json',
  items: 'data/items.json',
  pokemon: 'data/pokemon.json',
  trainerClasses: 'data/trainer_classes.json',
};

export class OverworldData {
  /**
   * @param {object} o
   * @param {(url:string) => Promise<any>} o.json
   * @param {(url:string) => Promise<IndexedImage>} o.image
   */
  constructor({ json, image }) {
    this._json = json;
    this._image = image;
    /** @type {Map<string, Promise<any>>} */
    this._promises = new Map();
    /** resolved values by url */
    this._cache = new Map();
    this.ready = false;
  }

  /** Browser convenience: build from the engine's Assets loader (shares its cache). */
  static fromAssets(assets) {
    return new OverworldData({ json: (u) => assets.json(u), image: (u) => assets.image(u) });
  }

  /** @private */
  _load(url, kind) {
    let p = this._promises.get(url);
    if (!p) {
      p = (kind === 'image' ? this._image(url) : this._json(url)).then((v) => { this._cache.set(url, v); return v; });
      p.catch(() => this._promises.delete(url));
      this._promises.set(url, p);
    }
    return p;
  }

  json(url) { return this._load(url, 'json'); }
  image(url) { return this._load(url, 'image'); }
  /** Synchronous access to something already loaded (undefined otherwise). */
  get(url) { return this._cache.get(url); }

  /** Load the global tables and the always-needed graphics. */
  async init() {
    const entries = await Promise.all(Object.entries(COMMON_FILES).map(async ([k, u]) => [k, await this.json(u)]));
    for (const [k, v] of entries) this[k] = v;
    const mi = this.mapIndex;
    /** @type {Map<string, any>} map const -> map_index entry */
    this.mapsByConst = new Map(mi.maps.map((m) => [m.const, m]));
    /** @type {Map<string, any>} map name -> map_index entry (real maps only) */
    this.mapsByName = new Map(mi.maps.filter((m) => m.name).map((m) => [m.name, m]));
    this.mapsById = mi.maps;
    this.mapNames = mi.maps.filter((m) => m.name && !m.unused).map((m) => m.name);
    this.tilesetsByConst = new Map(this.tilesetIndex.tilesets.map((t) => [t.const, t]));
    this.spritesByConst = new Map(this.sprites.sprites.map((s) => [s.const, s]));
    this.itemNames = new Map();
    for (const it of [...(this.items.items || []), ...(this.items.machines || [])]) this.itemNames.set(it.const, it.name);
    this.monsByConst = new Map(this.pokemon.map((p) => [p.const, p]));
    this.monsByDex = new Map(this.pokemon.map((p) => [p.dex, p]));
    this.trainerClassByConst = new Map((this.trainerClasses || []).map((c) => [`OPP_${c.const}`, c]));
    const id = (c) => (this.mapsByConst.get(c) || { id: -1 }).id;
    this.paletteIdx = {
      firstIndoorMap: mi.firstIndoorMap,
      numCityMaps: mi.numCityMaps,
      ids: {
        CERULEAN_CAVE_2F: id('CERULEAN_CAVE_2F'), CERULEAN_CAVE_1F: id('CERULEAN_CAVE_1F'),
        LORELEIS_ROOM: id('LORELEIS_ROOM'), BRUNOS_ROOM: id('BRUNOS_ROOM'),
      },
    };
    const og = this.owGfx;
    const imgs = {
      shadow: og.shadow.png,
      emote_shock: og.emote_shock.png,
      emote_question: og.emote_question.png,
      emote_happy: og.emote_happy.png,
      spinners: og.spinners.png,
      smoke: og.smoke.png,
      cutLeaf: og.cutLeaf.png,
    };
    const loaded = await Promise.all(Object.entries(imgs).map(async ([k, u]) => [k, await this.image(u)]));
    /** @type {Record<string, IndexedImage>} */
    this.gfx = Object.fromEntries(loaded);
    this.flowers = await Promise.all((this.tilesetIndex.flowerFrames || []).map((u) => this.image(u)));
    this.playerSheets = {
      walk: await this.image(this.spritesByConst.get(this.sprites.player.walk).sheet),
      bike: await this.image((this.sprites.extraSheets.find((s) => s.label === this.sprites.player.bike) || {}).sheet),
      surf: await this.image(this.spritesByConst.get(this.sprites.player.surf).sheet),
    };
    this.ready = true;
    return this;
  }

  /** Map name for a map const (unused ids resolve to the header they alias, like the ROM). */
  mapNameForConst(c) {
    const m = this.mapsByConst.get(c);
    if (!m) return null;
    if (m.name) return m.name;
    if (m.headerAlias) return m.headerAlias;
    return null;
  }

  /** map_index entry by name. */
  mapEntry(name) { return this.mapsByName.get(name) || null; }

  /** @returns {Promise<any>} data/maps/<name>.json */
  loadMapJson(name) {
    const e = this.mapEntry(name);
    if (!e) return Promise.reject(new Error(`OverworldData: unknown map ${name}`));
    return this.json(e.file);
  }

  /** Synchronous map JSON (if loaded). */
  getMapJson(name) {
    const e = this.mapEntry(name);
    return e ? this.get(e.file) : undefined;
  }

  tilesetFile(tilesetConst) {
    const t = this.tilesetsByConst.get(tilesetConst);
    if (!t) throw new Error(`OverworldData: unknown tileset ${tilesetConst}`);
    return t.file;
  }

  /** Sprite sheet URL for a SPRITE_* const (null for unknown / SPRITE_NONE). */
  spriteSheetUrl(spriteConst) {
    const s = this.spritesByConst.get(spriteConst);
    return s ? s.sheet : null;
  }

  /**
   * Load everything needed to enter a map: its JSON, the JSON of its connected maps (for the
   * border strips), its tileset JSON + sheet, its text file and the sprite sheets of its
   * objects. Resolves to a bundle; also keeps everything cached for synchronous access.
   * @param {string} name
   */
  async loadMapBundle(name) {
    const map = await this.loadMapJson(name);
    const conns = Object.values(map.connections || {}).map((c) => c.mapName);
    const [connected, tileset, text] = await Promise.all([
      Promise.all(conns.map((n) => this.loadMapJson(n))),
      this.json(map.tilesetFile || this.tilesetFile(map.tileset)),
      this.json(map.textFile || this.mapEntry(name).textFile),
    ]);
    const [tilesetImage, sheets] = await Promise.all([
      this.image(tileset.gfx),
      Promise.all([...new Set(map.objectEvents.map((o) => this.spriteSheetUrl(o.sprite)).filter(Boolean))]
        .map(async (u) => [u, await this.image(u)])),
    ]);
    return { map, connected, tileset, tilesetImage, text, sheets: new Map(sheets) };
  }

  /** True if loadMapBundle(name) would resolve without fetching. */
  isBundleLoaded(name) {
    const map = this.getMapJson(name);
    if (!map) return false;
    for (const c of Object.values(map.connections || {})) if (!this.getMapJson(c.mapName)) return false;
    const ts = this.get(map.tilesetFile || this.tilesetFile(map.tileset));
    if (!ts || !this.get(ts.gfx)) return false;
    if (!this.get(map.textFile || this.mapEntry(name).textFile)) return false;
    for (const o of map.objectEvents) {
      const u = this.spriteSheetUrl(o.sprite);
      if (u && !this.get(u)) return false;
    }
    return true;
  }

  /** Fire-and-forget preload of maps (connections and warp destinations of a map). */
  preloadNeighbours(map) {
    const names = new Set();
    for (const c of Object.values(map.connections || {})) names.add(c.mapName);
    for (const w of map.warps || []) if (w.destMapName) names.add(w.destMapName);
    for (const n of names) if (this.mapEntry(n)) this.loadMapBundle(n).catch(() => {});
  }

  /** Display name of an item const ('POTION' -> 'POTION', 'TM_MEGA_PUNCH' -> 'TM01'). */
  itemName(c) {
    return this.itemNames.get(c) || String(c).replace(/_/g, ' ');
  }

  /** Pokémon by const (internal-order name) -> pokemon.json entry. */
  mon(c) { return this.monsByConst.get(c) || null; }
}
