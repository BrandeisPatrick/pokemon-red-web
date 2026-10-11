// Moves and evolutions: WriteMonMoves, LearnMoveFromLevelUp, EvolutionAfterBattle,
// RenameEvolvedMon (engine/pokemon/evos_moves.asm), LearnMove (engine/pokemon/learn_move.asm),
// CanLearnTM / TM-HM moves (engine/items/tmhm.asm, data/moves/tmhm_moves.asm).

import { getGameData } from './data.js';
import { recalcStats } from './stats.js';

export const NUM_MOVES = 4;

/** Level-up learnset of a species: [{level, move}] ascending. */
export function levelUpMoves(species, gd = getGameData()) {
  return gd.species(species).learnset;
}

/** Every move the species learns exactly at `level` (in learnset order). */
export function movesLearnedAtLevel(species, level, gd = getGameData()) {
  return levelUpMoves(species, gd).filter((e) => e.level === level).map((e) => e.move);
}

/**
 * LearnMoveFromLevelUp: the FIRST learnset entry whose level equals `level`, or null. (Only
 * the final level's move is offered after a multi-level gain, and an already-known move ends
 * the search — check with knowsMove.)
 */
export function moveLearnedOnLevelUp(species, level, gd = getGameData()) {
  const e = levelUpMoves(species, gd).find((x) => x.level === level);
  return e ? e.move : null;
}

/**
 * WriteMonMoves: start from the species' level-1 moves, then for every learnset entry with
 * level <= `level` (stops at the first higher one) that isn't known yet: fill the first empty
 * slot, or shift all moves up (dropping slot 1) and put it in slot 4. Result = the "last 4
 * level-up moves" rule used for wild, trainer and new party mons.
 * @returns {string[]} 1-4 move consts
 */
export function defaultMoveset(species, level, gd = getGameData()) {
  const sp = gd.species(species);
  const moves = sp.startMoves.slice(0, NUM_MOVES);
  for (const e of sp.learnset) {
    if (e.level > level) break;
    if (moves.includes(e.move)) continue;
    if (moves.length < NUM_MOVES) moves.push(e.move);
    else {
      moves.shift();
      moves.push(e.move);
    }
  }
  return moves;
}

/**
 * WriteMonMoves with wLearningMovesFromDayCare set (day-care withdrawal): only moves with
 * startLevel < level <= newLevel are considered, PP travel with their moves when slots shift,
 * and each new move gets its base PP (PP Ups of shifted moves are kept, the dropped one's lost).
 * @param {{move:string, pp:number, ppUps:number}[]} moves current moves (not mutated)
 * @returns {{move:string, pp:number, ppUps:number}[]}
 */
export function dayCareMoves(species, startLevel, newLevel, moves, gd = getGameData()) {
  const out = moves.map((m) => ({ ...m }));
  for (const e of levelUpMoves(species, gd)) {
    if (e.level > newLevel) break;
    if (e.level <= startLevel) continue;
    if (out.some((m) => m.move === e.move)) continue;
    const slot = { move: e.move, pp: gd.move(e.move).pp, ppUps: 0 };
    if (out.length < NUM_MOVES) out.push(slot);
    else {
      out.shift();
      out.push(slot);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------- TM/HM

/** Move taught by a TM/HM item (const "TM_THUNDERBOLT", name "TM24"/"HM03", or the item). */
export function machineMove(item, gd = getGameData()) {
  const it = gd.item(item);
  if (!it.effect || it.effect.kind !== 'teachMove') throw new Error(`${it.const} is not a TM/HM`);
  return it.move;
}

/** @returns {boolean} the item is an HM (HM01-HM05) */
export function isHM(item, gd = getGameData()) {
  const it = gd.findItem(item);
  return !!(it && it.hm);
}

/** @returns {boolean} the item is a TM (TM01-TM50) */
export function isTM(item, gd = getGameData()) {
  const it = gd.findItem(item);
  return !!(it && it.tm);
}

/** @returns {boolean} the move is one of the 5 HM moves (can't be forgotten, IsMoveHM). */
export function isHMMove(move, gd = getGameData()) {
  const m = gd.move(move);
  return gd.raw.items.hmMoves.includes(m.const);
}

/**
 * CanLearnTM: whether the species' TM/HM bitfield has the machine. Accepts the machine item
 * (const / "TM24" / id) or the move const it teaches.
 */
export function canLearnTM(species, itemOrMove, gd = getGameData()) {
  const sp = gd.species(species);
  const it = gd.findItem(itemOrMove);
  const move = it && it.effect && it.effect.kind === 'teachMove' ? it.move : gd.move(itemOrMove).const;
  return sp.tmhm.includes(move);
}

// ------------------------------------------------------------------------------- learning

/** @returns {boolean} the mon knows `move` */
export function knowsMove(mon, move) {
  return (mon.moves || []).some((m) => (m.move || m) === move);
}

/** @returns {boolean} the mon knows any HM move (the day care refuses those, KnowsHMMove). */
export function knowsHMMove(mon, gd = getGameData()) {
  return (mon.moves || []).some((m) => isHMMove(m.move || m, gd));
}

/**
 * LearnMove: put `move` into the first empty slot; with 4 moves the player must pick one to
 * forget (`replaceSlot`, 0-3). HM moves can't be forgotten. The new move gets its base PP and
 * the slot's PP Ups are lost (the whole PP byte is overwritten). Mutates `mon.moves`.
 * @param {object} mon
 * @param {string} move
 * @param {{replaceSlot?:number}} [o]
 * @returns {{result:'learned'|'replaced'|'needsReplace'|'alreadyKnown'|'cannotForgetHM',
 *   slot?:number, forgotten?:string}}
 */
export function learnMove(mon, move, { replaceSlot } = {}, gd = getGameData()) {
  const m = gd.move(move);
  mon.moves = mon.moves || [];
  if (knowsMove(mon, m.const)) return { result: 'alreadyKnown' };
  if (mon.moves.length < NUM_MOVES) {
    mon.moves.push({ move: m.const, pp: m.pp, ppUps: 0 });
    return { result: 'learned', slot: mon.moves.length - 1 };
  }
  if (replaceSlot === undefined || replaceSlot === null) return { result: 'needsReplace' };
  const old = mon.moves[replaceSlot];
  if (!old) throw new Error(`learnMove: no move in slot ${replaceSlot}`);
  if (isHMMove(old.move, gd)) return { result: 'cannotForgetHM', slot: replaceSlot };
  mon.moves[replaceSlot] = { move: m.const, pp: m.pp, ppUps: 0 };
  return { result: 'replaced', slot: replaceSlot, forgotten: old.move };
}

// ------------------------------------------------------------------------------- evolution

/** Evolution entries of a species (data order). */
export function evolutionsOf(species, gd = getGameData()) {
  return gd.species(species).evolutions || [];
}

/**
 * EvolutionAfterBattle for a mon that levelled up (wForceEvolution = 0, not trading): walk the
 * entries in order; the first level entry with mon level >= its level wins; item and trade
 * entries are skipped. (The stone-glitch — an item entry matching wCurItem by accident — is
 * not reproduced.)
 * @returns {object|null} the evolution entry ({into, intoConst, ...})
 */
export function levelEvolution(mon, gd = getGameData()) {
  for (const e of evolutionsOf(mon.species, gd)) {
    if (e.method === 'level' && mon.level >= e.level) return e;
  }
  return null;
}

/**
 * Stone use (ItemUseEvoStone → wForceEvolution = 1): item entries naming the stone with
 * level >= minLevel evolve; trade entries are skipped; a level entry stops the search.
 */
export function itemEvolution(mon, item, gd = getGameData()) {
  const stone = gd.item(item).const;
  for (const e of evolutionsOf(mon.species, gd)) {
    if (e.method === 'trade') continue;
    if (e.method === 'level') return null;
    if (e.item === stone && mon.level >= (e.minLevel || 1)) return e;
  }
  return null;
}

/**
 * Link-trade evolution (wLinkState = LINK_STATE_TRADING): only a trade entry can apply and the
 * first non-trade entry ends the search. In-game NPC trades never trigger it.
 */
export function tradeEvolution(mon, gd = getGameData()) {
  for (const e of evolutionsOf(mon.species, gd)) {
    if (e.method !== 'trade') return null;
    return mon.level >= (e.minLevel || 1) ? e : null;
  }
  return null;
}

/**
 * Which evolution applies for a trigger.
 * @param {object} mon
 * @param {{trigger?:'level'|'item'|'trade', item?:string, allowTrade?:boolean}} [o]
 *   trade evolutions return null unless allowTrade (there is no link cable here)
 */
export function evolutionFor(mon, { trigger = 'level', item, allowTrade = false } = {}, gd = getGameData()) {
  if (trigger === 'item') return itemEvolution(mon, item, gd);
  if (trigger === 'trade') return allowTrade ? tradeEvolution(mon, gd) : null;
  return levelEvolution(mon, gd);
}

/**
 * Evolve a mon (EvolveMon tail of EvolutionAfterBattle): new species, RenameEvolvedMon (a
 * nickname equal to the OLD species name becomes the new species name, real nicknames are
 * kept), stats recalculated with stat exp, current HP += max-HP gain, and the new species'
 * move for the current level reported (LearnMoveFromLevelUp; teach it with learnMove).
 * The caller marks the new species owned/seen in the Pokédex. Mutates `mon`.
 * @param {object} mon
 * @param {any} [into] species ref or evolution entry; omitted → levelEvolution(mon)
 * @returns {{from:number, into:number, renamed:boolean, hpGain:number, moveToLearn:string|null}|null}
 *   null when `into` was omitted and no level evolution applies
 */
export function evolve(mon, into, gd = getGameData()) {
  if (into === undefined || into === null) {
    into = levelEvolution(mon, gd);
    if (!into) return null;
  }
  const from = gd.species(mon.species);
  const to = gd.species(into && into.into !== undefined ? into.into : into);
  let renamed = false;
  if (mon.nickname === from.name) {
    mon.nickname = to.name;
    renamed = true;
  }
  mon.species = to.dex;
  const { hpGain } = recalcStats(mon, { keepHpDifference: true }, gd);
  const move = moveLearnedOnLevelUp(to.dex, mon.level, gd);
  return { from: from.dex, into: to.dex, renamed, hpGain, moveToLearn: move && !knowsMove(mon, move) ? move : null };
}
