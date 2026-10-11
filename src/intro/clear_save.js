// The clear-save dialog (DoClearSaveDialogue in engine/movie/oak_speech/clear_save.asm),
// reached by holding Up+Select+B when leaving the title screen:
//   "Clear all saved / data?" + a NO/YES box at (14,7) (NO first, B ignored, no blip until
//   A, SFX_PRESS_AB, 15 frames). YES -> hooks.clearSave(). Either way the game restarts
//   from Init (copyright screen).

import { GbScene, PAD, MenuState, handleMenuInput, clearScreen, textBoxBorder, placeString, textSpeedFrames, textBoxSfx } from './gb.js';
import { loadFontTilePatterns, loadTextBoxTilePatterns } from './main_menu.js';
import { TextBox } from '../engine/text.js';

export class ClearSaveScene extends GbScene {
  get id() { return 'clearSave'; }

  *script() {
    const ctx = this.ctx;
    const { gb, game, hooks, data, sound, wram } = ctx;
    const font = game.font, map = gb.tilemap;
    yield* clearScreen(gb);
    yield* loadFontTilePatterns(ctx);
    yield* loadTextBoxTilePatterns(ctx);
    // wLetterPrintingDelayFlags is still 0 after PrepareTitleScreen: 1 frame per letter
    const speed = wram.letterDelayFlags ? textSpeedFrames(hooks.options) : 1;
    const box = new TextBox({ font, map, input: game.input, sfx: textBoxSfx(sound), speed, resolveFar: data.texts });
    yield* box.run([{ cmd: 'text_far', label: '_ClearSaveDataText' }, { cmd: 'text_end' }]);
    // TWO_OPTION_MENU / NO_YES_MENU at hlcoord 14,7, cursor (15,8)
    const saved = map.save(14, 7, 6, 5);
    textBoxBorder(font, map, 14, 7, 4, 3);
    placeString(font, map, 16, 8, 'NO\nYES');
    const m = new MenuState({ topX: 15, topY: 8, cur: 0, last: 0, max: 1, watched: PAD.a | PAD.b, noSound: true });
    for (;;) {
      const keys = yield* handleMenuInput(ctx, m);
      if (!(keys & PAD.b)) break; // this menu type ignores B
    }
    sound.playSfx('SFX_PRESS_AB');
    yield 15;
    map.restore(saved);
    if (m.cur === 1) {
      try { hooks.clearSave(); } catch (e) { console.warn('[intro] clearSave hook failed', e); }
    }
    return { next: ctx.make.splash() }; // jp Init
  }
}
