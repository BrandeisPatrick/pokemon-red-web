// Joypad input. Keyboard (and optional touch) events only record raw state; sample() is
// called once per fixed update and derives held / pressed / released for that frame, so
// game logic sees one consistent snapshot per frame, like the GB's hJoyHeld /
// hJoyPressed / hJoyReleased. A press shorter than a frame still registers.
//
// Default mapping (CLAUDE.md): arrows / WASD = D-pad, Z or Enter = A, X or Backspace = B,
// Shift = Start, Tab = Select.

/** GB button bit masks (same bit order as pokered's PAD_* constants). */
export const PAD = Object.freeze({
  a: 0x01, b: 0x02, select: 0x04, start: 0x08,
  right: 0x10, left: 0x20, up: 0x40, down: 0x80,
});

/** @typedef {'a'|'b'|'select'|'start'|'right'|'left'|'up'|'down'} Button */
/** @type {ReadonlyArray<Button>} */
export const BUTTONS = Object.freeze(/** @type {Button[]} */ (['a', 'b', 'select', 'start', 'right', 'left', 'up', 'down']));

/** KeyboardEvent.code -> button. */
export const DEFAULT_KEYMAP = Object.freeze({
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
  KeyZ: 'a', Enter: 'a', NumpadEnter: 'a',
  KeyX: 'b', Backspace: 'b',
  ShiftLeft: 'start', ShiftRight: 'start',
  Tab: 'select',
});

/** GB JoypadLowSensitivity timings: first repeat after 30 frames, then every 5. */
export const REPEAT_DELAY = 30;
export const REPEAT_INTERVAL = 5;

export class Input {
  /** @param {{keymap?: Record<string, Button>}} [opts] */
  constructor({ keymap = DEFAULT_KEYMAP } = {}) {
    /** @type {Record<string, Button>} */
    this.keymap = { ...keymap };
    /** bit masks for the current frame (GB hJoyHeld / hJoyPressed / hJoyReleased) */
    this.heldMask = 0;
    this.pressedMask = 0;
    this.releasedMask = 0;
    /** per-button booleans for the current frame, e.g. input.pressed.a */
    this.held = blank();
    this.pressed = blank();
    this.released = blank();
    /** frames each button has been held (0 on the frame it was pressed) */
    this.holdFrames = { a: 0, b: 0, select: 0, start: 0, right: 0, left: 0, up: 0, down: 0 };
    /** set to false to ignore all input (e.g. during scripted movement) */
    this.enabled = true;
    this._codes = new Set();
    this._virtual = new Map();
    this._rawMask = 0;
    this._edgeMask = 0;
    this._prevHeld = 0;
    this._target = null;
    this._onKeyDown = (e) => this.handleKeyDown(e);
    this._onKeyUp = (e) => this.handleKeyUp(e);
    this._onBlur = () => this.releaseAll();
  }

  /** Listen to keyboard events on `target` (default: window). */
  attach(target = globalThis.window) {
    this.detach();
    this._target = target;
    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
    return this;
  }

  detach() {
    const t = this._target;
    if (!t) return;
    t.removeEventListener('keydown', this._onKeyDown);
    t.removeEventListener('keyup', this._onKeyUp);
    t.removeEventListener('blur', this._onBlur);
    this._target = null;
  }

  /** Bind a KeyboardEvent.code to a button (or null to unbind). */
  bind(code, button) {
    if (button) this.keymap[code] = button;
    else delete this.keymap[code];
    this._recompute();
  }

  /** @param {KeyboardEvent|{code:string, repeat?:boolean, ctrlKey?:boolean, metaKey?:boolean, altKey?:boolean, preventDefault?:()=>void}} e */
  handleKeyDown(e) {
    const button = this.keymap[e.code];
    if (!button || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.preventDefault) e.preventDefault();
    if (e.repeat || this._codes.has(e.code)) return;
    this._codes.add(e.code);
    this._edgeMask |= PAD[button];
    this._recompute();
  }

  handleKeyUp(e) {
    const button = this.keymap[e.code];
    if (!button) return;
    if (e.preventDefault) e.preventDefault();
    this._codes.delete(e.code);
    this._recompute();
  }

  /** Programmatic press (touch controls, tests, demos). Pair with release(). */
  press(button) {
    if (!(button in PAD)) throw new Error(`Input.press: unknown button ${button}`);
    const n = this._virtual.get(button) || 0;
    this._virtual.set(button, n + 1);
    if (n === 0) this._edgeMask |= PAD[button];
    this._recompute();
  }

  release(button) {
    const n = this._virtual.get(button) || 0;
    if (n <= 1) this._virtual.delete(button);
    else this._virtual.set(button, n - 1);
    this._recompute();
  }

  /** Forget every key/touch currently down (window blur, scene changes). */
  releaseAll() {
    this._codes.clear();
    this._virtual.clear();
    this._recompute();
  }

  /** @private */
  _recompute() {
    let m = 0;
    for (const code of this._codes) {
      const b = this.keymap[code];
      if (b) m |= PAD[b];
    }
    for (const [b, n] of this._virtual) if (n > 0) m |= PAD[b];
    this._rawMask = m;
  }

  /** Snapshot the raw state into held/pressed/released. Call once per fixed update. */
  sample() {
    const edges = this._edgeMask;
    this._edgeMask = 0;
    let held = this._rawMask | edges;
    let pressed = edges | (held & ~this._prevHeld);
    if (!this.enabled) held = pressed = 0;
    this.releasedMask = this._prevHeld & ~held;
    this.pressedMask = pressed;
    this.heldMask = held;
    this._prevHeld = held;
    for (const b of BUTTONS) {
      const bit = PAD[b];
      this.held[b] = (held & bit) !== 0;
      this.pressed[b] = (pressed & bit) !== 0;
      this.released[b] = (this.releasedMask & bit) !== 0;
      if (this.pressed[b]) this.holdFrames[b] = 0;
      else if (this.held[b]) this.holdFrames[b]++;
      else this.holdFrames[b] = 0;
    }
  }

  /** @param {Button} b */
  isHeld(b) { return this.held[b]; }
  /** @param {Button} b */
  isPressed(b) { return this.pressed[b]; }
  /** @param {Button} b */
  isReleased(b) { return this.released[b]; }

  /** True if any of the given buttons was pressed this frame (default: any button). */
  anyPressed(...buttons) {
    if (buttons.length === 0) return this.pressedMask !== 0;
    return buttons.some((b) => this.pressed[b]);
  }

  /** True if any of the given buttons is held this frame (default: any button). */
  anyHeld(...buttons) {
    if (buttons.length === 0) return this.heldMask !== 0;
    return buttons.some((b) => this.held[b]);
  }

  /**
   * Auto-repeat like JoypadLowSensitivity: true on the press frame, then every `interval`
   * frames once the button has been held `delay` frames.
   * @param {Button} b
   */
  repeat(b, delay = REPEAT_DELAY, interval = REPEAT_INTERVAL) {
    if (this.pressed[b]) return true;
    if (!this.held[b]) return false;
    const f = this.holdFrames[b] - delay;
    return f >= 0 && f % interval === 0;
  }

  /** The current D-pad direction as 'up'|'down'|'left'|'right'|null (GB priority order). */
  direction() {
    for (const d of /** @type {Button[]} */ (['down', 'up', 'left', 'right'])) if (this.held[d]) return d;
    return null;
  }
}

function blank() {
  return { a: false, b: false, select: false, start: false, right: false, left: false, up: false, down: false };
}

/**
 * Optional on-screen controls for touch devices: a D-pad, A, B, START and SELECT laid over
 * the bottom of the page. Each control calls input.press()/release().
 *
 * @deprecated No longer used: src/main.js now builds the phone controls with
 * src/mobile/touch.js (multi-touch, sliding D-pad, portrait/landscape layout, see docs/mobile.md).
 * Kept only so older callers keep working; new code should not use it.
 * @param {Input} input
 * @param {{parent?: HTMLElement}} [opts]
 * @returns {HTMLElement} the overlay element
 */
export function createTouchControls(input, { parent } = {}) {
  const doc = globalThis.document;
  parent = parent || doc.body;
  const root = doc.createElement('div');
  root.className = 'touch-controls';
  root.setAttribute('aria-hidden', 'true');
  const style = doc.createElement('style');
  style.textContent = `
    .touch-controls { position: fixed; left: 0; right: 0; bottom: 0; height: 38vh; pointer-events: none;
      user-select: none; -webkit-user-select: none; touch-action: none; z-index: 10; }
    .touch-controls button { position: absolute; pointer-events: auto; touch-action: none;
      background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.75); border: 2px solid rgba(255,255,255,0.25);
      font: bold 14px/1 system-ui, sans-serif; border-radius: 50%; width: 64px; height: 64px; padding: 0; }
    .touch-controls button.pressed { background: rgba(255,255,255,0.35); }
    .touch-controls .dpad { border-radius: 10px; width: 54px; height: 54px; }
    .touch-controls .pill { border-radius: 14px; width: 72px; height: 28px; font-size: 11px; }`;
  root.appendChild(style);
  const make = (button, label, css, cls = '') => {
    const el = doc.createElement('button');
    el.type = 'button';
    el.textContent = label;
    el.className = cls;
    Object.assign(el.style, css);
    let down = false;
    const on = (e) => { e.preventDefault(); if (!down) { down = true; el.classList.add('pressed'); input.press(button); } };
    const off = (e) => { e.preventDefault(); if (down) { down = false; el.classList.remove('pressed'); input.release(button); } };
    el.addEventListener('pointerdown', (e) => { el.setPointerCapture?.(e.pointerId); on(e); });
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('lostpointercapture', off);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    root.appendChild(el);
  };
  make('up', '▲', { left: '74px', bottom: '170px' }, 'dpad');
  make('down', '▼', { left: '74px', bottom: '62px' }, 'dpad');
  make('left', '◀', { left: '20px', bottom: '116px' }, 'dpad');
  make('right', '▶', { left: '128px', bottom: '116px' }, 'dpad');
  make('a', 'A', { right: '20px', bottom: '138px' });
  make('b', 'B', { right: '96px', bottom: '98px' });
  make('select', 'SELECT', { left: 'calc(50% - 80px)', bottom: '14px' }, 'pill');
  make('start', 'START', { left: 'calc(50% + 8px)', bottom: '14px' }, 'pill');
  parent.appendChild(root);
  return root;
}
