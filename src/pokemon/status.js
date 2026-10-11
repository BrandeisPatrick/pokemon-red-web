// Non-volatile status conditions (the party-struct status byte) and the overworld rules that
// touch them: poison damage while walking (ApplyOutOfBattlePoisonDamage,
// engine/events/poison.asm), the day-care exp tick (IncrementDayCareMonExp), the step counter,
// Repel and Safari Zone step counting.
//
// Status byte layout (constants/battle_constants.asm): bits 0-2 = sleep counter (1-7),
// bit 3 PSN, bit 4 BRN, bit 5 FRZ, bit 6 PAR. A mon has at most one of them. Toxic's
// "badly poisoned" is a battle-only flag (BADLY_POISONED in wPlayerBattleStatus3).

export const STATUS_NONE = 0;
export const STATUS_SLP_MASK = 0b111;
export const STATUS_PSN = 1 << 3;
export const STATUS_BRN = 1 << 4;
export const STATUS_FRZ = 1 << 5;
export const STATUS_PAR = 1 << 6;
export const STATUS = Object.freeze({ NONE: 0, SLP_MASK: STATUS_SLP_MASK, PSN: STATUS_PSN, BRN: STATUS_BRN, FRZ: STATUS_FRZ, PAR: STATUS_PAR });
/** Status codes as printed by the game. */
export const STATUS_CODES = Object.freeze(['PSN', 'BRN', 'FRZ', 'PAR', 'SLP']);
const BIT_OF = { PSN: STATUS_PSN, BRN: STATUS_BRN, FRZ: STATUS_FRZ, PAR: STATUS_PAR };

/** Sleep turns drawn by SleepEffect are 1-7; Rest sets 2. */
export const MAX_SLEEP_TURNS = 7;
/** Poison hurts on every 4th step (wStepCounter & 3 == 0). */
export const POISON_STEP_INTERVAL = 4;
/** Safari Zone game: 502 steps, 30 balls (SafariZoneGate script). */
export const SAFARI_STEPS = 502;
export const SAFARI_BALLS = 30;

/**
 * Printed status of a status byte, in PrintStatusAilment's priority (PSN, BRN, FRZ, PAR, SLP),
 * or null.
 * @returns {'PSN'|'BRN'|'FRZ'|'PAR'|'SLP'|null}
 */
export function statusCode(status) {
  const s = status & 0xff;
  if (s & STATUS_PSN) return 'PSN';
  if (s & STATUS_BRN) return 'BRN';
  if (s & STATUS_FRZ) return 'FRZ';
  if (s & STATUS_PAR) return 'PAR';
  if (s & STATUS_SLP_MASK) return 'SLP';
  return null;
}

/** What the party menu / status screen shows: "FNT" at 0 HP (PrintStatusCondition), else the code or "". */
export function statusLabel(mon) {
  if (!mon.hp) return 'FNT';
  return statusCode(mon.status) || '';
}

/**
 * Status byte for a code. 'SLP' takes the sleep counter (default 1..7 → clamped).
 * @param {'PSN'|'BRN'|'FRZ'|'PAR'|'SLP'|null} code
 */
export function statusFromCode(code, sleepTurns = 1) {
  if (!code) return 0;
  const c = String(code).toUpperCase();
  if (c === 'SLP') return Math.max(1, Math.min(MAX_SLEEP_TURNS, sleepTurns | 0));
  if (!(c in BIT_OF)) throw new Error(`unknown status ${code}`);
  return BIT_OF[c];
}

export const isAsleep = (status) => (status & STATUS_SLP_MASK) !== 0;
export const sleepCounter = (status) => status & STATUS_SLP_MASK;
export const isPoisoned = (status) => (status & STATUS_PSN) !== 0;
export const isBurned = (status) => (status & STATUS_BRN) !== 0;
export const isFrozen = (status) => (status & STATUS_FRZ) !== 0;
export const isParalyzed = (status) => (status & STATUS_PAR) !== 0;

/** @returns {boolean} the status byte has the given condition */
export function hasStatus(status, code) {
  const c = String(code).toUpperCase();
  return c === 'SLP' ? isAsleep(status) : !!(status & (BIT_OF[c] || 0));
}

/**
 * Mask an item cures, from its effect.cures list (["PSN"], ["SLP"], or all five for Full
 * Heal / Full Restore → $ff like the game).
 */
export function cureMask(codes) {
  if (!codes || !codes.length) return 0;
  if (codes.length >= 5) return 0xff;
  let m = 0;
  for (const c of codes) m |= c === 'SLP' ? STATUS_SLP_MASK : BIT_OF[c];
  return m;
}

// ------------------------------------------------------------------------------ overworld steps

/**
 * One completed step's step-counter update (home/overworld.asm): wStepCounter is decremented
 * (8-bit) unless the movement is simulated/scripted. It is reset to 0 when a map is entered
 * (ClearVariablesOnEnterMap), so poison first hurts on the 4th step after entering a map.
 */
export function countStep(state, { scripted = false } = {}) {
  if (!scripted) state.stepCounter = (state.stepCounter - 1) & 0xff;
  return state.stepCounter;
}

/** Reset on map entry (ClearVariablesOnEnterMap). */
export function resetStepCounter(state) {
  state.stepCounter = 0;
}

/**
 * IncrementDayCareMonExp: +1 exp per step while a mon is in the day care (3-byte counter whose
 * top byte is clamped to $50 when it carries — a quirk without practical effect).
 */
export function incrementDayCareExp(state) {
  const dc = state.dayCareMon;
  if (!dc || !dc.mon) return;
  let exp = dc.mon.exp + 1;
  if (exp > 0xffffff || (exp & 0xffff) === 0) {
    let hi = (exp >> 16) & 0xff;
    if (exp > 0xffffff) hi = 0;
    if (hi >= 0x50) hi = 0x50;
    exp = (hi << 16) | (exp & 0xffff);
  }
  dc.mon.exp = exp;
}

/**
 * ApplyOutOfBattlePoisonDamage, called after every step outside battle (anywhere, not only
 * outdoors). Skipped while the movement is scripted or the party is empty; ticks the day-care
 * exp; on every 4th step (stepCounter & 3 == 0) each poisoned party mon with HP > 0 loses 1 HP.
 * In Gen 1 a mon CAN faint from poison in the field: its status is cleared and "<MON>
 * fainted!" is shown; if no mon is left standing the player blacks out.
 * @param {object} state GameState (party, stepCounter, dayCareMon)
 * @returns {{tick:boolean, hurt:number[], fainted:number[], flash:boolean, blackout:boolean}}
 *   flash = some party mon is (still) poisoned → BG white→dark-grey for 4 frames
 *   (ChangeBGPalColor0_4Frames) + SFX_POISONED
 */
export function poisonStep(state, { scripted = false } = {}) {
  const res = { tick: false, hurt: [], fainted: [], flash: false, blackout: false };
  const party = state.party || [];
  if (scripted || party.length === 0) return res;
  incrementDayCareExp(state);
  if (state.stepCounter & 3) return res;
  res.tick = true;
  party.forEach((mon, i) => {
    if (!(mon.status & STATUS_PSN) || mon.hp <= 0) return;
    mon.hp -= 1;
    res.hurt.push(i);
    if (mon.hp === 0) {
      mon.status = 0;
      res.fainted.push(i);
    }
  });
  res.flash = party.some((m) => (m.status & STATUS_PSN) !== 0);
  res.blackout = !party.some((m) => m.hp > 0);
  return res;
}

/**
 * Repel tick done by TryDoWildEncounter on encounter-eligible steps: steps > 0 → decrement;
 * when it reaches 0 that step prints "REPEL's effect wore off." and has no encounter.
 * @returns {{active:boolean, woreOff:boolean}} active = repel still on for this step's check
 */
export function repelStep(state) {
  if (!state.repelSteps) return { active: false, woreOff: false };
  state.repelSteps -= 1;
  if (state.repelSteps === 0) return { active: false, woreOff: true };
  return { active: true, woreOff: false };
}

/**
 * Repel blocks a rolled encounter when its level is lower than the FIRST party mon's level
 * (even if that mon has fainted).
 */
export function repelBlocksEncounter(state, wildLevel) {
  const lead = state.party && state.party[0];
  return !!state.repelSteps && !!lead && wildLevel < lead.level;
}

/**
 * SafariZoneCheckSteps (each step while EVENT_IN_SAFARI_ZONE is set): 0 steps left → game
 * over; else steps - 1. Balls running out is checked after battles (SafariZoneCheck).
 * @returns {{gameOver:boolean}}
 */
export function safariStep(state) {
  const s = state.safari;
  if (!s) return { gameOver: false };
  if (!s.steps) {
    s.gameOver = true;
    return { gameOver: true };
  }
  s.steps -= 1;
  s.gameOver = false;
  return { gameOver: false };
}

/**
 * One completed overworld step in the game's order: step counter, Safari Zone steps (only if
 * the EVENT_IN_SAFARI_ZONE flag is set), then poison / day care.
 * @returns {{safari:{gameOver:boolean}|null, poison:ReturnType<typeof poisonStep>}}
 */
export function overworldStep(state, { scripted = false } = {}) {
  countStep(state, { scripted });
  let safari = null;
  if (state.flags && state.flags.get('EVENT_IN_SAFARI_ZONE')) {
    safari = safariStep(state);
    if (safari.gameOver) return { safari, poison: { tick: false, hurt: [], fainted: [], flash: false, blackout: false } };
  }
  return { safari, poison: poisonStep(state, { scripted }) };
}
