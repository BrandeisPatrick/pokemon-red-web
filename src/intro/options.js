// The OPTION screen (DisplayOptionMenu in engine/menus/main_menu.asm; the same screen is
// opened from the START menu in the overworld).
//
//   ┌──────────────────┐
//   │TEXT SPEED        │   ▶ = current row's choice, ▷ = the other rows' choices.
//   │▶FAST  ▷MEDIUM SLOW   Up/Down move between rows (wrapping), Left/Right change the
//   └──────────────────┘   choice (live: hooks.options changes immediately).
//   ┌──────────────────┐   B or Start leave; A leaves only on CANCEL. SFX_PRESS_AB on exit.
//   │BATTLE ANIMATION  │
//   │▷ON       OFF     │
//   └──────────────────┘
//   ┌──────────────────┐
//   │BATTLE STYLE      │
//   │▷SHIFT    SET     │
//   └──────────────────┘
//    ▷CANCEL
//
// options = {textSpeed: 'fast'|'mid'|'slow' (or 1/3/5 frames), battleAnimations: bool,
//            battleStyle: 'shift'|'set'}.

import { GbScene, PAD, MenuState, placeMenuCursor, eraseMenuCursor, placeUnfilledArrowMenuCursor, textBoxBorder, placeString, textSpeedKey, setTextSpeed, CH, standaloneContext } from './gb.js';

/** TextSpeedOptionData: cursor X -> speed. */
export const TEXT_SPEED_X = Object.freeze({ fast: 1, mid: 7, slow: 14 });
const X_TO_SPEED = { 1: 'fast', 7: 'mid', 14: 'slow' };

/** Cursor rows (wTopMenuItemY values). */
export const OPTION_ROWS = Object.freeze({ textSpeed: 3, battleAnimation: 8, battleStyle: 13, cancel: 16 });

/**
 * Pure model of the option cursor logic (for tests and reuse).
 * @param {{textSpeed:any, battleAnimations:boolean, battleStyle:string}} options
 */
export function createOptionCursor(options) {
  return {
    y: OPTION_ROWS.textSpeed,
    textSpeedX: TEXT_SPEED_X[textSpeedKey(options)],
    animX: options.battleAnimations === false ? 10 : 1,
    styleX: options.battleStyle === 'set' ? 10 : 1,
    cancelX: 1,
  };
}

/** X of the cursor on its current row. */
export function cursorX(c) {
  return c.y === 3 ? c.textSpeedX : c.y === 8 ? c.animX : c.y === 13 ? c.styleX : c.cancelX;
}

/**
 * One key press (hJoy5 bits). Returns 'exit' | 'move' (row changed) | 'change' (X changed)
 * | 'none'. Mutates the cursor; call applyOptions afterwards.
 */
export function optionCursorPress(c, keys) {
  if (keys & PAD.b || keys & PAD.start) return 'exit';
  if (keys & PAD.a) return c.y === 16 ? 'exit' : 'none';
  if (keys & PAD.down) {
    c.y = c.y === 16 ? 3 : c.y === 3 ? 8 : c.y === 8 ? 13 : 16;
    return 'move';
  }
  if (keys & PAD.up) {
    c.y = c.y === 8 ? 3 : c.y === 13 ? 8 : c.y === 16 ? 13 : 16;
    return 'move';
  }
  if (c.y === 8) { c.animX ^= 1 ^ 10; return 'change'; }
  if (c.y === 13) { c.styleX ^= 1 ^ 10; return 'change'; }
  if (c.y === 16) return 'none';
  if (keys & PAD.left) {
    c.textSpeedX = c.textSpeedX === 1 ? 1 : c.textSpeedX === 7 ? 1 : 7;
  } else {
    c.textSpeedX = c.textSpeedX === 14 ? 14 : c.textSpeedX === 7 ? 14 : 7;
  }
  return 'change';
}

/** SetOptionsFromCursorPositions. */
export function applyOptions(c, options) {
  setTextSpeed(options, X_TO_SPEED[c.textSpeedX] || 'mid');
  options.battleAnimations = c.animX === 1;
  options.battleStyle = c.styleX === 1 ? 'shift' : 'set';
}

/**
 * DisplayOptionMenu as a coroutine on the shared screen.
 * @param {import('./gb.js').IntroContext} ctx
 */
export function* optionMenu(ctx) {
  const { gb, game, hooks, joy, sound } = ctx;
  const font = game.font, map = gb.tilemap;
  textBoxBorder(font, map, 0, 0, 18, 3);
  textBoxBorder(font, map, 0, 5, 18, 3);
  textBoxBorder(font, map, 0, 10, 18, 3);
  placeString(font, map, 1, 1, 'TEXT SPEED\n FAST  MEDIUM SLOW');
  placeString(font, map, 1, 6, 'BATTLE ANIMATION\n ON       OFF');
  placeString(font, map, 1, 11, 'BATTLE STYLE\n SHIFT    SET');
  placeString(font, map, 2, 16, 'CANCEL');
  const c = createOptionCursor(hooks.options);
  // SetCursorPositionsFromOptions: ▷ on every row's choice
  map.set(c.textSpeedX, 3, CH.cursorHollow);
  map.set(c.animX, 8, CH.cursorHollow);
  map.set(c.styleX, 13, CH.cursorHollow);
  map.set(1, 16, CH.cursorHollow);
  const m = new MenuState({ topX: c.textSpeedX, topY: 3, cur: 0, last: 0 });
  gb.autoTransfer = true;
  yield 3;
  for (;;) {
    placeMenuCursor(map, m);
    applyOptions(c, hooks.options);
    let keys;
    for (;;) {
      keys = joy.poll() & ~PAD.select;
      if (keys) break;
      yield 1;
    }
    const r = optionCursorPress(c, keys);
    if (r === 'exit') {
      sound.playSfx('SFX_PRESS_AB');
      return;
    }
    if (r === 'move') {
      m.topY = c.y;
      m.topX = cursorX(c);
      placeUnfilledArrowMenuCursor(map, m);
    } else if (r === 'change') {
      m.topX = cursorX(c);
      eraseMenuCursor(map, m);
    }
    // back to .loop without a DelayFrame: the cursor moves this frame, the next poll
    // (which cannot see the same press again) waits for the next frame
  }
}

export class OptionsScene extends GbScene {
  get id() { return 'options'; }

  *script() {
    yield* optionMenu(this.ctx);
    return { pop: this.ctx.hooks.options };
  }
}

/**
 * Reusable widget (the START menu's OPTION entry): push the option screen on game.scenes,
 * edit `options` in place and resolve with it when the player leaves (B, Start, or A on
 * CANCEL). The screen is drawn on a cleared screen, as StartMenu_Option does.
 *   await optionsScreen(state.options);
 * @param {{textSpeed:any, battleAnimations:boolean, battleStyle:string}} options
 * @param {any} [game] engine services (default window.game)
 * @param {{audio?: any}} [opts]
 * @returns {Promise<any>}
 */
export function optionsScreen(options, game = globalThis.game, { audio = null } = {}) {
  if (!game || !game.scenes || !game.font) throw new Error('optionsScreen: needs the engine game object (window.game)');
  const ctx = standaloneContext(game, { audio, options });
  const scene = new OptionsScene(ctx);
  game.scenes.push(scene);
  return scene.finished;
}
