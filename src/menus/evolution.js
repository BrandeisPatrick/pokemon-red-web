// Evolution from the menus (Rare Candy, evolution stones). The evolution *scene* belongs to
// the battle layer: if `game.hooks.evolve(info)` exists it is used (it may return a promise or
// a generator; its result `{cancelled}` tells whether a cancellable evolution was stopped).
// Otherwise a minimal stand-in runs here: "What? X is evolving!", 50 frames, the screen top
// cleared, the old and new pics alternating (B cancels when allowed), then
// "X evolved into Y!" (or "Huh? X stopped evolving!") — the texts of EvolutionAfterBattle.

import { evolve, moveLearnedOnLevelUp, knowsMove } from '../pokemon/learnset.js';
import { learnMoveFlow } from './learn_move.js';
import { drawPic } from './status_screen.js';

/**
 * Run an evolution.
 * @param {import('./base.js').MenuScene} s
 * @param {object} o
 * @param {any} o.mon party mon
 * @param {number} o.partyIndex
 * @param {number} o.from species (dex) before
 * @param {number} o.into species (dex) after
 * @param {boolean} o.cancellable B may stop it (level evolution); stones are forced
 * @param {boolean} [o.applied] the model already evolved the mon (stones: useItem did it)
 * @param {string} [o.name] the nickname before evolving (RenameEvolvedMon may change it)
 * @returns {Generator<any, {evolved:boolean}>}
 */
export function* runEvolution(s, o) {
  const game = s.game;
  const gd = s.gd;
  const hook = game.hooks && game.hooks.evolve;
  let cancelled = false;
  if (typeof hook === 'function') {
    let r = hook({ ...o, state: s.state });
    if (r && typeof r.next === 'function') r = yield* r;
    else if (r && typeof r.then === 'function') r = yield r;
    cancelled = !!(r && r.cancelled);
    s.flushInput();
  } else {
    cancelled = yield* evolutionStandIn(s, o);
  }
  if (cancelled && !o.applied) return { evolved: false };
  if (!o.applied) {
    const res = evolve(o.mon, o.into, gd);
    if (s.state.pokedex) s.state.pokedex.setOwned(o.into);
    if (typeof hook !== 'function' && res && res.moveToLearn) yield* learnMoveFlow(s, o.mon, res.moveToLearn);
    return { evolved: true };
  }
  if (typeof hook !== 'function') {
    const mv = moveLearnedOnLevelUp(o.mon.species, o.mon.level, gd);
    if (mv && !knowsMove(o.mon, mv)) yield* learnMoveFlow(s, o.mon, mv);
  }
  return { evolved: true };
}

/** @returns {Generator<any, boolean>} cancelled */
function* evolutionStandIn(s, o) {
  const gd = s.gd;
  const name = o.name ?? o.mon.nickname;
  yield* s.print('_IsEvolvingText', { subs: { wStringBuffer: name } });
  yield 50;
  const saved = s.scr.save();
  s.scr.clearArea(0, 0, 20, 12);
  const fromPic = yield s.ctx.frontPic(o.from);
  const intoPic = yield s.ctx.frontPic(o.into);
  let cancelled = false;
  s.evoPic = fromPic;
  const prev = s.drawExtra;
  s.drawExtra = (fb) => { prev.call(s, fb); if (s.evoPic) drawPic(fb, s.evoPic, 6, 4, {}); };
  s.flushInput();
  // the GB alternates the two pics with a speeding-up rhythm (Evolution_ChangeMonPic)
  for (let step = 0, wait = 16; step < 8; step++, wait = Math.max(2, wait - 2)) {
    s.evoPic = step % 2 ? fromPic : intoPic;
    for (let f = 0; f < wait; f++) {
      yield 1;
      const k = s.poll();
      if (k.b && o.cancellable) { cancelled = true; break; }
    }
    if (cancelled) break;
  }
  s.evoPic = cancelled ? fromPic : intoPic;
  if (cancelled) {
    yield* s.print('_StoppedEvolvingText', { subs: { wStringBuffer: name } });
  } else {
    s.cry(o.into);
    yield* s.print([
      { cmd: 'text_far', label: '_EvolvedText' },
      { cmd: 'text_far', label: '_IntoText' },
      { cmd: 'sound_get_item_2' },
      { cmd: 'text_promptbutton' },
      { cmd: 'text_end' },
    ], { subs: { wStringBuffer: name, wNameBuffer: gd.species(o.into).name } });
  }
  s.evoPic = null;
  s.drawExtra = prev;
  s.scr.restore(saved);
  return cancelled;
}
