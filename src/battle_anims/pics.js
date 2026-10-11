// The part of the Game Boy tile map (wTileMap) the battle animations work on, plus the two
// pic tile-data slots in VRAM.
//
// Cell values are the real BG tile ids, so the disassembly's tile arithmetic works as is:
//   $00-$30  enemy pic tile n   (vFrontPic, column-major: column n / 7, row n % 7)
//   $31-$61  player pic tile n-$31 (vBackPic)
//   $62-$7F  battle HUD / text-box tiles (assets/battle/battle_tiles_60_7f.png); $7F = blank
//   NONE (-1) = not managed here: the host's own drawing shows through
// Pure: no DOM.

import { TILE, SCREEN_TILES_W, SCREEN_TILES_H, PIC_TILE_COUNT, BLANK_TILE, PLAYER_PIC_REGION, ENEMY_PIC_REGION } from './layout.js';

export const NONE = -1;
export const BLANK = BLANK_TILE;
const PIC_BYTES = PIC_TILE_COUNT * 64;

/** A blank pic slot: 49 tiles x 64 colour indices, tile-major in VRAM (column-major) order. */
export function blankPicTiles() {
  return new Uint8Array(PIC_BYTES);
}

/**
 * Convert an IndexedImage to the 49-tile pic slot layout.
 *  - 'front': w x h tiles (5..7) placed like LoadUncompressedSpriteData: bottom-aligned,
 *    column offset (8 - w) >> 1, row offset 7 - h.
 *  - 'back': a 56x56 image (assets/pokemon/back2x) used as is; a 32x32 original back pic is
 *    scaled like ScaleSpriteByTwo (top-left 28x28 doubled).
 * @param {import('../engine/gfx.js').IndexedImage} img
 * @param {'front'|'back'} kind
 * @returns {Uint8Array}
 */
export function picTilesFromImage(img, kind = 'front') {
  const out = blankPicTiles();
  if (!img) return out;
  let src = img.data, sw = img.width, sh = img.height;
  if (kind === 'back' && sw === 32 && sh === 32) {
    const scaled = new Uint8Array(56 * 56);
    for (let y = 0; y < 56; y++) for (let x = 0; x < 56; x++) scaled[y * 56 + x] = src[(y >> 1) * 32 + (x >> 1)];
    src = scaled; sw = 56; sh = 56;
  }
  const wt = Math.min(7, Math.floor(sw / TILE)), ht = Math.min(7, Math.floor(sh / TILE));
  const colOff = kind === 'front' ? (8 - wt) >> 1 : 0;
  const rowOff = kind === 'front' ? 7 - ht : 0;
  for (let c = 0; c < 7; c++) {
    for (let r = 0; r < 7; r++) {
      const sc = c - colOff, sr = r - rowOff;
      if (sc < 0 || sr < 0 || sc >= wt || sr >= ht) continue;
      const base = (c * 7 + r) * 64;
      for (let y = 0; y < 8; y++) {
        const srow = (sr * 8 + y) * sw + sc * 8;
        for (let x = 0; x < 8; x++) out[base + y * 8 + x] = src[srow + x];
      }
    }
  }
  return out;
}

/** 8x8 pattern (Uint8Array view) of tile n of a pic slot. */
export function picTile(slot, n) {
  return slot.subarray(n * 64, n * 64 + 64);
}

/** wTileMap restricted to what the animations need. */
export class PicTilemap {
  constructor() {
    this.w = SCREEN_TILES_W;
    this.h = SCREEN_TILES_H;
    this.cells = new Int16Array(this.w * this.h).fill(NONE);
  }

  /** Forget everything (all cells NONE). With `own`, the two pic regions are owned (blank). */
  reset(own = true) {
    this.cells.fill(NONE);
    if (own) {
      this.fill(PLAYER_PIC_REGION.x, PLAYER_PIC_REGION.y, PLAYER_PIC_REGION.w, PLAYER_PIC_REGION.h, BLANK);
      this.fill(ENEMY_PIC_REGION.x, ENEMY_PIC_REGION.y, ENEMY_PIC_REGION.w, ENEMY_PIC_REGION.h, BLANK);
    }
  }

  inside(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }

  /** Raw cell value (NONE outside / unmanaged). */
  get(x, y) { return this.inside(x, y) ? this.cells[y * this.w + x] : NONE; }

  /** Value as the GB would read it: unmanaged cells read as the blank tile. */
  tileAt(x, y) {
    const v = this.get(x, y);
    return v === NONE ? BLANK : v;
  }

  set(x, y, v) { if (this.inside(x, y)) this.cells[y * this.w + x] = v; }

  fill(x, y, w, h, v) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, v);
  }

  /** ClearScreenArea: w x h blank tiles at (x, y). */
  clearArea(x, y, w, h) { this.fill(x, y, w, h, BLANK); }

  /**
   * CopyTileIDs: `rows` x `cols` cells from a row-major tile id list, each + base (8-bit).
   * @param {number} x @param {number} y @param {number} rows @param {number} cols
   * @param {ArrayLike<number>} list @param {number} base
   */
  copyTileIds(x, y, rows, cols, list, base = 0) {
    let k = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) this.set(x + c, y + r, (list[k++] + base) & 0xff);
  }

  /** CopyUncompressedPicToHL: 7x7 ids start, start+1, ... down each column (flipped: right to left). */
  copyPic(x, y, start, flipped = false) {
    let v = start;
    for (let c = 0; c < 7; c++) {
      const cx = flipped ? x + 6 - c : x + c;
      for (let r = 0; r < 7; r++) this.set(cx, y + r, (v++) & 0xff);
    }
  }

  /** Copy a w-wide row segment from (sx, sy) to (dx, dy) (CopyData on wTileMap rows). */
  copyRow(sx, sy, dx, dy, w) {
    const tmp = [];
    for (let i = 0; i < w; i++) tmp.push(this.get(sx + i, sy));
    for (let i = 0; i < w; i++) this.set(dx + i, dy, tmp[i]);
  }

  /** Snapshot / restore (tests, debugging). */
  save() { return this.cells.slice(); }
  restore(saved) { this.cells.set(saved); }

  /**
   * Draw every managed cell into `fb` (a FrameBuffer): pic tiles from the slots, HUD tiles from
   * `battleTiles` (tile id - $60), blank/unknown as white.
   * @param {{pixels: Uint8Array, width: number}} fb
   * @param {{enemy: Uint8Array, player: Uint8Array}} vram
   * @param {import('../engine/gfx.js').IndexedImage|null} battleTiles
   */
  draw(fb, vram, battleTiles) {
    const px = fb.pixels, W = fb.width;
    for (let ty = 0; ty < this.h; ty++) {
      for (let tx = 0; tx < this.w; tx++) {
        const v = this.cells[ty * this.w + tx];
        if (v === NONE) continue;
        let pat = null;
        if (v < 0x31) pat = picTile(vram.enemy, v);
        else if (v < 0x62) pat = picTile(vram.player, v - 0x31);
        else if (v < 0x80 && v !== BLANK && battleTiles) pat = battleTiles.tile(v - 0x60);
        const x0 = tx * TILE, y0 = ty * TILE;
        for (let y = 0; y < 8; y++) {
          const row = (y0 + y) * W + x0;
          if (pat) for (let x = 0; x < 8; x++) px[row + x] = pat[y * 8 + x];
          else px.fill(0, row, row + 8);
        }
      }
    }
  }
}
