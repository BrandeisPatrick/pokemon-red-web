// Type effectiveness with the Gen 1 TypeEffects table (data/types.json, source order kept):
// AdjustDamageForMoveType applies every matching row separately with flooring, and the
// "super effective" message uses only the last matching row. Gen 1 quirks come with the data
// (Ghost→Psychic 0, Bug↔Poison 2, Ice→Fire 1, Psychic only resisted by Psychic).

import { getGameData } from './data.js';

export const SUPER_EFFECTIVE = 20;
export const EFFECTIVE = 10;
export const NOT_VERY_EFFECTIVE = 5;
export const NO_EFFECT = 0;
/** AIGetTypeEffectiveness starts from $10 instead of EFFECTIVE (10) — a bug kept as data. */
export const AI_TYPE_EFFECTIVENESS_DEFAULT = 0x10;
/** Types with id >= 20 (SPECIAL) are special. */
export const SPECIAL_TYPE_THRESHOLD = 20;

/** @returns {boolean} true for special types (Fire, Water, Grass, Electric, Psychic, Ice, Dragon) */
export function isSpecialType(type, gd = getGameData()) {
  return gd.type(type).id >= SPECIAL_TYPE_THRESHOLD;
}

/** 'physical' | 'special' for a type const (Gen 1 splits by type, not by move). */
export function typeCategory(type, gd = getGameData()) {
  return isSpecialType(type, gd) ? 'special' : 'physical';
}

/** 'physical' | 'special' for a move (by its type). */
export function moveCategory(move, gd = getGameData()) {
  return typeCategory(gd.move(move).type, gd);
}

/**
 * Matching TypeEffects rows (source order) for a move type against a defender.
 * A row matches if its defender equals either defender type; a mono-type mon (both types the
 * same) matches each row at most once.
 */
export function matchingRows(attackType, defType1, defType2 = defType1, gd = getGameData()) {
  return gd.typeMatchups.filter((r) => r.attacker === attackType && (r.defender === defType1 || r.defender === defType2));
}

/**
 * Total multiplier (product of matching rows): 4, 2, 1, 0.5, 0.25 or 0.
 * Note the game floors after each row; use applyTypeEffectiveness() for damage.
 */
export function effectiveness(attackType, defType1, defType2 = defType1, gd = getGameData()) {
  let m = 1;
  for (const r of matchingRows(attackType, defType1, defType2, gd)) m *= r.factor / 10;
  return m;
}

/**
 * The type step of AdjustDamageForMoveType (after STAB): for every matching row in order
 * damage = floor(damage * factor / 10); if a row leaves 0 damage the move misses (factor 0:
 * "doesn't affect"; a ¼× hit on 2-3 damage also becomes 0 → "missed").
 * @returns {{damage:number, missed:boolean, immune:boolean, lastFactor:number|null,
 *   multiplier:number, rows:object[]}} lastFactor = wDamageMultipliers' factor (message source;
 *   null when no row matched = neutral)
 */
export function applyTypeEffectiveness(damage, attackType, defType1, defType2 = defType1, gd = getGameData()) {
  const rows = matchingRows(attackType, defType1, defType2, gd);
  let d = damage;
  let missed = false;
  let immune = false;
  let multiplier = 1;
  for (const r of rows) {
    d = Math.floor((d * r.factor) / 10) & 0xffff;
    multiplier *= r.factor / 10;
    if (r.factor === 0) immune = true;
    if (d === 0) missed = true;
  }
  return { damage: d, missed, immune, lastFactor: rows.length ? rows[rows.length - 1].factor : null, multiplier, rows };
}

/**
 * Message class from the last matching row like the game prints it:
 * 'super' (factor 20), 'notVery' (5), 'none' (0) or 'neutral'.
 */
export function effectivenessMessage(lastFactor) {
  if (lastFactor === null || lastFactor === undefined || lastFactor === EFFECTIVE) return 'neutral';
  if (lastFactor > EFFECTIVE) return 'super';
  if (lastFactor === 0) return 'none';
  return 'notVery';
}

/**
 * AIGetTypeEffectiveness: factor of the FIRST matching row only, default $10 (bug) when none.
 * Used by trainer AI layer 3 (> $10 super effective, < $10 not very effective).
 */
export function aiTypeEffectiveness(moveType, defType1, defType2 = defType1, gd = getGameData()) {
  const row = gd.typeMatchups.find((r) => r.attacker === moveType && (r.defender === defType1 || r.defender === defType2));
  return row ? row.factor : AI_TYPE_EFFECTIVENESS_DEFAULT;
}

/** STAB check: the move type equals either attacker type. */
export function isStab(moveType, attackerTypes) {
  return attackerTypes[0] === moveType || attackerTypes[1] === moveType;
}
