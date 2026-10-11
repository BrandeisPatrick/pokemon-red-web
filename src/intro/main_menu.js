// The main menu (MainMenu / DisplayContinueGameInfo in engine/menus/main_menu.asm).
//
//   ┌─────────────┐        CONTINUE only when hooks.saveInfo() returns a save.
//   │ ▶CONTINUE   │        HandleMenuInput: no wrap, Delay3 after every move, A/B blip,
//   │  NEW GAME   │        Start selects silently, B goes back to the title screen.
//   │  OPTION     │
//   └─────────────┘
// CONTINUE shows the save summary box (PLAYER / BADGES / POKéDEX / TIME) at (4,7); after
// 30 frames, holding A continues (hooks.onContinue) and holding B returns to the menu.
// NEW GAME runs Oak's speech; OPTION runs the option screen and redraws the menu.

import { GbScene, PAD, MenuState, handleMenuInput, clearScreen, copyVideoData, textBoxBorder, placeString, printNumber, gbPalWhiteOut, CH } from './gb.js';
import { VCHARS1, VCHARS2 } from './ppu.js';

export const MAIN_MENU_TIMING = Object.freeze({
  loopDelay: 20,        // .mainMenuLoop: DelayFrames 20
  afterChoice: 20,      // DelayFrames 20 after A/Start
  continueInfo: 30,     // DisplayContinueGameInfo: DelayFrames 30
  continueFade: 10,     // .pressedA: DelayFrames 10 after the white-out
});

/** PLAY TIME: hours (max 255) and minutes from a frame count (60 frames per second). */
export function playTimeParts(info) {
  if (info && Number.isFinite(info.playTimeHours)) {
    return { hours: Math.min(255, info.playTimeHours | 0), minutes: Math.min(59, (info.playTimeMinutes | 0)) };
  }
  const frames = Math.max(0, Math.floor((info && info.playTimeFrames) || 0));
  const totalMinutes = Math.floor(frames / 3600);
  return { hours: Math.min(255, Math.floor(totalMinutes / 60)), minutes: totalMinutes % 60 };
}

/** Number of badges from a count, an array or an object of booleans. */
export function badgeCount(b) {
  if (Array.isArray(b)) return b.filter(Boolean).length;
  if (b && typeof b === 'object') return Object.values(b).filter(Boolean).length;
  return Math.max(0, Math.min(8, Math.floor(Number(b) || 0)));
}

/** LoadFontTilePatterns (CopyVideoDataDouble 128 tiles = 17 frames with the LCD on). */
export function* loadFontTilePatterns(ctx) {
  const { gb, game } = ctx;
  yield* copyVideoData(gb, 128, (f, n) => gb.vram.load(VCHARS1 + f, game.font.gfx, 0x80 + f, n));
}

/** LoadTextBoxTilePatterns (CopyVideoData 32 tiles = 5 frames). */
export function* loadTextBoxTilePatterns(ctx) {
  const { gb, game } = ctx;
  yield* copyVideoData(gb, 32, (f, n) => gb.vram.load(VCHARS2 + 0x60 + f, game.font.gfx, 0x60 + f, n));
}

/**
 * DisplayContinueGameInfo: the save summary box. Pure tile writes (no delay).
 * @param {import('../engine/font.js').Font} font
 * @param {import('../engine/tilemap.js').TileMap} map
 * @param {import('./gb.js').SaveInfo} info
 */
export function drawContinueInfo(font, map, info) {
  textBoxBorder(font, map, 4, 7, 14, 8);
  placeString(font, map, 5, 9, 'PLAYER\nBADGES    \n#DEX    \nTIME');
  placeString(font, map, 12, 9, String(info.playerName || '').slice(0, 7));
  printNumber(map, 17, 11, badgeCount(info.badges), 2);
  printNumber(map, 16, 13, Math.max(0, Math.min(151, Math.floor(info.dexOwned || 0))), 3);
  const { hours, minutes } = playTimeParts(info);
  const x = printNumber(map, 13, 15, hours, 3);
  map.set(x, 15, CH.colon);
  printNumber(map, x + 1, 15, minutes, 2, { leadingZeroes: true });
}

export class MainMenuScene extends GbScene {
  get id() { return 'mainMenu'; }

  *script() {
    const ctx = this.ctx;
    const { gb, game, hooks, joy, wram } = ctx;
    const font = game.font;
    const map = gb.tilemap;
    // InitOptions: from here on letters use the option's text speed
    wram.letterDelayFlags = 1;
    let info = null;
    try { info = hooks.saveInfo(); } catch (e) { console.warn('[intro] saveInfo hook failed', e); }
    const hasSave = !!info;
    for (;;) {
      // .mainMenuLoop
      yield MAIN_MENU_TIMING.loopDelay;
      yield* clearScreen(gb);
      yield* loadTextBoxTilePatterns(ctx);
      yield* loadFontTilePatterns(ctx);
      if (hasSave) {
        textBoxBorder(font, map, 0, 0, 13, 6);
        placeString(font, map, 2, 2, 'CONTINUE\nNEW GAME\nOPTION');
      } else {
        textBoxBorder(font, map, 0, 0, 13, 4);
        placeString(font, map, 2, 2, 'NEW GAME\nOPTION');
      }
      const m = new MenuState({ topX: 1, topY: 2, cur: 0, last: 0, max: hasSave ? 2 : 1, watched: PAD.a | PAD.b | PAD.start });
      this.menu = m;
      const keys = yield* handleMenuInput(ctx, m);
      if (keys & PAD.b) return { next: ctx.make.title() };
      yield MAIN_MENU_TIMING.afterChoice;
      const item = hasSave ? m.cur : m.cur + 1;
      if (item === 0) {
        // .choseContinue
        gb.autoTransfer = false;
        drawContinueInfo(font, map, info);
        gb.autoTransfer = true;
        yield MAIN_MENU_TIMING.continueInfo;
        let choice = null;
        for (;;) {
          joy.poll();
          if (joy.held & PAD.a) { choice = 'a'; break; }
          if (joy.held & PAD.b) { choice = 'b'; break; }
          yield 1;
        }
        if (choice === 'b') continue;
        gbPalWhiteOut(game.palette);
        yield 3;
        yield* clearScreen(gb);
        yield MAIN_MENU_TIMING.continueFade;
        return { call: () => hooks.onContinue() };
      }
      if (item === 1) return { next: ctx.make.oakSpeech() };
      // OPTION
      yield* this.call(ctx.make.options());
    }
  }
}
