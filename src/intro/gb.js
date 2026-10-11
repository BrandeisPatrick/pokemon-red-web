// Shared helpers for the start sequence: ports of the small home/*.asm routines the
// intro, title, menus and Oak's speech are built from, the GbScene base class (one
// coroutine per scene, stepped once per frame, followed by the VBlank of the GB model)
// and the hook / audio adapters.

import { PAD } from '../engine/input.js';
import { Coroutine, Scene } from '../engine/scene.js';
import { byteToMap } from '../engine/palette.js';
import { SPACE, GbScreen, VCHARS1, VCHARS2, BG_MAP1 } from './ppu.js';

export { PAD };

/** Charmap bytes used directly by the ported code. */
export const CH = Object.freeze({
  space: SPACE, cursor: 0xed, cursorHollow: 0xec, downArrow: 0xee, colon: 0x6d,
  digit0: 0xf6, ed: 0xf0, underscore: 0x76, raisedUnderscore: 0x77,
});

// ------------------------------------------------------------------ joypad

/**
 * hJoyHeld / hJoyPressed as `_Joypad` computes them: pressed = buttons down now that were
 * not down at the previous *poll*. Polling only when the asm calls Joypad reproduces the
 * GB's behaviour (a button pressed while nothing polls still counts at the next poll if
 * it is held; a tap that ends before the next poll is lost).
 */
export class Joy {
  /** @param {{heldMask:number, pressedMask:number}} input engine Input (sampled per frame) */
  constructor(input) {
    this.input = input;
    this.held = 0;
    this.pressed = 0;
    this.last = 0;
  }

  /** Joypad / JoypadLowSensitivity with hJoy7 = 0: returns hJoyPressed (= hJoy5). */
  poll() {
    const cur = (this.input.heldMask | this.input.pressedMask) & 0xff;
    this.pressed = cur & ~this.last;
    this.held = cur;
    this.last = cur;
    return this.pressed;
  }

  /** Treat the buttons that are down now as already seen (after another screen polled them). */
  sync() {
    this.last = (this.input.heldMask | this.input.pressedMask) & 0xff;
  }

  /** Forget the current state (hJoyHeld = 0 like PlayIntro does). */
  reset() {
    this.held = this.pressed = 0;
    this.last = (this.input.heldMask | this.input.pressedMask) & 0xff;
  }
}

/** Up+Select+B exactly (CheckForUserInterruption compares hJoyHeld for equality). */
export const UP_SELECT_B = PAD.up | PAD.select | PAD.b;

/**
 * CheckForUserInterruption (home/overworld.asm): c times { DelayFrame; Joypad;
 * Up+Select+B held -> true; Start or A newly pressed -> true }.
 * @param {Joy} joy
 * @param {number} c frames
 * @returns {Generator<any, boolean>}
 */
export function* checkForUserInterruption(joy, c) {
  do {
    yield 1;
    joy.poll();
    if (joy.held === UP_SELECT_B) return true;
    if (joy.pressed & (PAD.start | PAD.a)) return true;
  } while (--c > 0);
  return false;
}

// ------------------------------------------------------------------ timing helpers

/** Frames CopyVideoData / CopyVideoDataDouble take for n tiles (8 per VBlank, then the rest). */
export function videoCopyFrames(n) {
  return Math.floor(n / 8) + 1;
}

/**
 * CopyVideoData: auto BG transfer off, `write(first, count)` 8 tiles per frame, then the
 * remainder, transfer back on.
 * @param {import('./ppu.js').GbScreen} gb
 * @param {number} n tiles
 * @param {(first:number, count:number) => void} [write]
 */
export function* copyVideoData(gb, n, write) {
  const saved = gb.autoTransfer;
  gb.autoTransfer = false;
  let done = 0;
  while (n - done >= 8) {
    if (write) write(done, 8);
    done += 8;
    yield 1;
  }
  if (write) write(done, n - done);
  yield 1;
  gb.autoTransfer = saved;
}

/**
 * Wait for a promise (an audio hook's playCry/playSfx/waitForSfx) but never longer than
 * `maxFrames`; returns immediately if `p` is not a thenable.
 */
export function* waitFor(p, maxFrames = 600) {
  if (!p || typeof p.then !== 'function') return;
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < maxFrames && !done; i++) yield 1;
}

// ------------------------------------------------------------------ tile map helpers

/** ClearScreen without the delay: fill wTileMap with ' '. */
export function fillScreen(gb) {
  gb.tilemap.fill(SPACE);
}

/** ClearScreen: fill wTileMap with ' ' then Delay3. */
export function* clearScreen(gb) {
  fillScreen(gb);
  yield 3;
}

/** ClearScreenArea: c x b (width x height) of ' ' at (x, y). */
export function clearScreenArea(map, x, y, w, h) {
  map.fillRect(x, y, w, h, SPACE);
}

/**
 * TextBoxBorder with the asm's arguments: inner width c, inner height b at (x, y).
 * @param {import('../engine/font.js').Font} font
 */
export function textBoxBorder(font, map, x, y, c, b) {
  font.drawBox(map, x, y, c + 2, b + 2);
}

/**
 * PlaceString: write a string at (x, y); '\n' is <NEXT> (2 rows below the line start).
 * @returns {number} x after the last character
 */
export function placeString(font, map, x, y, str, subs) {
  return font.putText(map, str, x, y, { subs, lineStep: 2 });
}

/**
 * PrintNumber (home/print_num.asm) for a value that fits `digits` digits: right aligned,
 * spaces in front (or zeroes with leadingZeroes). @returns {number} x after the number
 */
export function printNumber(map, x, y, value, digits, { leadingZeroes = false } = {}) {
  const s = String(Math.max(0, Math.floor(value)) % 10 ** digits);
  for (let i = 0; i < digits; i++) {
    const k = i - (digits - s.length);
    const ch = k >= 0 ? CH.digit0 + Number(s[k]) : leadingZeroes ? CH.digit0 : SPACE;
    map.set(x + i, y, ch);
  }
  return x + digits;
}

// ------------------------------------------------------------------ menus (home/window.asm)

/**
 * The wTopMenuItemX/Y, wCurrentMenuItem, wLastMenuItem, wMaxMenuItem, wMenuWatchedKeys,
 * wMenuWrappingEnabled, wMenuWatchMovingOutOfBounds, wTileBehindCursor and
 * wMenuCursorLocation variables of one menu.
 */
export class MenuState {
  constructor({ topX = 1, topY = 2, cur = 0, last = 0, max = 0, watched = PAD.a, wrap = false, watchOOB = false, noSound = false } = {}) {
    Object.assign(this, { topX, topY, cur, last, max, watched, wrap, watchOOB, noSound });
    this.tileBehind = SPACE;
    /** index into wTileMap of the last ▶ placed (-1 = none) */
    this.cursorLoc = -1;
  }
}

/** PlaceMenuCursor (double-spaced menus). */
export function placeMenuCursor(map, m) {
  const cells = map.cells;
  const base = m.topY * 20 + m.topX;
  if (m.last) {
    const old = base + m.last * 40;
    if (cells[old] === CH.cursor) cells[old] = m.tileBehind;
  } else if (cells[base] === CH.cursor) {
    cells[base] = m.tileBehind;
  }
  const at = base + m.cur * 40;
  if (cells[at] !== CH.cursor) m.tileBehind = cells[at];
  cells[at] = CH.cursor;
  m.cursorLoc = at;
  m.last = m.cur;
}

/** EraseMenuCursor: ' ' at wMenuCursorLocation. */
export function eraseMenuCursor(map, m) {
  if (m.cursorLoc >= 0) map.cells[m.cursorLoc] = SPACE;
}

/** PlaceUnfilledArrowMenuCursor: ▷ at wMenuCursorLocation. */
export function placeUnfilledArrowMenuCursor(map, m) {
  if (m.cursorLoc >= 0) map.cells[m.cursorLoc] = CH.cursorHollow;
}

/**
 * HandleMenuInput: place the cursor, Delay3, then poll until a key is pressed; Up/Down
 * move (wrapping only if enabled); keys not in `watched` start over; A/B play
 * SFX_PRESS_AB unless the menu is silent. @returns {Generator<any, number>} hJoy5
 * @param {IntroContext} ctx
 * @param {MenuState} m
 */
export function* handleMenuInput(ctx, m) {
  const map = ctx.gb.tilemap;
  for (;;) {
    placeMenuCursor(map, m);
    yield 3;
    let keys = ctx.joy.poll();
    while (!keys) {
      yield 1;
      keys = ctx.joy.poll();
    }
    let checkKeys = true;
    if (keys & PAD.up) {
      if (m.cur > 0) m.cur--;
      else if (m.wrap) m.cur = m.max;
      else if (m.watchOOB) checkKeys = false;
    } else if (keys & PAD.down) {
      if (m.cur < m.max) m.cur++;
      else if (m.wrap) m.cur = 0;
      else if (m.watchOOB) checkKeys = false;
    }
    if (checkKeys && !(m.watched & keys)) continue;
    if (keys & (PAD.a | PAD.b) && !m.noSound) ctx.sound.playSfx('SFX_PRESS_AB');
    m.wrap = false;
    return keys;
  }
}

// ------------------------------------------------------------------ palettes (home/palettes.asm, fade.asm)

/** rBGP / rOBP0 / rOBP1 writes (any can be null to leave it). */
export function setPal(palette, bgp, obp0 = null, obp1 = null) {
  palette.setMaps(
    bgp == null ? palette.bgp : byteToMap(bgp),
    obp0 == null ? palette.obp0 : byteToMap(obp0),
    obp1 == null ? palette.obp1 : byteToMap(obp1),
  );
}

/** GBPalNormal: BGP %11100100, OBP0 %11010000. */
export function gbPalNormal(palette) {
  setPal(palette, 0xe4, 0xd0);
}

/** GBPalWhiteOut. */
export function gbPalWhiteOut(palette) {
  setPal(palette, 0, 0, 0);
}

/** LoadGBPal (wMapPalOffset = 0): FadePal4. */
export function loadGBPal(palette) {
  palette.setFadeStep(4);
}

/** GBPalWhiteOutWithDelay3. */
export function* gbPalWhiteOutWithDelay3(palette) {
  gbPalWhiteOut(palette);
  yield 3;
}

// ------------------------------------------------------------------ options

const SPEED_FRAMES = { fast: 1, mid: 3, medium: 3, slow: 5 };

/** Frames per letter for the options' text speed ('fast'|'mid'|'slow' or 1/3/5). */
export function textSpeedFrames(options) {
  const v = options && options.textSpeed;
  if (typeof v === 'number' && v >= 0) return v;
  return SPEED_FRAMES[v] ?? 3;
}

/** 'fast' | 'mid' | 'slow' for any accepted textSpeed value. */
export function textSpeedKey(options) {
  const f = textSpeedFrames(options);
  return f <= 1 ? 'fast' : f >= 5 ? 'slow' : 'mid';
}

/**
 * Store a text speed key, keeping the representation the options object already uses
 * (numbers stay frames, strings stay 'fast'|'mid'|'slow'; 'medium' is kept if used).
 */
export function setTextSpeed(options, key) {
  const frames = SPEED_FRAMES[key];
  if (typeof options.textSpeed === 'number') options.textSpeed = frames;
  else if (options.textSpeed === 'medium' && key === 'mid') options.textSpeed = 'medium';
  else options.textSpeed = key;
}

// ------------------------------------------------------------------ hooks

/**
 * @typedef {Object} IntroAudio
 * @property {(name:string) => any} [playMusic]
 * @property {() => any} [stopMusic]
 * @property {(name:string) => any} [playSfx]
 * @property {(dex:number|object|string) => any} [playCry]
 * @property {(frames:number) => any} [fadeOutMusic]
 * @property {() => any} [waitForSfx]
 */
/**
 * @typedef {Object} SaveInfo
 * @property {string} playerName
 * @property {number|Array<any>} badges   count (0-8), or an array of badges
 * @property {number} dexOwned
 * @property {number} playTimeFrames      60 per second
 */
/**
 * @typedef {Object} IntroHooks
 * @property {IntroAudio} [audio]
 * @property {() => SaveInfo|null} [saveInfo]
 * @property {() => any} [clearSave]
 * @property {{textSpeed: string|number, battleAnimations: boolean, battleStyle: 'shift'|'set'}} [options]
 * @property {(names: {playerName:string, rivalName:string}) => any} [onNewGame]
 * @property {() => any} [onContinue]
 */

/** Fill in defaults so the scenes never have to null-check. @param {IntroHooks} [h] */
export function normalizeHooks(h = {}) {
  const options = h.options || { textSpeed: 'mid', battleAnimations: true, battleStyle: 'shift' };
  if (options.textSpeed === undefined) options.textSpeed = 'mid';
  if (options.battleAnimations === undefined) options.battleAnimations = true;
  if (options.battleStyle === undefined) options.battleStyle = 'shift';
  return {
    audio: h.audio || null,
    saveInfo: typeof h.saveInfo === 'function' ? h.saveInfo : () => null,
    clearSave: typeof h.clearSave === 'function' ? h.clearSave : () => {},
    options,
    onNewGame: typeof h.onNewGame === 'function' ? h.onNewGame : (names) => console.info('[intro] onNewGame', names),
    onContinue: typeof h.onContinue === 'function' ? h.onContinue : () => console.info('[intro] onContinue'),
  };
}

/**
 * Safe wrapper around hooks.audio. Without an audio hook, SFX_PRESS_AB falls back to the
 * engine's beeper (game.sfx) and everything else is silent.
 */
export function makeSound(audio, sfx) {
  const call = (name, ...args) => {
    if (!audio || typeof audio[name] !== 'function') return undefined;
    try {
      const r = audio[name](...args);
      if (r && typeof r.catch === 'function') r.catch((e) => console.warn(`[intro] audio.${name} failed`, e));
      return r;
    } catch (e) {
      console.warn(`[intro] audio.${name} failed`, e);
      return undefined;
    }
  };
  const sound = {
    log: null,
    playMusic(name) { sound._log('music', name); return call('playMusic', name); },
    stopMusic() { sound._log('stop'); return call('stopMusic'); },
    fadeOutMusic(frames) { sound._log('fadeOut', frames); return call('fadeOutMusic', frames); },
    playSfx(name) {
      sound._log('sfx', name);
      if (audio && typeof audio.playSfx === 'function') return call('playSfx', name);
      if (name === 'SFX_PRESS_AB' && sfx && typeof sfx.play === 'function') sfx.play('press');
      return undefined;
    },
    playCry(dex) { sound._log('cry', dex); return call('playCry', dex); },
    waitForSfx() { return call('waitForSfx'); },
    _log(kind, arg) { if (sound.log) sound.log(kind, arg); },
  };
  return sound;
}

/** Adapter with the {play(name)} shape TextBox expects ('press' = SFX_PRESS_AB). */
export function textBoxSfx(sound) {
  return { play: (name) => sound.playSfx(name === 'press' ? 'SFX_PRESS_AB' : name), has: () => true };
}

// ------------------------------------------------------------------ scenes

/**
 * @typedef {Object} IntroContext
 * @property {any} game                         engine services (font, input, palette, rng, scenes...)
 * @property {import('./ppu.js').GbScreen} gb   the shared screen model
 * @property {Joy} joy
 * @property {ReturnType<typeof normalizeHooks>} hooks
 * @property {ReturnType<typeof makeSound>} sound
 * @property {any} data                         loaded assets (src/intro/data.js)
 * @property {any} wram                         persistent variables (names, title mon, case...)
 * @property {(scene: GbScene) => void} [onScene] notified whenever a scene starts
 */

/**
 * A scene whose behaviour is one generator (`script()`), stepped once per frame inside
 * update() and followed by the GB model's VBlank, so `yield` = DelayFrame.
 * The script's return value decides what happens next:
 *   {next: scene}  replace this scene        {pop: value}  pop with a result
 *   {call: fn}     run fn() after the script (if it returns a Scene, replace this one)
 * A sub-scene is run with `const r = yield* this.call(scene)` (the child's first step runs
 * in the same frame, and the parent continues in the frame the child finishes, like a
 * `call` in the asm).
 */
export class GbScene extends Scene {
  /** @param {IntroContext} ctx */
  constructor(ctx, params = {}) {
    super();
    this.ctx = ctx;
    this.params = params;
    this.co = null;
    this.idle = false;
    this._stepping = false;
    this._resumed = false;
    this._waitingSub = false;
    this._subResult = undefined;
  }

  /** Scene id used by the test page / debugging. */
  get id() { return 'scene'; }

  enter() {
    this.co = new Coroutine(this.script(this.params));
    if (this.ctx.onScene) this.ctx.onScene(this);
    this.step();
  }

  exit() {
    if (this.co && !this.co.done && !this._stepping) this.co.cancel();
  }

  /** Run the script until its next yield (DelayFrame). */
  step() {
    const co = this.co;
    if (!co || co.done || this._stepping) return;
    this._stepping = true;
    try {
      co.step();
    } finally {
      this._stepping = false;
    }
    if (co.done) {
      if (co.error) console.error(`[intro] ${this.id} script failed:`, co.error);
      this._finish(co.value);
    }
  }

  /** @private */
  _finish(v) {
    this.idle = true;
    if (!this.stack || !v) return;
    if (v.next) { this.stack.replace(v.next); return; }
    if ('pop' in v) { this.close(v.pop); return; }
    if (typeof v.call === 'function') {
      const r = v.call();
      if (r instanceof Scene && this.stack && this.stack.top === this) this.stack.replace(r);
    }
  }

  update() {
    if (!this.stack) return;
    const gb = this.ctx.gb;
    gb.beginFrame();
    this.step();
    gb.vblank();
  }

  resume(result) {
    // only a sub-scene started with call() continues the script in the same frame; a scene
    // pushed by someone else (e.g. namingScreen() over a menu) just un-pauses this one, and
    // the buttons it consumed must not count as new presses here
    if (!this._waitingSub) {
      this.ctx.joy.sync();
      return;
    }
    this._subResult = result;
    this._resumed = true;
    if (!this._stepping) this.step();
  }

  draw(fb) {
    this.ctx.gb.render(fb);
  }

  /** Push a sub-scene and wait (inside the script) until it pops; returns its result. */
  *call(scene) {
    this._resumed = false;
    this._waitingSub = true;
    try {
      this.stack.push(scene);
      if (!this._resumed) yield () => this._resumed;
    } finally {
      this._waitingSub = false;
      this._resumed = false;
    }
    return this._subResult;
  }

  /** @returns {Generator<any, any>} */
  *script() {}
}

/**
 * A context for running one of these screens outside the intro (namingScreen(),
 * optionsScreen()): its own screen model with the font and text box tiles loaded and the
 * window over the screen, like after the main menu.
 * @param {any} game engine services
 * @param {{audio?: any, options?: any}} [opts]
 * @returns {IntroContext}
 */
export function standaloneContext(game, { audio = null, options } = {}) {
  const gb = new GbScreen({ font: game.font });
  gb.vram.load(VCHARS2 + 0x60, game.font.gfx, 0x60, 32);
  gb.vram.load(VCHARS1, game.font.gfx, 0x80, 128);
  gb.hWY = gb.wy = 0;
  gb.autoTransfer = true;
  gb.autoDest = BG_MAP1;
  const hooks = normalizeHooks({ audio, options });
  return {
    game, gb, hooks, data: null,
    joy: new Joy(game.input),
    sound: makeSound(hooks.audio, game.sfx),
    wram: { alphabetLower: false, letterDelayFlags: 1, playerName: '', rivalName: '', titleMon: 0, curOpponent: 0 },
    onScene: null,
    make: {},
  };
}
