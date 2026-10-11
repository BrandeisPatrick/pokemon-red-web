// Experience: growth-rate curves (CalcExperience / CalcLevelFromExperience,
// engine/pokemon/experience.asm) and exp gain (GainExperience + FaintEnemyPokemon's EXP.ALL,
// engine/battle/experience.asm, engine/battle/core.asm).

import { getGameData } from './data.js';
import { STATS, addStatExp, recalcStats } from './stats.js';

export const MAX_LEVEL = 100;
const EXP_MOD = 0x1000000; // experience is a 3-byte value

/** @param {any} rate growth-rate entry, name ("MEDIUM_SLOW") or const ("GROWTH_MEDIUM_SLOW") */
function rateOf(rate, gd) {
  return typeof rate === 'object' && rate && rate.coefficients ? rate : (gd || getGameData()).growthRate(rate);
}

/**
 * CalcExperience, bit-exact: floor(n·L³/d) ± s·L² + l·L − c computed in 3 bytes (wraps mod 2²⁴),
 * so a level-1 Medium Slow mon needs 16777162 (= −54). Works for any level 0-255.
 * @param {any} rate growth rate (entry or name)
 * @param {number} level
 * @returns {number} 0 .. 16777215
 */
export function calcExperience(rate, level, gd) {
  const { cubeNumerator: n, cubeDenominator: d, square: s, linear: l, constant: c } = rateOf(rate, gd).coefficients;
  const L = level & 0xff;
  const cube = Math.floor((n * L * L * L) / d) % EXP_MOD;
  const total = cube + s * L * L + l * L - c;
  return ((total % EXP_MOD) + EXP_MOD) % EXP_MOD;
}

/** Total experience required for `level` (24-bit, as stored). */
export function expForLevel(rate, level, gd) {
  const r = rateOf(rate, gd);
  if (level >= 1 && level <= MAX_LEVEL && Array.isArray(r.exp)) return r.exp[level - 1];
  return calcExperience(r, level, gd);
}

/** Same as expForLevel but negative for the wrapped level-1 values (−54 for Medium Slow). */
export function expForLevelSigned(rate, level, gd) {
  const v = expForLevel(rate, level, gd);
  return v >= 0x800000 ? v - EXP_MOD : v;
}

/** Experience needed for MAX_LEVEL (the cap GainExperience applies). */
export function maxExp(rate, gd) {
  return expForLevel(rate, MAX_LEVEL, gd);
}

/**
 * CalcLevelFromExperience: starting at level 2, the highest level whose requirement is <= exp
 * (so 0..8 exp is level 1 for Medium Slow, whose level-1 requirement wraps to 16777162).
 * The routine has no upper bound; we stop at MAX_LEVEL (only glitch exp values differ).
 */
export function levelForExp(rate, exp, gd) {
  const r = rateOf(rate, gd);
  let d = 1;
  while (d < MAX_LEVEL && exp >= expForLevel(r, d + 1, gd)) d++;
  return d;
}

/** Experience still missing to reach the next level (0 at level 100). */
export function expToNextLevel(rate, level, exp, gd) {
  if (level >= MAX_LEVEL) return 0;
  return Math.max(0, expForLevel(rate, level + 1, gd) - exp);
}

// ------------------------------------------------------------------------------------ gaining

/** floor(baseExp × level / 7), kept to the 16 bits the game adds. */
export function baseExpYield(baseExp, enemyLevel) {
  return Math.floor((baseExp * enemyLevel) / 7) & 0xffff;
}

/** BoostExp: exp += exp / 2 on 16 bits (traded mons, trainer battles). */
export function boostExp(exp) {
  return (exp + (exp >> 1)) & 0xffff;
}

/**
 * Exp one mon gains from a defeated foe (one GainExperience iteration).
 * @param {{baseExp:number, enemyLevel:number, traded?:boolean, trainerBattle?:boolean}} o
 *   baseExp must already be divided by the number of participants (see divideExpData)
 */
export function expGain({ baseExp, enemyLevel, traded = false, trainerBattle = false }) {
  let exp = baseExpYield(baseExp, enemyLevel);
  if (traded) exp = boostExp(exp);
  if (trainerBattle) exp = boostExp(exp);
  return exp;
}

/**
 * @typedef {object} ExpData the 7 bytes GainExperience works on (wEnemyMonBaseStats ..
 *   wEnemyMonBaseExp): 5 base stats, catch rate, base exp
 * @property {import('./stats.js').StatBlock} baseStats
 * @property {number} catchRate
 * @property {number} baseExp
 */

/** ExpData of a species. */
export function expDataFor(species, gd = getGameData()) {
  const sp = gd.species(species);
  return { baseStats: { ...sp.baseStats }, catchRate: sp.catchRate, baseExp: sp.baseExp };
}

/** DivideExpDataByNumMonsGainingExp: every byte /= n when n >= 2 (else unchanged copy). */
export function divideExpData(data, n) {
  const div = (v) => (n >= 2 ? Math.floor(v / n) : v);
  const baseStats = {};
  for (const k of STATS) baseStats[k] = div(data.baseStats[k]);
  return { baseStats, catchRate: div(data.catchRate), baseExp: div(data.baseExp) };
}

/** EXP.ALL first halves all 7 bytes (srl). */
export function halveExpData(data) {
  return divideExpData(data, 2);
}

function countBits(mask) {
  let n = 0;
  for (let m = mask; m; m >>= 1) n += m & 1;
  return n;
}

function toMask(participants) {
  if (typeof participants === 'number') return participants & 0x3f;
  let mask = 0;
  for (const i of participants || []) mask |= 1 << i;
  return mask;
}

/**
 * @typedef {object} ExpAward
 * @property {number} partyIndex
 * @property {number} exp            exp points gained (the "gained N EXP. Points!" number)
 * @property {import('./stats.js').StatBlock} statExp  stat-exp added (before the 65535 cap)
 * @property {boolean} boosted       "a boosted" (traded mon)
 * @property {boolean} withExpAll    printed "with EXP.ALL" (second pass)
 */

/**
 * Plan the experience for one fainted foe exactly like FaintEnemyPokemon + GainExperience:
 * participants share (base stats, catch rate, base exp) / n; with EXP.ALL in the bag all 7
 * values are first halved, participants get their share, then every party mon is flagged and
 * the (already divided) values are divided again by the party size — fainted mons count in
 * that divisor but get nothing. Mons with 0 HP are skipped. Nothing is mutated.
 * @param {object} o
 * @param {Array<{hp:number, otId:number}>} o.party
 * @param {number[]|number} o.participants party indices (or wPartyGainExpFlags mask) that fought
 *   the foe and did not faint
 * @param {{species:any, level:number}} o.enemy
 * @param {boolean} [o.trainerBattle]
 * @param {boolean} [o.expAll] EXP.ALL is in the bag
 * @param {number} o.playerId
 * @returns {ExpAward[]} in the order the game processes (and prints) them
 */
export function planExperience({ party, participants, enemy, trainerBattle = false, expAll = false, playerId }, gd = getGameData()) {
  if (!Number.isInteger(playerId)) throw new Error('planExperience: playerId (state.playerId) is required for the traded-mon boost');
  let data = expDataFor(enemy.species, gd);
  const awards = [];
  const pass = (mask, withExpAll) => {
    data = divideExpData(data, countBits(mask));
    party.forEach((mon, i) => {
      if (!mon || mon.hp <= 0 || !(mask & (1 << i))) return;
      const traded = (mon.otId & 0xffff) !== (playerId & 0xffff);
      awards.push({
        partyIndex: i,
        exp: expGain({ baseExp: data.baseExp, enemyLevel: enemy.level, traded, trainerBattle }),
        statExp: { ...data.baseStats },
        boosted: traded,
        withExpAll,
      });
    });
  };
  if (expAll) data = halveExpData(data);
  pass(toMask(participants), false);
  if (expAll) pass((1 << party.length) - 1, true);
  return awards;
}

/**
 * Add experience to one mon (the add + cap of GainExperience): 3-byte add that wraps, then
 * capped at the level-100 requirement. Returns the new exp; does not touch the level.
 */
export function addExp(currentExp, amount, rate, gd) {
  const exp = (currentExp + amount) % EXP_MOD;
  const cap = maxExp(rate, gd);
  return exp >= cap ? cap : exp;
}

/**
 * Apply one award (or a raw exp amount) to a party mon: stat exp, exp, and on a level change
 * the stat recalculation with stat exp and the current-HP adjustment (GainExperience). The
 * move to learn is reported (LearnMoveFromLevelUp: only the FIRST learnset entry of the final
 * level, and only if not already known) — teaching it is up to the caller
 * (learnset.js learnMove) because a full moveset needs a prompt.
 * @param {object} mon party mon (mutated)
 * @param {ExpAward|{exp:number, statExp?:object}} award
 * @returns {{oldLevel:number, newLevel:number, levelChanged:boolean, hpGain:number,
 *   oldStats:object|null, stats:object, moveToLearn:string|null, canEvolve:boolean}}
 */
export function applyExperience(mon, award, gd = getGameData()) {
  const sp = gd.species(mon.species);
  if (award.statExp) mon.statExp = addStatExp(mon.statExp, award.statExp);
  mon.exp = addExp(mon.exp, award.exp, sp.growthRate, gd);
  const oldLevel = mon.level;
  const newLevel = levelForExp(sp.growthRate, mon.exp, gd);
  if (newLevel === oldLevel) {
    return { oldLevel, newLevel, levelChanged: false, hpGain: 0, oldStats: mon.stats ? { ...mon.stats } : null,
      stats: mon.stats, moveToLearn: null, canEvolve: false };
  }
  mon.level = newLevel;
  const { oldStats, stats, hpGain } = recalcStats(mon, { keepHpDifference: true }, gd);
  const entry = sp.learnset.find((e) => e.level === newLevel);
  const known = entry && (mon.moves || []).some((m) => (m.move || m) === entry.move);
  return { oldLevel, newLevel, levelChanged: true, hpGain, oldStats, stats,
    moveToLearn: entry && !known ? entry.move : null, canEvolve: true };
}

/**
 * planExperience + applyExperience in one go (mutates the party mons).
 * @returns {Array<ExpAward & ReturnType<typeof applyExperience>>}
 */
export function awardExperience(params, gd = getGameData()) {
  return planExperience(params, gd).map((a) => ({ ...a, ...applyExperience(params.party[a.partyIndex], a, gd) }));
}
