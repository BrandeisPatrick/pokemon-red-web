// Palettes: 4 RGB colours (shade 0 = lightest ... 3 = darkest) plus the three DMG shade
// maps (rBGP, rOBP0, rOBP1) that turn colour indices into shades.
//
// Fades work exactly like home/fade.asm: the colours never change, only the shade maps
// are stepped through the FadePal1..8 table, holding each step 8 frames.
//
// A shade map is an array m where m[colourIndex] = shade. The GB register byte for
// `dc a,b,c,d` is (a<<6)|(b<<4)|(c<<2)|d, i.e. colour 3 -> a, 2 -> b, 1 -> c, 0 -> d.

import { packRGBA } from './framebuffer.js';

/** @typedef {[number, number, number]} RGB */
/** @typedef {[RGB, RGB, RGB, RGB]} Colors */

/** Built-in colour sets (index 0 = lightest). */
export const PALETTES = Object.freeze({
  /** DMG green as popularised by the BGB emulator (readable, the default). */
  dmg: [[0xe0, 0xf8, 0xd0], [0x88, 0xc0, 0x70], [0x34, 0x68, 0x56], [0x08, 0x18, 0x20]],
  /** The classic, more saturated "pea soup" DMG green. */
  dmgClassic: [[0x9b, 0xbc, 0x0f], [0x8b, 0xac, 0x0f], [0x30, 0x62, 0x30], [0x0f, 0x38, 0x0f]],
  /** Game Boy Pocket / "DMG gray". */
  pocket: [[0xc4, 0xcf, 0xa1], [0x8b, 0x95, 0x6d], [0x4d, 0x53, 0x3c], [0x1f, 0x1f, 0x1f]],
  /** Neutral greys identical to the PNG greys (255/170/85/0); handy for debugging. */
  gray: [[0xff, 0xff, 0xff], [0xaa, 0xaa, 0xaa], [0x55, 0x55, 0x55], [0x00, 0x00, 0x00]],
});

/** `dc a,b,c,d` (as written in pokered) -> shade map [colour0..colour3]. */
export function dc(a, b, c, d) {
  return [d, c, b, a];
}

/** GB palette register byte -> shade map. */
export function byteToMap(byte) {
  return [byte & 3, (byte >> 2) & 3, (byte >> 4) & 3, (byte >> 6) & 3];
}

/** Shade map -> GB palette register byte. */
export function mapToByte(map) {
  return (map[0] & 3) | ((map[1] & 3) << 2) | ((map[2] & 3) << 4) | ((map[3] & 3) << 6);
}

/** home/palettes.asm GBPalNormal: rBGP = %11100100, rOBP0 = %11010000; rOBP1 from FadePal4. */
export const BGP_NORMAL = Object.freeze(dc(3, 2, 1, 0));
export const OBP0_NORMAL = Object.freeze(dc(3, 1, 0, 0));
export const OBP1_NORMAL = Object.freeze(dc(3, 2, 0, 0));

/**
 * home/fade.asm FadePal1..FadePal8 (index 0 unused so FADE_PALS[n] == FadePal<n>).
 * @type {ReadonlyArray<{bgp:number[], obp0:number[], obp1:number[]}>}
 */
export const FADE_PALS = Object.freeze([
  null,
  { bgp: dc(3, 3, 3, 3), obp0: dc(3, 3, 3, 3), obp1: dc(3, 3, 3, 3) }, // 1 black
  { bgp: dc(3, 3, 3, 2), obp0: dc(3, 3, 3, 2), obp1: dc(3, 3, 2, 0) }, // 2
  { bgp: dc(3, 3, 2, 1), obp0: dc(3, 2, 1, 0), obp1: dc(3, 2, 1, 0) }, // 3
  { bgp: dc(3, 2, 1, 0), obp0: dc(3, 1, 0, 0), obp1: dc(3, 2, 0, 0) }, // 4 normal
  { bgp: dc(3, 2, 1, 0), obp0: dc(3, 1, 0, 0), obp1: dc(3, 2, 0, 0) }, // 5 normal
  { bgp: dc(2, 1, 0, 0), obp0: dc(2, 0, 0, 0), obp1: dc(2, 1, 0, 0) }, // 6
  { bgp: dc(1, 0, 0, 0), obp0: dc(1, 0, 0, 0), obp1: dc(1, 0, 0, 0) }, // 7
  { bgp: dc(0, 0, 0, 0), obp0: dc(0, 0, 0, 0), obp1: dc(0, 0, 0, 0) }, // 8 white
]);

/**
 * The FadePal steps each GB fade routine walks through (8 frames per step):
 *   GBFadeInFromBlack: 1,2,3,4   GBFadeOutToWhite: 6,7,8
 *   GBFadeOutToBlack: 4,3,2,1 (yes, it starts by re-setting the normal palette)
 *   GBFadeInFromWhite: 7,6,5
 */
export const FADES = Object.freeze({
  inFromBlack: Object.freeze([1, 2, 3, 4]),
  outToWhite: Object.freeze([6, 7, 8]),
  outToBlack: Object.freeze([4, 3, 2, 1]),
  inFromWhite: Object.freeze([7, 6, 5]),
});

export const FADE_FRAMES_PER_STEP = 8;

/** SGB/CGB 5-bit RGB (0..31 per channel, as in data/sgb/sgb_palettes.asm) -> 8-bit RGB. */
export function rgb5(r, g, b) {
  const x = (v) => ((v & 31) << 3) | ((v & 31) >> 2);
  return [x(r), x(g), x(b)];
}

/**
 * Generic frame tween for coroutines: calls fn(t, i) with t = i/frames for i = 1..frames,
 * yielding one frame after each call.   yield* tween(16, t => sprite.y = 100 - 40 * t)
 * @param {number} frames
 * @param {(t:number, i:number) => void} fn
 */
export function* tween(frames, fn) {
  frames = Math.max(1, frames | 0);
  for (let i = 1; i <= frames; i++) {
    fn(i / frames, i);
    yield 1;
  }
}

export class Palette {
  /** @param {Colors|string} [colors] colour set or PALETTES key */
  constructor(colors = PALETTES.dmg) {
    /** @type {Colors} */
    this.colors = /** @type {any} */ (null);
    this.bgp = BGP_NORMAL.slice();
    this.obp0 = OBP0_NORMAL.slice();
    this.obp1 = OBP1_NORMAL.slice();
    /** optional separate colours for OBJ palettes (default: same as BG) */
    this.obj0Colors = null;
    this.obj1Colors = null;
    this._lut = new Uint32Array(16);
    this._dirty = true;
    this.setColors(colors);
  }

  /** @param {Colors|string} colors colour set (4 x [r,g,b]) or a PALETTES key */
  setColors(colors) {
    const c = typeof colors === 'string' ? PALETTES[colors] : colors;
    if (!c || c.length !== 4) throw new Error(`Palette.setColors: need 4 colours, got ${colors}`);
    this.colors = /** @type {Colors} */ (c.map((rgb) => [rgb[0] | 0, rgb[1] | 0, rgb[2] | 0]));
    this._dirty = true;
    return this;
  }

  /**
   * Give OBJ palette 0 or 1 its own colour set (SGB-style), or null to share the BG colours.
   * @param {0|1} which
   * @param {Colors|string|null} colors
   */
  setObjColors(which, colors) {
    const c = colors == null ? null : (typeof colors === 'string' ? PALETTES[colors] : colors);
    if (c && c.length !== 4) throw new Error('Palette.setObjColors: need 4 colours');
    const copy = c ? c.map((rgb) => [rgb[0] | 0, rgb[1] | 0, rgb[2] | 0]) : null;
    if (which === 1) this.obj1Colors = copy;
    else this.obj0Colors = copy;
    this._dirty = true;
    return this;
  }

  /** Set the BG shade map (m[colour] = shade). Leaves OBJ maps alone. */
  setMap(map) {
    this.bgp = Array.from(map, (v) => v & 3);
    this._dirty = true;
    return this;
  }

  /** Set all three shade maps at once. */
  setMaps(bgp, obp0 = this.obp0, obp1 = this.obp1) {
    this.bgp = Array.from(bgp, (v) => v & 3);
    this.obp0 = Array.from(obp0, (v) => v & 3);
    this.obp1 = Array.from(obp1, (v) => v & 3);
    this._dirty = true;
    return this;
  }

  /** Apply FadePal<n> (1 = black ... 4/5 = normal ... 8 = white) to BGP/OBP0/OBP1. */
  setFadeStep(n) {
    const p = FADE_PALS[n];
    if (!p) throw new Error(`Palette.setFadeStep: no FadePal${n}`);
    return this.setMaps(p.bgp, p.obp0, p.obp1);
  }

  /** GBPalNormal (+ normal OBP1). */
  reset() {
    return this.setFadeStep(4);
  }

  /** GBPalWhiteOut: every shade map -> white. */
  whiteOut() {
    return this.setFadeStep(8);
  }

  /** Every shade map -> black. */
  blackOut() {
    return this.setFadeStep(1);
  }

  get bgpByte() { return mapToByte(this.bgp); }
  set bgpByte(v) { this.setMap(byteToMap(v)); }

  /** Shade (0..3) that framebuffer value `v` currently displays as. */
  shadeOf(v) {
    if (v >= 8) return this.obp1[v & 3];
    if (v >= 4) return this.obp0[v & 3];
    return this.bgp[v & 3];
  }

  /** RGB that framebuffer value `v` currently displays as. */
  rgbOf(v) {
    const set = v >= 8 ? this.obj1Colors || this.colors : v >= 4 ? this.obj0Colors || this.colors : this.colors;
    return set[this.shadeOf(v)];
  }

  /** 16-entry framebuffer value -> packed RGBA lookup (cached until something changes). */
  lut32() {
    if (this._dirty) {
      for (let v = 0; v < 16; v++) {
        const c = this.rgbOf(v);
        this._lut[v] = packRGBA(c[0], c[1], c[2]);
      }
      this._dirty = false;
    }
    return this._lut;
  }

  /**
   * Coroutine: walk a FADES sequence (name or explicit FadePal step list), holding each
   * step `framesPerStep` frames, like GBFadeIncCommon / GBFadeDecCommon.
   * @param {keyof FADES | number[]} steps
   * @param {number} [framesPerStep]
   */
  *fade(steps, framesPerStep = FADE_FRAMES_PER_STEP) {
    const list = typeof steps === 'string' ? FADES[steps] : steps;
    if (!list) throw new Error(`Palette.fade: unknown fade ${steps}`);
    for (const n of list) {
      this.setFadeStep(n);
      yield framesPerStep;
    }
  }

  /** GBFadeOutToWhite (3 steps, 24 frames). */
  *fadeToWhite(framesPerStep) { yield* this.fade('outToWhite', framesPerStep); }
  /** GBFadeOutToBlack (4 steps, 32 frames; the first step is the normal palette). */
  *fadeToBlack(framesPerStep) { yield* this.fade('outToBlack', framesPerStep); }
  /** GBFadeInFromWhite (3 steps, 24 frames). */
  *fadeInFromWhite(framesPerStep) { yield* this.fade('inFromWhite', framesPerStep); }
  /** GBFadeInFromBlack (4 steps, 32 frames). */
  *fadeInFromBlack(framesPerStep) { yield* this.fade('inFromBlack', framesPerStep); }
  /** Fade in from 'black' (default) or 'white'. */
  *fadeIn(from = 'black', framesPerStep) {
    yield* this.fade(from === 'white' ? 'inFromWhite' : 'inFromBlack', framesPerStep);
  }
}
