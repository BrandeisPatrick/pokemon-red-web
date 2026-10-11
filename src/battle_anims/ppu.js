// A tiny Game Boy PPU model on top of the index framebuffer, just big enough for the battle
// animations:
//
//   * WINDOW layer = the battle screen (pokered shows the battle on the window: WX = 7, WY = 0).
//     Its source is the "live" screen (host drawing + pic tile map) or a frozen snapshot.
//   * BG layer (BG map 0) behind it, 256x256 px, scrolled by SCX/SCY or a per-line SCX table
//     (wavy screen, battle intro). Blank (white) after the intro, a snapshot during
//     AnimationWavyScreen / AnimationShakeEnemyHUD.
//   * OAM: 40 sprites (8x8), DMG rules: the first 10 sprites (in OAM order) on a line are
//     drawn, the one with the smaller X wins where they overlap (then the lower OAM index),
//     colour 0 is transparent, OAM_PAL1 selects OBP1, OAM_PRIO hides it behind BG colours 1-3.
//
// Pure: no DOM. Pixels are framebuffer colour indices (0-3 BG, 4-7 OBP0, 8-11 OBP1).

import {
  SCREEN_W, SCREEN_H, OAM_COUNT, OAM_X_OFS, OAM_Y_OFS, SPRITES_PER_LINE,
  OAM_XFLIP, OAM_YFLIP, OAM_PAL1, OAM_PRIO, WX_NORMAL, WY_NORMAL,
} from './layout.js';

/** Shadow OAM (wShadowOAM): 40 entries of Y, X, tile, attributes (raw GB bytes). */
export class Oam {
  constructor() {
    this.y = new Uint8Array(OAM_COUNT);
    this.x = new Uint8Array(OAM_COUNT);
    this.tile = new Uint8Array(OAM_COUNT);
    this.attr = new Uint8Array(OAM_COUNT);
  }

  /** ClearSprites: zero all 160 bytes (Y = 0 hides an entry). */
  clear() {
    this.y.fill(0); this.x.fill(0); this.tile.fill(0); this.attr.fill(0);
  }

  /** HideSprites: Y = 160 for every entry. */
  hide() {
    this.y.fill(SCREEN_H + OAM_Y_OFS);
  }

  /** Write entry i (bytes are wrapped to 8 bits like the hardware). Writes past entry 39 are dropped. */
  set(i, y, x, tile, attr = 0) {
    if (i < 0 || i >= OAM_COUNT) return false;
    this.y[i] = y & 0xff; this.x[i] = x & 0xff; this.tile[i] = tile & 0xff; this.attr[i] = attr & 0xff;
    return true;
  }

  /** Copy n entries from index `from` to index `to` (CopyData on the shadow OAM). */
  copy(from, to, n) {
    for (let k = 0; k < n; k++) {
      const s = from + k, d = to + k;
      if (s >= OAM_COUNT || d >= OAM_COUNT) break;
      this.y[d] = this.y[s]; this.x[d] = this.x[s]; this.tile[d] = this.tile[s]; this.attr[d] = this.attr[s];
    }
  }

  /** Entries that are on screen (for tests/debugging): {i, y, x, tile, attr, sx, sy}. */
  visible() {
    const out = [];
    for (let i = 0; i < OAM_COUNT; i++) {
      const y = this.y[i], x = this.x[i];
      if (y === 0 || y >= SCREEN_H + OAM_Y_OFS || x === 0 || x >= SCREEN_W + OAM_X_OFS) continue;
      if (y <= OAM_Y_OFS - 8) continue;
      out.push({ i, y, x, tile: this.tile[i], attr: this.attr[i], sx: x - OAM_X_OFS, sy: y - OAM_Y_OFS });
    }
    return out;
  }

  /** Number of entries with any non-zero byte. */
  count() {
    let n = 0;
    for (let i = 0; i < OAM_COUNT; i++) if (this.y[i] || this.x[i] || this.tile[i] || this.attr[i]) n++;
    return n;
  }
}

/** Layer sources. */
export const LAYER_BLANK = 'blank';
export const LAYER_LIVE = 'live';
export const LAYER_SNAPSHOT = 'snapshot';

/**
 * PPU registers the animations touch, plus layer sources.
 */
export class PpuState {
  constructor() { this.reset(); }

  reset() {
    /** window position (rWX / rWY) */
    this.wx = WX_NORMAL;
    this.wy = WY_NORMAL;
    /** BG scroll (hSCX / hSCY) */
    this.scx = 0;
    this.scy = 0;
    /** optional per-line SCX (Int16Array(144) or null) - wavy screen, battle intro */
    this.lineScx = null;
    /** BG map 0 content: LAYER_BLANK | LAYER_LIVE | LAYER_SNAPSHOT (+ bgPixels) */
    this.bg = LAYER_BLANK;
    this.bgPixels = null;
    /** window content: LAYER_LIVE | LAYER_SNAPSHOT (+ winPixels); winSrcY = source line shown on window line 0 */
    this.win = LAYER_LIVE;
    this.winPixels = null;
    this.winSrcY = 0;
  }

  /** True when the PPU is in the normal battle configuration. */
  isNormal() {
    return this.wx === WX_NORMAL && this.wy === WY_NORMAL && !this.lineScx && this.win === LAYER_LIVE
      && this.winSrcY === 0;
  }
}

/**
 * Compose one frame.
 * @param {Uint8Array} out    160x144 framebuffer pixels to write
 * @param {Uint8Array} live   160x144 live screen (BG colour indices 0..3)
 * @param {PpuState} ppu
 * @param {Oam} oam
 * @param {Array<ArrayLike<number>|null>} objTiles  256 OBJ tile patterns (64 indices each) or null
 */
export function composeFrame(out, live, ppu, oam, objTiles) {
  const W = SCREEN_W, H = SCREEN_H;
  const winVisible = ppu.wy < H && ppu.wx < W + 7;
  const winX0 = ppu.wx - 7;
  const winSrc = ppu.win === LAYER_SNAPSHOT && ppu.winPixels ? ppu.winPixels : live;
  const bgSrc = ppu.bg === LAYER_LIVE ? live : (ppu.bg === LAYER_SNAPSHOT ? ppu.bgPixels : null);
  if (ppu.isNormal()) {
    out.set(live);
  } else {
    for (let y = 0; y < H; y++) {
      const row = y * W;
      const winLine = winVisible && y >= ppu.wy;
      const srcY = y - ppu.wy + ppu.winSrcY;
      const scx = ppu.lineScx ? ppu.lineScx[y] : ppu.scx;
      const by = (y + ppu.scy) & 0xff;
      for (let x = 0; x < W; x++) {
        let v = 0;
        if (winLine && x >= winX0) {
          const sx = x - winX0;
          if (srcY >= 0 && srcY < H && sx < W) v = winSrc[srcY * W + sx];
        } else if (bgSrc) {
          const bx = (x + scx) & 0xff;
          if (bx < W && by < H) v = bgSrc[by * W + bx];
        }
        out[row + x] = v;
      }
    }
  }
  drawOam(out, oam, objTiles);
}

/**
 * Draw the shadow OAM with DMG rules (10 per line in OAM order, X priority, colour 0
 * transparent, OBP0/OBP1 tags, BG priority bit).
 */
export function drawOam(out, oam, objTiles) {
  const W = SCREEN_W, H = SCREEN_H;
  const sel = new Int32Array(SPRITES_PER_LINE);
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let i = 0; i < OAM_COUNT && n < SPRITES_PER_LINE; i++) {
      const sy = oam.y[i] - OAM_Y_OFS;
      if (y >= sy && y < sy + 8) sel[n++] = i;
    }
    if (!n) continue;
    // draw lowest priority first: larger X first, then larger index
    const order = Array.from(sel.subarray(0, n)).sort((a, b) => (oam.x[b] - oam.x[a]) || (b - a));
    const row = y * W;
    for (const i of order) {
      const pat = objTiles[oam.tile[i]];
      if (!pat) continue;
      const attr = oam.attr[i];
      let ty = y - (oam.y[i] - OAM_Y_OFS);
      if (attr & OAM_YFLIP) ty = 7 - ty;
      const tag = attr & OAM_PAL1 ? 8 : 4;
      const behind = (attr & OAM_PRIO) !== 0;
      const sx0 = oam.x[i] - OAM_X_OFS;
      for (let px = 0; px < 8; px++) {
        const sx = sx0 + px;
        if (sx < 0 || sx >= W) continue;
        const c = pat[ty * 8 + ((attr & OAM_XFLIP) ? 7 - px : px)];
        if (c === 0) continue;
        if (behind && out[row + sx] < 4 && out[row + sx] !== 0) continue;
        out[row + sx] = c + tag;
      }
    }
  }
}
