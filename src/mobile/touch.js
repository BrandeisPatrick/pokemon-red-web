// On-screen Game Boy controls: D-pad, A, B, START, SELECT.
//
// Pointer events with pointer capture, so several fingers work at once (hold a direction while
// tapping A or B). The D-pad is one touch surface: the direction comes from the angle between
// the pad centre and the finger (dead zone in the middle, one of the four directions at a time,
// a little hysteresis at the diagonals), so sliding the thumb across the pad changes direction
// without lifting. Everything drives the engine through Input.press()/release().
//
// The handlers only touch the DOM when a button changes state (a class / data attribute), and do
// all their geometry from numbers cached at pointerdown: no per-frame work, no layout reads
// while a finger moves. Styles live in index.html (`.touch-controls`, `.tc-*`); positions and
// sizes are set by src/mobile/layout.js. See docs/mobile.md.

/** Dead zone as a fraction of the D-pad radius: no direction while the finger is this close to the centre. */
export const DPAD_DEAD_ZONE = 0.2;
/** Degrees a finger must pass the 45-degree diagonal before the direction flips (stops jitter). */
export const DPAD_HYSTERESIS = 12;

/** Screen angle (degrees, y down) of each D-pad axis. */
const AXIS_ANGLE = { right: 0, down: 90, left: 180, up: -90 };

/**
 * The direction a finger at (dx, dy) from the pad centre means, or null inside the dead zone.
 * @param {number} dx   finger x minus pad centre x (px)
 * @param {number} dy   finger y minus pad centre y (px, positive = down)
 * @param {number} radius pad radius (px)
 * @param {'up'|'down'|'left'|'right'|null} [current] direction already held (hysteresis)
 * @returns {'up'|'down'|'left'|'right'|null}
 */
export function dpadDirection(dx, dy, radius, current = null, deadZone = DPAD_DEAD_ZONE, hysteresis = DPAD_HYSTERESIS) {
  if (!(Math.hypot(dx, dy) > deadZone * radius)) return null;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180, 0 = right, 90 = down
  if (current) {
    const diff = Math.abs((((angle - AXIS_ANGLE[current]) % 360) + 540) % 360 - 180);
    if (diff <= 45 + hysteresis) return current;
  }
  if (angle >= -45 && angle < 45) return 'right';
  if (angle >= 45 && angle < 135) return 'down';
  if (angle >= -135 && angle < -45) return 'up';
  return 'left';
}

const isPrimaryButton = (e) => e.button === undefined || e.button === 0;

function capture(el, pointerId) {
  try {
    if (el.setPointerCapture) el.setPointerCapture(pointerId);
  } catch {
    // the pointer is already gone, or capture is unsupported: the events still arrive
  }
}

/**
 * A momentary button (A, B, START, SELECT). Several fingers on it count as one press; it stays
 * down until the last one lifts. `pointercancel` and a lost capture release it.
 * @param {HTMLElement} el
 * @param {import('../engine/input.js').Button} button
 * @param {{press(b: string): void, release(b: string): void}} input
 */
export function bindButton(el, button, input, { onChange } = {}) {
  const pointers = new Set();
  let down = false;

  function set(on) {
    if (on === down) return;
    down = on;
    if (on) input.press(button);
    else input.release(button);
    el.classList.toggle('on', on);
    if (onChange) onChange(on);
  }
  const onDown = (e) => {
    if (!isPrimaryButton(e)) return;
    e.preventDefault();
    pointers.add(e.pointerId);
    capture(el, e.pointerId);
    set(true);
  };
  const onEnd = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 0) set(false);
  };
  const events = [['pointerdown', onDown], ['pointerup', onEnd], ['pointercancel', onEnd], ['lostpointercapture', onEnd]];
  for (const [type, fn] of events) el.addEventListener(type, fn);

  return {
    get down() { return down; },
    /** Release now (window blur, page hidden). */
    release() {
      pointers.clear();
      set(false);
    },
    destroy() {
      for (const [type, fn] of events) el.removeEventListener(type, fn);
      pointers.clear();
      set(false);
    },
  };
}

/**
 * The D-pad: one finger steers it (a second finger on the pad is ignored), the direction follows
 * the finger's angle from the pad centre until it lifts.
 * @param {HTMLElement} el the pad element (its box is the touch surface)
 * @param {{press(b: string): void, release(b: string): void}} input
 */
export function bindDpad(el, input, { deadZone = DPAD_DEAD_ZONE, hysteresis = DPAD_HYSTERESIS, onChange } = {}) {
  let pointerId = null;
  let dir = null;
  let cx = 0;
  let cy = 0;
  let radius = 1;

  function setDir(next) {
    if (next === dir) return;
    if (dir) input.release(dir);
    dir = next;
    if (dir) {
      input.press(dir);
      el.dataset.dir = dir; // one attribute write per change: CSS lights the matching arm
    } else {
      delete el.dataset.dir;
    }
    if (onChange) onChange(dir);
  }
  const track = (e) => setDir(dpadDirection(e.clientX - cx, e.clientY - cy, radius, dir, deadZone, hysteresis));

  const onDown = (e) => {
    if (!isPrimaryButton(e)) return;
    e.preventDefault();
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    capture(el, pointerId);
    const r = el.getBoundingClientRect(); // read once per touch, not per move
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
    radius = Math.min(r.width, r.height) / 2 || 1;
    track(e);
  };
  const onMove = (e) => {
    if (e.pointerId !== pointerId) return;
    track(e);
  };
  const onEnd = (e) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    setDir(null);
  };
  const events = [
    ['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onEnd],
    ['pointercancel', onEnd], ['lostpointercapture', onEnd],
  ];
  for (const [type, fn] of events) el.addEventListener(type, fn);

  return {
    get direction() { return dir; },
    release() {
      pointerId = null;
      setDir(null);
    },
    destroy() {
      for (const [type, fn] of events) el.removeEventListener(type, fn);
      pointerId = null;
      setDir(null);
    },
  };
}

function make(doc, tag, className, parent, text) {
  const e = doc.createElement(tag);
  e.className = className;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/**
 * Build the controls and bind them to `input`. Positions and sizes are set later by the layout
 * controller; until then the overlay stays hidden (no `ready` class).
 * @param {{press(b: string): void, release(b: string): void}} input
 * @param {{document?: Document, window?: Window, parent?: HTMLElement}} [opts]
 */
export function createTouchControls(input, { document: doc = globalThis.document, window: win = globalThis.window, parent } = {}) {
  const root = make(doc, 'div', 'touch-controls', parent || doc.body);
  root.setAttribute('aria-hidden', 'true');

  const dpad = make(doc, 'div', 'tc-dpad', root);
  make(doc, 'i', 'tc-bar tc-h', dpad);
  make(doc, 'i', 'tc-bar tc-v', dpad);
  for (const d of ['up', 'right', 'down', 'left']) make(doc, 'b', 'tc-glyph', make(doc, 'i', `tc-arm tc-${d}`, dpad));
  make(doc, 'i', 'tc-hub', dpad);

  const b = make(doc, 'div', 'tc-btn tc-b', root, 'B');
  const a = make(doc, 'div', 'tc-btn tc-a', root, 'A');
  const select = make(doc, 'div', 'tc-pill tc-select', root, 'SELECT');
  const start = make(doc, 'div', 'tc-pill tc-start', root, 'START');

  const bindings = [
    bindDpad(dpad, input),
    bindButton(a, 'a', input),
    bindButton(b, 'b', input),
    bindButton(select, 'select', input),
    bindButton(start, 'start', input),
  ];
  const releaseAll = () => { for (const x of bindings) x.release(); };

  // a finger that vanished with the page (app switch, lock screen) must not keep a button down
  const onHidden = () => { if (doc.hidden) releaseAll(); };
  win.addEventListener('blur', releaseAll);
  win.addEventListener('pagehide', releaseAll);
  doc.addEventListener('visibilitychange', onHidden);
  const noMenu = (e) => e.preventDefault();
  root.addEventListener('contextmenu', noMenu);

  return {
    root,
    elements: { root, dpad, a, b, select, start },
    releaseAll,
    destroy() {
      win.removeEventListener('blur', releaseAll);
      win.removeEventListener('pagehide', releaseAll);
      doc.removeEventListener('visibilitychange', onHidden);
      root.removeEventListener('contextmenu', noMenu);
      for (const x of bindings) x.destroy();
      if (root.remove) root.remove();
    },
  };
}

/**
 * Page-level guards for touch play: no pinch zoom (Safari's gesture events), no rubber-band or
 * pull-to-refresh scrolling, no long-press context menu, no text selection. CSS does most of this
 * (touch-action, overscroll-behavior, user-select, -webkit-touch-callout in index.html); these
 * listeners cover Safari versions that ignore part of it.
 * @param {{document?: Document}} [o]
 * @returns {() => void} remove the guards
 */
export function installTouchGuards({ document: doc = globalThis.document } = {}) {
  const stop = (e) => { if (e.cancelable !== false) e.preventDefault(); };
  /** @type {Array<[string, (e: Event) => void, object]>} */
  const listeners = [
    ['gesturestart', stop, { passive: false }],
    ['gesturechange', stop, { passive: false }],
    ['gestureend', stop, { passive: false }],
    ['touchmove', stop, { passive: false }],
    ['contextmenu', stop, { passive: false }],
    ['selectstart', stop, { passive: false }],
    ['dragstart', stop, { passive: false }],
  ];
  for (const [type, fn, opts] of listeners) doc.addEventListener(type, fn, opts);
  return () => { for (const [type, fn, opts] of listeners) doc.removeEventListener(type, fn, opts); };
}
