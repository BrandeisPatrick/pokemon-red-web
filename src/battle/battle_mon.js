// The per-side battle structures of the original (wBattleMon / wEnemyMon battle_struct plus
// the per-side bytes of wBattleStatusData / wMiscBattleData) and the routines that fill and
// recompute them: LoadBattleMonFromParty, LoadEnemyMonData, CalculateModifiedStat,
// ApplyBadgeStatBoosts, QuarterSpeedDueToParalysis, HalveAttackDueToBurn, GetEnemyMonStat.
//
// Values are kept as the game keeps them: move ids (numbers), raw PP bytes (PP Ups in bits
// 6-7), status bytes, battle-status bitfields, stat modifiers 1..13 (7 = neutral). Species are
// dex numbers; types are type constants ('NORMAL', ...). Pure: no UI.

import { getGameData } from '../pokemon/data.js';
import { calcStat, calcStats } from '../pokemon/stats.js';
import { defaultMoveset } from '../pokemon/learnset.js';
import { badgeBoost } from '../pokemon/damage.js';
import { PP_MASK, PP_UP_MASK, NUM_STAT_MODS, NEUTRAL_MOD, PAR, BRN, BADGE, TRANSFORMED } from './constants.js';

/** StatModifierRatios (data/battle/stat_modifiers.asm), index = mod - 1. */
export const STAT_MODIFIER_RATIOS = Object.freeze([
  [25, 100], [28, 100], [33, 100], [40, 100], [50, 100], [66, 100],
  [1, 1],
  [15, 10], [2, 1], [25, 10], [3, 1], [35, 10], [4, 1],
]);

/** The four non-HP battle stats, in RAM order. */
export const BATTLE_STAT_KEYS = Object.freeze(['atk', 'def', 'spd', 'spc']);

/** @returns {object} a zeroed move-data block (wPlayerMoveNum .. wPlayerMoveMaxPP) */
export function emptyMoveData() {
  return { num: 0, effect: 0, power: 0, type: 'NORMAL', accuracy: 0, maxPP: 0 };
}

/**
 * Move data as it sits in the Moves table (MOVE_LENGTH bytes): the RAM copy the engine works
 * on (GetCurrentMove / ReadMove / ReloadMoveData).
 * @param {number} id move id 1-165
 */
export function moveDataById(id, gd = getGameData()) {
  const m = gd.move(id);
  return { num: m.id, effect: m.effectId, power: m.power, type: m.type, accuracy: m.accuracyByte, maxPP: m.pp };
}

/**
 * One side of the battle. Field names follow wram.asm (wBattleMon* / wEnemyMon*,
 * w<Side>BattleStatus1-3, w<Side>NumAttacksLeft, ...).
 */
export class BattleSide {
  constructor(index) {
    /** 0 = player, 1 = enemy (hWhoseTurn value of this side) */
    this.index = index;
    // ---- battle_struct
    this.species = 0; // dex number (0 = none)
    this.species2 = 0; // w<Side>MonSpecies2: the species "shown" (cries, names)
    this.nick = '';
    this.hp = 0;
    this.partyPos = 0;
    this.status = 0;
    this.type1 = 'NORMAL';
    this.type2 = 'NORMAL';
    this.catchRate = 0;
    /** @type {number[]} 4 move ids, 0 = empty */
    this.moves = [0, 0, 0, 0];
    /** @type {number[]} 4 raw PP bytes */
    this.pp = [0, 0, 0, 0];
    this.dvs = { atk: 0, def: 0, spd: 0, spc: 0 };
    this.level = 0;
    this.maxHP = 0;
    this.atk = 0;
    this.def = 0;
    this.spd = 0;
    this.spc = 0;
    // ---- w<Side>MonUnmodified* (level, max HP and the 4 stats as loaded)
    this.unmod = { level: 0, maxHP: 0, atk: 0, def: 0, spd: 0, spc: 0 };
    // ---- w<Side>MonStatMods (attack, defense, speed, special, accuracy, evasion, 2 unused)
    this.mods = new Array(NUM_STAT_MODS).fill(NEUTRAL_MOD);
    // ---- wBattleStatusData
    this.statsToDouble = 0;
    this.statsToHalve = 0;
    this.status1 = 0;
    this.status2 = 0;
    this.status3 = 0;
    this.numAttacksLeft = 0;
    this.confusedCounter = 0;
    this.toxicCounter = 0;
    /** high nibble: disabled move slot (1-4), low nibble: turns left */
    this.disabledMove = 0;
    /** w<Side>BideAccumulatedDamage (16-bit); w<Side>NumHits shares its first (high) byte */
    this.bide = 0;
    // ---- wMiscBattleData
    this.substituteHP = 0;
    this.selectedMove = 0;
    this.moveListIndex = 0;
    this.disabledMoveNumber = 0;
    this.usedMove = 0;
    this.minimized = 0;
    /** w<Side>MoveNum .. w<Side>MoveMaxPP: the move currently being executed / looked at */
    this.move = emptyMoveData();
    // ---- enemy-only block after the struct: base stats, catch rate, base exp (exp data)
    this.baseStats = { hp: 0, atk: 0, def: 0, spd: 0, spc: 0 };
    this.actualCatchRate = 0;
    this.baseExp = 0;
  }

  /** w<Side>NumHits (aliases the high byte of the Bide accumulator). */
  get numHits() { return (this.bide >> 8) & 0xff; }
  set numHits(v) { this.bide = ((v & 0xff) << 8) | (this.bide & 0xff); }

  /** Battle stat by key ('atk' ...). */
  stat(k) { return this[k]; }

  /** Number of known moves (wNumMovesMinusOne + 1). */
  get numMoves() {
    let n = 0;
    for (const m of this.moves) if (m) n++;
    return n;
  }

  /** Current PP of slot i (PP_MASK). */
  ppOf(i) { return this.pp[i] & PP_MASK; }

  /** Clear the w<Side>StatsToDouble .. w<Side>BattleStatus3 block (5 bytes). */
  clearStatusBlock() {
    this.statsToDouble = 0;
    this.statsToHalve = 0;
    this.status1 = 0;
    this.status2 = 0;
    this.status3 = 0;
  }

  /** Reset the 8 stat modifiers to neutral. */
  resetMods() {
    this.mods.fill(NEUTRAL_MOD);
  }
}

// ------------------------------------------------------------------------------- PP bytes

/** Raw PP byte of a party move slot {pp, ppUps}. */
export function rawPP(slot) {
  if (!slot) return 0;
  return (((slot.ppUps | 0) & 3) << 6) | ((slot.pp | 0) & PP_MASK);
}

/** Write a raw PP byte back into a party move slot. */
export function setRawPP(slot, raw) {
  if (!slot) return;
  slot.pp = raw & PP_MASK;
  slot.ppUps = (raw & PP_UP_MASK) >> 6;
}

/** Move ids of a party mon (4 entries, 0 = empty). */
export function partyMoveIds(mon, gd = getGameData()) {
  const out = [0, 0, 0, 0];
  (mon.moves || []).slice(0, 4).forEach((m, i) => { out[i] = gd.move(m.move || m).id; });
  return out;
}

/** Raw PP bytes of a party mon (4 entries). */
export function partyRawPP(mon) {
  const out = [0, 0, 0, 0];
  (mon.moves || []).slice(0, 4).forEach((m, i) => { out[i] = rawPP(m); });
  return out;
}

/**
 * Write battle moves + raw PP back into a party mon (LearnMove / SwapMovesInMenu / DecrementPP
 * keep the two copies in step). Moves with id 0 are dropped.
 */
export function writePartyMoves(mon, ids, pps, gd = getGameData()) {
  const slots = [];
  for (let i = 0; i < 4; i++) {
    if (!ids[i]) continue;
    const s = { move: gd.move(ids[i]).const, pp: 0, ppUps: 0 };
    setRawPP(s, pps[i]);
    slots.push(s);
  }
  mon.moves = slots;
}

// ------------------------------------------------------------------------------- loading

/**
 * LoadBattleMonFromParty: copy the party mon into wBattleMon, keep the unmodified stats,
 * apply the burn/paralysis penalties and the badge boosts, reset the stat mods.
 * @param {BattleSide} p
 * @param {import('../pokemon/mon.js').Mon} mon
 * @param {number} partyIndex
 * @param {{badges:number, link?:boolean}} o
 */
export function loadBattleMonFromParty(p, mon, partyIndex, { badges = 0, link = false } = {}, gd = getGameData()) {
  const sp = gd.species(mon.species);
  p.species = sp.dex;
  p.species2 = sp.dex;
  p.hp = mon.hp;
  p.partyPos = partyIndex;
  p.status = mon.status & 0xff;
  p.type1 = sp.types[0];
  p.type2 = sp.types[1] ?? sp.types[0];
  p.catchRate = sp.catchRate;
  p.moves = partyMoveIds(mon, gd);
  p.dvs = { atk: mon.dvs.atk, def: mon.dvs.def, spd: mon.dvs.spd, spc: mon.dvs.spc };
  p.pp = partyRawPP(mon);
  p.level = mon.level;
  const st = mon.stats;
  p.maxHP = st.hp;
  p.atk = st.atk;
  p.def = st.def;
  p.spd = st.spd;
  p.spc = st.spc;
  p.nick = mon.nickname;
  p.unmod = { level: p.level, maxHP: p.maxHP, atk: p.atk, def: p.def, spd: p.spd, spc: p.spc };
  applyBurnAndParalysisPenalties(p, p);
  if (!link) applyBadgeStatBoosts(p, badges);
  p.resetMods();
}

/**
 * LoadEnemyMonData for a wild or trainer mon (not link). For a wild mon the DVs come from two
 * BattleRandom bytes (first -> Spd/Spc, second -> Atk/Def) unless `dvs` is given or the mon is
 * transformed (then wTransformedEnemyMonOriginalDVs). Trainer mons have fixed DVs and take HP,
 * status and moves from their party data. Stats never include stat exp.
 * @param {BattleSide} e
 * @param {object} o
 * @param {number} o.species dex
 * @param {number} o.level wCurEnemyLevel
 * @param {boolean} o.trainer
 * @param {object} [o.partyMon] trainer party Mon (HP, status, moves)
 * @param {number} [o.partyIndex]
 * @param {{atk,def,spd,spc}} [o.dvs] fixed DVs (wild: replaces the random bytes)
 * @param {{atk,def,spd,spc}} [o.originalDVs] wTransformedEnemyMonOriginalDVs when transformed
 * @param {string[]} [o.moves] wild mon moves override (scripted encounters)
 * @param {{randByte:()=>number}} rng
 */
export function loadEnemyMonData(e, o, rng, gd = getGameData()) {
  const sp = gd.species(o.species);
  e.species = sp.dex;
  const transformed = (e.status3 & TRANSFORMED) !== 0;
  let dvs;
  if (transformed && o.originalDVs) dvs = { ...o.originalDVs };
  else if (o.trainer) dvs = { atk: 9, def: 8, spd: 8, spc: 8 };
  else if (o.dvs) dvs = { atk: o.dvs.atk & 15, def: o.dvs.def & 15, spd: o.dvs.spd & 15, spc: o.dvs.spc & 15 };
  else {
    const b = rng.randByte() & 0xff; // -> Spd/Spc
    const a = rng.randByte() & 0xff; // -> Atk/Def
    dvs = { atk: a >> 4, def: a & 15, spd: b >> 4, spc: b & 15 };
  }
  e.dvs = dvs;
  e.level = o.level;
  const stats = calcStats(sp.baseStats, dvs, null, o.level, false);
  e.maxHP = stats.hp;
  e.atk = stats.atk;
  e.def = stats.def;
  e.spd = stats.spd;
  e.spc = stats.spc;
  if (o.trainer) {
    const pm = o.partyMon;
    e.hp = pm.hp;
    e.partyPos = o.partyIndex;
    e.status = pm.status & 0xff;
  } else if (!transformed) {
    e.hp = e.maxHP;
    e.status = 0;
  }
  e.type1 = sp.types[0];
  e.type2 = sp.types[1] ?? sp.types[0];
  e.catchRate = sp.catchRate;
  if (o.trainer) {
    e.moves = partyMoveIds(o.partyMon, gd);
  } else {
    const list = o.moves && o.moves.length ? o.moves : defaultMoveset(sp.dex, o.level, gd);
    e.moves = [0, 0, 0, 0];
    list.slice(0, 4).forEach((m, i) => { e.moves[i] = gd.move(m).id; });
  }
  // LoadMovePPs: base PP of each move (no PP Ups)
  e.pp = e.moves.map((id) => (id ? gd.move(id).pp : 0));
  e.baseStats = { ...sp.baseStats };
  e.actualCatchRate = sp.catchRate;
  e.baseExp = sp.baseExp;
  e.nick = sp.name;
  e.unmod = { level: e.level, maxHP: e.maxHP, atk: e.atk, def: e.def, spd: e.spd, spc: e.spc };
  e.resetMods();
  return dvs;
}

// --------------------------------------------------------------------------- stat changes

/**
 * CalculateModifiedStat for one stat (0 atk .. 3 spc) of a side: unmodified * ratio, capped
 * at 999, at least 1.
 */
export function calculateModifiedStat(side, statIndex) {
  const key = BATTLE_STAT_KEYS[statIndex];
  const [num, den] = STAT_MODIFIER_RATIOS[side.mods[statIndex] - 1];
  let v = Math.floor((side.unmod[key] * num) / den);
  if (v >= 999) v = 999;
  if (v === 0) v = 1;
  side[key] = v;
}

/** CalculateModifiedStats: all four. */
export function calculateModifiedStats(side) {
  for (let i = 0; i < 4; i++) calculateModifiedStat(side, i);
}

/**
 * QuarterSpeedDueToParalysis of `target` (the side whose turn it is NOT): speed / 4 (16-bit
 * shift), at least 1, if paralysed.
 */
export function quarterSpeedDueToParalysis(target) {
  if (!(target.status & PAR)) return;
  let v = (target.spd >> 2) & 0xffff;
  if (v === 0) v = 1;
  target.spd = v;
}

/** HalveAttackDueToBurn of `target`: attack / 2, at least 1, if burned. */
export function halveAttackDueToBurn(target) {
  if (!(target.status & BRN)) return;
  let v = (target.atk >> 1) & 0xffff;
  if (v === 0) v = 1;
  target.atk = v;
}

/** ApplyBurnAndParalysisPenalties to `target` (speed first, then attack). */
export function applyBurnAndParalysisPenalties(_unused, target) {
  quarterSpeedDueToParalysis(target);
  halveAttackDueToBurn(target);
}

/**
 * ApplyBadgeStatBoosts to the player's battle stats (not in link battles): Boulder -> Attack,
 * Thunder -> Defense, Soul -> Speed, Volcano -> Special, each stat += stat / 8, capped at 999.
 */
export function applyBadgeStatBoosts(p, badges) {
  if (badges & (1 << BADGE.BOULDER)) p.atk = badgeBoost(p.atk);
  if (badges & (1 << BADGE.THUNDER)) p.def = badgeBoost(p.def);
  if (badges & (1 << BADGE.SOUL)) p.spd = badgeBoost(p.spd);
  if (badges & (1 << BADGE.VOLCANO)) p.spc = badgeBoost(p.spc);
}

/**
 * GetEnemyMonStat (not link): the enemy's stat recomputed from its current species' base
 * stats, its DVs and its level, without stat exp (critical hits use it).
 * @param {BattleSide} e
 * @param {'atk'|'def'|'spd'|'spc'} key
 */
export function getEnemyMonStat(e, key, gd = getGameData()) {
  const sp = gd.species(e.species);
  return calcStat(sp.baseStats[key], e.dvs[key], 0, e.level, false, false);
}
