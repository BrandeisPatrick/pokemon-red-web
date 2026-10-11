// The Pokémon model: one class for party mons and box mons (box mons have stats === null),
// constructors that follow the game's routines, and small HP/status/PP helpers.
//
//   makeMon         _AddPartyMon outside battle (starters, gifts, prizes, trades)
//   makeWildMon     LoadEnemyMonData for a wild mon
//   makeTrainerMon  _AddPartyMon for an enemy trainer party (fixed DVs)
//   makeCaughtMon   what ItemUseBall adds after a capture
//   toBoxMon / fromBoxMon   _MoveMon party ↔ box (box mons drop their stats; withdrawing
//                    recomputes the level from exp and the stats with stat exp)

import { getGameData } from './data.js';
import { Rng } from '../engine/rng.js';
import { calcStats, normalizeDVs, randomDVs, trainerDVs, zeroStatExp, statsForMon, STATS } from './stats.js';
import { expForLevel, levelForExp, MAX_LEVEL } from './exp.js';
import { defaultMoveset, NUM_MOVES } from './learnset.js';
import { statusCode } from './status.js';

/** Max characters of a nickname / OT name (NAME_LENGTH 11 bytes incl. the terminator). */
export const NAME_LENGTH = 10;
/** Max characters of the player / rival name (PLAYER_NAME_LENGTH 8 incl. the terminator). */
export const PLAYER_NAME_LENGTH = 7;
export const MAX_PP_UPS = 3;

let fallbackRng = null;
function defaultRng() {
  if (!fallbackRng) fallbackRng = new Rng();
  return fallbackRng;
}

/**
 * @typedef {{move:string, pp:number, ppUps:number}} MoveSlot  move = move const; pp = current
 *   PP; ppUps = PP Ups used (0-3) — the game packs both into one byte (bits 6-7 = PP Ups)
 * @typedef {import('./stats.js').StatBlock} StatBlock
 * @typedef {import('./stats.js').DVs} DVs
 */

export class Mon {
  /**
   * @param {object} [o]
   * @param {number} o.species dex number
   * @param {string} [o.nickname]
   * @param {string} [o.otName]
   * @param {number} [o.otId] 0-65535
   * @param {number} [o.level]
   * @param {number} [o.exp]
   * @param {number} [o.hp]
   * @param {number} [o.status] status byte (see status.js)
   * @param {Array<MoveSlot|string>} [o.moves]
   * @param {DVs} [o.dvs]
   * @param {Partial<StatBlock>} [o.statExp]
   * @param {StatBlock|null} [o.stats] null for a box mon
   */
  constructor(o = {}) {
    /** @type {number} dex number */
    this.species = o.species;
    this.nickname = o.nickname ?? '';
    this.otName = o.otName ?? '';
    this.otId = (o.otId ?? 0) & 0xffff;
    this.level = o.level ?? 1;
    this.exp = o.exp ?? 0;
    this.hp = o.hp ?? 0;
    this.status = (o.status ?? 0) & 0xff;
    /** @type {MoveSlot[]} 0-4 entries, no empty placeholders */
    this.moves = (o.moves || []).slice(0, NUM_MOVES).map((m) => (typeof m === 'string'
      ? { move: m, pp: 0, ppUps: 0 }
      : { move: m.move, pp: m.pp | 0, ppUps: (m.ppUps | 0) & 3 }));
    /** @type {DVs} */
    this.dvs = normalizeDVs(o.dvs || { atk: 0, def: 0, spd: 0, spc: 0 });
    /** @type {StatBlock} */
    this.statExp = { ...zeroStatExp(), ...(o.statExp || {}) };
    /** @type {StatBlock|null} party stats; null while stored in a box / the day care */
    this.stats = o.stats ? { ...o.stats } : null;
  }

  /** Max HP (computed from the species for a box mon). */
  get maxHP() {
    return this.stats ? this.stats.hp : statsForMon(this).hp;
  }

  get isFainted() { return this.hp <= 0; }
  get isBoxMon() { return this.stats === null; }

  /** Species data (data/pokemon.json entry). */
  get data() { return getGameData().species(this.species); }
  get speciesConst() { return this.data.const; }
  get speciesName() { return this.data.name; }
  get types() { return this.data.types; }

  /** Printed status: "FNT", "PSN", ..., or "". */
  get statusLabel() {
    if (!this.hp) return 'FNT';
    return statusCode(this.status) || '';
  }

  /** Plain JSON (what the save file stores). */
  toJSON() {
    return {
      species: this.species,
      nickname: this.nickname,
      otName: this.otName,
      otId: this.otId,
      level: this.level,
      exp: this.exp,
      hp: this.hp,
      status: this.status,
      moves: this.moves.map((m) => ({ move: m.move, pp: m.pp, ppUps: m.ppUps })),
      dvs: { atk: this.dvs.atk, def: this.dvs.def, spd: this.dvs.spd, spc: this.dvs.spc },
      statExp: { ...this.statExp },
      stats: this.stats ? { ...this.stats } : null,
    };
  }

  /** @returns {Mon} */
  static fromJSON(o) {
    return o instanceof Mon ? o.clone() : new Mon(o);
  }

  /** Deep copy. */
  clone() {
    return new Mon(this.toJSON());
  }
}

/** Build MoveSlots from move consts / partial slots, filling PP with the move's max PP. */
export function moveSlots(list, gd = getGameData()) {
  return (list || []).slice(0, NUM_MOVES).map((m) => {
    const isStr = typeof m === 'string' || typeof m === 'number';
    const data = gd.move(isStr ? m : m.move);
    const ppUps = isStr ? 0 : (m.ppUps | 0) & 3;
    const max = maxPPFor(data.pp, ppUps);
    return { move: data.const, pp: isStr || m.pp === undefined ? max : Math.min(m.pp, max), ppUps };
  });
}

// --------------------------------------------------------------------------------- creation

/**
 * A new party mon exactly like _AddPartyMon outside battle: random DVs (two Random() bytes,
 * the first → Spd/Spc) unless given, moves = WriteMonMoves default (last 4 level-up moves) with
 * full PP, stat exp 0, exp = CalcExperience(level) (24-bit: a level-1 Medium Slow mon gets
 * 16777162 like the game), stats without stat exp, full HP, no status, nickname = species name.
 * Pokédex flags are NOT touched here (see party.js giveMon / addCaughtMon).
 * @param {object} o
 * @param {any} o.species dex number, const or name
 * @param {number} o.level 1-100
 * @param {string} [o.otName]
 * @param {number} [o.otId]
 * @param {DVs} [o.dvs]
 * @param {Array<string|MoveSlot>} [o.moves]
 * @param {string} [o.nickname]
 * @param {{randByte:()=>number}} [o.rng] for the DVs (default: a Date-seeded engine Rng)
 * @returns {Mon}
 */
export function makeMon({ species, level, otName = '', otId = 0, dvs, moves, nickname, rng } = {}, gd = getGameData()) {
  const sp = gd.species(species);
  if (!(level >= 1 && level <= MAX_LEVEL)) throw new RangeError(`makeMon: level ${level} out of range`);
  const d = dvs ? normalizeDVs(dvs) : randomDVs(rng || defaultRng());
  const mon = new Mon({
    species: sp.dex, nickname: nickname ?? sp.name, otName, otId, level,
    exp: expForLevel(sp.growthRate, level, gd), status: 0, dvs: d, statExp: zeroStatExp(),
  });
  mon.moves = moveSlots(moves ?? defaultMoveset(sp.dex, level, gd), gd);
  mon.stats = calcStats(sp.baseStats, d, mon.statExp, level, false);
  mon.hp = mon.stats.hp;
  return mon;
}

/**
 * A wild mon as LoadEnemyMonData builds it: random DVs (first BattleRandom byte → Spd/Spc),
 * stats without stat exp, full HP, no status, default moves with full PP. otName/otId empty.
 */
export function makeWildMon({ species, level, dvs, rng } = {}, gd = getGameData()) {
  const sp = gd.species(species);
  const d = dvs ? normalizeDVs(dvs) : randomDVs(rng || defaultRng());
  const mon = new Mon({ species: sp.dex, nickname: sp.name, level, exp: expForLevel(sp.growthRate, level, gd), dvs: d });
  mon.moves = moveSlots(defaultMoveset(sp.dex, level, gd), gd);
  mon.stats = calcStats(sp.baseStats, d, null, level, false);
  mon.hp = mon.stats.hp;
  return mon;
}

/**
 * An enemy trainer's mon (_AddPartyMon with ENEMY_PARTY_DATA): fixed DVs Atk 9 / Def 8 /
 * Spd 8 / Spc 8 (HP 8), default moves unless `moves` given (special moves are applied by
 * trainer.js), stats without stat exp, full HP.
 */
export function makeTrainerMon({ species, level, moves, otName = '', otId = 0 } = {}, gd = getGameData()) {
  const sp = gd.species(species);
  const d = trainerDVs();
  const mon = new Mon({ species: sp.dex, nickname: sp.name, otName, otId, level, exp: expForLevel(sp.growthRate, level, gd), dvs: d });
  mon.moves = moveSlots(moves ?? defaultMoveset(sp.dex, level, gd), gd);
  mon.stats = calcStats(sp.baseStats, d, null, level, false);
  mon.hp = mon.stats.hp;
  return mon;
}

/**
 * The mon the player receives after a successful capture (ItemUseBall reloads the enemy with
 * LoadEnemyMonData keeping its DVs, current HP and status, then AddPartyMon / SendNewMonToBox):
 * same DVs, level, HP and status; FRESH stats (no stages), the default moveset for the level
 * with full PP (moves learned in battle, e.g. via Mimic, are not kept), OT = player, exp =
 * CalcExperience(level), stat exp 0. A transformed wild mon is caught as DITTO (game bug).
 * @param {{species:any, level:number, dvs:DVs, hp:number, status?:number, transformed?:boolean}} enemy
 * @param {{otName:string, otId:number, toBox?:boolean}} o toBox → returned as a box mon
 */
export function makeCaughtMon(enemy, { otName, otId, toBox = false } = {}, gd = getGameData()) {
  const species = enemy.transformed ? 'DITTO' : enemy.species;
  const mon = makeMon({ species, level: enemy.level, otName, otId, dvs: enemy.dvs }, gd);
  mon.hp = Math.min(enemy.hp, mon.stats.hp);
  mon.status = (enemy.status || 0) & 0xff;
  return toBox ? toBoxMon(mon) : mon;
}

// --------------------------------------------------------------------------------- box moves

/**
 * Party → box (or day care): the box struct keeps species, HP, level (box level), status,
 * moves/PP, OT, exp, stat exp and DVs; the party stats are dropped.
 * @returns {Mon} a new Mon with stats === null
 */
export function toBoxMon(mon) {
  const m = Mon.fromJSON(mon);
  m.stats = null;
  return m;
}

/**
 * Box (or day care) → party: _MoveMon recomputes the level from exp (CalcLevelFromExperience)
 * and the stats WITH stat exp (CalcStats b=1). HP and status are kept as stored.
 * @returns {Mon} a new party Mon
 */
export function fromBoxMon(mon, gd = getGameData()) {
  const m = Mon.fromJSON(mon);
  const sp = gd.species(m.species);
  m.level = levelForExp(sp.growthRate, m.exp, gd);
  m.stats = calcStats(sp.baseStats, m.dvs, m.statExp, m.level, true);
  return m;
}

/** Stats a box mon would show on its status screen (box level, with stat exp). */
export function boxMonStats(mon, gd = getGameData()) {
  return statsForMon(mon, true, gd);
}

// ---------------------------------------------------------------------------------- PP

/** Max PP of a move with n PP Ups: base + n·min(7, floor(base/5)) (GetMaxPP/AddBonusPP). */
export function maxPPFor(basePP, ppUps = 0) {
  const bonus = Math.min(7, Math.floor(basePP / 5));
  return basePP + (ppUps & 3) * bonus;
}

/** Max PP of a move slot. */
export function maxPP(slot, gd = getGameData()) {
  return maxPPFor(gd.move(slot.move).pp, slot.ppUps);
}

/** PP restored by one PP Up / the bonus per PP Up: min(7, floor(base/5)). */
export function ppUpBonus(move, gd = getGameData()) {
  return Math.min(7, Math.floor(gd.move(move).pp / 5));
}

/** Restore every move's PP to its max (with PP Ups). */
export function restoreAllPP(mon, gd = getGameData()) {
  for (const m of mon.moves) m.pp = maxPP(m, gd);
  return mon;
}

// ---------------------------------------------------------------------------------- HP / status

/** HealParty for one mon (Pokémon Center, Mom, blackout): full HP, no status, full PP. */
export function healMon(mon, gd = getGameData()) {
  if (!mon.stats) mon.stats = statsForMon(mon, true, gd);
  mon.hp = mon.stats.hp;
  mon.status = 0;
  restoreAllPP(mon, gd);
  return mon;
}

/** Lose `amount` HP (floored at 0). @returns {{lost:number, fainted:boolean}} */
export function damageMon(mon, amount) {
  const lost = Math.min(mon.hp, Math.max(0, amount | 0));
  mon.hp -= lost;
  return { lost, fainted: mon.hp === 0 };
}

/** Gain up to `amount` HP (capped at max HP). @returns {number} HP actually restored */
export function restoreHP(mon, amount) {
  const max = mon.maxHP;
  const gained = Math.max(0, Math.min(max - mon.hp, amount | 0));
  mon.hp += gained;
  return gained;
}

/** Set the status byte (see status.js statusFromCode). */
export function setStatus(mon, status) {
  mon.status = status & 0xff;
  return mon;
}

/** Clear the status. */
export function clearStatus(mon) {
  mon.status = 0;
  return mon;
}

/** True if the mon was traded in (exp boost / obedience): OT id differs from the player's. */
export function isTraded(mon, playerId) {
  return (mon.otId & 0xffff) !== (playerId & 0xffff);
}

/** @returns {boolean} every STATS key present and numeric */
export function hasValidStats(mon) {
  return !!mon.stats && STATS.every((k) => Number.isInteger(mon.stats[k]));
}
