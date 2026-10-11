// 160x144 index framebuffer (the Game Boy LCD).
//
// Pixels hold *colour indices*, never RGB:
//   0..3   background colours  -> shade = palette.bgp[index]
//   4..7   OBJ palette 0       -> shade = palette.obp0[index - 4]
//   8..11  OBJ palette 1       -> shade = palette.obp1[index - 8]
// Plain drawing (tiles, text, BG) writes 0..3. Sprites drawn with {obj: 0|1} keep their
// raw colour index plus the palette tag, so palette fades act on BG and OBJ exactly like
// rBGP / rOBP0 / rOBP1 do on the hardware.
//
// Everything here is pure except attachCanvas()/layout()/present(), which touch the DOM
// only when called (browser).

/** @typedef {import('./gfx.js').IndexedImage} IndexedImage */

export const SCREEN_WIDTH = 160;
export const SCREEN_HEIGHT = 144;
export const TILE_SIZE = 8;
export const SCREEN_TILES_X = 20;
export const SCREEN_TILES_Y = 18;

/**
 * @typedef {Object} DrawOptions
 * @property {boolean} [flipX]        mirror horizontally
 * @property {boolean} [flipY]        mirror vertically
 * @property {boolean} [transparent]  skip source colour 0 (implied by `obj`)
 * @property {0|1} [obj]              draw as a sprite with OBJ palette 0/1 (colour 0 transparent)
 * @property {ArrayLike<number>} [pal] 4-entry remap applied to the source index before storing
 * @property {boolean} [behind]       OBJ-to-BG priority: only draw where the buffer holds 0
 */

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Pack an RGB triple into a Uint32 laid out as RGBA bytes in memory. */
export function packRGBA(r, g, b, a = 255) {
  return LITTLE_ENDIAN
    ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

/**
 * Build the 16-entry pixel-value -> packed RGBA lookup for a palette-like object.
 * Accepts a Palette (anything with lut32()) or a plain array of four [r,g,b].
 * @param {any} palette
 * @returns {Uint32Array}
 */
export function paletteLUT(palette) {
  if (palette && typeof palette.lut32 === 'function') return palette.lut32();
  const lut = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    const c = palette[i & 3];
    lut[i] = packRGBA(c[0], c[1], c[2]);
  }
  return lut;
}

export class FrameBuffer {
  /**
   * @param {number} [width]
   * @param {number} [height]
   */
  constructor(width = SCREEN_WIDTH, height = SCREEN_HEIGHT) {
    this.width = width;
    this.height = height;
    /** @type {Uint8Array} colour indices, row-major */
    this.pixels = new Uint8Array(width * height);
    /** integer scale chosen by the last layout() */
    this.scale = 1;
    this._canvas = null;
    this._ctx = null;
    this._off = null;
    this._offCtx = null;
    this._image = null;
    this._u32 = null;
    this._onResize = null;
    this._viewport = null;
  }

  /** Fill the whole buffer with one index (default 0 = lightest). */
  clear(fill = 0) {
    this.pixels.fill(fill);
  }

  /** @returns {number} the stored index, or -1 outside the buffer */
  getIndex(x, y) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    return this.pixels[y * this.width + x];
  }

  /** Store an index at (x, y); ignored outside the buffer. */
  setIndex(x, y, value) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.pixels[y * this.width + x] = value;
  }

  /** Fill a clipped rectangle with an index. */
  fillRect(x, y, w, h, value) {
    const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
    const x1 = Math.min(this.width, (x + w) | 0), y1 = Math.min(this.height, (y + h) | 0);
    for (let yy = y0; yy < y1; yy++) this.pixels.fill(value, yy * this.width + x0, yy * this.width + x1);
  }

  /**
   * Draw tile `tileIndex` of an indexed image at pixel (x, y), clipped to the buffer.
   * @param {IndexedImage} gfx
   * @param {number} tileIndex
   * @param {number} x
   * @param {number} y
   * @param {DrawOptions} [opts]
   */
  drawTile(gfx, tileIndex, x, y, opts) {
    if (tileIndex < 0 || tileIndex >= gfx.tileCount) return;
    this._drawTile8(gfx.tiles, tileIndex * 64, x | 0, y | 0, opts);
  }

  /**
   * Draw a raw 8x8 tile (64 indices, row-major) at pixel (x, y).
   * @param {ArrayLike<number>} data
   * @param {number} x
   * @param {number} y
   * @param {DrawOptions} [opts]
   */
  drawTileRaw(data, x, y, opts) {
    this._drawTile8(data, 0, x | 0, y | 0, opts);
  }

  /** @private */
  _drawTile8(src, base, x, y, opts) {
    const W = this.width, H = this.height;
    const tx0 = x < 0 ? -x : 0, ty0 = y < 0 ? -y : 0;
    const tx1 = x + 8 > W ? W - x : 8, ty1 = y + 8 > H ? H - y : 8;
    if (tx0 >= tx1 || ty0 >= ty1) return;
    const px = this.pixels;
    if (!opts) {
      for (let ty = ty0; ty < ty1; ty++) {
        let di = (y + ty) * W + x + tx0, si = base + ty * 8 + tx0;
        for (let tx = tx0; tx < tx1; tx++) px[di++] = src[si++];
      }
      return;
    }
    const flipX = !!opts.flipX, flipY = !!opts.flipY;
    const obj = opts.obj === 0 || opts.obj === 1 ? opts.obj : -1;
    const transparent = obj >= 0 || !!opts.transparent;
    const behind = !!opts.behind;
    const pal = opts.pal || null;
    const tag = obj >= 0 ? 4 + obj * 4 : 0;
    for (let ty = ty0; ty < ty1; ty++) {
      const sy = flipY ? 7 - ty : ty;
      let di = (y + ty) * W + x + tx0;
      for (let tx = tx0; tx < tx1; tx++, di++) {
        let v = src[base + sy * 8 + (flipX ? 7 - tx : tx)];
        if (transparent && v === 0) continue;
        if (behind && px[di] !== 0) continue;
        if (pal) v = pal[v];
        px[di] = v + tag;
      }
    }
  }

  /**
   * Copy a w x h pixel region of an indexed image (source pixel coords) to (dx, dy).
   * Clipped against both the source image and the buffer. Flips mirror the region.
   * @param {IndexedImage} gfx
   * @param {number} sx
   * @param {number} sy
   * @param {number} w
   * @param {number} h
   * @param {number} dx
   * @param {number} dy
   * @param {DrawOptions} [opts]
   */
  blit(gfx, sx, sy, w, h, dx, dy, opts) {
    this.blitScaled(gfx, sx, sy, w, h, dx, dy, w, h, opts);
  }

  /**
   * Nearest-neighbour scaled blit of a source region (sw x sh) into a dw x dh rectangle.
   * @param {IndexedImage} gfx
   * @param {number} sx @param {number} sy @param {number} sw @param {number} sh
   * @param {number} dx @param {number} dy @param {number} dw @param {number} dh
   * @param {DrawOptions} [opts]
   */
  blitScaled(gfx, sx, sy, sw, sh, dx, dy, dw, dh, opts = {}) {
    sx |= 0; sy |= 0; sw |= 0; sh |= 0; dx |= 0; dy |= 0; dw |= 0; dh |= 0;
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
    const W = this.width, H = this.height, src = gfx.data, GW = gfx.width, GH = gfx.height;
    const flipX = !!opts.flipX, flipY = !!opts.flipY;
    const obj = opts.obj === 0 || opts.obj === 1 ? opts.obj : -1;
    const transparent = obj >= 0 || !!opts.transparent;
    const behind = !!opts.behind;
    const pal = opts.pal || null;
    const tag = obj >= 0 ? 4 + obj * 4 : 0;
    const px = this.pixels;
    const x0 = Math.max(0, -dx), y0 = Math.max(0, -dy);
    const x1 = Math.min(dw, W - dx), y1 = Math.min(dh, H - dy);
    for (let y = y0; y < y1; y++) {
      let ry = Math.floor((y * sh) / dh);
      if (flipY) ry = sh - 1 - ry;
      const syy = sy + ry;
      if (syy < 0 || syy >= GH) continue;
      let di = (dy + y) * W + dx + x0;
      for (let x = x0; x < x1; x++, di++) {
        let rx = Math.floor((x * sw) / dw);
        if (flipX) rx = sw - 1 - rx;
        const sxx = sx + rx;
        if (sxx < 0 || sxx >= GW) continue;
        let v = src[syy * GW + sxx];
        if (transparent && v === 0) continue;
        if (behind && px[di] !== 0) continue;
        if (pal) v = pal[v];
        px[di] = v + tag;
      }
    }
  }

  /** @returns {Uint8Array} a copy of the pixels (e.g. to freeze a frame behind a menu) */
  snapshot() {
    return this.pixels.slice();
  }

  /** Restore pixels saved by snapshot(). */
  restore(snap) {
    this.pixels.set(snap);
  }

  /**
   * Convert to RGBA through a palette (pure; used by present(), tests and PNG dumps).
   * @param {any} palette Palette instance or array of four [r,g,b]
   * @param {Uint8ClampedArray} [out] RGBA output (width*height*4)
   * @returns {Uint8ClampedArray}
   */
  toRGBA(palette, out) {
    const n = this.width * this.height;
    out = out || new Uint8ClampedArray(n * 4);
    const u32 = new Uint32Array(out.buffer, out.byteOffset, n);
    this._writeLUT(paletteLUT(palette), u32);
    return out;
  }

  /** @private */
  _writeLUT(lut, u32) {
    const px = this.pixels, n = px.length;
    for (let i = 0; i < n; i++) u32[i] = lut[px[i] & 15];
  }

  // ------------------------------------------------------------------ browser output

  /**
   * Attach the visible canvas. Creates a width x height offscreen canvas, sizes the visible
   * canvas to the largest integer scale that fits the viewport (in device pixels) and keeps
   * doing so on window resize.
   * @param {HTMLCanvasElement} canvas
   * @param {{getViewport?: () => {width:number,height:number}, window?: Window}} [opts]
   */
  attachCanvas(canvas, opts = {}) {
    const win = opts.window || canvas.ownerDocument.defaultView;
    this._win = win;
    this._canvas = canvas;
    this._viewport = opts.getViewport || (() => ({ width: win.innerWidth, height: win.innerHeight }));
    const doc = canvas.ownerDocument;
    this._off = doc.createElement('canvas');
    this._off.width = this.width;
    this._off.height = this.height;
    this._offCtx = this._off.getContext('2d');
    this._image = this._offCtx.createImageData(this.width, this.height);
    this._u32 = new Uint32Array(this._image.data.buffer);
    this._ctx = canvas.getContext('2d', { alpha: false });
    canvas.style.imageRendering = 'pixelated';
    this._onResize = () => this.layout();
    win.addEventListener('resize', this._onResize);
    this.layout();
  }

  /** Remove the resize listener. */
  detachCanvas() {
    if (this._win && this._onResize) this._win.removeEventListener('resize', this._onResize);
    this._canvas = this._ctx = this._off = this._offCtx = this._image = this._u32 = null;
  }

  /** Recompute the integer scale and canvas size (called automatically on resize). */
  layout() {
    if (!this._canvas) return;
    const win = this._win;
    const dpr = win.devicePixelRatio || 1;
    const vp = this._viewport();
    const availW = Math.floor(vp.width * dpr), availH = Math.floor(vp.height * dpr);
    const scale = Math.max(1, Math.floor(Math.min(availW / this.width, availH / this.height)));
    this.scale = scale;
    const c = this._canvas;
    if (c.width !== this.width * scale || c.height !== this.height * scale) {
      c.width = this.width * scale;
      c.height = this.height * scale;
    }
    c.style.width = `${(this.width * scale) / dpr}px`;
    c.style.height = `${(this.height * scale) / dpr}px`;
    this._ctx.imageSmoothingEnabled = false;
    if (this._lastPalette) this.present(this._lastPalette);
  }

  /**
   * Map indices -> RGBA through `palette`, put them on the offscreen canvas and draw it
   * scaled (nearest neighbour) onto the visible canvas.
   * @param {any} palette Palette instance or array of four [r,g,b]
   */
  present(palette) {
    if (!this._canvas) throw new Error('FrameBuffer.present: call attachCanvas(canvas) first');
    this._lastPalette = palette;
    this._writeLUT(paletteLUT(palette), this._u32);
    this._offCtx.putImageData(this._image, 0, 0);
    const ctx = this._ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this._off, 0, 0, this._canvas.width, this._canvas.height);
  }
}
