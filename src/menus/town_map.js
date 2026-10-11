// The Town Map (engine/items/town_map.asm): the TOWN MAP item (DisplayTownMap), the Fly
// destination picker (LoadTownMap_Fly) and the Pokédex AREA page (LoadTownMap_Nest).
//
// The map is data/town_map.json `tilemap` (20×18 bytes $60+tile, tiles at VRAM $60). A location
// (x, y) is the cell at tile (x+2, y+1); the 16×16 markers (player, cursor, bird) sit with
// their top-left at (8x+12, 8y+5) — WriteTownMapSpriteOAM subtracts 4 from X and, because of
// the carry, only 3 from Y. Sprites 0-35 blink (25 frames on, 25 off); the player marker
// (OAM 36-39) never does.

import { MenuScene } from './base.js';
import { SPACE } from './screen.js';

/** NOT_VISITED marker of wFlyLocationsList. */
export const NOT_VISITED = 0xfe;
/** Cerulean Cave's town map coordinates ($19): never shown as a nest. */
const CERULEAN_CAVE_COORDS = { x: 9, y: 1 };

/** LoadTownMapEntry: {x, y, name} of a map (const). */
export function townMapEntry(townMap, mapConst) {
  return townMap.perMap[mapConst] || townMap.perMap.PALLET_TOWN;
}

/** TownMapOrder navigation: up = next, down = previous, both wrap. */
export function townMapStep(index, dir, length) {
  if (dir === 'up') return index + 1 >= length ? 0 : index + 1;
  return index - 1 < 0 ? length - 1 : index - 1;
}

/**
 * BuildFlyLocationsList: map ids 0..numCityMaps-1, NOT_VISITED for unvisited towns.
 * @param {number} visitedBits wTownVisitedFlag (state.flyUnlocked)
 */
export function flyLocations(visitedBits, numCityMaps = 11) {
  const out = [];
  for (let i = 0; i < numCityMaps; i++) out.push(visitedBits & (1 << i) ? i : NOT_VISITED);
  return out;
}

/**
 * Next visited town in the fly list (skipping NOT_VISITED, wrapping).
 * @param {number[]} list flyLocations()
 * @param {number} pos index into list
 * @param {'up'|'down'} dir
 */
export function flyStep(list, pos, dir) {
  const n = list.length;
  if (!list.some((v) => v !== NOT_VISITED)) return pos;
  let p = pos;
  do {
    p = dir === 'up' ? (p + 1) % n : (p - 1 + n) % n;
  } while (list[p] === NOT_VISITED);
  return p;
}

/**
 * FindWildLocationsOfMon + ZeroOutDuplicatesInList + DisplayWildLocations: town map cells
 * where a species lives in the grass or water (map ids in order, duplicates and map 0
 * dropped, Cerulean Cave skipped).
 * @returns {{x:number, y:number, map:string}[]}
 */
export function nestLocations(gd, townMap, species) {
  const dex = gd.species(species).dex;
  const enc = gd.encounters.maps;
  const byId = [];
  for (const [mapConst, t] of Object.entries(enc)) {
    for (const kind of ['grass', 'water']) {
      const tab = t[kind];
      if (!tab || !tab.rate) continue;
      for (const s of tab.slots) if (s.species === dex) byId.push({ id: t.mapId, map: mapConst });
    }
  }
  byId.sort((a, b) => a.id - b.id);
  const seen = new Set();
  const out = [];
  for (const e of byId) {
    if (seen.has(e.id) || e.id === 0) { seen.add(e.id); continue; }
    seen.add(e.id);
    const c = townMapEntry(townMap, e.map);
    if (c.x === CERULEAN_CAVE_COORDS.x && c.y === CERULEAN_CAVE_COORDS.y) continue;
    out.push({ x: c.x, y: c.y, map: e.map });
  }
  return out;
}

/** Top-left pixel of a 16×16 marker for town map coordinates. */
export function markerPixel(c) { return { x: 8 * c.x + 12, y: 8 * c.y + 5 }; }
/** Top-left pixel of the 8×8 nest icon. */
export function nestPixel(c) { return { x: 8 * (c.x + 2), y: 8 * (c.y + 1) }; }

class TownMapBase extends MenuScene {
  constructor(params = {}) {
    super({ ...params, opaque: true, vramMode: 'townMap' });
    /** sprites: {img, sx, sy, w, h, x, y, blink} */
    this.marks = [];
    this.blinkHidden = false;
    this.blinkCounter = 0;
  }

  get townMap() { return this.ctx.townMap; }

  /** LoadTownMap: the map tiles over the whole screen. */
  *loadTownMap() {
    yield* this.whiteOutDelay3();
    const tm = this.townMap;
    const s = this.scr;
    s.clear();
    for (let y = 0; y < tm.tilemapHeight; y++) {
      for (let x = 0; x < tm.tilemapWidth; x++) s.put(x, y, 0x60 + tm.tilemap[y * tm.tilemapWidth + x]);
    }
    yield 3;
    this.palNormal();
    this.blinkCounter = 0;
    this.blinkHidden = false;
  }

  /** TownMapSpriteBlinkingAnimation (one frame). */
  blinkStep() {
    this.blinkCounter++;
    if (this.blinkCounter === 25) this.blinkHidden = true;
    else if (this.blinkCounter === 50) { this.blinkHidden = false; this.blinkCounter = 0; }
  }

  /** The 16×16 player marker (frame 0 of red.png) at the current map. */
  playerMark() {
    const map = (this.state.pos && this.state.pos.map) || 'PALLET_TOWN';
    const c = townMapEntry(this.townMap, map);
    return { img: this.ctx.images.redSprite, sx: 0, sy: 0, w: 16, h: 16, ...markerPixel(c), blink: false };
  }

  drawExtra(fb) {
    for (const m of this.marks) {
      if (!m || !m.img) continue;
      if (m.blink && this.blinkHidden) continue;
      fb.blit(m.img, m.sx || 0, m.sy || 0, m.w, m.h, m.x, m.y, { obj: 0 });
    }
  }

  /** Print a name at (1,0), clearing the whole top row first unless `keepRow`. */
  showName(name, keepRow = false) {
    if (!keepRow) this.scr.clearArea(0, 0, 20, 1);
    this.scr.text(1, 0, name);
  }
}

/** DisplayTownMap (the TOWN MAP item). Returns when A or B is pressed. */
export class TownMapScene extends TownMapBase {
  *main() {
    yield* this.loadTownMap();
    const tm = this.townMap;
    const order = tm.order;
    const player = this.playerMark();
    const cur = { img: this.ctx.images.townMapCursor, sx: 0, sy: 0, w: 16, h: 16, x: 0, y: 0, blink: true };
    this.marks = [cur, player];
    let idx = 0;
    let mapConst = (this.state.pos && this.state.pos.map) || 'PALLET_TOWN';
    let first = true;
    for (;;) {
      const c = townMapEntry(tm, mapConst);
      Object.assign(cur, markerPixel(c));
      this.blinkHidden = false;
      // .townMapLoop clears row 0 first; the first name is printed over the map border
      this.showName(c.name, first);
      first = false;
      let k;
      for (;;) {
        this.blinkStep();
        k = this.poll(true);
        if (k.a || k.b || k.up || k.down) break;
        yield 1;
      }
      this.sfx('SFX_TINK');
      if (k.up) idx = townMapStep(idx, 'up', order.length);
      else if (k.down) idx = townMapStep(idx, 'down', order.length);
      else break;
      mapConst = order[idx];
      yield 1;
    }
    this.marks = [];
    this.palWhiteOut();
    return null;
  }
}

/**
 * LoadTownMap_Fly. Params: {destinations?: [{map, x, y}]} (visitedFlyDestinations). Returns the
 * chosen destination {map, x, y} or null (B).
 */
export class FlyMapScene extends TownMapBase {
  *main() {
    yield* this.loadTownMap();
    const tm = this.townMap;
    const gd = this.gd;
    const s = this.scr;
    const list = flyLocations(this.state.flyUnlocked | 0, gd.mapIndex.numCityMaps);
    const idToConst = (id) => gd.map(id).const;
    s.text(0, 0, 'To');
    const player = this.playerMark();
    const bird = { img: this.ctx.images.birdSprite, sx: 0, sy: 0, w: 16, h: 16, x: 0, y: 0, blink: false };
    this.marks = [bird, player];
    let pos = list.findIndex((v) => v !== NOT_VISITED);
    if (pos < 0) {
      // nowhere to fly (the GB would show garbage); behave like B
      yield* this.waitButton();
      return null;
    }
    let arrow = 18; // the de register: which arrow to blank
    for (;;) {
      s.put(arrow, 0, SPACE);
      s.clearArea(3, 0, 15, 1);
      const mapConst = idToConst(list[pos]);
      const c = townMapEntry(tm, mapConst);
      Object.assign(bird, markerPixel(c));
      s.text(3, 0, c.name);
      yield 15;
      s.text(18, 0, '▲');
      s.text(19, 0, '▼');
      let k;
      for (;;) {
        yield 1;
        k = this.poll(true);
        if (k.a || k.b || k.up || k.down) break;
      }
      if (k.a) {
        this.sfx('SFX_HEAL_AILMENT');
        const dests = this.params.destinations || [];
        const d = dests.find((x) => x.map === mapConst) || { map: mapConst };
        yield* this.whiteOutDelay3();
        return d;
      }
      this.sfx('SFX_TINK');
      if (k.up) { arrow = 18; pos = flyStep(list, pos, 'up'); continue; }
      if (k.down) { arrow = 19; pos = flyStep(list, pos, 'down'); continue; }
      yield* this.whiteOutDelay3();
      return null;
    }
  }
}

/** LoadTownMap_Nest: "<MON>'s NEST" and the blinking nests. Params: {species}. */
export class NestMapScene extends TownMapBase {
  *main() {
    yield* this.loadTownMap();
    const tm = this.townMap;
    const gd = this.gd;
    const s = this.scr;
    const sp = gd.species(this.params.species);
    const nests = nestLocations(gd, tm, sp.dex);
    this.marks = nests.map((c) => ({ img: this.ctx.images.nestIcon, sx: 0, sy: 0, w: 8, h: 8, ...nestPixel(c), blink: true }));
    if (!nests.length) {
      s.box(1, 7, 17, 4);
      s.text(2, 9, ' AREA UNKNOWN');
    } else {
      this.marks.push(this.playerMark());
    }
    const end = s.text(1, 0, sp.name);
    s.text(end.x, 0, "'s NEST");
    yield* this.waitButton({ idle: () => this.blinkStep() });
    this.marks = [];
    this.palWhiteOut();
    return null;
  }
}
