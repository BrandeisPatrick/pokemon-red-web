// Phone layout. Two halves:
//
//   * computeLayout(env)  PURE geometry (node-testable): where the canvas and every control go
//                         for a viewport size, device-pixel ratio and safe-area insets.
//   * createLayoutController(...)  the DOM glue: reads the viewport + env(safe-area-inset-*),
//                         feeds the FrameBuffer its canvas region (attachCanvas({getViewport})),
//                         positions the canvas on the device-pixel grid and places the controls.
//
// Portrait : canvas at the top under the safe-area inset at the largest integer scale that fits
//            the width, the controls in the band below it (D-pad left, A/B right, START/SELECT
//            in the middle).
// Landscape: canvas centred at the largest integer scale that fits the height, D-pad in the
//            left panel, A/B in the right panel (SELECT under the D-pad, START under A/B).
//
// Nothing here runs per frame: the layout is recomputed on resize / orientationchange only.
// See docs/mobile.md.

export const SCREEN_W = 160;
export const SCREEN_H = 144;

/** Minimum / maximum sizes in CSS px (the spec: D-pad >= 130, A and B >= 60). */
export const MIN_DPAD = 130;
export const MAX_DPAD = 220;
export const MIN_BUTTON = 60;
export const MAX_BUTTON = 100;
export const PILL_H = 34;
export const FULLSCREEN_SIZE = 40;

const TOP_GAP = 8;            // portrait: canvas top below the safe-area inset
const BELOW_GAP = 12;         // portrait: canvas bottom -> control band
const MIN_CONTROLS_H = 232;   // portrait: height always left for the controls under the canvas
const EDGE = 24;              // controls keep this far from the screen edge (system back gestures)
const PANEL_GAP = 6;          // landscape: control panel <-> canvas
const BOTTOM_MARGIN = 14;     // START/SELECT above the bottom inset
const PILL_GAP = 16;          // portrait: SELECT <-> START
/** landscape: how far a control may reach into the canvas margin on small phones */
export const OVERLAP_TOLERANCE = 32;
/** landscape: width always reserved on each side of the canvas: room for the smallest D-pad (EDGE + D-pad + gap - tolerance), or 14% of the width on big screens */
const minSide = (areaW) => Math.max(EDGE + MIN_DPAD + PANEL_GAP - OVERLAP_TOLERANCE, Math.round(areaW * 0.14));
/** A/B diagonal in button diameters: A is up and to the right of B (the discs stay about 0.12 diameters apart) */
const CLUSTER_DX = 1.0;
const CLUSTER_DY = 0.5;

/** @typedef {{x:number, y:number, w:number, h:number}} Rect */
/** @typedef {{top:number, right:number, bottom:number, left:number}} Insets */
/**
 * @typedef {Object} LayoutEnv
 * @property {number} width    viewport width in CSS px (window.innerWidth)
 * @property {number} height   viewport height in CSS px (window.innerHeight / 100dvh)
 * @property {number} [dpr]    devicePixelRatio (default 1)
 * @property {Partial<Insets>} [safe]  env(safe-area-inset-*) in CSS px
 * @property {number} [scale]  force this integer scale (the FrameBuffer's, after its layout())
 */
/**
 * @typedef {Object} Layout
 * @property {'portrait'|'landscape'} orientation
 * @property {number} dpr
 * @property {number} scale      integer canvas scale in device pixels per game pixel
 * @property {Rect} region       the area the FrameBuffer may fill (what getViewport() returns)
 * @property {Rect} canvas       the canvas box in CSS px, on the device-pixel grid
 * @property {Rect} dpad @property {Rect} a @property {Rect} b
 * @property {Rect} select @property {Rect} start @property {Rect} fullscreen
 */

const clamp = (lo, v, hi) => Math.max(lo, Math.min(v, hi));

/** Round a CSS length to a whole number of device pixels. */
export function snapPx(v, dpr = 1) {
  return Math.round(v * dpr) / dpr;
}

/**
 * The scale FrameBuffer.layout() picks: the largest integer scale at which the 160x144 screen
 * fits (width, height) in *device* pixels.
 */
export function integerScale(width, height, dpr = 1) {
  const availW = Math.floor(width * dpr);
  const availH = Math.floor(height * dpr);
  return Math.max(1, Math.floor(Math.min(availW / SCREEN_W, availH / SCREEN_H)));
}

/** True if two rectangles share any area. */
export function rectsOverlap(p, q) {
  return p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
}

/**
 * Where everything goes.
 * @param {LayoutEnv} env
 * @returns {Layout}
 */
export function computeLayout(env) {
  const dpr = env.dpr || 1;
  const safe = { top: 0, right: 0, bottom: 0, left: 0, ...(env.safe || {}) };
  const c = { W: env.width, H: env.height, dpr, safe, scale: env.scale || 0 };
  return c.H >= c.W ? portraitLayout(c) : landscapeLayout(c);
}

function canvasBox(cx, cy, scale, dpr) {
  const w = (SCREEN_W * scale) / dpr;
  const h = (SCREEN_H * scale) / dpr;
  return { x: snapPx(cx - w / 2, dpr), y: snapPx(cy - h / 2, dpr), w, h };
}

function portraitLayout({ W, H, dpr, safe, scale: forced }) {
  const areaX = safe.left;
  const areaW = W - safe.left - safe.right;
  const top = safe.top + TOP_GAP;
  const bottom = H - safe.bottom;

  // The canvas may use the full width but must leave MIN_CONTROLS_H below it.
  const region = { x: areaX, y: top, w: areaW, h: Math.max(SCREEN_H, bottom - top - MIN_CONTROLS_H) };
  const scale = forced || integerScale(region.w, region.h, dpr);
  const box = canvasBox(areaX + areaW / 2, 0, scale, dpr);
  const canvas = { x: box.x, y: snapPx(top, dpr), w: box.w, h: box.h };

  const mx = clamp(EDGE, Math.round(areaW * 0.06), 40);
  const B = clamp(MIN_BUTTON, Math.round(areaW * 0.2), MAX_BUTTON);
  const dx = Math.round(B * CLUSTER_DX);
  const dy = Math.round(B * CLUSTER_DY);
  const clusterW = dx + B;
  const clusterH = dy + B;

  const ctlTop = Math.ceil(canvas.y + canvas.h + BELOW_GAP);
  const ctlH = bottom - ctlTop;
  const P = clamp(
    MIN_DPAD,
    Math.min(Math.round(areaW * 0.45), areaW - clusterW - 2 * mx - 10, ctlH - (PILL_H + BOTTOM_MARGIN + 24)),
    MAX_DPAD,
  );
  const pillW = clamp(72, Math.round(areaW * 0.23), 104);
  const pillsTop = bottom - BOTTOM_MARGIN - PILL_H;

  // the Fullscreen button sits in the pills' row, at the right edge
  const fullscreen = { x: areaX + areaW - mx - FULLSCREEN_SIZE, y: Math.round(pillsTop + (PILL_H - FULLSCREEN_SIZE) / 2), w: FULLSCREEN_SIZE, h: FULLSCREEN_SIZE };

  // D-pad and A/B share one row, a little below the middle of the band above the pills.
  const rowTop = ctlTop;
  const rowBottom = pillsTop - 12;
  const rowH = Math.max(P, clusterH);
  const centre = Math.round(clamp(rowTop + rowH / 2, rowTop + (rowBottom - rowTop) * 0.58, rowBottom - rowH / 2));
  const dpad = { x: areaX + mx, y: Math.round(centre - P / 2), w: P, h: P };
  const clusterLeft = areaX + areaW - mx - clusterW;
  const clusterTop = Math.round(centre - clusterH / 2);
  const a = { x: clusterLeft + dx, y: clusterTop, w: B, h: B };
  const b = { x: clusterLeft, y: clusterTop + dy, w: B, h: B };

  const cx = areaX + areaW / 2;
  const select = { x: Math.round(cx - PILL_GAP / 2 - pillW), y: pillsTop, w: pillW, h: PILL_H };
  const start = { x: Math.round(cx + PILL_GAP / 2), y: pillsTop, w: pillW, h: PILL_H };

  return { orientation: 'portrait', dpr, scale, region, canvas, dpad, a, b, select, start, fullscreen };
}

function landscapeLayout({ W, H, dpr, safe, scale: forced }) {
  const area = { x: safe.left, y: safe.top, w: W - safe.left - safe.right, h: H - safe.top - safe.bottom };

  // The canvas takes the full height; the width is held back so both side panels keep room for
  // the controls (small phones may let them reach OVERLAP_TOLERANCE px into the canvas margin).
  const side = minSide(area.w);
  const region = {
    x: area.x + side,
    y: area.y,
    w: Math.max(SCREEN_W, area.w - 2 * side),
    h: Math.max(SCREEN_H, area.h),
  };
  const scale = forced || integerScale(region.w, region.h, dpr);
  const canvas = canvasBox(area.x + area.w / 2, area.y + area.h / 2, scale, dpr);

  const leftEdge = Math.max(EDGE, safe.left + 8);
  const rightEdge = W - Math.max(EDGE, safe.right + 8);
  const availL = Math.floor(canvas.x - PANEL_GAP - leftEdge);
  const availR = Math.floor(rightEdge - (canvas.x + canvas.w + PANEL_GAP));

  const P = clamp(MIN_DPAD, Math.min(availL, Math.round(area.h * 0.5)), MAX_DPAD);
  const pillsTop = H - safe.bottom - BOTTOM_MARGIN - PILL_H;
  const fullscreen = { x: rightEdge - FULLSCREEN_SIZE, y: area.y + 8, w: FULLSCREEN_SIZE, h: FULLSCREEN_SIZE };
  // the A/B cluster must fit between the Fullscreen button and the START pill
  const roomH = pillsTop - 8 - (fullscreen.y + FULLSCREEN_SIZE + 6);
  const B = clamp(
    MIN_BUTTON,
    Math.min(Math.floor(availR / (1 + CLUSTER_DX)), Math.round(area.h * 0.24), Math.floor(roomH / (1 + CLUSTER_DY))),
    MAX_BUTTON,
  );
  const dx = Math.round(B * CLUSTER_DX);
  const dy = Math.round(B * CLUSTER_DY);
  const clusterW = dx + B;
  const clusterH = dy + B;
  const pillW = clamp(72, Math.round(Math.min(availL, availR) * 0.6), 104);
  const rowH = Math.max(P, clusterH);
  const centre = Math.round(clamp(area.y + 8 + rowH / 2, area.y + area.h * 0.5, pillsTop - 8 - rowH / 2));

  const dpadX = leftEdge + Math.max(0, Math.floor((availL - P) / 2));
  const dpad = { x: dpadX, y: Math.round(centre - P / 2), w: P, h: P };

  const clusterLeft = availR >= clusterW
    ? canvas.x + canvas.w + PANEL_GAP + Math.floor((availR - clusterW) / 2)
    : rightEdge - clusterW;
  const clusterTop = Math.max(Math.round(centre - clusterH / 2), fullscreen.y + FULLSCREEN_SIZE + 6);
  const a = { x: clusterLeft + dx, y: clusterTop, w: B, h: B };
  const b = { x: clusterLeft, y: clusterTop + dy, w: B, h: B };

  const select = { x: Math.round(dpad.x + (P - pillW) / 2), y: pillsTop, w: pillW, h: PILL_H };
  const start = { x: Math.round(clusterLeft + (clusterW - pillW) / 2), y: pillsTop, w: pillW, h: PILL_H };

  return { orientation: 'landscape', dpr, scale, region, canvas, dpad, a, b, select, start, fullscreen };
}

// ------------------------------------------------------------------------------ touch mode

/**
 * Should the on-screen controls (and the phone layout) be used?
 * Coarse primary pointer, or `?touch=1`; `?touch=0` forces them off.
 * (The inline script in index.html applies the same rule before first paint.)
 * @param {{location?: {search?: string}, matchMedia?: (q: string) => {matches: boolean}}} [win]
 */
export function detectTouch(win = globalThis.window) {
  const search = (win && win.location && win.location.search) || '';
  const param = new URLSearchParams(search).get('touch');
  if (param !== null) return !/^(0|false|off|no)$/i.test(param);
  return !!(win && win.matchMedia && win.matchMedia('(pointer: coarse)').matches);
}

// ------------------------------------------------------------------------------- DOM glue

/** @returns {Insets} */
export function readSafeInsets(probe, win = globalThis.window) {
  const cs = win.getComputedStyle(probe);
  const px = (v) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);
  return { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
}

/** A zero-size fixed element whose padding is env(safe-area-inset-*): the only way to read them. */
function ensureProbe(doc) {
  let probe = doc.getElementById('safe-probe');
  if (!probe) {
    probe = doc.createElement('div');
    probe.id = 'safe-probe';
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;'
      + 'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    doc.body.appendChild(probe);
  }
  return probe;
}

/**
 * Wires the layout to the page: call `getViewport` from `fb.attachCanvas(canvas, {getViewport})`,
 * then `bind(fb, elements)` once the controls exist.
 * @param {{win?: Window, doc?: Document, canvas: HTMLCanvasElement}} o
 */
export function createLayoutController({ win = globalThis.window, doc = win.document, canvas } = {}) {
  const probe = ensureProbe(doc);
  const html = doc.documentElement;
  let fb = null;
  /** @type {Record<string, HTMLElement|null|undefined>} */
  let els = {};
  let controlsRoot = null;
  /** @type {Layout|null} */
  let last = null;
  let timer = 0;
  const written = new WeakMap();

  const readEnv = () => ({
    width: win.innerWidth,
    height: win.innerHeight,
    dpr: win.devicePixelRatio || 1,
    safe: readSafeInsets(probe, win),
  });

  /** Canvas region for FrameBuffer.attachCanvas({getViewport}) (fresh on every call). */
  const getViewport = () => {
    const l = computeLayout(readEnv());
    return { width: l.region.w, height: l.region.h };
  };

  /** Position an element (and size it unless `sized` is false); skips the write when unchanged. */
  function place(el, r, sized = true) {
    if (!el) return;
    const key = sized ? `${r.x}|${r.y}|${r.w}|${r.h}` : `${r.x}|${r.y}`;
    if (written.get(el) === key) return;
    written.set(el, key);
    const s = el.style;
    s.left = `${r.x}px`;
    s.top = `${r.y}px`;
    if (sized) {
      s.width = `${r.w}px`;
      s.height = `${r.h}px`;
    }
  }

  /** Recompute and apply (resize, orientationchange, fullscreen change, first bind). */
  function apply() {
    const env = readEnv();
    if (fb) fb.layout(); // sizes the canvas through getViewport()
    const l = computeLayout({ ...env, scale: fb ? fb.scale : 0 });
    last = l;
    place(canvas, l.canvas, false); // fb.layout() already set the canvas CSS size; this adds the position
    for (const name of ['dpad', 'a', 'b', 'select', 'start', 'fullscreen']) place(els[name], l[name]);
    if (html.dataset.orient !== l.orientation) html.dataset.orient = l.orientation;
    if (controlsRoot) {
      controlsRoot.style.setProperty('--dpad', `${l.dpad.w}px`);
      controlsRoot.style.setProperty('--btn', `${l.a.w}px`);
      controlsRoot.style.setProperty('--pill-w', `${l.select.w}px`);
      controlsRoot.classList.add('ready');
    }
    return l;
  }

  const onResize = () => apply();
  const onOrientation = () => {
    apply();
    // iOS reports the old size for a moment after the event: measure again once it settled.
    win.clearTimeout(timer);
    timer = win.setTimeout(apply, 300);
  };
  win.addEventListener('resize', onResize);
  win.addEventListener('orientationchange', onOrientation);
  if (win.visualViewport) win.visualViewport.addEventListener('resize', onResize);
  doc.addEventListener('fullscreenchange', onResize);
  doc.addEventListener('webkitfullscreenchange', onResize);

  return {
    getViewport,
    /**
     * @param {import('../engine/framebuffer.js').FrameBuffer} frameBuffer
     * @param {{root?: HTMLElement, dpad?: HTMLElement, a?: HTMLElement, b?: HTMLElement, select?: HTMLElement, start?: HTMLElement, fullscreen?: HTMLElement|null}} elements
     */
    bind(frameBuffer, elements) {
      fb = frameBuffer;
      els = elements;
      controlsRoot = elements.root || null;
      return apply();
    },
    apply,
    get layout() { return last; },
    destroy() {
      win.removeEventListener('resize', onResize);
      win.removeEventListener('orientationchange', onOrientation);
      if (win.visualViewport) win.visualViewport.removeEventListener('resize', onResize);
      doc.removeEventListener('fullscreenchange', onResize);
      doc.removeEventListener('webkitfullscreenchange', onResize);
      win.clearTimeout(timer);
    },
  };
}
