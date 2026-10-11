// Gen-1 dialogue box (home/text.asm semantics) driven as a coroutine.
//
// Input is the structured command list the text extractor emits, e.g.
//   [{cmd:'text', str:'Hello there!'}, {cmd:'line', str:'Welcome to the'},
//    {cmd:'cont', str:'world of #MON!'}, {cmd:'para', str:'My name is OAK!'},
//    {cmd:'prompt'}]
// A plain string is treated as a single `text` command; strings may also embed the
// charmap control tags (<LINE> <NEXT> <PARA> <CONT> <SCROLL> <PAGE> <DONE> <PROMPT>).
//
// Semantics (all timings in frames, see data/textbox.json "timing"):
//   text   print at the cursor (first line (1,14) when the box opens)
//   line   jump to the second line (1,16) and print
//   next   jump 2 rows below the start of the current string (menus)
//   cont   ▼ at (18,16), wait 3, wait for A/B (▼ blinks), blip, then scroll the text up
//          one line in two 8-px steps of 5 frames each, print on the second line
//   scroll same scroll without waiting (text_scroll / <SCROLL>)
//   para   ▼, wait 3, wait for A/B, blip, clear the box interior, wait 20, print on line 1
//   page   like para but for the Pokédex page area ((1,10) 18x7, restart at (1,11))
//   prompt ▼, wait 3, wait for A/B, blip, erase ▼, end
//   done   end immediately (DisplayTextID then waits for A/B with no arrow: run's
//          `waitAtEnd` option does that, and holds the box open while A is held)
//   promptbutton (text_promptbutton) ▼ + wait + erase, continue; waitbutton: wait, no ▼
//   pause  30 frames unless A/B is held; dots {n}: n × "…" 10 frames apart
//   text_ram {ram} / text_decimal {ram, digits} / text_bcd {ram, bytes, flags}: print a
//          value from the substitution map (keyed by the WRAM symbol, e.g. wStringBuffer;
//          wPlayerName/wRivalName fall back to PLAYER/RIVAL)
//   text_far {label}: run another text (found through the `resolveFar` option); like the GB,
//          a done/prompt/text_end inside it only ends *that* text and the outer list goes on
//   sound {sound}: onSound hook; text_asm / script {script}: onCall hook (may return a
//          generator that runs inline or a promise that is awaited, e.g. a mart or nurse
//          handler); str: print a raw string
// This matches the command lists the text extractor writes to data/text/*.json.
// Letters appear one every `speed` frames (fast 1 / medium 3 / slow 5, 0 = instant);
// holding A or B prints one letter per frame (home/print_text.asm PrintLetterDelay).

import { EMPTY, TileMap } from './tilemap.js';

/** @typedef {import('./font.js').Font} Font */
/** @typedef {import('./input.js').Input} Input */
/** @typedef {{cmd:string, str?:string, var?:string, value?:any, n?:number, name?:string, [k:string]:any}} TextCommand */

/** Frames per letter for each Gen-1 text speed option. */
export const TEXT_SPEED = Object.freeze({ instant: 0, fast: 1, medium: 3, slow: 5 });

/**
 * Frames the ▼ stays on / off while waiting. The GB toggles it every ~1536 iterations of
 * a busy-wait loop (HandleDownArrowBlinkTiming), which is roughly 35-50 frames; 40 is a
 * close approximation.
 */
export const ARROW_BLINK_FRAMES = 40;

export const DEFAULT_TIMING = Object.freeze({
  letterDelayFrames: { fast: 1, medium: 3, slow: 5 },
  arrowAppearDelay: 3,
  scrollStepFrames: 5,
  paragraphClearDelay: 20,
  pageClearDelay: 20,
  pauseFrames: 30,
  dotsFrames: 10,
  openDelay: 3,
});

const DEFAULT_GEOMETRY = Object.freeze({
  x: 0, y: 12, w: 20, h: 6, textX: 1, line1Y: 14, line2Y: 16, arrowX: 18, arrowY: 16, lineWidth: 18,
});

const ALIASES = {
  text: 'text', start: 'text', text_start: 'text',
  line: 'line', next: 'next', cont: 'cont', para: 'para', page: 'page',
  done: 'done', prompt: 'prompt', dex: 'dex', end: 'end', text_end: 'end',
  scroll: 'scroll', text_scroll: 'scroll', low: 'low', text_low: 'low',
  promptbutton: 'promptbutton', text_promptbutton: 'promptbutton', prompt_button: 'promptbutton',
  waitbutton: 'waitbutton', text_waitbutton: 'waitbutton', wait_button: 'waitbutton',
  pause: 'pause', text_pause: 'pause', dots: 'dots', text_dots: 'dots',
  ram: 'ram', text_ram: 'ram', var: 'ram',
  num: 'num', decimal: 'num', text_decimal: 'num', bcd: 'num', text_bcd: 'num',
  move: 'move', text_move: 'move', box: 'box', text_box: 'box',
  sound: 'sound', asm: 'call', text_asm: 'call', call: 'call', script: 'call',
  far: 'far', text_far: 'far', str: 'text',
};

/** Ops that end the current text stream (a whole run, or just a text_far'd text). */
const TERMINAL_OPS = new Set(['done', 'end', 'prompt', 'dex']);
const MAX_FAR_DEPTH = 8;

/** Control tags that may appear inside strings -> op. */
const INLINE_TAGS = {
  '<LINE>': 'line', '<NEXT>': 'next', '<PARA>': 'para', '<CONT>': 'cont', '<_CONT>': 'cont',
  '<SCROLL>': 'scroll', '<PAGE>': 'page', '<DONE>': 'done', '<PROMPT>': 'prompt', '<DEXEND>': 'dex',
};
const INLINE_RE = /(<LINE>|<NEXT>|<PARA>|<CONT>|<_CONT>|<SCROLL>|<PAGE>|<DONE>|<PROMPT>|<DEXEND>)/;

/** WRAM symbols used by text_ram -> substitution keys tried after the symbol itself. */
const RAM_ALIASES = { wPlayerName: 'PLAYER', wRivalName: 'RIVAL' };

function lookupRam(subs, key) {
  if (!key) return undefined;
  if (subs && subs[key] !== undefined) return subs[key];
  const alias = RAM_ALIASES[key];
  if (alias && subs && subs[alias] !== undefined) return subs[alias];
  return undefined;
}

/** Accept a string, a command array or {commands|text: [...]}. @returns {TextCommand[]} */
export function normalizeText(input) {
  if (input == null) return [];
  if (typeof input === 'string') return [{ cmd: 'text', str: input }];
  if (Array.isArray(input)) return input.map((c) => (typeof c === 'string' ? { cmd: 'text', str: c } : c));
  if (Array.isArray(input.commands)) return normalizeText(input.commands);
  if (Array.isArray(input.text)) return normalizeText(input.text);
  throw new Error(`normalizeText: unsupported input ${JSON.stringify(input).slice(0, 80)}`);
}

export class TextBox {
  /**
   * @param {object} o
   * @param {Font} o.font
   * @param {TileMap} [o.map]          tile layer to draw into (default: a new 20x18 map)
   * @param {Input|{pressed:any, held:any}} o.input
   * @param {{play:(name:string)=>void}} [o.sfx]
   * @param {number} [o.speed]         frames per letter (TEXT_SPEED), default medium (3)
   * @param {Record<string,string|number>} [o.subs] placeholder values ({PLAYER}, {RIVAL}...)
   * @param {object} [o.geometry]      override messageBox geometry (tile units)
   * @param {(name:string, cmd:TextCommand) => void} [o.onSound]
   * @param {(cmd:TextCommand, box:TextBox) => any} [o.onCall]  for text_asm / script commands
   * @param {(label:string) => any} [o.resolveFar] text_far label -> commands (array or {commands})
   */
  constructor({ font, map, input, sfx = null, speed = TEXT_SPEED.medium, subs = {}, geometry, onSound, onCall, resolveFar }) {
    this.font = font;
    this.map = map || new TileMap(20, 18);
    this.input = input;
    this.sfx = sfx;
    this.speed = speed;
    this.subs = { ...subs };
    const boxJson = font.textbox || {};
    this.geometry = { ...DEFAULT_GEOMETRY, ...(boxJson.messageBox || {}), ...(geometry || {}) };
    this.timing = { ...DEFAULT_TIMING, ...(boxJson.timing || {}) };
    this.arrowBlinkFrames = ARROW_BLINK_FRAMES;
    this.onSound = onSound || null;
    this.onCall = onCall || null;
    /** text_far resolver: label -> commands */
    this.resolveFar = resolveFar || null;
    /** called with (kind, textbox) whenever the box starts waiting for a button */
    this.onWait = null;
    /** true while waiting for A/B */
    this.waiting = false;
    this.isOpen = false;
    this.cx = this.geometry.textX;
    this.cy = this.geometry.line1Y;
    this._lineStart = { x: this.cx, y: this.cy };
    this._overflowWarned = false;
  }

  // ------------------------------------------------------------------ box handling

  /** Draw the bordered message box and put the cursor on line 1. */
  open() {
    const g = this.geometry;
    this.font.drawBox(this.map, g.x, g.y, g.w, g.h);
    this.isOpen = true;
    this.home();
  }

  /** Remove the box from the tile layer (cells -> EMPTY). */
  close() {
    const g = this.geometry;
    this.map.clearRect(g.x, g.y, g.w, g.h);
    this.isOpen = false;
    this.waiting = false;
  }

  /** Blank the interior (ClearScreenArea of the 18x4 text area). */
  clear() {
    const g = this.geometry;
    this.map.fillRect(g.x + 1, g.y + 1, g.w - 2, g.h - 2, this.font.space);
  }

  /** Cursor to the start of the first text line. */
  home() {
    this.cx = this.geometry.textX;
    this.cy = this.geometry.line1Y;
    this._lineStart = { x: this.cx, y: this.cy };
  }

  // ------------------------------------------------------------------ compilation

  /**
   * Turn commands into a flat op list, resolving placeholders and expansions now.
   * @param {any} input
   * @param {Record<string,string|number>} [subs]
   * @returns {{op:string, [k:string]:any}[]}
   */
  compile(input, subs = this.subs, depth = 0) {
    const ops = [];
    for (const c of normalizeText(input)) {
      const name = String(c.cmd || 'text');
      const kind = ALIASES[name] || (name.startsWith('sound_') ? 'sound' : null);
      switch (kind) {
        case 'text':
          ops.push({ op: 'start' });
          this._compileString(c.str, ops, subs);
          break;
        case 'line': case 'next': case 'cont': case 'para': case 'page': case 'scroll':
          ops.push({ op: kind });
          this._compileString(c.str, ops, subs);
          break;
        case 'done': case 'prompt': case 'dex': case 'end':
        case 'low': case 'promptbutton': case 'waitbutton': case 'pause':
          ops.push({ op: kind });
          if (c.str) this._compileString(c.str, ops, subs);
          break;
        case 'dots':
          ops.push({ op: 'dots', n: Number(c.n ?? c.count ?? c.value ?? 1) });
          break;
        case 'ram': {
          const key = c.ram ?? c.var;
          const v = lookupRam(subs, key) ?? c.str ?? (key ? `{${key}}` : '');
          this._compileString(String(v), ops, subs);
          break;
        }
        case 'num': {
          const key = c.ram ?? c.var;
          const raw = c.value ?? lookupRam(subs, key);
          if (raw === undefined) {
            this._compileString(key ? `{${key}}` : '0', ops, subs);
            break;
          }
          let v = String(raw);
          const flags = c.flags || [];
          const width = c.bytes ? c.bytes * 2 : 0;
          if (name.endsWith('bcd') && width) {
            // home/print_bcd.asm: bit 7 (LEADING_ZEROES) SET means "do not print leading
            // zeroes"; unset means pad with zeroes. LEFT_ALIGN skips the space padding.
            if (!flags.includes('LEADING_ZEROES')) v = v.padStart(width, '0');
            else if (!flags.includes('LEFT_ALIGN')) v = v.padStart(width, ' ');
          }
          this._compileString(v, ops, subs);
          break;
        }
        case 'move':
          ops.push({ op: 'move', x: c.x | 0, y: c.y | 0 });
          break;
        case 'box':
          ops.push({ op: 'box', x: c.x | 0, y: c.y | 0, w: c.w | 0, h: c.h | 0 });
          break;
        case 'sound':
          ops.push({ op: 'sound', name: c.sound || c.name || (name !== 'sound' ? name : c.str), cmd: c });
          break;
        case 'call':
          ops.push({ op: 'call', cmd: c });
          break;
        case 'far': {
          let inner = c.commands || c.text;
          if (!inner && c.label && this.resolveFar) inner = this.resolveFar(c.label);
          if (!inner) {
            this._warnOnce(`TextBox: cannot resolve text_far ${c.label ?? ''}`);
            break;
          }
          if (depth >= MAX_FAR_DEPTH) throw new Error(`TextBox: text_far nesting too deep at ${c.label}`);
          // the far text runs in its own TextCommandProcessor: its done/prompt/text_end
          // only end it, then the outer list continues
          for (const o of this.compile(inner, subs, depth + 1)) {
            if (TERMINAL_OPS.has(o.op)) {
              if (o.op === 'prompt') ops.push({ op: 'prompt', end: false });
              else if (o.op === 'dex') ops.push({ op: 'dex', end: false });
              break;
            }
            ops.push(o);
          }
          break;
        }
        default:
          this._warnOnce(`TextBox: unknown text command ${JSON.stringify(name)}`);
      }
    }
    return ops;
  }

  /** @private */
  _compileString(str, ops, subs) {
    if (str == null || str === '') return;
    for (const part of String(str).split(INLINE_RE)) {
      if (!part) continue;
      const tag = INLINE_TAGS[part];
      if (tag) ops.push({ op: tag });
      else ops.push({ op: 'chars', tiles: this.font.encode(part, subs) });
    }
  }

  // ------------------------------------------------------------------ running

  /**
   * Coroutine that prints `input` with Gen-1 timing. Run it with a scene's coroutine
   * runner (`yield* box.run(text)` inside a script, or `scene.run(box.run(text))`).
   * @param {any} input commands (see file header)
   * @param {object} [opts]
   * @param {boolean} [opts.open=true]      draw a fresh box first (+3 frame delay like PrintText)
   * @param {boolean} [opts.waitAtEnd=false] after the text ends, wait for A/B without an arrow
   *   and keep the box while A is held (DisplayTextID behaviour for NPCs/signs)
   * @param {boolean} [opts.close=false]    remove the box when finished
   * @param {Record<string,string|number>} [opts.subs] extra substitutions
   */
  *run(input, opts = {}) {
    const subs = opts.subs ? { ...this.subs, ...opts.subs } : this.subs;
    const ops = this.compile(input, subs);
    const g = this.geometry, T = this.timing;
    if (opts.open !== false) {
      this.open();
      if (T.openDelay > 0) yield T.openDelay;
    } else if (!this.isOpen) {
      this.open();
    }
    this._overflowWarned = false;
    let ended = false;
    for (let i = 0; i < ops.length && !ended; i++) {
      const o = ops[i];
      switch (o.op) {
        case 'start':
          this._lineStart = { x: this.cx, y: this.cy };
          break;
        case 'chars':
          for (const t of o.tiles) {
            this._put(t);
            yield* this._letterDelay();
          }
          break;
        case 'line':
          this.cx = g.textX; this.cy = g.line2Y;
          this._lineStart = { x: this.cx, y: this.cy };
          break;
        case 'low':
          this.cx = g.textX; this.cy = g.line2Y;
          break;
        case 'next':
          this.cx = this._lineStart.x; this.cy = this._lineStart.y + 2;
          this._lineStart = { x: this.cx, y: this.cy };
          break;
        case 'cont':
          yield* this._arrowWait('cont', true);
          this._setArrow(false);
          yield* this._scroll();
          break;
        case 'scroll':
          this._setArrow(false);
          yield* this._scroll();
          break;
        case 'para':
          yield* this._arrowWait('para', true);
          this.map.fillRect(g.x + 1, g.y + 1, g.w - 2, g.h - 2, this.font.space);
          yield T.paragraphClearDelay;
          this.cx = g.textX; this.cy = g.line1Y;
          this._lineStart = { x: this.cx, y: this.cy };
          break;
        case 'page':
          yield* this._arrowWait('page', true);
          this.map.fillRect(1, 10, 18, 7, this.font.space);
          yield T.pageClearDelay;
          this.cx = 1; this.cy = 11;
          this._lineStart = { x: this.cx, y: this.cy };
          break;
        case 'prompt':
          yield* this._arrowWait('prompt', true);
          this._setArrow(false);
          if (o.end !== false) ended = true;
          break;
        case 'promptbutton':
          yield* this._arrowWait('promptbutton', false);
          this._setArrow(false);
          break;
        case 'waitbutton':
          yield* this._waitButton('waitbutton', false);
          this._blip();
          break;
        case 'pause':
          if (!this._abHeld()) yield T.pauseFrames;
          break;
        case 'dots':
          for (let k = 0; k < o.n; k++) {
            this._put(this.font.tile('…'));
            if (!this._abHeld()) yield T.dotsFrames;
          }
          break;
        case 'move':
          this.cx = o.x; this.cy = o.y;
          break;
        case 'box':
          this.font.drawBox(this.map, o.x, o.y, o.w, o.h);
          break;
        case 'sound':
          if (this.onSound) this.onSound(o.name, o.cmd);
          else if (this.sfx && typeof this.sfx.has === 'function' && this.sfx.has(o.name)) this.sfx.play(o.name);
          break;
        case 'call': {
          const r = this.onCall ? this.onCall(o.cmd, this) : undefined;
          if (r && typeof r.next === 'function') yield* r; // generator handler: run inline
          else if (r && typeof r.then === 'function') yield r; // async handler: wait for it
          break;
        }
        case 'dex':
          this._put(this.font.tile('.'));
          if (o.end !== false) ended = true;
          break;
        case 'done':
        case 'end':
          ended = true;
          break;
        default:
          break;
      }
    }
    if (opts.waitAtEnd) {
      yield* this._waitButton('end', false);
      while (this.input.held.a) yield 1; // HoldTextDisplayOpen
    }
    if (opts.close) this.close();
  }

  /**
   * Coroutine: print a string at the cursor with letter delays (for scripts that build
   * text piecemeal).
   */
  *print(str, subs) {
    for (const t of this.font.encode(str, subs ? { ...this.subs, ...subs } : this.subs)) {
      this._put(t);
      yield* this._letterDelay();
    }
  }

  /** Coroutine: wait for A/B with the blinking ▼ (like text_promptbutton). */
  *promptButton() {
    yield* this._arrowWait('promptbutton', false);
    this._setArrow(false);
  }

  /** Coroutine: wait for A/B without an arrow (WaitForTextScrollButtonPress). */
  *waitForButton() {
    yield* this._waitButton('waitbutton', false);
  }

  // ------------------------------------------------------------------ internals

  /** @private */
  _put(tile) {
    const g = this.geometry;
    if (this.cx >= g.x + g.w - 1 && !this._overflowWarned) {
      this._overflowWarned = true;
      console.warn(`TextBox: text runs past column ${g.x + g.w - 2} at row ${this.cy}`);
    }
    // the GB writes linearly into wTileMap, so overflow wraps to the next row
    if (this.cx >= this.map.width) { this.cx = 0; this.cy++; }
    this.map.set(this.cx, this.cy, tile);
    this.cx++;
  }

  /** @private */
  _abHeld() {
    const h = this.input.held;
    return !!(h && (h.a || h.b));
  }

  /** @private */
  _abPressed() {
    const p = this.input.pressed;
    return !!(p && (p.a || p.b));
  }

  /** @private PrintLetterDelay */
  *_letterDelay() {
    let remaining = this.speed;
    if (remaining <= 0) return;
    for (;;) {
      if (this._abHeld()) { yield 1; return; }
      if (remaining <= 0) return;
      yield 1;
      remaining--;
    }
  }

  /** @private */
  _setArrow(on) {
    const g = this.geometry;
    this.map.set(g.arrowX, g.arrowY, on ? this.font.cursor.down : this.font.space);
  }

  /** @private ▼, Delay3, ManualTextScroll (wait + blip) */
  *_arrowWait(kind, delay3) {
    this._setArrow(true);
    let early = false;
    if (delay3) {
      for (let i = 0; i < this.timing.arrowAppearDelay; i++) {
        yield 1;
        if (this._abPressed()) early = true;
      }
    }
    if (!early) yield* this._waitButton(kind, true);
    this._blip();
  }

  /** @private WaitForTextScrollButtonPress (+ optional ▼ blinking) */
  *_waitButton(kind, blink) {
    this.waiting = true;
    if (this.onWait) this.onWait(kind, this);
    let frames = 0, on = true;
    try {
      for (;;) {
        yield 1;
        if (this._abPressed()) return;
        if (blink && ++frames >= this.arrowBlinkFrames) {
          frames = 0;
          on = !on;
          this._setArrow(on);
        }
      }
    } finally {
      this.waiting = false;
    }
  }

  /** @private ScrollTextUpOneLine x2: rows 14..16 -> 13..15, blank row 16, 5 frames each */
  *_scroll() {
    const g = this.geometry;
    for (let step = 0; step < 2; step++) {
      this.map.copyRows(g.line1Y, g.line1Y - 1, 3);
      this.map.fillRect(g.textX, g.line2Y, g.lineWidth, 1, this.font.space);
      yield this.timing.scrollStepFrames;
    }
    this.cx = g.textX; this.cy = g.line2Y;
    this._lineStart = { x: this.cx, y: this.cy };
  }

  /** @private SFX_PRESS_AB */
  _blip() {
    if (this.sfx) this.sfx.play('press');
  }

  /** @private */
  _warnOnce(msg) {
    TextBox._warned = TextBox._warned || new Set();
    if (TextBox._warned.has(msg)) return;
    TextBox._warned.add(msg);
    console.warn(msg);
  }
}

/**
 * Read a row of a TileMap back as text (debugging/tests).
 * @param {Font} font
 * @param {TileMap} map
 */
export function decodeRow(font, map, y, x0 = 0, x1 = map.width) {
  if (!font._reverse) {
    font._reverse = new Map();
    for (const [k, t] of Object.entries(font.chars)) if (!font._reverse.has(t)) font._reverse.set(t, k);
  }
  let s = '';
  for (let x = x0; x < x1; x++) {
    const t = map.get(x, y);
    s += t === EMPTY ? '' : font._reverse.get(t) ?? '?';
  }
  return s;
}

/**
 * Run a text through a real TextBox at instant speed, auto-pressing A at every wait, and
 * return what the two text lines show each time the player is asked to press a button.
 * Pure (no DOM); used by tests and handy for checking extracted text fits the box.
 * @param {Font} font
 * @param {any} input
 * @param {{subs?: Record<string,string|number>, resolveFar?: (label:string)=>any, maxFrames?: number}} [opts]
 * @returns {{wait:string, lines:[string,string]}[]}
 */
export function paginate(font, input, { subs, resolveFar, maxFrames = 100000 } = {}) {
  const fake = { pressed: { a: false, b: false }, held: { a: false, b: false } };
  const box = new TextBox({ font, input: fake, speed: TEXT_SPEED.instant, subs, resolveFar });
  const g = box.geometry;
  const screens = [];
  box.onWait = (kind) => {
    screens.push({
      wait: kind,
      lines: [
        decodeRow(font, box.map, g.line1Y, g.textX, g.textX + g.lineWidth).trimEnd(),
        decodeRow(font, box.map, g.line2Y, g.textX, g.textX + g.lineWidth).replace(/▼$/, '').trimEnd(),
      ],
    });
  };
  const it = box.run(input);
  for (let f = 0; f < maxFrames; f++) {
    fake.pressed.a = box.waiting;
    if (it.next().done) {
      screens.push({
        wait: 'end',
        lines: [
          decodeRow(font, box.map, g.line1Y, g.textX, g.textX + g.lineWidth).trimEnd(),
          decodeRow(font, box.map, g.line2Y, g.textX, g.textX + g.lineWidth).trimEnd(),
        ],
      });
      return screens;
    }
  }
  throw new Error('paginate: text did not finish');
}

/**
 * Build a text_far resolver from loaded data/text/*.json documents
 * ({texts: {label: {commands}}}); later documents win on duplicate labels.
 *   const resolveFar = textResolver(commonJson, mapJson);
 *   new TextBox({ ..., resolveFar });
 * @param {...{texts?: Record<string, {commands?: TextCommand[]}>}} docs
 * @returns {(label: string) => TextCommand[] | undefined}
 */
export function textResolver(...docs) {
  const map = new Map();
  for (const d of docs) {
    for (const [label, t] of Object.entries((d && d.texts) || {})) if (t && Array.isArray(t.commands)) map.set(label, t.commands);
  }
  const resolve = (label) => map.get(label);
  resolve.labels = map;
  return resolve;
}
