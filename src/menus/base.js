// MenuScene: the base of every menu screen. One engine Scene with its own tile layer
// (wTileMap), a byte writer (Screen), a Gen-1 TextBox, sprites, and a coroutine `main()`
// whose return value pops the scene (the parent's `yield* this.child(scene)` gets it).
//
// Helpers mirror the home/ routines the menu code is built from:
//   menuInput()   HandleMenuInput (PlaceMenuCursor, Delay3, wrap / out-of-bounds, A/B blip)
//   print()       PrintText (box at (0,12), 3 frames, TextCommandProcessor)
//   yesNo()       DisplayTextBoxID TWO_OPTION_MENU (YES/NO at (14,7), 15 frames after)
//   waitButton()  WaitForTextScrollButtonPress (▼ at (18,16) blinks if present)
//   child()       push another scene and wait for its result

import { Scene } from '../engine/scene.js';
import { TileMap } from '../engine/tilemap.js';
import { TextBox, ARROW_BLINK_FRAMES } from '../engine/text.js';
import { Menu, YesNoMenu } from '../engine/menu.js';
import { Screen, SPACE, CURSOR, CURSOR_HOLLOW, DOWN_ARROW } from './screen.js';
import { menuContext } from './context.js';
import { printBCD, LEADING_ZEROES, LEFT_ALIGN, MONEY_SIGN } from './format.js';
import { waitPromise } from './sound.js';

export const BUTTONS = Object.freeze(['a', 'b', 'select', 'start', 'right', 'left', 'up', 'down']);
const NO_KEYS = () => ({ a: false, b: false, select: false, start: false, right: false, left: false, up: false, down: false });

/** 'sound_get_item_1' -> 'SFX_GET_ITEM_1'. */
export function soundName(s) {
  if (!s) return s;
  if (/^SFX_|^MUSIC_/.test(s)) return s;
  return String(s).replace(/^sound_/, 'SFX_').toUpperCase();
}

const BCD_FLAG = { LEADING_ZEROES, LEFT_ALIGN, MONEY_SIGN };

/** Two-part texts the game joins with text_low (ItemUseText00, Got On/Off Bicycle). */
const LOW_PAIRS = new Set(['_ItemUseText001', '_GotOnBicycleText1', '_GotOffBicycleText1']);

/**
 * Prepare text commands for the engine TextBox: sounds become blocking calls (TextCommand_SOUND
 * waits for the SFX to end), text_bcd is printed through our exact PrintBCDNumber.
 */
export function prepareText(cmds) {
  if (!Array.isArray(cmds)) return cmds;
  return cmds.map((c) => {
    if (!c || typeof c !== 'object') return c;
    const name = String(c.cmd || '');
    if (name === 'sound' || name.startsWith('sound_')) {
      return { cmd: 'text_asm', __sound: soundName(c.sound || c.name || (name !== 'sound' ? name : c.str)) };
    }
    if (name === 'text_bcd') {
      const flags = (c.flags || []).reduce((m, f) => m | (BCD_FLAG[f] || 0), 0);
      return { cmd: 'text_ram', ram: `${c.ram}#${c.bytes || 3}#${flags}` };
    }
    return c;
  });
}

/** Substitutions with on-the-fly BCD formatting for keys "ram#bytes#flags". */
export function makeSubs(base) {
  return new Proxy(base, {
    get(t, k) {
      if (typeof k !== 'string') return t[k];
      if (k in t) return t[k];
      const m = /^(.+)#(\d+)#(\d+)$/.exec(k);
      if (m && m[1] in t) return printBCD(t[m[1]], Number(m[2]), Number(m[3]));
      return undefined;
    },
    has(t, k) { return k in t || (typeof k === 'string' && /#\d+#\d+$/.test(k)); },
  });
}

export class MenuScene extends Scene {
  /**
   * @param {object} [params]
   * @param {boolean} [params.opaque] hide the scenes below (full-screen menus)
   * @param {any} [params.state] GameState (default game.state)
   */
  constructor(params = {}) {
    super();
    this.params = params;
    this.opaque = params.opaque ?? false;
    /** VRAM table name (context.vram[...]) */
    this.vramMode = params.vramMode || 'text';
    /** extra sprites drawn after the tile layer: {img, sx, sy, w, h, x, y, opts} */
    this.sprites = [];
    this.frame = 0;
    this._acc = new Set();
    this.result = undefined;
  }

  // ------------------------------------------------------------------ scene plumbing

  enter(params) {
    if (params && typeof params === 'object') this.params = { ...this.params, ...params };
    this.ctx = menuContext(this.game);
    this.state = this.params.state || this.game.state;
    this.font = this.ctx.font;
    this.ui = new TileMap(20, 18);
    this.scr = new Screen({ font: this.font, charmap: this.ctx.charmap, map: this.ui, vram: this.ctx.vram[this.vramMode], subs: this.baseSubs() });
    this.box = new TextBox({
      font: this.font, map: this.ui, input: this.game.input, sfx: this.ctx.sound.blip,
      speed: this.textSpeed(), subs: this.baseSubs(),
      resolveFar: (label) => prepareText(this.ctx.textCommands(label, this.mapName)),
      onCall: (cmd) => this.onTextCall(cmd),
    });
    this.run(this._main());
  }

  /** @private */
  *_main() {
    let r;
    try {
      r = yield* this.main(this.params);
    } catch (err) {
      console.error('[menus]', this.constructor.name, err);
      r = null;
    }
    this.result = r;
    this.close(r);
  }

  /** Override: the scene's flow. Its return value is the scene result. */
  *main() { return null; }

  update(frame, input) {
    this.frame++;
    for (const b of BUTTONS) if (input.pressed && input.pressed[b]) this._acc.add(b);
  }

  resume() {
    // the child scene consumed the presses (hJoyPressed is relative to the last Joypad call)
    this._acc.clear();
  }

  exit() {
    // LoadGBPal: a top-level menu (opened through index.js) hands the screen back with the
    // palette it found, as CloseTextDisplay / the START menu's exit reload the map palette.
    const p = this.restorePaletteOnExit;
    if (p && this.game && this.game.palette) this.game.palette.setMaps(p.bgp, p.obp0, p.obp1);
  }

  draw(fb) {
    if (this.hiddenByAbove()) return;
    if (this._frozenCells) {
      // hAutoBGTransferEnabled = 0: the screen keeps the tiles of the last transfer
      const live = this.ui.cells;
      this.ui.cells = this._frozenCells;
      try { this.ui.draw(fb, this.ctx.sheet.gfx); } finally { this.ui.cells = live; }
    } else {
      this.ui.draw(fb, this.ctx.sheet.gfx);
    }
    for (const s of this.sprites) {
      if (!s || s.hidden) continue;
      fb.blit(s.img, s.sx || 0, s.sy || 0, s.w ?? s.img.width, s.h ?? s.img.height, s.x, s.y, s.opts || { obj: 0 });
    }
    this.drawExtra(fb);
  }

  /** Override for extra drawing (pics, animations). */
  drawExtra(fb) {}

  /**
   * xor a / ldh [hAutoBGTransferEnabled], a: keep showing the current tiles while the code
   * redraws (e.g. DisplayListMenuID's 10-frame wait before the entries are printed).
   */
  freezeBg() {
    if (!this._frozenCells) this._frozenCells = Int16Array.from(this.ui.cells);
  }

  /** ldh [hAutoBGTransferEnabled], 1: the screen follows the tile map again. */
  thawBg() {
    this._frozenCells = null;
  }

  /** A scene above set `hideMenusBelow` (ItemUseReloadOverworldData: the map shows again). */
  hiddenByAbove() {
    const list = this.stack ? this.stack.scenes : null;
    if (!list) return false;
    for (let k = list.indexOf(this) + 1; k < list.length; k++) if (list[k].hideMenusBelow) return true;
    return false;
  }

  // ------------------------------------------------------------------ state helpers

  get gd() { return this.ctx.gd; }
  get snd() { return this.ctx.sound; }
  get input() { return this.game.input; }

  baseSubs() {
    const s = this.state || {};
    return { PLAYER: s.playerName || 'RED', RIVAL: s.rivalName || 'BLUE', wPlayerName: s.playerName || 'RED', wRivalName: s.rivalName || 'BLUE' };
  }

  /** Frames per letter (wOptions). */
  textSpeed() {
    const o = this.game.options;
    if (o && typeof o.menuTextSpeed === 'number') return o.menuTextSpeed; // test / debug override
    const s = this.state;
    if (s && typeof s.textSpeedFrames === 'number') return s.textSpeedFrames;
    const g = this.game.options && this.game.options.textSpeed;
    return typeof g === 'number' ? g : 3;
  }

  // ------------------------------------------------------------------ input

  /**
   * hJoyPressed since the last poll (presses during delays are kept), plus auto-repeated
   * directions in the low-sensitivity mode (hJoy7 = 1, list menus).
   */
  poll(repeat = false) {
    const k = NO_KEYS();
    for (const b of this._acc) k[b] = true;
    this._acc.clear();
    const inp = this.game.input;
    if (repeat && inp && typeof inp.repeat === 'function') {
      const abHeld = inp.held && (inp.held.a || inp.held.b);
      for (const d of ['up', 'down', 'left', 'right']) {
        if (inp.pressed && inp.pressed[d]) continue;
        if (!abHeld && inp.repeat(d)) k[d] = true;
      }
    }
    return k;
  }

  /** Forget pending presses (after an engine widget consumed them). */
  flushInput() { this._acc.clear(); }

  /**
   * HandleMenuInput.
   * @param {object} cfg
   * @param {number} cfg.x wTopMenuItemX (cursor column)
   * @param {number} cfg.y wTopMenuItemY (row of item 0)
   * @param {number} cfg.max wMaxMenuItem
   * @param {number} [cfg.current] wCurrentMenuItem
   * @param {number} [cfg.last] wLastMenuItem (where an old ▶ may be)
   * @param {string[]} [cfg.watched] wMenuWatchedKeys (default a, b)
   * @param {boolean} [cfg.wrap] wMenuWrappingEnabled
   * @param {boolean} [cfg.outOfBounds] wMenuWatchMovingOutOfBounds
   * @param {number} [cfg.step] rows between items (2; 1 = BIT_DOUBLE_SPACED_MENU)
   * @param {boolean} [cfg.sound] SFX_PRESS_AB on A/B (false = BIT_NO_MENU_BUTTON_SOUND)
   * @param {boolean} [cfg.repeat] hJoy7 low-sensitivity auto-repeat
   * @param {(index:number, frame:number) => void} [cfg.idle] called every frame while waiting
   * @param {{x:number, y:number}} [cfg.blink] blink a ▼ here (HandleDownArrowBlinkTiming)
   * @param {Screen} [cfg.screen]
   * @returns {Generator<any, {keys:any, index:number, outOfBounds:boolean}>}
   */
  *menuInput(cfg) {
    const scr = cfg.screen || this.scr;
    const step = cfg.step ?? 2;
    const watched = cfg.watched || ['a', 'b'];
    let cur = cfg.current ?? 0;
    let last = cfg.last ?? cur;
    const pos = (i) => [cfg.x, cfg.y + i * step];
    let behind = cfg.behind ?? SPACE;
    let blinkFrames = 0;
    let blinkOn = true;
    for (;;) {
      // PlaceMenuCursor
      const [ox, oy] = pos(last);
      if (scr.is(ox, oy, CURSOR)) scr.put(ox, oy, behind);
      const [nx, ny] = pos(cur);
      if (!scr.is(nx, ny, CURSOR)) {
        const b = scr.get(nx, ny);
        behind = b >= 0 ? b : SPACE;
      }
      scr.put(nx, ny, CURSOR);
      last = cur;
      this.menuCursor = { x: nx, y: ny };
      if (cfg.onPlace) cfg.onPlace(cur);
      // Delay3 (+ the idle animation keeps running on the GB only inside loop2)
      let idleFrame = 0;
      yield 3;
      let keys;
      for (;;) {
        if (cfg.idle) cfg.idle(cur, idleFrame++);
        if (cfg.blink) {
          if (scr.is(cfg.blink.x, cfg.blink.y, DOWN_ARROW) || !blinkOn) {
            if (++blinkFrames >= ARROW_BLINK_FRAMES) {
              blinkFrames = 0;
              blinkOn = !blinkOn;
              scr.put(cfg.blink.x, cfg.blink.y, blinkOn ? DOWN_ARROW : SPACE);
            }
          }
        }
        keys = this.poll(cfg.repeat);
        if (BUTTONS.some((b) => keys[b])) break;
        yield 1;
      }
      let oob = false;
      if (keys.up) {
        if (cur > 0) cur--;
        else if (cfg.wrap) cur = cfg.max;
        else if (cfg.outOfBounds) oob = true;
      } else if (keys.down) {
        if (cur < cfg.max) cur++;
        else if (cfg.wrap) cur = 0;
        else if (cfg.outOfBounds) oob = true;
      }
      if (cfg.blink && !blinkOn) { scr.put(cfg.blink.x, cfg.blink.y, DOWN_ARROW); blinkOn = true; }
      if (!oob && !watched.some((b) => keys[b])) continue;
      if ((keys.a || keys.b) && cfg.sound !== false) this.snd.sfx('SFX_PRESS_AB');
      return { keys, index: cur, outOfBounds: oob };
    }
  }

  /** PlaceUnfilledArrowMenuCursor at the last placed menu cursor. */
  hollowCursor() {
    if (this.menuCursor) this.scr.put(this.menuCursor.x, this.menuCursor.y, CURSOR_HOLLOW);
  }

  /** EraseMenuCursor. */
  eraseCursor() {
    if (this.menuCursor) this.scr.put(this.menuCursor.x, this.menuCursor.y, SPACE);
  }

  /**
   * WaitForTextScrollButtonPress: until A or B is newly pressed; a ▼ at (18,16) blinks.
   * @param {{idle?:(frame:number)=>void}} [o]
   */
  *waitButton(o = {}) {
    let frames = 0, on = true, f = 0;
    const x = 18, y = 16;
    this.flushInput();
    for (;;) {
      if (o.idle) o.idle(f++);
      if (this.scr.is(x, y, DOWN_ARROW) || !on) {
        if (++frames >= ARROW_BLINK_FRAMES) {
          frames = 0;
          on = !on;
          this.ui.set(x, y, on ? this.ctx.vram.text[DOWN_ARROW] : this.ctx.vram.text[SPACE]);
        }
      }
      const k = this.poll();
      if (k.a || k.b) break;
      yield 1;
    }
    if (!on) this.ui.set(x, y, this.ctx.vram.text[DOWN_ARROW]);
  }

  // ------------------------------------------------------------------ text

  /**
   * PrintText. `text` = a common.json label, a command list, or {label, map}.
   * @param {any} text
   * @param {object} [o]
   * @param {Record<string, any>} [o.subs] text_ram values (wNameBuffer, wStringBuffer ...)
   * @param {boolean} [o.instant] BIT_NO_TEXT_DELAY
   * @param {boolean} [o.open=true] draw a fresh message box (+3 frames)
   * @param {boolean} [o.wait] wait for A/B at the end (no arrow), like DisplayTextID
   * @param {boolean} [o.close] remove the box afterwards
   * @param {string} [o.map] data/text/<map>.json labels take precedence
   */
  *print(text, o = {}) {
    if (Array.isArray(text) && text.length && text.every((t) => typeof t === 'string')) {
      if (text.length === 2 && LOW_PAIRS.has(text[0])) {
        text = [{ cmd: 'text_far', label: text[0] }, { cmd: 'text_low' }, { cmd: 'text_far', label: text[1] }, { cmd: 'text_end' }];
      } else {
        for (const t of text) yield* this.print(t, o);
        return;
      }
    }
    let cmds;
    if (typeof text === 'string') cmds = [{ cmd: 'text_far', label: text }, { cmd: 'text_end' }];
    else if (Array.isArray(text)) cmds = text;
    else if (text && text.label) cmds = [{ cmd: 'text_far', label: text.label }, { cmd: 'text_end' }];
    else cmds = [];
    const prevMap = this.mapName;
    if (o.map) this.mapName = o.map;
    this.box.subs = makeSubs({ ...this.baseSubs(), ...(o.subs || {}) });
    this.box.speed = o.instant ? 0 : this.textSpeed();
    try {
      yield* this.box.run(prepareText(cmds), { open: o.open !== false, waitAtEnd: !!o.wait, close: !!o.close });
    } finally {
      this.mapName = prevMap;
      this.flushInput();
    }
  }

  /** text_asm / sound commands inside texts. */
  onTextCall(cmd) {
    if (cmd && cmd.__sound) return this._soundCmd(cmd.__sound);
    if (this.params.onTextAsm) return this.params.onTextAsm(cmd, this);
    return undefined;
  }

  /** @private TextCommand_SOUND: play and wait for the end */
  *_soundCmd(name) {
    // the battle engine is not loaded in menus: SFX_GET_ITEM_1 is the item jingle
    yield* this.snd.waitSfx(name);
  }

  /**
   * DisplayTextBoxID TWO_OPTION_MENU YES/NO (default at (14,7)). @returns {boolean} yes
   */
  *yesNo(o = {}) {
    const menu = new YesNoMenu({ font: this.font, map: this.ui, input: this.game.input, sfx: this.ctx.sound.blip, ...o });
    const r = yield* menu.run();
    this.flushInput();
    return r;
  }

  /**
   * A two-option menu with custom geometry (HEAL/CANCEL ...): box (x,y) w×h, items from row
   * y+top, cursor at x+1. B picks the second option. @returns {number} 0 or 1
   */
  *twoOption({ x, y, w, h, items, top = 1 }) {
    const menu = new Menu({
      font: this.font, map: this.ui, input: this.game.input, sfx: this.ctx.sound.blip,
      items, x, y, width: w, height: h, top, spacing: 2, wrap: false, cancelable: true, exitDelay: 15,
    });
    const i = yield* menu.run();
    menu.close();
    this.flushInput();
    return i === 0 ? 0 : 1;
  }

  // ------------------------------------------------------------------ scenes, sound, palette

  /** Push a child scene and wait for its result. */
  *child(scene, params) {
    this.stack.push(scene, params);
    const r = yield scene.finished;
    this.flushInput();
    return r;
  }

  sfx(name) { return this.snd.sfx(name); }
  *sfxWait(name) { return yield* this.snd.waitSfx(name); }
  cry(dex) { return this.snd.cry(dex); }
  *cryWait(dex) { return yield* this.snd.waitCry(dex); }
  *waitFor(promise, max) { return yield* waitPromise(promise, max); }

  /** GBPalWhiteOut. */
  palWhiteOut() { if (this.game.palette) this.game.palette.whiteOut(); }
  /** GBPalNormal. */
  palNormal() { if (this.game.palette) this.game.palette.reset(); }
  /** Save BGP/OBP0/OBP1 (LoadGBPal restores what the map uses). */
  savePalette() {
    const p = this.game.palette;
    return p ? { bgp: p.bgp.slice(), obp0: p.obp0.slice(), obp1: p.obp1.slice() } : null;
  }
  restorePalette(saved) {
    const p = this.game.palette;
    if (p && saved) p.setMaps(saved.bgp, saved.obp0, saved.obp1);
  }
  /** GBPalWhiteOutWithDelay3. */
  *whiteOutDelay3() { this.palWhiteOut(); yield 3; }
}

export { SPACE, CURSOR, CURSOR_HOLLOW, DOWN_ARROW };
