// Party (max 6), PC boxes (12 × 20) and the Pokédex seen/owned flags.
//
// state.party is a plain array of Mon; state.pcBoxes an array of 12 arrays of (box) Mon;
// state.currentBox the 0-based current box. The functions mirror the game's routines:
// _MoveMon / RemovePokemon (Bill's PC), SendNewMonToBox (caught/gift mons go to the FRONT of
// the current box), _GivePokemon, the Pokédex FlagActions.

import { getGameData } from './data.js';
import { Mon, toBoxMon, fromBoxMon, healMon } from './mon.js';
import { knowsHMMove, dayCareMoves } from './learnset.js';
import { levelForExp, expForLevel, MAX_LEVEL } from './exp.js';

export const PARTY_LENGTH = 6;
export const MONS_PER_BOX = 20;
export const NUM_BOXES = 12;
export const NUM_POKEMON = 151;

/** 12 empty boxes. */
export function emptyBoxes() {
  return Array.from({ length: NUM_BOXES }, () => []);
}

// ------------------------------------------------------------------------------------ party

/** @returns {boolean} added (false if the party already has 6) */
export function partyAdd(state, mon) {
  if (state.party.length >= PARTY_LENGTH) return false;
  state.party.push(mon instanceof Mon ? mon : Mon.fromJSON(mon));
  return true;
}

/** Remove and return the mon at `index` (RemovePokemon shifts the rest up). */
export function partyRemove(state, index) {
  if (index < 0 || index >= state.party.length) throw new RangeError(`no party mon ${index}`);
  return state.party.splice(index, 1)[0];
}

/** Swap two party slots (party menu SWITCH). */
export function partySwap(state, i, j) {
  const p = state.party;
  if (i < 0 || j < 0 || i >= p.length || j >= p.length) throw new RangeError('partySwap: index out of range');
  [p[i], p[j]] = [p[j], p[i]];
}

/** Index of the first mon with HP > 0 (the one sent out first), or -1. */
export function firstAliveIndex(party) {
  return party.findIndex((m) => m.hp > 0);
}

/** AnyPartyAlive. */
export function anyAlive(party) {
  return party.some((m) => m.hp > 0);
}

/** HealParty: every party mon to full HP, no status, full PP. */
export function healParty(party, gd = getGameData()) {
  for (const m of party) healMon(m, gd);
}

// ------------------------------------------------------------------------------------ boxes

/** The current box array. */
export function currentBox(state) {
  return state.pcBoxes[state.currentBox];
}

/** @returns {boolean} the current box holds 20 mons */
export function isCurrentBoxFull(state) {
  return currentBox(state).length >= MONS_PER_BOX;
}

/** Switch the current box (Bill's PC "CHANGE BOX"; the game saves when doing so). */
export function changeBox(state, n) {
  if (!(n >= 0 && n < NUM_BOXES)) throw new RangeError(`no box ${n}`);
  state.currentBox = n;
  state.boxesChanged = true;
}

/**
 * Bill's PC DEPOSIT: refused for the last party mon (even if others fainted: the check is the
 * party count) and when the current box is full; otherwise the mon goes to the END of the box
 * as a box mon (stats dropped).
 * @returns {{ok:boolean, reason?:'lastMon'|'boxFull', mon?:Mon, boxNumber?:number}}
 */
export function deposit(state, partyIndex) {
  if (state.party.length <= 1) return { ok: false, reason: 'lastMon' };
  if (isCurrentBoxFull(state)) return { ok: false, reason: 'boxFull' };
  const mon = partyRemove(state, partyIndex);
  currentBox(state).push(toBoxMon(mon));
  return { ok: true, mon, boxNumber: state.currentBox + 1 };
}

/**
 * Bill's PC WITHDRAW: needs a non-empty box and a party with room; the mon is appended to the
 * party with its level recomputed from exp and stats recalculated with stat exp.
 * @returns {{ok:boolean, reason?:'boxEmpty'|'partyFull', mon?:Mon}}
 */
export function withdraw(state, boxIndex, gd = getGameData()) {
  const box = currentBox(state);
  if (box.length === 0) return { ok: false, reason: 'boxEmpty' };
  if (state.party.length >= PARTY_LENGTH) return { ok: false, reason: 'partyFull' };
  if (boxIndex < 0 || boxIndex >= box.length) throw new RangeError(`no box mon ${boxIndex}`);
  const mon = fromBoxMon(box.splice(boxIndex, 1)[0], gd);
  state.party.push(mon);
  return { ok: true, mon };
}

/** Bill's PC RELEASE (box only, after a YES). @returns {{ok:boolean, reason?:'boxEmpty', mon?:Mon}} */
export function release(state, boxIndex) {
  const box = currentBox(state);
  if (box.length === 0) return { ok: false, reason: 'boxEmpty' };
  if (boxIndex < 0 || boxIndex >= box.length) throw new RangeError(`no box mon ${boxIndex}`);
  return { ok: true, mon: box.splice(boxIndex, 1)[0] };
}

/**
 * SendNewMonToBox: insert at the FRONT of the current box (everything shifts down).
 * @returns {boolean} false if the box is full
 */
export function sendToBox(state, mon) {
  if (isCurrentBoxFull(state)) return false;
  currentBox(state).unshift(toBoxMon(mon));
  return true;
}

/** @returns {boolean} the party is full AND the current box is full (balls can't be thrown) */
export function noRoomForMon(state) {
  return state.party.length >= PARTY_LENGTH && isCurrentBoxFull(state);
}

/**
 * _GivePokemon (gifts: Magikarp, Eevee, Lapras, fossils, prizes, the Hitmon...): party if it has
 * room (owned + seen), else the front of the current box (owned + seen) if it has room, else
 * nothing ("no more room"). The caller shows the naming prompt for party mons.
 * @returns {{ok:boolean, where?:'party'|'box', boxNumber?:number, reason?:'boxFull'}}
 */
export function giveMon(state, mon) {
  if (state.party.length < PARTY_LENGTH) {
    partyAdd(state, mon);
    state.pokedex.setOwned(mon.species);
    return { ok: true, where: 'party' };
  }
  if (isCurrentBoxFull(state)) return { ok: false, reason: 'boxFull' };
  sendToBox(state, mon);
  state.pokedex.setOwned(mon.species);
  return { ok: true, where: 'box', boxNumber: state.currentBox + 1 };
}

/**
 * A caught mon (ItemUseBall after the capture): owned (+ seen) in the Pokédex, then the party
 * or, if it is full, the front of the current box. Returns firstCatch = the species was not
 * owned before (the game then shows its Pokédex entry).
 * @returns {{ok:boolean, where?:'party'|'box', boxNumber?:number, firstCatch:boolean}}
 */
export function addCaughtMon(state, mon) {
  const firstCatch = !state.pokedex.isOwned(mon.species);
  state.pokedex.setOwned(mon.species);
  if (state.party.length < PARTY_LENGTH) {
    partyAdd(state, mon);
    return { ok: true, where: 'party', firstCatch };
  }
  if (!sendToBox(state, mon)) return { ok: false, firstCatch };
  return { ok: true, where: 'box', boxNumber: state.currentBox + 1, firstCatch };
}

// ---------------------------------------------------------------------------------- day care

/** ¥100 per level grown, plus ¥100 (wDayCarePerLevelCost added levelsGrown + 1 times). */
export const DAY_CARE_COST_PER_LEVEL = 100;

/**
 * Day-care man, leaving a mon (scripts/Daycare.asm): refused while one is already there, with
 * only one party mon, or if it knows an HM move (KnowsHMMove). The mon is stored in box form;
 * its `level` (the box level) is the start level the fee is computed from.
 * @returns {{ok:boolean, reason?:'inUse'|'onlyOneMon'|'knowsHM', mon?:Mon}}
 */
export function dayCareDeposit(state, partyIndex, gd = getGameData()) {
  if (state.dayCareMon) return { ok: false, reason: 'inUse' };
  if (state.party.length <= 1) return { ok: false, reason: 'onlyOneMon' };
  const mon = state.party[partyIndex];
  if (!mon) throw new RangeError(`no party mon ${partyIndex}`);
  if (knowsHMMove(mon, gd)) return { ok: false, reason: 'knowsHM' };
  partyRemove(state, partyIndex);
  state.dayCareMon = { mon: toBoxMon(mon) };
  return { ok: true, mon };
}

/**
 * What the day-care man says when talked to with a mon inside: its level now (from exp; at
 * level 100 the exp is clamped to the level-100 value, as the script writes back), the levels
 * grown and the fee ¥100 × (levels grown + 1). Clamps the stored exp like the game.
 * @returns {{level:number, startLevel:number, levelsGrown:number, cost:number}|null}
 */
export function dayCareQuote(state, gd = getGameData()) {
  const dc = state.dayCareMon;
  if (!dc) return null;
  const rate = gd.species(dc.mon.species).growthRate;
  let level = levelForExp(rate, dc.mon.exp, gd);
  if (level >= MAX_LEVEL) {
    level = MAX_LEVEL;
    dc.mon.exp = expForLevel(rate, MAX_LEVEL, gd);
  }
  const startLevel = dc.mon.level;
  const levelsGrown = Math.max(0, level - startLevel);
  return { level, startLevel, levelsGrown, cost: DAY_CARE_COST_PER_LEVEL * (levelsGrown + 1) };
}

/**
 * Taking the mon back (after the YES): needs room in the party and the fee. The mon returns with
 * its level from exp, stats recalculated with stat exp, the moves it learned in the meantime
 * (WriteMonMoves in day-care mode: levels above the start level, PP shifted with their moves)
 * and full HP (its status is kept).
 * @returns {{ok:boolean, reason?:'empty'|'partyFull'|'notEnoughMoney', mon?:Mon, cost?:number,
 *   levelsGrown?:number}}
 */
export function dayCareWithdraw(state, gd = getGameData()) {
  const q = dayCareQuote(state, gd);
  if (!q) return { ok: false, reason: 'empty' };
  if (state.party.length >= PARTY_LENGTH) return { ok: false, reason: 'partyFull' };
  if (state.money < q.cost) return { ok: false, reason: 'notEnoughMoney', cost: q.cost };
  state.money -= q.cost;
  const stored = state.dayCareMon.mon;
  const mon = fromBoxMon(stored, gd);
  mon.moves = dayCareMoves(mon.species, q.startLevel, mon.level, stored.moves, gd);
  mon.hp = mon.stats.hp;
  state.party.push(mon);
  state.dayCareMon = null;
  return { ok: true, mon, cost: q.cost, levelsGrown: q.levelsGrown };
}

// ------------------------------------------------------------------------------------ Pokédex

/**
 * Pokédex seen/owned bitfields (wPokedexSeen / wPokedexOwned, bit dex-1). Setting "owned"
 * also sets "seen" (every routine that sets owned sets seen too, except _GivePokemon's box
 * path, which marks seen via LoadEnemyMonData — same result).
 */
export class Pokedex {
  constructor({ seen = [], owned = [] } = {}) {
    this.seen = new Uint8Array(Math.ceil(NUM_POKEMON / 8));
    this.owned = new Uint8Array(Math.ceil(NUM_POKEMON / 8));
    for (const d of seen) this._set(this.seen, d);
    for (const d of owned) this._set(this.owned, d);
  }

  _dex(x) {
    if (typeof x === 'number') return x;
    return getGameData().dexOf(x);
  }

  _set(bits, x) {
    const d = this._dex(x);
    if (!(d >= 1 && d <= NUM_POKEMON)) throw new RangeError(`dex number ${d} out of range`);
    bits[(d - 1) >> 3] |= 1 << ((d - 1) & 7);
  }

  _test(bits, x) {
    const d = this._dex(x);
    if (!(d >= 1 && d <= NUM_POKEMON)) return false;
    return (bits[(d - 1) >> 3] & (1 << ((d - 1) & 7))) !== 0;
  }

  /** Mark a species seen (dex number or any species ref). */
  setSeen(x) { this._set(this.seen, x); }
  /** Mark a species owned (and seen). */
  setOwned(x) { this._set(this.owned, x); this._set(this.seen, x); }
  isSeen(x) { return this._test(this.seen, x); }
  isOwned(x) { return this._test(this.owned, x); }

  /** @returns {number[]} dex numbers */
  seenList() { return this._list(this.seen); }
  ownedList() { return this._list(this.owned); }
  get seenCount() { return this.seenList().length; }
  get ownedCount() { return this.ownedList().length; }

  _list(bits) {
    const out = [];
    for (let d = 1; d <= NUM_POKEMON; d++) if (bits[(d - 1) >> 3] & (1 << ((d - 1) & 7))) out.push(d);
    return out;
  }

  /** Highest seen dex number (the Pokédex list length), 0 if none. */
  get lastSeen() {
    const s = this.seenList();
    return s.length ? s[s.length - 1] : 0;
  }

  toJSON() { return { seen: this.seenList(), owned: this.ownedList() }; }
  static fromJSON(o) { return o instanceof Pokedex ? new Pokedex(o.toJSON()) : new Pokedex(o || {}); }
}
