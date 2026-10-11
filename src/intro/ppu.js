// A small model of the Game Boy picture hardware, used by the start sequence so the asm
// can be ported almost line for line (engine/movie/*.asm play with BG scrolling, the
// window, raster SCX splits, OAM priority and VRAM tile slots).
//
//   * Vram: 384 tiles = $8000-$97FF. OBJ tile id n -> slot n ($8000 addressing); BG/window
//     tile id n -> slot 256+n for n < $80, slot n otherwise ($8800 addressing, LCDC_BLOCK21,
//     which pokered always uses). vChars0 = slot 0, vChars1 = 128, vChars2 = 256.
//   * bg: the 2 KB of tile maps $9800-$9FFF (vBGMap0 = index 0, vBGMap1 = index $400).
//     Cells are tile ids; ids >= 256 are an escape hatch meaning "tile <id> of the engine
//     font sheet" (so engine widgets that write page-1 font tiles still render) and
//     negative ids (TileMap EMPTY) render as colour 0.
//   * wTileMap is an engine TileMap (20x18) that the VBlank handler copies to the map at
//     hAutoBGTransferDest one third (6 rows) per frame while hAutoBGTransferEnabled is set,
//     exactly like AutoBgMapTransfer (home/vblank.asm).
//   * Shadow registers hSCX/hSCY/hWY are latched into SCX/SCY/WY at VBlank; rWX, LCDC and
//     raster splits (SCX written at a given LY, as TitleScroll/ScrollTitleScreenGameVersion
//     do) are immediate.
//   * render() is a scanline renderer: BG, window, then up to 10 sprites per line chosen in
//     OAM order, DMG priority (smaller X, then lower OAM index) and the OAM_PRIO bit
//     (sprite behind BG colours 1-3). Output values follow the framebuffer convention:
//     0..3 BG colours, 4..7 OBJ palette 0, 8..11 OBJ palette 1.
//
// Pure (no DOM); unit tested in tests/intro/ppu.test.js.

import { TileMap } from '../engine/tilemap.js';

export const VCHARS0 = 0;
export const VCHARS1 = 128;
export const VCHARS2 = 256;
export const BG_MAP0 = 0x9800;
export const BG_MAP1 = 0x9c00;

export const OAM_PRIO = 0x80;
export const OAM_YFLIP = 0x40;
export const OAM_XFLIP = 0x20;
export const OAM_PAL1 = 0x10;

/** OAM Y that hides a sprite (SCREEN_HEIGHT_PX + OAM_Y_OFS). */
export const OAM_HIDDEN_Y = 160;

/** The blank tile (charmap ' ') that ClearScreen / ClearBgMap write. */
export const SPACE = 0x7f;

const W = 160;
const H = 144;

/** @typedef {import('../engine/gfx.js').IndexedImage} IndexedImage */

/** Tile slot for a BG/window tile id ($8800 addressing). */
export function bgSlot(id) {
  id &= 0xff;
  return id < 0x80 ? VCHARS2 + id : id;
}

export class Vram {
  constructor() {
    /** 384 tiles x 64 colour indices */
    this.tiles = new Uint8Array(384 * 64);
  }

  clear() {
    this.tiles.fill(0);
  }

  /** Write one 8x8 tile (64 colour indices, row-major) at `slot`. */
  setTile(slot, data, { flipX = false } = {}) {
    if (slot < 0 || slot >= 384) return;
    const o = slot * 64;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) this.tiles[o + y * 8 + x] = data[y * 8 + (flipX ? 7 - x : x)] & 3;
    }
  }

  /** Blank `count` slots starting at `slot`. */
  fill(slot, count, value = 0) {
    this.tiles.fill(value, slot * 64, Math.min(384, slot + count) * 64);
  }

  /**
   * Copy `count` tiles of an image (row-major tile order, like a 2bpp file) to `slot`.
   * @param {number} slot
   * @param {IndexedImage} img
   * @param {number} [first=0]
   * @param {number} [count]
   */
  load(slot, img, first = 0, count = img.tileCount - first) {
    for (let i = 0; i < count; i++) this.setTile(slot + i, img.tile(first + i));
  }

  /** Copy a list of 64-entry tiles to consecutive slots. */
  loadList(slot, list) {
    list.forEach((t, i) => this.setTile(slot + i, t));
  }

  /** @returns {Uint8Array} view of slot */
  tile(slot) {
    return this.tiles.subarray(slot * 64, slot * 64 + 64);
  }
}

/**
 * Tiles of a w x h-tile image region in column-major order (VRAM order of rgbgfx
 * --columns sheets and of uncompressed pics).
 * @param {IndexedImage} img
 * @param {number} cols
 * @param {number} rows
 * @returns {Uint8Array[]}
 */
export function columnMajorTiles(img, cols, rows) {
  const out = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) out.push(img.tile(r * img.tilesPerRow + c));
  return out;
}

/**
 * The 49 tiles a pic occupies in vFrontPic after LoadUncompressedSpriteData +
 * InterlaceMergeSpriteBuffers: the w x h tile pic is placed in a 7x7 box, bottom-aligned,
 * horizontally centred at column (8 - w) >> 1; tile n is column n / 7, row n % 7.
 * With `flip` (wSpriteFlipped) every tile's pixels are mirrored; CopyUncompressedPicToHL
 * then lays the columns out right to left, which mirrors the whole 7x7 box on screen.
 * @param {IndexedImage} img square pic (40/48/56 px)
 * @param {{flip?: boolean}} [opts]
 * @returns {Uint8Array[]} 49 tiles
 */
export function picTiles(img, { flip = false } = {}) {
  const w = img.tilesPerRow, h = img.tileRows;
  const colOff = (8 - w) >> 1, rowOff = 7 - h;
  const blank = new Uint8Array(64);
  const grid = []; // [col][row]
  for (let c = 0; c < 7; c++) {
    const col = [];
    for (let r = 0; r < 7; r++) {
      const sc = c - colOff, sr = r - rowOff;
      col.push(sc >= 0 && sc < w && sr >= 0 && sr < h ? img.tile(sr * w + sc) : blank);
    }
    grid.push(col);
  }
  const out = [];
  for (let c = 0; c < 7; c++) {
    for (let r = 0; r < 7; r++) {
      const src = grid[c][r];
      if (!flip) { out.push(src); continue; }
      const t = new Uint8Array(64);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) t[y * 8 + x] = src[y * 8 + 7 - x];
      out.push(t);
    }
  }
  return out;
}

/**
 * CopyUncompressedPicToHL: tile ids startId.. column-major into a 7x7 area at (x, y);
 * flipped pics are laid out from the rightmost column leftwards.
 * @param {import('../engine/tilemap.js').TileMap} map
 */
export function copyPicToTilemap(map, x, y, { flip = false, startId = 0 } = {}) {
  let id = startId;
  for (let c = 0; c < 7; c++) {
    const tx = flip ? x + 6 - c : x + c;
    for (let r = 0; r < 7; r++) map.set(tx, y + r, id++);
  }
}

function newOam() {
  return Array.from({ length: 40 }, () => ({ y: 0, x: 0, tile: 0, attr: 0 }));
}

export class GbScreen {
  /**
   * @param {{font?: {gfx: IndexedImage}}} [opts] font: the engine Font (escape hatch ids >= 256)
   */
  constructor({ font = null } = {}) {
    this.font = font;
    this.vram = new Vram();
    /** $9800-$9FFF */
    this.bg = new Int16Array(2048).fill(SPACE);
    /** wTileMap */
    this.tilemap = new TileMap(20, 18, SPACE);
    /** LCDC bits that matter here (LCDC_DEFAULT) */
    this.lcdc = { on: true, bgOn: true, objOn: true, bgMap: 0, winOn: true, winMap: 1 };
    // live registers
    this.scx = 0; this.scy = 0; this.wx = 7; this.wy = 144;
    // shadow registers (VBlank copies them)
    this.hSCX = 0; this.hSCY = 0; this.hWY = 144;
    /** raster writes for the frame being built: {line, scx?, scy?, wx?} */
    this.splits = [];
    /** wShadowOAM (40 x {y, x, tile, attr}) in hardware coordinates (y-16, x-8 = screen) */
    this.oam = newOam();
    // hAutoBGTransferEnabled / hAutoBGTransferDest / hAutoBGTransferPortion
    this.autoTransfer = false;
    this.autoDest = BG_MAP1;
    this.portion = 0;
    /** frames rendered (debugging) */
    this.frames = 0;
    this._line = new Uint8Array(W);
    this._claimed = new Uint8Array(W);
  }

  /** Init: everything the way home/init.asm leaves it before PlayIntro. */
  reset() {
    this.vram.clear();
    this.bg.fill(SPACE);
    this.tilemap.fill(SPACE);
    this.lcdc = { on: true, bgOn: true, objOn: true, bgMap: 0, winOn: true, winMap: 1 };
    this.scx = this.scy = 0; this.wx = 7; this.wy = 144;
    this.hSCX = this.hSCY = 0; this.hWY = 144;
    this.splits = [];
    this.clearSprites();
    this.autoTransfer = false;
    this.autoDest = BG_MAP1;
    this.portion = 0;
  }

  // ---------------------------------------------------------------- per-frame hooks

  /** Start of a frame: forget last frame's raster splits. */
  beginFrame() {
    this.splits.length = 0;
  }

  /** Raster effect: at line `line` set registers (e.g. {scx: 144}). */
  split(line, regs) {
    this.splits.push({ line, ...regs });
  }

  /** The VBlank handler: latch shadow registers, transfer a third of wTileMap. */
  vblank() {
    this.scx = this.hSCX & 0xff;
    this.scy = this.hSCY & 0xff;
    this.wy = this.hWY & 0xff;
    if (this.autoTransfer) {
      this.transferRows(this.portion * 6, 6, this.autoDest);
      this.portion = (this.portion + 1) % 3;
    }
  }

  /** Copy wTileMap rows [y0, y0+n) to the BG map at `dest` (32 cells per row). */
  transferRows(y0, n, dest) {
    const cells = this.tilemap.cells;
    for (let r = y0; r < y0 + n; r++) {
      const base = dest - BG_MAP0 + r * 32;
      for (let c = 0; c < 20; c++) this.bg[(base + c) & 2047] = cells[r * 20 + c];
    }
  }

  /** CopyScreenTileBufferToVRAM without the delay: whole wTileMap to `dest`. */
  transferAll(dest) {
    this.transferRows(0, 18, dest);
  }

  /** Fill `count` BG map cells from address `addr`. */
  fillBg(addr, count, value) {
    for (let i = 0; i < count; i++) this.bg[(addr - BG_MAP0 + i) & 2047] = value;
  }

  /** Read a BG map cell at an address. */
  bgAt(addr) {
    return this.bg[(addr - BG_MAP0) & 2047];
  }

  // ---------------------------------------------------------------- OAM

  /** ClearSprites: zero the whole OAM buffer. */
  clearSprites() {
    for (const o of this.oam) { o.y = 0; o.x = 0; o.tile = 0; o.attr = 0; }
  }

  /** HideSprites: Y = 160 for every entry. */
  hideSprites() {
    for (const o of this.oam) o.y = OAM_HIDDEN_Y;
  }

  /** Set OAM entry i (hardware coordinates). */
  setSprite(i, y, x, tile, attr = 0) {
    const o = this.oam[i];
    o.y = y & 0xff; o.x = x & 0xff; o.tile = tile & 0xff; o.attr = attr & 0xff;
  }

  // ---------------------------------------------------------------- rendering

  /** Colour index of BG/window tile `id` at (fx, fy). */
  bgPixel(id, fx, fy) {
    if (id < 0) return 0;
    if (id >= 256) {
      const g = this.font && this.font.gfx;
      if (!g || id >= g.tileCount) return 0;
      return g.tiles[id * 64 + fy * 8 + fx];
    }
    return this.vram.tiles[bgSlot(id) * 64 + fy * 8 + fx];
  }

  /**
   * Render one frame into a FrameBuffer-like object ({pixels: Uint8Array(160*144)}).
   * @param {{pixels: Uint8Array}} fb
   */
  render(fb) {
    this.frames++;
    const out = fb.pixels;
    if (!this.lcdc.on) { out.fill(0); return; }
    const splits = this.splits.length > 1 ? [...this.splits].sort((a, b) => a.line - b.line) : this.splits;
    let si = 0;
    let scx = this.scx, scy = this.scy, wx = this.wx;
    const wy = this.wy;
    const lcdc = this.lcdc;
    const bg = this.bg;
    const bgBase = lcdc.bgMap ? 0x400 : 0;
    const winBase = lcdc.winMap ? 0x400 : 0;
    const line = this._line;
    let winLine = 0;
    for (let ly = 0; ly < H; ly++) {
      while (si < splits.length && splits[si].line <= ly) {
        const s = splits[si++];
        if (s.scx !== undefined) scx = s.scx & 0xff;
        if (s.scy !== undefined) scy = s.scy & 0xff;
        if (s.wx !== undefined) wx = s.wx & 0xff;
      }
      // background
      if (lcdc.bgOn) {
        const by = (ly + scy) & 0xff;
        const rowBase = bgBase + (by >> 3) * 32, fy = by & 7;
        for (let x = 0; x < W; x++) {
          const bx = (x + scx) & 0xff;
          line[x] = this.bgPixel(bg[rowBase + (bx >> 3)], bx & 7, fy);
        }
      } else line.fill(0);
      // window
      if (lcdc.winOn && lcdc.bgOn && ly >= wy && wx <= 166) {
        const x0 = wx - 7;
        const rowBase = winBase + (winLine >> 3) * 32, fy = winLine & 7;
        for (let x = Math.max(0, x0); x < W; x++) {
          const wxp = x - x0;
          line[x] = this.bgPixel(bg[rowBase + (wxp >> 3)], wxp & 7, fy);
        }
        winLine++;
      }
      const row = ly * W;
      for (let x = 0; x < W; x++) out[row + x] = line[x];
      if (lcdc.objOn) this._sprites(ly, out, row);
    }
  }

  /** @private sprites of one scanline */
  _sprites(ly, out, row) {
    const oam = this.oam;
    const sel = [];
    for (let i = 0; i < 40 && sel.length < 10; i++) {
      const sy = oam[i].y - 16;
      if (ly >= sy && ly < sy + 8) sel.push(i);
    }
    if (!sel.length) return;
    sel.sort((a, b) => (oam[a].x - oam[b].x) || (a - b));
    const claimed = this._claimed;
    claimed.fill(0);
    const vt = this.vram.tiles;
    for (const i of sel) {
      const o = oam[i];
      const sx = o.x - 8;
      let r = ly - (o.y - 16);
      if (o.attr & OAM_YFLIP) r = 7 - r;
      const base = o.tile * 64 + r * 8;
      const flipX = (o.attr & OAM_XFLIP) !== 0;
      const tag = o.attr & OAM_PAL1 ? 8 : 4;
      const behind = (o.attr & OAM_PRIO) !== 0;
      for (let px = 0; px < 8; px++) {
        const x = sx + px;
        if (x < 0 || x >= W || claimed[x]) continue;
        const c = vt[base + (flipX ? 7 - px : px)];
        if (c === 0) continue;
        claimed[x] = 1;
        if (behind && out[row + x] !== 0) continue;
        out[row + x] = tag + c;
      }
    }
  }
}
