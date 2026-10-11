// Animated BG tiles (UpdateMovingBgTiles, home/vcopy.asm; LoadSpinnerArrowTiles,
// engine/overworld/spinners.asm; docs/data-format-maps.md §12.5). Pure: works on an
// IndexedImage copy of the tileset sheet (tile-major `tiles` array, 64 shade indices per tile).

import { makeIndexedImage } from '../engine/gfx.js';
import { TILE } from './constants.js';

/** Make a private, writable copy of a tileset sheet (VRAM gets reloaded on every map load). */
export function cloneTilesetImage(img) {
  return makeIndexedImage(img.width, img.height, img.data.slice(), { url: img.url });
}

/** Rotate every pixel row of a tile horizontally by one pixel (rrca / rlca of both planes). */
export function rotateTileRows(tiles, tileIndex, right) {
  const base = tileIndex * 64;
  for (let y = 0; y < 8; y++) {
    const o = base + y * 8;
    if (right) {
      const last = tiles[o + 7];
      for (let x = 7; x > 0; x--) tiles[o + x] = tiles[o + x - 1];
      tiles[o] = last;
    } else {
      const first = tiles[o];
      for (let x = 0; x < 7; x++) tiles[o + x] = tiles[o + x + 1];
      tiles[o + 7] = first;
    }
  }
}

/** Copy one 8x8 tile from an IndexedImage into tile slot `dest` of `tiles`. */
export function copyTile(tiles, dest, srcImg, srcTile) {
  tiles.set(srcImg.tiles.subarray(srcTile * 64, srcTile * 64 + 64), dest * 64);
}

/**
 * The per-frame tile animator. c1 is reset by LoadTilesetHeader (every map header load,
 * connections included); c2 (wMovingBGTilesCounter2) is never reset.
 */
export class TileAnimator {
  constructor() {
    this.c1 = 0;
    this.c2 = 0;
    /** 0 none, 1 water, 2 water + flower (hTileAnimations) */
    this.mode = 0;
    this.image = null;
    this.flowers = null;
  }

  /**
   * New map header (LoadTilesetHeader): set the animation type and reset c1.
   * @param {number} animationId tileset.animationId
   * @param {any} image the map's writable tileset image (or null to keep the current one)
   * @param {any[]} flowers flower1..3 IndexedImages
   */
  reset(animationId, image, flowers) {
    this.mode = animationId | 0;
    this.c1 = 0;
    if (image) this.image = image;
    if (flowers) this.flowers = flowers;
  }

  /** One V-blank. @returns {boolean} true if a tile changed */
  tick() {
    if (!this.mode || !this.image) return false;
    this.c1++;
    if (this.c1 < 20) return false;
    if (this.c1 === 21) {
      // flower: tile $03 <- flower1 if (c2 & 3) < 2, flower2 if == 2, flower3 if == 3
      this.c1 = 0;
      const k = this.c2 & 3;
      const f = this.flowers && this.flowers[k < 2 ? 0 : k === 2 ? 1 : 2];
      if (f) copyTile(this.image.tiles, 3, f, 0);
      return true;
    }
    // c1 == 20: water
    this.c2 = (this.c2 + 1) & 7;
    rotateTileRows(this.image.tiles, TILE.WATER, (this.c2 & 4) === 0);
    if (this.mode & 1) this.c1 = 0; // TILEANIM_WATER: period 20; WATER_FLOWER: flower next frame
    return true;
  }
}

/**
 * LoadSpinnerArrowTiles: overwrite the tileset's arrow tiles with either the spinner
 * animation tiles (odd number of simulated steps left) or the tileset's own tiles (even).
 * @param {any} image writable tileset image
 * @param {any} original pristine tileset image
 * @param {any} spinners assets/overworld/spinners.png (4 tiles)
 * @param {any[]} entries tileset.spinnerArrows (first 4: spinner tiles, last 4: own tiles)
 * @param {number} remaining wSimulatedJoypadStatesIndex
 */
export function loadSpinnerArrowTiles(image, original, spinners, entries, remaining) {
  if (!entries || entries.length < 8) return;
  const half = remaining & 1 ? entries.slice(0, 4) : entries.slice(4, 8);
  for (const e of half) {
    const src = e.source === 'SpinnerArrowAnimTiles' ? spinners : original;
    if (src) copyTile(image.tiles, e.destTile, src, e.sourceTile);
  }
}
