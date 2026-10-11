// Game Boy style screen writing for the menus.
//
// The disassembly writes *bytes* into wTileMap (`hlcoord x, y` + `ld [hl], $78`, PlaceString)
// and what a byte looks like depends on what the current screen loaded into VRAM (the party
// menu loads the HP-bar tiles over $62-$7F, the Pokédex its border tiles over $60-$71, the
// status screen the battle HUD tiles over $6D-$78 ...). We do the same:
//
//   * one combined tile sheet per game (`combineSheets`): tiles 0..511 are the engine font
//     sheet (so the engine TextBox / Menu tile indices stay valid), the menu graphics follow;
//   * a VRAM table per screen (`makeVram`): byte -> tile index in that sheet, built from the
//     font's own tables (data/font.json `vram.text|menu|status|battle`) plus overrides;
//   * `Screen` writes bytes through the table into an engine TileMap, so code can be copied
//     from the asm coordinate for coordinate.
//
// Strings are converted to bytes with the game's charmap (constants/charmap.asm) — derived
// from data/font.json, where page-0 tile = byte and page-1 tile = 256 + byte.

import { TileMap, EMPTY } from '../engine/tilemap.js';
import { makeIndexedImage } from '../engine/gfx.js';
import { printNumber, printBCD, hpBarPixels, hpBarBytes, HP_BAR_PARTY, HP_BAR_STATUS, levelString, statusText } from './format.js';

/** ' ' — the blank tile byte. */
export const SPACE = 0x7f;
/** Frame bytes (TextBoxBorder). */
export const FRAME = Object.freeze({ tl: 0x79, h: 0x7a, tr: 0x7b, v: 0x7c, bl: 0x7d, br: 0x7e });
export const CURSOR = 0xed; // ▶
export const CURSOR_HOLLOW = 0xec; // ▷
export const DOWN_ARROW = 0xee; // ▼

/** Glyphs the font extractor stored outside page 0 because their byte is shared. */
const MISC_BYTES = Object.freeze({ '′': 0x60, '″': 0x61, '<BOLD_P>': 0x72, '▲': 0xed, '<ED>': 0xf0 });

/**
 * charmap key -> byte, derived from the font (tile < 256 -> tile, page 1 -> tile - 256).
 * @param {import('../engine/font.js').Font} font
 * @returns {Map<string, number>}
 */
export function buildCharmap(font) {
  const map = new Map();
  for (const [key, tile] of Object.entries(font.chars)) {
    if (MISC_BYTES[key] !== undefined) map.set(key, MISC_BYTES[key]);
    else if (tile >= 256) map.set(key, tile - 256);
    else if (tile >= 0x60) map.set(key, tile);
  }
  return map;
}

/**
 * Encode a string to charmap bytes (placeholders and expansions like the Font does).
 * @param {import('../engine/font.js').Font} font
 * @param {Map<string, number>} charmap
 * @param {string} str
 * @param {Record<string, any>} [subs]
 * @returns {number[]}
 */
export function encodeBytes(font, charmap, str, subs) {
  const keys = font.tokenize(font.expand(String(str), subs));
  return keys.map((k) => {
    const b = charmap.get(k);
    return b === undefined ? 0xe6 /* ? */ : b;
  });
}

/**
 * Concatenate the font sheet and extra sheets into one 128-px-wide IndexedImage.
 * @param {import('../engine/gfx.js').IndexedImage} fontGfx
 * @param {{name:string, img:import('../engine/gfx.js').IndexedImage}[]} extras
 * @returns {{gfx: import('../engine/gfx.js').IndexedImage, base: Record<string, number>, count: Record<string, number>}}
 */
export function combineSheets(fontGfx, extras) {
  const base = {};
  const count = {};
  let total = fontGfx.tileCount;
  for (const e of extras) {
    base[e.name] = total;
    count[e.name] = e.img.tileCount;
    total += e.img.tileCount;
  }
  const rows = Math.ceil(total / 16);
  const width = 128;
  const data = new Uint8Array(width * rows * 8);
  const copyTile = (src, t, dst) => {
    const ox = (dst % 16) * 8, oy = Math.floor(dst / 16) * 8;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) data[(oy + y) * width + ox + x] = src[t * 64 + y * 8 + x];
  };
  for (let t = 0; t < fontGfx.tileCount; t++) copyTile(fontGfx.tiles, t, t);
  for (const e of extras) for (let t = 0; t < e.img.tileCount; t++) copyTile(e.img.tiles, t, base[e.name] + t);
  return { gfx: makeIndexedImage(width, rows * 8, data, { url: 'menus:combined' }), base, count };
}

/**
 * A VRAM table: byte -> sheet tile index.
 * @param {import('../engine/font.js').Font} font
 * @param {'text'|'menu'|'status'|'battle'} mode base table (data/font.json vram)
 * @param {Array<[number, number]>} [overrides] [byte, sheet tile] pairs
 * @returns {Int16Array}
 */
export function makeVram(font, mode = 'text', overrides = []) {
  const src = (font.vram && font.vram[mode]) || [];
  const v = new Int16Array(256);
  for (let b = 0; b < 256; b++) {
    const t = src[b];
    v[b] = t === undefined || t < 0 ? font.space : t;
  }
  for (const [b, t] of overrides) v[b & 0xff] = t;
  return v;
}

/** Overrides placing `n` consecutive sheet tiles from `start` at bytes `byte`.. */
export function vramRange(byte, start, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push([byte + i, start + i]);
  return out;
}

/**
 * Byte-level writer over an engine TileMap (wTileMap), asm style.
 */
export class Screen {
  /**
   * @param {object} o
   * @param {import('../engine/font.js').Font} o.font
   * @param {Map<string, number>} o.charmap
   * @param {TileMap} [o.map]
   * @param {Int16Array} o.vram
   * @param {Record<string, any>} [o.subs] default substitutions ({PLAYER}, {RIVAL})
   */
  constructor({ font, charmap, map, vram, subs }) {
    this.font = font;
    this.charmap = charmap;
    this.map = map || new TileMap(20, 18);
    this.vram = vram;
    this.subs = subs || {};
    /** byte value of every cell (-1 = untouched/EMPTY), mirrors wTileMap */
    this.bytes = new Int16Array(this.map.width * this.map.height).fill(-1);
  }

  /**
   * Switch the VRAM table and re-resolve every cell written through this Screen (a tile data
   * reload). Cells changed since by other writers (the engine TextBox) are left alone.
   */
  setVram(vram) {
    const old = this.vram;
    this.vram = vram;
    for (let i = 0; i < this.bytes.length; i++) {
      const b = this.bytes[i];
      if (b >= 0 && this.map.cells[i] === old[b]) this.map.cells[i] = vram[b];
    }
  }

  /** True if the cell at (x, y) currently shows `byte` (checks the tile, like `ld a,[hl]; cp`). */
  is(x, y, byte) {
    return this.map.get(x, y) === this.vram[byte & 0xff];
  }

  /** Write one byte. */
  put(x, y, byte) {
    if (x < 0 || y < 0 || x >= this.map.width || y >= this.map.height) return;
    const b = byte & 0xff;
    this.bytes[y * this.map.width + x] = b;
    this.map.set(x, y, this.vram[b]);
  }

  /** Read back the byte at (x, y) (-1 if not written by a Screen call). */
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.map.width || y >= this.map.height) return -1;
    return this.bytes[y * this.map.width + x];
  }

  /** Write a raw sheet tile (not a byte), e.g. a pic tile. */
  putTile(x, y, tile) {
    if (x < 0 || y < 0 || x >= this.map.width || y >= this.map.height) return;
    this.bytes[y * this.map.width + x] = -1;
    this.map.set(x, y, tile);
  }

  /** Remove a cell (the scene below shows through). */
  erase(x, y) {
    if (x < 0 || y < 0 || x >= this.map.width || y >= this.map.height) return;
    this.bytes[y * this.map.width + x] = -1;
    this.map.set(x, y, EMPTY);
  }

  /** Make a rectangle transparent again. */
  eraseRect(x, y, w, h) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.erase(xx, yy);
  }

  /** Every cell transparent. */
  reset() {
    this.bytes.fill(-1);
    this.map.clear();
  }

  /** ClearScreen: every cell = ' '. */
  clear() {
    this.fill(0, 0, this.map.width, this.map.height, SPACE);
  }

  /** Fill a rectangle with a byte. */
  fill(x, y, w, h, byte) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.put(xx, yy, byte);
  }

  /** ClearScreenArea (hlcoord x,y; b = h rows; c = w columns). */
  clearArea(x, y, w, h) {
    this.fill(x, y, w, h, SPACE);
  }

  /** Encode a string to bytes with this screen's substitutions. */
  bytesOf(str, subs) {
    return encodeBytes(this.font, this.charmap, str, subs ? { ...this.subs, ...subs } : this.subs);
  }

  /**
   * PlaceString at (x, y). '\n' = <NEXT> (lineStep rows below the line start, 2 by default,
   * 1 with BIT_SINGLE_SPACED_LINES). @returns {{x:number, y:number}} where the string ended
   * (the bc of PlaceString)
   */
  text(x, y, str, { subs, lineStep = 2 } = {}) {
    let cx = x, cy = y;
    const lines = String(str).split('\n');
    lines.forEach((line, i) => {
      if (i > 0) { cx = x; cy += lineStep; }
      for (const b of this.bytesOf(line, subs)) this.put(cx++, cy, b);
    });
    return { x: cx, y: cy };
  }

  /** Write a run of raw bytes left to right. @returns {number} x after */
  bytesAt(x, y, bytes) {
    for (const b of bytes) this.put(x++, y, b);
    return x;
  }

  /**
   * TextBoxBorder with the *outer* size (asm: b = h - 2 interior rows, c = w - 2 columns).
   */
  box(x, y, w, h) {
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const top = yy === 0, bottom = yy === h - 1, left = xx === 0, right = xx === w - 1;
        let b = SPACE;
        if (top) b = left ? FRAME.tl : right ? FRAME.tr : FRAME.h;
        else if (bottom) b = left ? FRAME.bl : right ? FRAME.br : FRAME.h;
        else if (left || right) b = FRAME.v;
        this.put(x + xx, y + yy, b);
      }
    }
  }

  /** TextBoxBorder with the asm's interior size (hlcoord x,y; b rows; c columns). */
  boxInner(x, y, c, b) {
    this.box(x, y, c + 2, b + 2);
  }

  /**
   * PrintNumber at (x, y); right-aligned padding cells are skipped (not written).
   * @returns {number} x after (the hl PrintNumber leaves)
   */
  num(x, y, value, digits, flags = 0) {
    const s = printNumber(value, digits, flags);
    return this._digits(x, y, s);
  }

  /** PrintBCDNumber at (x, y). @returns {number} x after */
  bcd(x, y, value, bytes, flags = 0) {
    return this._digits(x, y, printBCD(value, bytes, flags));
  }

  /** @private write a formatted number, skipping the leading padding spaces */
  _digits(x, y, s) {
    let i = 0;
    while (i < s.length && s[i] === ' ') { i++; x++; }
    const bytes = this.bytesOf(s.slice(i));
    return this.bytesAt(x, y, bytes);
  }

  /** PrintLevel at (x, y). @returns {number} x after */
  level(x, y, level) {
    const s = levelString(level);
    return this.bytesAt(x, y, this.bytesOf(s));
  }

  /** PrintStatusCondition at (x, y) ("FNT" at 0 HP). @returns {string} what was printed */
  status(x, y, hp, status) {
    const s = statusText(hp, status);
    if (s) this.text(x, y, s);
    return s;
  }

  /**
   * DrawHPBar at (x, y) for `pixels` (0-48). type: HP_BAR_PARTY ($6C end) or HP_BAR_STATUS ($6D).
   */
  hpBarPixels(x, y, pixels, type = HP_BAR_PARTY) {
    this.bytesAt(x, y, hpBarBytes(pixels, type));
  }

  /**
   * DrawHP_: the bar at (x, y) and the "hp/max" numbers (party menu: 9 cells right of the bar
   * start; status screen: one row below, one column right).
   * @returns {number} the bar's pixel length
   */
  hp(x, y, hp, maxHp, type = HP_BAR_PARTY) {
    const px = hp > 0 ? hpBarPixels(hp, maxHp) : 0;
    this.hpBarPixels(x, y, px, type);
    const nx = type === HP_BAR_PARTY ? x + 9 : x + 1;
    const ny = type === HP_BAR_PARTY ? y : y + 1;
    let ex = this.num(nx, ny, hp, 3);
    this.put(ex++, ny, 0xf3); // '/'
    this.num(ex, ny, maxHp, 3);
    return px;
  }

  /** The ▶ cursor / ▷ / ' ' at (x, y). */
  cursor(x, y, kind = 'right') {
    this.put(x, y, kind === 'hollow' ? CURSOR_HOLLOW : kind === 'none' ? SPACE : CURSOR);
  }

  /** Copy all cells of a rectangle (SaveScreenTilesToBuffer). */
  save(x = 0, y = 0, w = this.map.width, h = this.map.height) {
    const cells = this.map.save(x, y, w, h);
    const bytes = new Int16Array(w * h);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) bytes[yy * w + xx] = this.get(x + xx, y + yy);
    return { cells, bytes };
  }

  /** Put back a rectangle captured with save(). */
  restore(saved) {
    this.map.restore(saved.cells);
    const { x, y, w, h } = saved.cells;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const X = x + xx, Y = y + yy;
      if (X < 0 || Y < 0 || X >= this.map.width || Y >= this.map.height) continue;
      this.bytes[Y * this.map.width + X] = saved.bytes[yy * w + xx];
    }
  }
}

export { HP_BAR_PARTY, HP_BAR_STATUS };
