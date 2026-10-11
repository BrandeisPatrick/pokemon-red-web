// A grid of tile indices drawn over the scene, like the GB's wTileMap / window layer.
// UI widgets (text box, menus) write font tile indices into a TileMap in *tile
// coordinates* exactly like pokered's `hlcoord x, y`; the scene draws it each frame.
// Cells holding EMPTY (-1) are not drawn, so whatever the scene drew underneath shows.

/** @typedef {import('./gfx.js').IndexedImage} IndexedImage */
/** @typedef {import('./framebuffer.js').FrameBuffer} FrameBuffer */

export const EMPTY = -1;

export class TileMap {
  /**
   * @param {number} [width=20]  in tiles (20 = screen width)
   * @param {number} [height=18] in tiles (18 = screen height)
   * @param {number} [fill=EMPTY]
   */
  constructor(width = 20, height = 18, fill = EMPTY) {
    this.width = width;
    this.height = height;
    this.cells = new Int16Array(width * height).fill(fill);
  }

  /** @returns {number} tile at (x, y) or EMPTY outside the map */
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return EMPTY;
    return this.cells[y * this.width + x];
  }

  /** Set one cell (ignored outside the map). */
  set(x, y, tile) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.cells[y * this.width + x] = tile;
  }

  /** Fill everything (default: clear to EMPTY). */
  fill(tile = EMPTY) {
    this.cells.fill(tile);
  }

  clear() {
    this.cells.fill(EMPTY);
  }

  /** Fill a rectangle (clipped). */
  fillRect(x, y, w, h, tile) {
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) this.cells[yy * this.width + xx] = tile;
    }
  }

  /** Clear a rectangle to EMPTY. */
  clearRect(x, y, w, h) {
    this.fillRect(x, y, w, h, EMPTY);
  }

  /** Write a run of tiles starting at (x, y), left to right. @returns {number} x after the run */
  putTiles(x, y, tiles) {
    for (const t of tiles) this.set(x++, y, t);
    return x;
  }

  /**
   * Copy whole rows: rows [srcY, srcY+count) -> [dstY, dstY+count), processed top-down
   * (correct for moving rows up, which is what the text scroll does).
   */
  copyRows(srcY, dstY, count) {
    const w = this.width;
    for (let i = 0; i < count; i++) {
      const s = srcY + i, d = dstY + i;
      if (s < 0 || d < 0 || s >= this.height || d >= this.height) continue;
      this.cells.copyWithin(d * w, s * w, s * w + w);
    }
  }

  /** @returns {{x:number,y:number,w:number,h:number,cells:Int16Array}} saved rectangle */
  save(x, y, w, h) {
    const cells = new Int16Array(w * h);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) cells[yy * w + xx] = this.get(x + xx, y + yy);
    return { x, y, w, h, cells };
  }

  /** Put back a rectangle captured with save(). */
  restore(saved) {
    const { x, y, w, h, cells } = saved;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) this.set(x + xx, y + yy, cells[yy * w + xx]);
  }

  /** Row as an array (debugging/tests). */
  row(y) {
    return Array.from(this.cells.subarray(y * this.width, (y + 1) * this.width));
  }

  /**
   * Draw every non-empty cell with `gfx` tiles at pixel offset (ox, oy).
   * @param {FrameBuffer} fb
   * @param {IndexedImage} gfx
   * @param {number} [ox=0]
   * @param {number} [oy=0]
   */
  draw(fb, gfx, ox = 0, oy = 0) {
    const { width: w, height: h, cells } = this;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = cells[y * w + x];
        if (t >= 0) fb.drawTile(gfx, t, ox + x * 8, oy + y * 8);
      }
    }
  }
}
