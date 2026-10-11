// Gen 1 battle math as small pure steps, in the order engine/battle/core.asm runs them:
//   CriticalHitTest → GetDamageVars → CalculateDamage → AdjustDamageForMoveType (STAB, types)
//   → RandomizeDamage → MoveHitTest
// plus stat stages (CalculateModifiedStat), badge boosts (ApplyBadgeStatBoosts), burn/paralysis
// penalties, fixed-damage moves, Counter, OHKO, confusion self-hits and running away.
// Random numbers come from an `rng` with randByte() (src/engine/rng.js); each step documents
// how many bytes it consumes so the battle engine can keep the game's RNG order.

import { getGameData } from './data.js';
import { applyTypeEffectiveness, isStab, isSpecialType } from './types.js';

export const MAX_STAT_VALUE = 999;
export const MIN_NEUTRAL_DAMAGE = 2;
export const MAX_NEUTRAL_DAMAGE = 999;
export const MIN_STAGE = -6;
export const MAX_STAGE = 6;
export const RANDOM_FACTOR_MIN = 217; // 85 percent + 1
export const RANDOM_FACTOR_MAX = 255;
export const OHKO_DAMAGE = 0xffff;
export const SONICBOOM_DAMAGE = 20;
export const DRAGON_RAGE_DAMAGE = 40;
export const CONFUSION_DAMAGE_POWER = 40;

/** StatModifierRatios, index = stage + 6 (data/battle/stat_modifiers.asm). */
export const STAT_STAGE_RATIOS = Object.freeze([
  [25, 100], [28, 100], [33, 100], [40, 100], [50, 100], [66, 100],
  [1, 1],
  [15, 10], [2, 1], [25, 10], [3, 1], [35, 10], [4, 1],
]);

/** Badge → stat it boosts by 1/8 in battle (bit = wObtainedBadges bit). */
export const BADGE_STAT_BOOSTS = Object.freeze([
  { badge: 'BOULDERBADGE', bit: 0, stat: 'atk' },
  { badge: 'THUNDERBADGE', bit: 2, stat: 'def' },
  { badge: 'SOULBADGE', bit: 4, stat: 'spd' },
  { badge: 'VOLCANOBADGE', bit: 6, stat: 'spc' },
]);

/** Effect ids (constants/move_effect_constants.asm) used by the steps below. */
export const EFFECT = Object.freeze({
  EXPLODE: 0x07, DREAM_EATER: 0x08, SWIFT: 0x11, ATTACK_DOWN1: 0x12, HAZE: 0x19,
  TWO_TO_FIVE_ATTACKS: 0x1d, EFFECT_1E: 0x1e, OHKO: 0x26, SUPER_FANG: 0x28, SPECIAL_DAMAGE: 0x29,
  ATTACK_DOWN2: 0x3a, REFLECT: 0x41,
});

const clampStage = (s) => Math.max(MIN_STAGE, Math.min(MAX_STAGE, s | 0));
const byte = (rng) => rng.randByte() & 0xff;

// ------------------------------------------------------------------------------- stat stages

/** [numerator, denominator] for a stage -6..+6. */
export function stageRatio(stage) {
  return STAT_STAGE_RATIOS[clampStage(stage) + 6];
}

/** Stage (-6..6) ↔ the RAM "mod" byte (1..13, 7 = neutral). */
export const stageToMod = (stage) => clampStage(stage) + 7;
export const modToStage = (mod) => clampStage(mod - 7);

/**
 * CalculateModifiedStat: floor(unmodified · num / den), capped at 999, at least 1.
 * Always computed from the unmodified stat.
 */
export function applyStatStage(unmodified, stage) {
  const [num, den] = stageRatio(stage);
  let v = Math.floor((unmodified * num) / den);
  if (v >= MAX_STAT_VALUE) v = MAX_STAT_VALUE;
  return v === 0 ? 1 : v;
}

// ------------------------------------------------------------------------------- badges, status

/** One badge boost: stat += stat / 8, then capped at 999. */
export function badgeBoost(stat) {
  const v = stat + (stat >> 3);
  return v >= MAX_STAT_VALUE ? MAX_STAT_VALUE : v;
}

/**
 * ApplyBadgeStatBoosts on the player's battle stats (not in link battles). Note the game calls
 * it again on every stat change of the player / stat drop by the enemy, so boosts stack — the
 * battle engine reproduces that by calling this again on the current values.
 * @param {{atk:number, def:number, spd:number, spc:number}} stats current battle stats
 * @param {number} badges wObtainedBadges bitfield
 * @returns new object
 */
export function applyBadgeStatBoosts(stats, badges, { link = false } = {}) {
  const out = { ...stats };
  if (link) return out;
  for (const b of BADGE_STAT_BOOSTS) if (badges & (1 << b.bit)) out[b.stat] = badgeBoost(out[b.stat]);
  return out;
}

/** QuarterSpeedDueToParalysis: speed / 4, at least 1. */
export function paralysisSpeed(speed) {
  return Math.max(1, speed >> 2);
}

/** HalveAttackDueToBurn: attack / 2, at least 1. */
export function burnAttack(attack) {
  return Math.max(1, attack >> 1);
}

// ----------------------------------------------------------------------------- critical hits

/**
 * CriticalHitTest threshold b (crit if rotl3(Random()) < b):
 *   b = baseSpeed / 2; Focus Energy/Dire Hit: b /= 2 (bug), else b = min(255, b*2);
 *   high-crit move: b = min(255, b*2) twice, else b /= 2.
 * Normal: floor(base/2); high crit: min(255, 8·floor(base/2)); with Focus Energy ¼ of those.
 */
export function critThreshold({ baseSpeed, highCrit = false, focusEnergy = false }) {
  let b = (baseSpeed & 0xff) >> 1;
  if (focusEnergy) b >>= 1;
  else b = Math.min(255, b * 2);
  if (highCrit) {
    b = Math.min(255, b * 2);
    b = Math.min(255, b * 2);
  } else {
    b >>= 1;
  }
  return b;
}

/** Crit probability = threshold / 256. */
export function critChance(o) {
  return critThreshold(o) / 256;
}

/** Roll against a threshold: consumes ONE random byte. */
export function rollCritical(threshold, rng) {
  const r = byte(rng);
  const rot = ((r << 3) | (r >> 5)) & 0xff;
  return rot < threshold;
}

/**
 * Full CriticalHitTest: moves with 0 power never crit and consume no random number.
 * @param {{baseSpeed:number, power:number, highCrit?:boolean, focusEnergy?:boolean}} o
 */
export function criticalHitTest(o, rng) {
  if (!o.power) return false;
  return rollCritical(critThreshold(o), rng);
}

// ----------------------------------------------------------------------------- damage vars

/**
 * GetDamageVarsForPlayerAttack / ...EnemyAttack.
 * Non-crit: A = attacker's current Attack/Special, D = defender's current Defense/Special
 * (×2 with Reflect / Light Screen, not capped). Crit: A and D are replaced by the unmodified
 * stats (player: its party stat; enemy: recomputed from base + DVs, no stat exp) — stages,
 * screens, burn and badge boosts all ignored. If A or D > 255 both are divided by 4
 * (A: 0 → 1) and only the low byte is used (≥1024 wraps; D can become 0). Level ×2 on a crit
 * (8-bit: ≥128 overflows).
 * @param {object} o
 * @param {number} o.attack       current offensive stat
 * @param {number} o.defense      current defensive stat
 * @param {number} o.level        attacker level
 * @param {boolean} [o.critical]
 * @param {boolean} [o.screen]    defender has Reflect (physical) / Light Screen (special)
 * @param {number} [o.critAttack] unmodified offensive stat (required for crits)
 * @param {number} [o.critDefense] unmodified defensive stat (required for crits)
 * @returns {{attack:number, defense:number, level:number, scaled:boolean}}
 */
export function damageVars({ attack, defense, level, critical = false, screen = false, critAttack, critDefense }) {
  let D = screen ? defense * 2 : defense;
  let A = attack;
  if (critical) {
    if (critAttack === undefined || critDefense === undefined) throw new Error('damageVars: critAttack/critDefense needed for a critical hit');
    A = critAttack;
    D = critDefense;
  }
  let scaled = false;
  if (A > 255 || D > 255) {
    scaled = true;
    D >>= 2;
    A >>= 2;
    if (A === 0) A = 1;
  }
  const L = critical ? (level * 2) & 0xff : level & 0xff;
  return { attack: A & 0xff, defense: D & 0xff, level: L, scaled };
}

/**
 * CalculateDamage: the core formula, before STAB / types / random.
 *   explode (Selfdestruct/Explosion): D = max(1, D / 2)
 *   power 0 → 0 (status move; the caller doesn't continue)
 *   damage = floor(floor(floor((floor(2L/5) + 2) · power · A) / D) / 50)
 *   return min(damage, 997) + 2
 * D = 0 freezes the real game (division by zero); here it is treated as 1.
 * @param {{level:number, power:number, attack:number, defense:number, explode?:boolean}} o
 */
export function calculateDamage({ level, power, attack, defense, explode = false }) {
  let D = defense & 0xff;
  if (explode) {
    D >>= 1;
    if (D === 0) D = 1;
  }
  if (!power) return 0;
  if (D === 0) D = 1;
  let x = Math.floor((2 * level) / 5) + 2;
  x = x * power * attack;
  x = Math.floor(x / D);
  x = Math.floor(x / 50);
  return Math.min(x, MAX_NEUTRAL_DAMAGE - MIN_NEUTRAL_DAMAGE) + MIN_NEUTRAL_DAMAGE;
}

/** STAB: damage += damage / 2 when the move type is one of the attacker's types. */
export function applyStab(damage, moveType, attackerTypes) {
  return isStab(moveType, attackerTypes) ? (damage + (damage >> 1)) & 0xffff : damage;
}

export { applyTypeEffectiveness };

/** Deterministic RandomizeDamage with a given factor r (217..255). Damage < 2 is unchanged. */
export function applyRandomFactor(damage, r) {
  if (damage < 2) return damage;
  return Math.floor((damage * r) / 255);
}

/**
 * RandomizeDamage: only if damage >= 2; draws r = rotr(Random()) until r >= 217 (≥1 byte,
 * rejection sampling), damage = floor(damage · r / 255).
 * @returns {number}
 */
export function randomizeDamage(damage, rng) {
  if (damage < 2) return damage;
  let r;
  do {
    const b = byte(rng);
    r = ((b >> 1) | (b << 7)) & 0xff;
  } while (r < RANDOM_FACTOR_MIN);
  return Math.floor((damage * r) / 255);
}

// -------------------------------------------------------------------------------- accuracy

/**
 * CalcHitChance: accuracy byte × accuracy-stage ratio (≥1), × ratio of the MIRRORED evasion
 * stage (≥1), capped at 255. 100% moves give 255 → hit 255/256.
 * @param {{accuracyByte:number, accuracyStage?:number, evasionStage?:number}} o
 */
export function hitChance({ accuracyByte, accuracyStage = 0, evasionStage = 0 }) {
  let acc = accuracyByte & 0xff;
  for (const stage of [accuracyStage, -evasionStage]) {
    const [num, den] = stageRatio(stage);
    acc = Math.floor((acc * num) / den);
    if ((acc & 0xffff) === 0) acc = 1;
  }
  return acc > 255 ? 255 : acc;
}

/** One accuracy roll: hit if Random() < chance (consumes one byte). */
export function rollHit(chance, rng) {
  return byte(rng) < chance;
}

/** Effects Mist protects against: $12-$19 and $3A-$41 (stat-lowering, plus a few no-ops). */
export function isMistBlockedEffect(effectId) {
  return (effectId >= EFFECT.ATTACK_DOWN1 && effectId <= EFFECT.HAZE)
    || (effectId >= EFFECT.ATTACK_DOWN2 && effectId <= EFFECT.REFLECT);
}

/**
 * MoveHitTest in order: Dream Eater vs a non-sleeping target misses; Swift always hits (even
 * Fly/Dig); an invulnerable (Fly/Dig) target is missed; Mist blocks stat-lowering effects;
 * X Accuracy always hits; otherwise one accuracy roll.
 * (The Substitute check for draining moves is broken in the game and does nothing.)
 * @param {object} o
 * @param {number} o.effectId
 * @param {number} o.accuracyByte
 * @param {number} [o.accuracyStage]
 * @param {number} [o.evasionStage]
 * @param {boolean} [o.targetAsleep]
 * @param {boolean} [o.targetInvulnerable]
 * @param {boolean} [o.targetMist]
 * @param {boolean} [o.xAccuracy]
 * @returns {{hit:boolean, reason:string, chance?:number}} reason: dreamEater|swift|invulnerable|
 *   mist|xAccuracy|roll
 */
export function moveHitTest(o, rng) {
  const effect = o.effectId | 0;
  if (effect === EFFECT.DREAM_EATER && !o.targetAsleep) return { hit: false, reason: 'dreamEater' };
  if (effect === EFFECT.SWIFT) return { hit: true, reason: 'swift' };
  if (o.targetInvulnerable) return { hit: false, reason: 'invulnerable' };
  if (o.targetMist && isMistBlockedEffect(effect)) return { hit: false, reason: 'mist' };
  if (o.xAccuracy) return { hit: true, reason: 'xAccuracy' };
  const chance = hitChance(o);
  return { hit: rollHit(chance, rng), reason: 'roll', chance };
}

// ---------------------------------------------------------------------- fixed / special damage

/**
 * Damage of SUPER_FANG_EFFECT and SPECIAL_DAMAGE_EFFECT moves (ApplyAttackTo*Pokemon). They
 * skip crits, the formula, STAB and types (Seismic Toss hits Ghosts) but still roll accuracy.
 *   Super Fang: max(1, targetHP / 2); Seismic Toss / Night Shade: user level; Sonic Boom 20;
 *   Dragon Rage 40; Psywave: Random() rerolled into [1, ⌊1.5·L⌋) for the player and
 *   [0, ⌊1.5·L⌋) for the enemy (⌊1.5·L⌋ on 8 bits).
 * @param {object} o
 * @param {string} o.move move const
 * @param {number} o.userLevel
 * @param {number} [o.targetHP]
 * @param {'player'|'enemy'} [o.side='player'] who uses the move
 * @returns {number|null} null if the move is not a fixed-damage move
 */
export function fixedDamage({ move, userLevel, targetHP = 0, side = 'player' }, rng, gd = getGameData()) {
  const m = gd.move(move);
  if (m.effectId === EFFECT.SUPER_FANG) return Math.max(1, (targetHP & 0xffff) >> 1);
  if (m.effectId !== EFFECT.SPECIAL_DAMAGE) return null;
  switch (m.const) {
    case 'SEISMIC_TOSS':
    case 'NIGHT_SHADE':
      return userLevel;
    case 'SONICBOOM':
      return SONICBOOM_DAMAGE;
    case 'DRAGON_RAGE':
      return DRAGON_RAGE_DAMAGE;
    default: {
      // Psywave
      const b = (userLevel + (userLevel >> 1)) & 0xff;
      const min = side === 'player' ? 1 : 0;
      if (b <= min) return min; // the real game would loop forever here (level 0/1 users)
      let r;
      do r = byte(rng); while (r < min || r >= b);
      return r;
    }
  }
}

/**
 * OHKO moves (OneHitKOEffect): hit (65535 damage) if the user's current Speed >= the target's,
 * otherwise miss. Type immunity and the accuracy roll still apply (done by the caller).
 */
export function ohko({ userSpeed, targetSpeed }) {
  return userSpeed >= targetSpeed ? { hit: true, damage: OHKO_DAMAGE } : { hit: false, damage: 0 };
}

/**
 * Counter (HandleCounterMove): hits only if the opponent's last selected move is not Counter,
 * has power > 0 and is Normal or Fighting; damage = 2 × the last damage dealt by anyone
 * (wDamage), capped at 65535; 0 last damage → miss. The accuracy roll follows.
 * @returns {{hit:boolean, damage:number}}
 */
export function counterDamage({ lastMove, lastDamage }, gd = getGameData()) {
  if (!lastMove) return { hit: false, damage: 0 };
  const m = gd.move(lastMove);
  if (m.const === 'COUNTER' || !m.power || (m.type !== 'NORMAL' && m.type !== 'FIGHTING')) return { hit: false, damage: 0 };
  if (!lastDamage) return { hit: false, damage: 0 };
  return { hit: true, damage: Math.min(0xffff, lastDamage * 2) };
}

/**
 * Confusion self-hit (HandleSelfConfusionDamage): a typeless 40-power physical hit of the
 * mon's own current Attack against its own current Defense — doubled by the OPPONENT's
 * Reflect (quirk) — never critical, no STAB, no type, no random factor.
 */
export function confusionDamage({ attack, defense, level, opponentReflect = false }) {
  const v = damageVars({ attack, defense, level, critical: false, screen: opponentReflect });
  return calculateDamage({ level: v.level, power: CONFUSION_DAMAGE_POWER, attack: v.attack, defense: v.defense });
}

// -------------------------------------------------------------------------------- pipeline

/**
 * Convenience pipeline for an ordinary damaging move, in the game's order and RNG order
 * (1 crit byte if power > 0, ≥1 damage bytes if damage ≥ 2 after types). Accuracy is NOT
 * rolled here (MoveHitTest comes after; see moveHitTest). Fixed-damage/OHKO moves → use
 * fixedDamage/ohko instead.
 * @param {object} o
 * @param {string|object} o.move
 * @param {{level:number, types:string[], baseSpeed:number, attack:number, special:number,
 *   unmodifiedAttack?:number, unmodifiedSpecial?:number, focusEnergy?:boolean}} o.attacker
 * @param {{types:string[], defense:number, special:number, unmodifiedDefense?:number,
 *   unmodifiedSpecial?:number, reflect?:boolean, lightScreen?:boolean}} o.defender
 * @param {boolean} [o.critical] force the crit result (skips the roll)
 * @param {number} [o.randomFactor] force r (skips the random roll)
 * @returns {{critical:boolean, vars:object|null, base:number, stab:number, typeResult:object,
 *   damage:number, missed:boolean, immune:boolean, effectiveness:number|null}}
 */
export function computeDamage(o, rng, gd = getGameData()) {
  const move = gd.move(o.move);
  const special = isSpecialType(move.type, gd);
  const atk = o.attacker;
  const def = o.defender;
  const critical = o.critical !== undefined
    ? !!o.critical && move.power > 0
    : criticalHitTest({ baseSpeed: atk.baseSpeed, power: move.power, highCrit: move.highCrit, focusEnergy: atk.focusEnergy }, rng);
  if (!move.power) {
    return { critical: false, vars: null, base: 0, stab: 0, typeResult: null, damage: 0, missed: false, immune: false, effectiveness: null };
  }
  const vars = damageVars({
    attack: special ? atk.special : atk.attack,
    defense: special ? def.special : def.defense,
    level: atk.level,
    critical,
    screen: special ? !!def.lightScreen : !!def.reflect,
    critAttack: special ? (atk.unmodifiedSpecial ?? atk.special) : (atk.unmodifiedAttack ?? atk.attack),
    critDefense: special ? (def.unmodifiedSpecial ?? def.special) : (def.unmodifiedDefense ?? def.defense),
  });
  const base = calculateDamage({ ...vars, power: move.power, explode: move.effectId === EFFECT.EXPLODE });
  const stab = applyStab(base, move.type, atk.types);
  const typeResult = applyTypeEffectiveness(stab, move.type, def.types[0], def.types[1] ?? def.types[0], gd);
  let damage = typeResult.damage;
  damage = o.randomFactor !== undefined ? applyRandomFactor(damage, o.randomFactor) : randomizeDamage(damage, rng);
  return { critical, vars, base, stab, typeResult, damage, missed: typeResult.missed, immune: typeResult.immune,
    effectiveness: typeResult.lastFactor };
}

// --------------------------------------------------------------------------------- running

/**
 * TryRunningFromBattle for a normal wild battle (ghost/Safari/link battles always escape,
 * trainer battles never — handled by the caller). `attempts` = wNumRunAttempts AFTER it was
 * incremented for this try (1 on the first try). Consumes one byte only when it gets to the
 * final roll.
 * @returns {boolean} escaped
 */
export function tryEscape({ playerSpeed, enemySpeed, attempts }, rng) {
  if (playerSpeed >= enemySpeed) return true;
  const divisor = (enemySpeed >> 2) & 0xff;
  if (divisor === 0) return true;
  let q = Math.floor(((playerSpeed * 32) & 0xffff) / divisor);
  if (q > 255) return true;
  for (let i = 1; i < attempts; i++) {
    q += 30;
    if (q > 255) return true;
  }
  return byte(rng) <= q;
}
