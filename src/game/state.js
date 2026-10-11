// GameState — the complete save: everything the original writes to SRAM (player name, the
// wMainData block, sprite data, party, boxes, Hall of Fame) in a JSON-friendly shape.
// See docs/game-model.md for every field and the RAM label it mirrors.

import { getGameData } from '../pokemon/data.js';
import { Mon } from '../pokemon/mon.js';
import { Bag, BAG_ITEM_CAPACITY, PC_ITEM_CAPACITY } from '../pokemon/bag.js';
import { Pokedex, NUM_BOXES, PARTY_LENGTH, MONS_PER_BOX } from '../pokemon/party.js';
import { EventFlags, Missables, HiddenItems, StatusFlags, badgeMask } from './flags.js';

/** Bump when the JSON shape changes; add a migration in save.js. */
export const SAVE_SCHEMA_VERSION = 1;

/** wOptions text delays: frames per letter (TEXT_DELAY_FAST 1, MEDIUM 3, SLOW 5). */
export const TEXT_SPEED_FRAMES = Object.freeze({ fast: 1, mid: 3, slow: 5 });
export const DEFAULT_OPTIONS = Object.freeze({ textSpeed: 'mid', battleAnimations: true, battleStyle: 'shift' });
export const FACINGS = Object.freeze(['down', 'up', 'left', 'right']);
/** The play-time counter stops at 255:59:59 (wPlayTimeMaxed). */
export const MAX_PLAY_TIME_FRAMES = ((255 * 60 + 59) * 60 + 59) * 60 + 59;
export const HALL_OF_FAME_CAPACITY = 50;

const clampInt = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.trunc(v))) : dflt);
const copyObj = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

/**
 * @typedef {{map:string, x:number, y:number, facing:'down'|'up'|'left'|'right'}} Position
 * @typedef {{map:string, x:number|null, y:number|null, warpIndex:number|null}} OutdoorPosition
 */

export class GameState {
  /** @param {object} [init] partial field values (plain JSON or live objects) */
  constructor(init = {}, gd = getGameData()) {
    const s = init;
    this.version = SAVE_SCHEMA_VERSION;
    // --- identity (wPlayerName, wRivalName, wPlayerID)
    this.playerName = s.playerName ?? 'RED';
    this.rivalName = s.rivalName ?? 'BLUE';
    this.playerId = clampInt(s.playerId, 0, 0xffff, 0);
    // --- wallet (wPlayerMoney BCD, wPlayerCoins BCD), wObtainedBadges
    this.money = clampInt(s.money, 0, 999999, 0);
    this.coins = clampInt(s.coins, 0, 9999, 0);
    this.badges = clampInt(s.badges, 0, 0xff, 0);
    // --- bit flags
    /** @type {EventFlags} */
    this.flags = EventFlags.fromJSON(s.flags ?? [], gd);
    /** @type {Missables} */
    this.missables = s.missables === undefined ? Missables.initial(gd) : Missables.fromJSON(s.missables, gd);
    /** @type {HiddenItems} */
    this.hiddenItems = HiddenItems.fromJSON(s.hiddenItems ?? []);
    /** @type {StatusFlags} */
    this.statusFlags = StatusFlags.fromJSON(s.statusFlags ?? {}, gd);
    // --- Pokémon
    /** @type {Mon[]} */
    this.party = (s.party || []).slice(0, PARTY_LENGTH).map((m) => Mon.fromJSON(m));
    /** @type {Mon[][]} 12 boxes of box mons (stats === null) */
    this.pcBoxes = Array.from({ length: NUM_BOXES }, (_, i) => ((s.pcBoxes && s.pcBoxes[i]) || [])
      .slice(0, MONS_PER_BOX).map((m) => { const mon = Mon.fromJSON(m); mon.stats = null; return mon; }));
    this.currentBox = clampInt(s.currentBox, 0, NUM_BOXES - 1, 0);
    this.boxesChanged = !!s.boxesChanged;
    /** @type {Pokedex} */
    this.pokedex = Pokedex.fromJSON(s.pokedex);
    /** @type {{mon:Mon}|null} the day-care mon in box form (its level = level when left) */
    this.dayCareMon = s.dayCareMon && s.dayCareMon.mon
      ? { mon: (() => { const m = Mon.fromJSON(s.dayCareMon.mon); m.stats = null; return m; })() }
      : null;
    // --- items
    /** @type {Bag} */
    this.bag = Bag.fromJSON(s.bag ?? [], BAG_ITEM_CAPACITY);
    /** @type {Bag} */
    this.pcItems = Bag.fromJSON(s.pcItems ?? [], PC_ITEM_CAPACITY);
    // --- where (wCurMap, wXCoord, wYCoord, wPlayerDirection; wLastMap; wLastBlackoutMap)
    /** @type {Position} */
    this.pos = { map: 'REDS_HOUSE_2F', x: 3, y: 6, facing: 'down', ...(s.pos || {}) };
    /** @type {OutdoorPosition} last outdoor map (target of LAST_MAP warps) */
    this.lastOutdoor = { map: 'PALLET_TOWN', x: null, y: null, warpIndex: null, ...(s.lastOutdoor || {}) };
    this.lastBlackoutMap = s.lastBlackoutMap ?? 'PALLET_TOWN';
    /** elevator return warp (wWarpedFromWhichWarp / wWarpedFromWhichMap) */
    this.warpedFrom = s.warpedFrom ? { ...s.warpedFrom } : null;
    /** @type {number} bit = map id of a visited town (wTownVisitedFlag, Fly targets) */
    this.flyUnlocked = Number.isFinite(s.flyUnlocked) ? s.flyUnlocked & 0xffff : 0;
    // --- movement / step state
    this.surfing = !!s.surfing;
    this.bike = !!s.bike && !this.surfing;
    this.repelSteps = clampInt(s.repelSteps, 0, 255, 0);
    this.stepCounter = clampInt(s.stepCounter, 0, 255, 0);
    /** 0 = normal palette, 6 = dark map not yet lit by Flash (wMapPalOffset) */
    this.mapPalOffset = clampInt(s.mapPalOffset, 0, 0xff, 0);
    this.safari = { steps: 0, balls: 0, gameOver: false, ...(s.safari || {}) };
    // --- options (wOptions)
    this.options = { ...DEFAULT_OPTIONS, ...(s.options || {}) };
    // --- time
    this.playTime = clampInt(s.playTime, 0, MAX_PLAY_TIME_FRAMES, 0);
    this.playTimeMaxed = !!s.playTimeMaxed;
    // --- story choices
    /** wPlayerStarter (dex number) */
    this.starterChoice = s.starterChoice ?? null;
    /** wRivalStarter (dex number) */
    this.rivalStarter = s.rivalStarter ?? null;
    /** wFossilItem / wFossilMon: fossil given to the Cinnabar lab and the dex number it becomes */
    this.fossilChoice = { item: null, mon: null, ...(s.fossilChoice || {}) };
    /** wCompletedInGameTradeFlags: bit = trade id of data/events.json trades */
    this.completedTrades = clampInt(s.completedTrades, 0, 0xffff, 0);
    /** w<Map>CurScript bytes: map → script index */
    this.currentMapScriptIndices = { ...(s.currentMapScriptIndices || {}) };
    /** Vermilion Gym trash-can locks (wFirstLockTrashCanIndex / wSecondLockTrashCanIndex) */
    this.trashCans = { first: 0, second: 0, ...(s.trashCans || {}) };
    // --- Hall of Fame (sHallOfFame, wNumHoFTeams)
    /** @type {{species:number, level:number, nickname:string}[][]} oldest first, max 50 */
    this.hallOfFame = (s.hallOfFame || []).slice(-HALL_OF_FAME_CAPACITY).map((team) => team.map((m) => ({ ...m })));
    this.hallOfFameCount = clampInt(s.hallOfFameCount, 0, 255, this.hallOfFame.length);
    // --- engine-owned blobs (saved verbatim)
    /** per-map NPC state the overworld wants to persist (the game saves wSpriteData) */
    this.objectState = copyObj(s.objectState) || {};
    /** free-form persistent script variables (e.g. Cinnabar quiz opponent) */
    this.scriptVars = copyObj(s.scriptVars) || {};
    /** RNG seed newGame used (debugging only) */
    this.seed = s.seed ?? null;
  }

  // ------------------------------------------------------------------------------ badges

  hasBadge(name) { return (this.badges & badgeMask(name)) !== 0; }
  giveBadge(name) { this.badges |= badgeMask(name); }
  get badgeCount() { let n = 0; for (let b = this.badges; b; b >>= 1) n += b & 1; return n; }

  // ------------------------------------------------------------------------------ movement

  /** wWalkBikeSurfState: 0 walking, 1 biking, 2 surfing. */
  get walkBikeSurfState() { return this.surfing ? 2 : this.bike ? 1 : 0; }

  /** Set walking / biking / surfing (mutually exclusive). */
  setMovementMode(mode) {
    if (mode === 'walk' || mode === 0) { this.bike = false; this.surfing = false; } else if (mode === 'bike' || mode === 1) { this.bike = true; this.surfing = false; } else if (mode === 'surf' || mode === 2) { this.bike = false; this.surfing = true; } else throw new Error(`unknown movement mode ${mode}`);
  }

  // ------------------------------------------------------------------------------ towns

  /**
   * MarkTownVisitedAndLoadToggleableObjects: entering any map with id < FIRST_ROUTE_MAP (the 11
   * towns, plus the never-used map $0B) sets its bit — the Fly destinations.
   */
  markTownVisited(map, gd = getGameData()) {
    const m = gd.map(map);
    if (m.id < gd.mapIndex.firstRouteMap) this.flyUnlocked |= 1 << m.id;
  }

  isTownVisited(map, gd = getGameData()) {
    const m = gd.map(map);
    return m.id < gd.mapIndex.numCityMaps && (this.flyUnlocked & (1 << m.id)) !== 0;
  }

  // ------------------------------------------------------------------------------ map scripts

  /** w<Map>CurScript of a map (key: map name "OaksLab" or const "OAKS_LAB" — normalized to the name). */
  getMapScript(map) {
    return this.currentMapScriptIndices[mapScriptKey(map)] ?? 0;
  }

  setMapScript(map, index) {
    this.currentMapScriptIndices[mapScriptKey(map)] = index & 0xff;
  }

  // ------------------------------------------------------------------------------ time

  /** Add frames to the play time (stops at 255:59:59 like wPlayTimeMaxed). */
  addPlayTime(frames = 1) {
    if (this.playTimeMaxed) return;
    this.playTime = Math.min(MAX_PLAY_TIME_FRAMES, this.playTime + frames);
    if (this.playTime >= MAX_PLAY_TIME_FRAMES) this.playTimeMaxed = true;
  }

  /** {hours, minutes, seconds, frames} of the play time (trainer card / save screen). */
  get playTimeParts() {
    let f = this.playTime;
    const frames = f % 60; f = Math.floor(f / 60);
    const seconds = f % 60; f = Math.floor(f / 60);
    const minutes = f % 60;
    const hours = Math.floor(f / 60);
    return { hours, minutes, seconds, frames };
  }

  /** Frames per letter for the current text speed (TEXT_SPEED in src/engine/text.js). */
  get textSpeedFrames() { return TEXT_SPEED_FRAMES[this.options.textSpeed] ?? 3; }

  // ------------------------------------------------------------------------------ JSON

  /** Plain JSON of the whole save (schema SAVE_SCHEMA_VERSION). */
  toJSON() {
    return {
      version: SAVE_SCHEMA_VERSION,
      playerName: this.playerName,
      rivalName: this.rivalName,
      playerId: this.playerId,
      money: this.money,
      coins: this.coins,
      badges: this.badges,
      flags: this.flags.toJSON(),
      missables: this.missables.toJSON(),
      hiddenItems: this.hiddenItems.toJSON(),
      statusFlags: this.statusFlags.toJSON(),
      party: this.party.map((m) => m.toJSON()),
      pcBoxes: this.pcBoxes.map((box) => box.map((m) => ({ ...m.toJSON(), stats: null }))),
      currentBox: this.currentBox,
      boxesChanged: this.boxesChanged,
      pokedex: this.pokedex.toJSON(),
      dayCareMon: this.dayCareMon ? { mon: { ...this.dayCareMon.mon.toJSON(), stats: null } } : null,
      bag: this.bag.toJSON(),
      pcItems: this.pcItems.toJSON(),
      pos: { ...this.pos },
      lastOutdoor: { ...this.lastOutdoor },
      lastBlackoutMap: this.lastBlackoutMap,
      warpedFrom: this.warpedFrom ? { ...this.warpedFrom } : null,
      flyUnlocked: this.flyUnlocked,
      surfing: this.surfing,
      bike: this.bike,
      repelSteps: this.repelSteps,
      stepCounter: this.stepCounter,
      mapPalOffset: this.mapPalOffset,
      safari: { ...this.safari },
      options: { ...this.options },
      playTime: this.playTime,
      playTimeMaxed: this.playTimeMaxed,
      starterChoice: this.starterChoice,
      rivalStarter: this.rivalStarter,
      fossilChoice: { ...this.fossilChoice },
      completedTrades: this.completedTrades,
      currentMapScriptIndices: { ...this.currentMapScriptIndices },
      trashCans: { ...this.trashCans },
      hallOfFame: this.hallOfFame.map((t) => t.map((m) => ({ ...m }))),
      hallOfFameCount: this.hallOfFameCount,
      objectState: copyObj(this.objectState),
      scriptVars: copyObj(this.scriptVars),
      seed: this.seed,
    };
  }

  /**
   * Rebuild from JSON (missing fields get their defaults; values are range-checked).
   * @throws if the object is not a save of this schema version
   */
  static fromJSON(obj, gd = getGameData()) {
    if (!obj || typeof obj !== 'object') throw new Error('GameState.fromJSON: not an object');
    if (obj.version !== undefined && obj.version !== SAVE_SCHEMA_VERSION) {
      throw new Error(`GameState.fromJSON: schema version ${obj.version}, expected ${SAVE_SCHEMA_VERSION} (migrate first)`);
    }
    return new GameState(obj, gd);
  }

  /** Deep copy. */
  clone() { return GameState.fromJSON(JSON.parse(JSON.stringify(this.toJSON()))); }
}

/** Normalizes a map reference to the key used in currentMapScriptIndices (the map name). */
export function mapScriptKey(map, gd = getGameData()) {
  const m = gd.findMap(map);
  return m ? m.name : String(map);
}
