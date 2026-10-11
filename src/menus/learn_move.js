// Teaching a move to a party mon (engine/pokemon/learn_move.asm LearnMove) and the move list
// used by PP items (engine/battle/core.asm MoveSelectionMenu, wMoveMenuType 2), as coroutines
// that run inside any MenuScene (they draw into its tile layer and text box).

import { learnMove, isHMMove } from '../pokemon/learnset.js';

/**
 * LearnMove. @returns {Generator<any, boolean>} true if learned
 * @param {import('./base.js').MenuScene} s
 * @param {any} mon party mon (mutated)
 * @param {string} move move const
 */
export function* learnMoveFlow(s, mon, move) {
  const gd = s.gd;
  const mname = gd.move(move).name;
  const vars = { wLearnMoveMonName: mon.nickname, wStringBuffer: mname };
  // SaveScreenTilesToBuffer1
  const saved = s.scr.save();
  for (;;) {
    // DontAbandonLearning: an empty slot?
    if (mon.moves.length < 4) {
      learnMove(mon, move, {}, gd);
      yield* printLearned(s, vars);
      return true;
    }
    // TryingToLearn
    yield* s.print('_TryingToLearnText', { subs: vars });
    const yes = yield* s.yesNo();
    if (yes) {
      const slot = yield* forgetWhichMove(s, mon, saved);
      if (slot >= 0) {
        const old = mon.moves[slot].move;
        learnMove(mon, move, { replaceSlot: slot }, gd);
        // OneTwoAndText: text_pause, SFX_SWAP, PoofText + text_pause, ForgotAndText
        yield* s.print([{ cmd: 'text_far', label: '_OneTwoAndText' }, { cmd: 'text_pause' }], { subs: vars });
        yield* s.sfxWait('SFX_SWAP');
        yield* s.print([
          { cmd: 'text_far', label: '_PoofText' }, { cmd: 'text_pause' },
          { cmd: 'text_far', label: '_ForgotAndText' }, { cmd: 'text_end' },
        ], { open: false, subs: { ...vars, wNameBuffer: gd.move(old).name } });
        yield* printLearned(s, vars);
        return true;
      }
    }
    // AbandonLearning
    yield* s.print('_AbandonLearningText', { subs: vars });
    const abandon = yield* s.yesNo();
    if (abandon) {
      yield* s.print('_DidNotLearnText', { subs: vars });
      return false;
    }
  }
}

/** LearnedMove1Text: "X learned Y!" + sound_get_item_1 + text_promptbutton. */
function* printLearned(s, vars) {
  yield* s.print([
    { cmd: 'text_far', label: '_LearnedMove1Text' },
    { cmd: 'sound_get_item_1' },
    { cmd: 'text_promptbutton' },
    { cmd: 'text_end' },
  ], { subs: vars });
}

/**
 * "Which move should be forgotten?": box (4,7) 16×6, moves single-spaced at (6,8), cursor
 * (5,8); the screen is restored after every choice (LoadScreenTilesFromBuffer1); HM moves
 * can't be deleted. @returns {Generator<any, number>} slot or -1 (B)
 */
export function* forgetWhichMove(s, mon, saved) {
  const gd = s.gd;
  for (;;) {
    yield* s.print('_WhichMoveToForgetText');
    s.scr.box(4, 7, 16, 6);
    s.scr.text(6, 8, mon.moves.map((m) => gd.move(m.move).name).join('\n'), { lineStep: 1 });
    const r = yield* s.menuInput({ x: 5, y: 8, max: mon.moves.length - 1, current: 0, step: 1 });
    if (saved) s.scr.restore(saved);
    if (r.keys.b) return -1;
    if (isHMMove(mon.moves[r.index].move, gd)) {
      yield* s.print('_HMCantDeleteText');
      continue;
    }
    return r.index;
  }
}

/**
 * MoveSelectionMenu with wMoveMenuType 2 (PP Up / Ether): box (4,7) 16×6, the moves (or '-')
 * at (6,8) single-spaced, cursor column 5; the index is 1-based around the moves and wraps
 * (SelectMenuItem_CursorUp/Down); B cancels. @returns {Generator<any, number>} slot or -1
 */
export function* chooseMoveMenu(s, mon) {
  const gd = s.gd;
  const n = mon.moves.length;
  s.scr.box(4, 7, 16, 6);
  const names = [];
  for (let i = 0; i < 4; i++) names.push(mon.moves[i] ? gd.move(mon.moves[i].move).name : '-');
  s.scr.text(6, 8, names.join('\n'), { lineStep: 1 });
  let cur = 1;
  for (;;) {
    const r = yield* s.menuInput({ x: 5, y: 7, max: n + 1, current: cur, last: cur, step: 1, watched: ['a', 'b', 'up', 'down'] });
    cur = r.index;
    if (r.keys.up && cur === 0) { s.eraseCursor(); cur = n; continue; }
    if (r.keys.down && cur === n + 1) { s.eraseCursor(); cur = 1; continue; }
    if (r.keys.up || r.keys.down) continue;
    if (r.keys.b) return -1;
    return cur - 1;
  }
}
