// Catch formula — ItemUseBall (engine/items/item_effects.asm), transcribed step by step.
//
//   Master Ball: caught. Unidentified ghost / ghost Marowak: "can't be caught".
//   Rand1 = Random(), rerolled while > 200 (Great) or > 150 (Ultra, Safari); any for Poké Ball
//   Status = 25 (SLP/FRZ), 12 (PSN/BRN/PAR), 0;  Rand1 < Status → caught;  Rand1 -= Status
//   W = floor(floor(MaxHP·255 / BallFactor) / max(1, HP/4))     BallFactor = 8 Great, else 12
//   X = min(W, 255)
//   Rand1 > CatchRate → fail;  W > 255 → caught;  Random() <= X → caught;  else fail
//   fail → Y = floor(CatchRate·100 / BallFactor2) (255 Poké, 200 Great, 150 Ultra/Safari)
//          Z = floor(X·Y / 255) + (10 SLP/FRZ, 5 PSN/BRN/PAR)
//          Z < 10: 0 shakes ("missed"), < 30: 1, < 70: 2, else 3

import { getGameData } from './data.js';
import { STATUS_SLP_MASK, STATUS_FRZ, STATUS_PSN, STATUS_BRN, STATUS_PAR, statusFromCode } from './status.js';

/** wPokeBallAnimData values (the ball animation / message selector). */
export const BALL_ANIM = Object.freeze({ CANT_CATCH: 0x10, MISSED: 0x20, SHAKE1: 0x61, SHAKE2: 0x62, SHAKE3: 0x63, CAUGHT: 0x43 });

/** Message label per result (data/text/common.json). */
export const BALL_TEXT = Object.freeze({
  [BALL_ANIM.CANT_CATCH]: '_ItemUseBallText00', // It dodged the thrown BALL! This #MON can't be caught!
  [BALL_ANIM.MISSED]: '_ItemUseBallText01', // You missed the #MON!
  [BALL_ANIM.SHAKE1]: '_ItemUseBallText02', // Darn! The #MON broke free!
  [BALL_ANIM.SHAKE2]: '_ItemUseBallText03', // Aww! It appeared to be caught!
  [BALL_ANIM.SHAKE3]: '_ItemUseBallText04', // Shoot! It was so close too!
  [BALL_ANIM.CAUGHT]: '_ItemUseBallText05', // All right! <MON> was caught!
});

function statusByte(status) {
  if (typeof status === 'number') return status & 0xff;
  if (!status) return 0;
  return statusFromCode(status);
}

/** Status bonus subtracted from Rand1: 25 asleep/frozen, 12 other status, 0. */
export function catchStatusBonus(status) {
  const s = statusByte(status);
  if (!s) return 0;
  return s & (STATUS_FRZ | STATUS_SLP_MASK) ? 25 : 12;
}

/** Shake bonus added to Z: 10 asleep/frozen, 5 other status, 0. */
export function shakeStatusBonus(status) {
  const s = statusByte(status);
  if (!s) return 0;
  return s & (STATUS_FRZ | STATUS_SLP_MASK) ? 10 : 5;
}

/** Ball parameters: {rand1Max, ballFactor, ballFactor2, alwaysCatches}. */
export function ballParams(ball, gd = getGameData()) {
  const it = gd.item(ball);
  const e = it.effect || {};
  if (e.kind !== 'ball') throw new Error(`${it.const} is not a ball`);
  if (e.alwaysCatches) return { const: it.const, alwaysCatches: true, rand1Max: 255, ballFactor: 12, ballFactor2: 255 };
  return { const: it.const, alwaysCatches: false, rand1Max: e.rand1Max, ballFactor: e.ballFactor, ballFactor2: e.ballFactor2 };
}

/** W of the formula (before the 255 clamp). */
export function catchW({ maxHp, hp, ballFactor }) {
  let q = Math.floor((maxHp * 255) / ballFactor);
  let h = ((hp & 0xffff) >> 2) & 0xff;
  if (h === 0) h = 1;
  return Math.floor(q / h);
}

/** Number of shakes for a failed throw (0-3). */
export function shakesFor({ x, catchRate, ballFactor2, status }) {
  const y = Math.floor((catchRate * 100) / ballFactor2);
  if (y > 255) return 3;
  const z = (Math.floor((x * y) / 255) + shakeStatusBonus(status)) & 0xff;
  if (z < 10) return 0;
  if (z < 30) return 1;
  if (z < 70) return 2;
  return 3;
}

const SHAKE_ANIM = [BALL_ANIM.MISSED, BALL_ANIM.SHAKE1, BALL_ANIM.SHAKE2, BALL_ANIM.SHAKE3];

/**
 * One ball throw at a wild mon.
 * @param {object} o
 * @param {string} o.ball item const (MASTER_BALL, ULTRA_BALL, GREAT_BALL, POKE_BALL, SAFARI_BALL)
 * @param {number} o.hp current HP of the wild mon
 * @param {number} o.maxHp
 * @param {number|string|null} o.status status byte or code ('SLP', 'PSN', ...)
 * @param {number} o.catchRate wEnemyMonActualCatchRate (species value; Safari bait/rock change it)
 * @param {boolean} [o.uncatchable] unidentified ghost (no Silph Scope) or the Pokémon Tower
 *   ghost Marowak — checked before the Master Ball, so even it fails
 * @param {boolean} [o.oldManBattle] the Old Man's tutorial battle always "catches" (no mon given)
 * @param {{randByte:()=>number}} rng consumed like the game: Rand1 (rerolled), then Rand2 only
 *   when needed
 * @returns {{caught:boolean, shakes:number, animData:number, text:string, uncatchable?:boolean}}
 *   shakes = wobbles shown (3 on a capture)
 */
export function throwBall(o, rng, gd = getGameData()) {
  if (o.uncatchable) {
    return { caught: false, shakes: 0, animData: BALL_ANIM.CANT_CATCH, text: BALL_TEXT[BALL_ANIM.CANT_CATCH], uncatchable: true };
  }
  const caught = () => ({ caught: true, shakes: 3, animData: BALL_ANIM.CAUGHT, text: BALL_TEXT[BALL_ANIM.CAUGHT] });
  if (o.oldManBattle) return caught();
  const p = ballParams(o.ball, gd);
  let rand1;
  do {
    rand1 = rng.randByte() & 0xff;
    if (p.alwaysCatches) return caught();
  } while (rand1 > p.rand1Max);
  const statusBonus = catchStatusBonus(o.status);
  if (statusBonus) {
    if (rand1 < statusBonus) return caught();
    rand1 -= statusBonus;
  }
  const w = catchW({ maxHp: o.maxHp, hp: o.hp, ballFactor: p.ballFactor });
  const x = w > 255 ? 255 : w;
  const fail = () => {
    const shakes = shakesFor({ x, catchRate: o.catchRate, ballFactor2: p.ballFactor2, status: o.status });
    const animData = SHAKE_ANIM[shakes];
    return { caught: false, shakes, animData, text: BALL_TEXT[animData] };
  };
  if (rand1 > o.catchRate) return fail();
  if (w > 255) return caught();
  const rand2 = rng.randByte() & 0xff;
  if (rand2 > x) return fail();
  return caught();
}

/**
 * Exact capture probability of one throw (enumerates Rand1/Rand2 like throwBall).
 * @param {Omit<Parameters<typeof throwBall>[0], never>} o
 */
export function catchProbability(o, gd = getGameData()) {
  if (o.uncatchable) return 0;
  if (o.oldManBattle) return 1;
  const p = ballParams(o.ball, gd);
  if (p.alwaysCatches) return 1;
  const statusBonus = catchStatusBonus(o.status);
  const w = catchW({ maxHp: o.maxHp, hp: o.hp, ballFactor: p.ballFactor });
  const x = w > 255 ? 255 : w;
  let caught = 0;
  const n = p.rand1Max + 1;
  for (let r1 = 0; r1 < n; r1++) {
    if (statusBonus && r1 < statusBonus) { caught += 1; continue; }
    const r = r1 - statusBonus;
    if (r > o.catchRate) continue;
    if (w > 255) { caught += 1; continue; }
    caught += (x + 1) / 256;
  }
  return caught / n;
}
