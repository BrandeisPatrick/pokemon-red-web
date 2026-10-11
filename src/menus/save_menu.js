// SAVE from the START menu (engine/menus/save.asm SaveMenu, engine/menus/main_menu.asm
// PrintSaveScreenText).
//
// The info box (4,0) 16×10: PLAYER / BADGES / POKéDEX / TIME at (5,2..8), the name (12,2),
// badges (17,4), owned (16,6), time (13,8); 30 frames; "Would you like to SAVE the game?" with
// YES/NO at (0,7); an older file of another player asks "The older file will be erased to
// save. Okay?"; then "Now saving..." at (1,14) for 120 frames, "{PLAYER} saved the game!",
// SFX_SAVE, 30 frames. Saving goes through src/game/save.js (localStorage).

import { MenuScene } from './base.js';
import { playTimeString, printNumber } from './format.js';
import { createSaveStore, saveGame, loadGame, hasSave } from '../game/save.js';

/** The store the menus save to: game.saveStore if set, else the default localStorage store. */
export function menuSaveStore(game) {
  if (!game.saveStore) game.saveStore = createSaveStore();
  return game.saveStore;
}

/**
 * CheckPreviousSaveFile: is there a save of *another* game (different name or ID)?
 * @returns {boolean}
 */
export function saveWouldOverwriteOther(store, state) {
  if (!hasSave(store)) return false;
  const old = loadGame(store);
  if (!old) return false;
  return old.playerName !== state.playerName || (old.playerId & 0xffff) !== (state.playerId & 0xffff);
}

export class SaveScene extends MenuScene {
  constructor(params = {}) {
    super({ ...params, opaque: false, vramMode: 'text' });
  }

  *main() {
    const st = this.state;
    const store = this.params.store || menuSaveStore(this.game);
    this.printSaveScreenText();
    yield 30;
    yield* this.print('_WouldYouLikeToSaveText');
    const yes = yield* this.yesNo({ x: 0, y: 7 });
    if (!yes) return yield* this.hold(false);
    if (saveWouldOverwriteOther(store, st)) {
      yield* this.print('_OlderFileWillBeErasedText');
      const ok = yield* this.yesNo({ x: 0, y: 7 });
      if (!ok) return yield* this.hold(false);
    }
    const r = saveGame(st, store);
    if (!r.ok) console.warn('[menus] save failed:', r.error);
    this.scr.clearArea(1, 13, 18, 4);
    this.scr.text(1, 14, 'Now saving...');
    yield 120;
    yield* this.print('_GameSavedText');
    yield* this.sfxWait('SFX_SAVE');
    yield 30;
    return yield* this.hold(r.ok);
  }

  /** HoldTextDisplayOpen: wait until A is released. */
  *hold(saved) {
    while (this.input.held && this.input.held.a) yield 1;
    return { saved };
  }

  /** PrintSaveScreenText. */
  printSaveScreenText() {
    const s = this.scr;
    const st = this.state;
    s.box(4, 0, 16, 10);
    s.text(5, 2, 'PLAYER\nBADGES    \n#DEX    \nTIME');
    s.text(12, 2, st.playerName);
    s.text(17, 4, printNumber(st.badgeCount, 2));
    s.num(16, 6, st.pokedex.ownedCount, 3);
    const t = st.playTimeParts || { hours: 0, minutes: 0 };
    const str = playTimeString(t.hours, t.minutes);
    // hours right-aligned in 3 cells (skipped cells keep the box blank)
    s.text(13, 8, str);
  }
}
