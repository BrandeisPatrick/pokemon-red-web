// Gen 1 stats: CalcStat (home/move_mon.asm), DVs, stat experience.
// Pure functions; species data is only read by the helpers at the bottom.

import { getGameData } from './data.js';

/** Stat keys in the game's order (HP, Attack, Defense, Speed, Special). */
export const STATS = Object.freeze(['hp', 'atk', 'def', 'spd', 'spc']);
/** The four non-HP stats in RAM order (wBattleMonAttack ...). */
export const BATTLE_STATS = Object.freeze(['atk', 'def', 'spd', 'spc']);
export const MAX_STAT_VALUE = 999;
export const MAX_STAT_EXP = 65535;
export const MAX_DV = 15;
/** ATKDEFDV_TRAINER = $98, SPDSPCDV_TRAINER = $88 (constants/battle_constants.asm) → HP DV 8. */
export const ATKDEFDV_TRAINER = 0x98;
export const SPDSPCDV_TRAINER = 0x88;
export const TRAINER_DVS = Object.freeze({ atk: 9, def: 8, spd: 8, spc: 8 });

/**
 * @typedef {{atk:number, def:number, spd:number, spc:number, hp?:number}} DVs
 * @typedef {{hp:number, atk:number, def:number, spd:number, spc:number}} StatBlock
 */

/** HP DV = LSBs of Atk, Def, Spd, Spc (in that order, Atk = bit 3). */
export function hpDV(dvs) {
  return ((dvs.atk & 1) << 3) | ((dvs.def & 1) << 2) | ((dvs.spd & 1) << 1) | (dvs.spc & 1);
}

/** DVs from the two stored bytes (byte 0 = Atk<<4|Def, byte 1 = Spd<<4|Spc); includes hp. */
export function dvsFromBytes(atkDef, spdSpc) {
  const d = { atk: (atkDef >> 4) & 15, def: atkDef & 15, spd: (spdSpc >> 4) & 15, spc: spdSpc & 15 };
  return { ...d, hp: hpDV(d) };
}

/** @returns {[number, number]} the two DV bytes */
export function dvsToBytes(dvs) {
  return [((dvs.atk & 15) << 4) | (dvs.def & 15), ((dvs.spd & 15) << 4) | (dvs.spc & 15)];
}

/** Copy of `dvs` with hp recomputed (a stored hp value is ignored: Gen 1 derives it). */
export function normalizeDVs(dvs) {
  const d = { atk: dvs.atk & 15, def: dvs.def & 15, spd: dvs.spd & 15, spc: dvs.spc & 15 };
  return { ...d, hp: hpDV(d) };
}

/** All four DVs = n (handy for tests: 0 → HP DV 0, 15 → HP DV 15). */
export function uniformDVs(n) {
  return normalizeDVs({ atk: n, def: n, spd: n, spc: n });
}

/**
 * Random DVs exactly as _AddPartyMon / LoadEnemyMonData draw them: two random bytes, the
 * FIRST becomes byte 1 (Spd/Spc), the SECOND byte 0 (Atk/Def).
 * @param {{randByte:()=>number}} rng
 */
export function randomDVs(rng) {
  const spdSpc = rng.randByte() & 0xff;
  const atkDef = rng.randByte() & 0xff;
  return dvsFromBytes(atkDef, spdSpc);
}

/** Fixed trainer DVs (Atk 9, Def 8, Spd 8, Spc 8, HP 8). */
export function trainerDVs() {
  return normalizeDVs(TRAINER_DVS);
}

/**
 * The stat-exp term of CalcStat before the /4: smallest b >= 1 with b*b >= statExp, but the
 * loop stops at 255 ("ceil(sqrt)", capped).
 */
export function statExpBonus(statExp) {
  const e = Math.max(0, Math.min(MAX_STAT_EXP, statExp | 0));
  let b = 0;
  for (;;) {
    b++;
    if (b === 255) return 255;
    if (b * b >= e) return b;
  }
}

/**
 * CalcStat for one stat.
 *   stat = floor(((base + DV) * 2 + floor(bonus / 4)) * level / 100) + 5
 *   HP   = floor(((base + DV) * 2 + floor(bonus / 4)) * level / 100) + level + 10
 * capped at 999. `useStatExp` = the routine's b argument (enemy mons and fresh party mons: false).
 */
export function calcStat(base, dv, statExp, level, isHP, useStatExp = true) {
  const bonus = useStatExp ? statExpBonus(statExp) : 0;
  const core = Math.floor((((base + dv) * 2) + (bonus >> 2)) * level / 100);
  const v = core + (isHP ? level + 10 : 5);
  return v > MAX_STAT_VALUE ? MAX_STAT_VALUE : v;
}

/**
 * All five stats (CalcStats).
 * @param {StatBlock} baseStats
 * @param {DVs} dvs
 * @param {Partial<StatBlock>} [statExp]
 * @param {number} level
 * @param {boolean} [useStatExp=true]
 * @returns {StatBlock}
 */
export function calcStats(baseStats, dvs, statExp, level, useStatExp = true) {
  const d = normalizeDVs(dvs);
  const se = statExp || {};
  const out = {};
  for (const k of STATS) out[k] = calcStat(baseStats[k], d[k], se[k] || 0, level, k === 'hp', useStatExp);
  return out;
}

/** A zeroed stat-exp block. */
export function zeroStatExp() {
  return { hp: 0, atk: 0, def: 0, spd: 0, spc: 0 };
}

/**
 * Stat exp after defeating a foe (GainExperience): each stat exp += the foe's base stat (already
 * divided by the number of participants by the caller if needed), each capped at 65535.
 * @param {Partial<StatBlock>} statExp
 * @param {StatBlock} gains usually the defeated species' base stats
 * @returns {StatBlock} new object
 */
export function addStatExp(statExp, gains) {
  const out = {};
  for (const k of STATS) out[k] = Math.min(MAX_STAT_EXP, ((statExp && statExp[k]) || 0) + ((gains && gains[k]) || 0));
  return out;
}

// --------------------------------------------------------------------------------- mon helpers

/**
 * Stats of a mon-like object {species, level, dvs, statExp} from its species' base stats.
 * @param {{species:any, level:number, dvs:DVs, statExp?:Partial<StatBlock>}} mon
 * @param {boolean} [useStatExp=true] false for enemy/trainer mons and fresh AddPartyMon stats
 */
export function statsForMon(mon, useStatExp = true, gd = getGameData()) {
  const sp = gd.species(mon.species);
  return calcStats(sp.baseStats, mon.dvs, mon.statExp, mon.level, useStatExp);
}

/**
 * Recalculate a party mon's stats with stat exp (level-up, Rare Candy, evolution, vitamins)
 * and, if `keepHpDifference`, add the max-HP change to the current HP exactly like
 * GainExperience / EvolutionAfterBattle / Rare Candy (current HP += newMax - oldMax; a fainted
 * mon given a Rare Candy therefore gets HP back). Vitamins don't touch current HP.
 * Mutates `mon.stats` (and `mon.hp`).
 * @returns {{oldStats:StatBlock|null, stats:StatBlock, hpGain:number}}
 */
export function recalcStats(mon, { keepHpDifference = true } = {}, gd = getGameData()) {
  const oldStats = mon.stats ? { ...mon.stats } : null;
  const stats = statsForMon(mon, true, gd);
  mon.stats = stats;
  let hpGain = 0;
  if (keepHpDifference && oldStats) {
    hpGain = stats.hp - oldStats.hp;
    mon.hp = Math.max(0, Math.min(0xffff, mon.hp + hpGain));
  }
  return { oldStats, stats, hpGain };
}
