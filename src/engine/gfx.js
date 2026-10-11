// Indexed (2-bit, 4-shade) images.
//
// Shade convention used project-wide: 0 = lightest (white) ... 3 = darkest (black).
// pret PNGs are 1/2-bit greyscale (white 255 -> 0, 170 -> 1, 85 -> 2, black 0 -> 3) and
// the generated sheets in assets/ use the same greys (assets/font/font.png is a 2-bit
// paletted PNG whose palette index *is* the shade and whose colours are those greys).
//
// The browser only gives us RGBA after decoding, so we map colours back to shades:
//   * alpha < 128                      -> 0 (transparent == colour 0, like OBJ colour 0)
//   * otherwise luminance quantised to the 4 standard greys (3 - round(L / 85))
//   * if the image has exactly 4 opaque colours that are *not* the standard greys
//     (e.g. a DMG-green paletted PNG) they are ranked by luminance instead.
// rgbaToIndices() is pure and returns a report so the mapping can be verified
// (see inspectShades()).

/**
 * @typedef {Object} ShadeColor
 * @property {number[]} rgba   source colour
 * @property {number} lum      luminance 0..255
 * @property {number} index    shade index assigned
 * @property {number} count    number of pixels
 */
/**
 * @typedef {Object} ShadeReport
 * @property {'absolute'|'rank'} mode
 * @property {boolean} exact   every opaque colour was within ±8 of a standard grey (or rank mode)
 * @property {number[]} histogram  pixel count per shade 0..3
 * @property {ShadeColor[]} colors
 */
/**
 * @typedef {Object} IndexedImage
 * @property {string} [url]
 * @property {number} width
 * @property {number} height
 * @property {number} tilesPerRow  width / 8 (floored)
 * @property {number} tileRows     height / 8 (floored)
 * @property {number} tileCount
 * @property {Uint8Array} data     row-major shade indices 0..3 (width*height)
 * @property {Uint8Array} tiles    tile-major copy: tile i = tiles[i*64 .. i*64+63]
 * @property {(i:number) => Uint8Array} tile  view of tile i (64 entries, row-major)
 * @property {ShadeReport} [shades]
 */

export const SHADE_GREYS = Object.freeze([255, 170, 85, 0]);

/** Rec. 601 luma, 0..255. */
export function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Wrap a row-major index array as an IndexedImage (pure, usable from node tests).
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|number[]} data
 * @param {{url?: string, shades?: ShadeReport}} [extra]
 * @returns {IndexedImage}
 */
export function makeIndexedImage(width, height, data, extra = {}) {
  const pixels = data instanceof Uint8Array ? data : Uint8Array.from(data);
  if (pixels.length !== width * height) throw new Error(`makeIndexedImage: ${pixels.length} != ${width}x${height}`);
  const tilesPerRow = Math.floor(width / 8);
  const tileRows = Math.floor(height / 8);
  const tileCount = tilesPerRow * tileRows;
  const tiles = new Uint8Array(tileCount * 64);
  for (let t = 0; t < tileCount; t++) {
    const ox = (t % tilesPerRow) * 8, oy = Math.floor(t / tilesPerRow) * 8;
    for (let y = 0; y < 8; y++) {
      const row = (oy + y) * width + ox;
      for (let x = 0; x < 8; x++) tiles[t * 64 + y * 8 + x] = pixels[row + x];
    }
  }
  return {
    url: extra.url,
    width,
    height,
    tilesPerRow,
    tileRows,
    tileCount,
    data: pixels,
    tiles,
    tile(i) {
      return tiles.subarray(i * 64, i * 64 + 64);
    },
    shades: extra.shades,
  };
}

/**
 * Map decoded RGBA pixels to shade indices 0..3.
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {{mode?: 'auto'|'absolute'|'rank'}} [opts]
 * @returns {{data: Uint8Array, report: ShadeReport}}
 */
export function rgbaToIndices(rgba, width, height, opts = {}) {
  const n = width * height;
  const data = new Uint8Array(n);
  /** @type {Map<number, ShadeColor>} */
  const colors = new Map();
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = rgba[o + 3];
    const key = a < 128 ? -1 : (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
    let c = colors.get(key);
    if (!c) {
      c = { rgba: [rgba[o], rgba[o + 1], rgba[o + 2], a], lum: key < 0 ? 255 : luminance(rgba[o], rgba[o + 1], rgba[o + 2]), index: 0, count: 0, key };
      colors.set(key, c);
    }
    c.count++;
  }
  const opaque = [...colors.values()].filter((c) => c.key >= 0);
  const nearGrey = (c) => {
    const idx = Math.min(3, Math.max(0, 3 - Math.round(c.lum / 85)));
    const [r, g, b] = c.rgba;
    return Math.abs(c.lum - SHADE_GREYS[idx]) <= 8 && Math.max(r, g, b) - Math.min(r, g, b) <= 16;
  };
  let mode = opts.mode || 'auto';
  if (mode === 'auto') mode = opaque.length === 4 && !opaque.every(nearGrey) ? 'rank' : 'absolute';
  if (mode === 'rank') {
    const sorted = [...opaque].sort((p, q) => q.lum - p.lum);
    const step = sorted.length > 1 ? 3 / (sorted.length - 1) : 0;
    sorted.forEach((c, i) => { c.index = Math.round(i * step); });
  } else {
    for (const c of opaque) c.index = Math.min(3, Math.max(0, 3 - Math.round(c.lum / 85)));
  }
  const t = colors.get(-1);
  if (t) t.index = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const key = rgba[o + 3] < 128 ? -1 : (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
    data[i] = colors.get(key).index;
  }
  const histogram = [0, 0, 0, 0];
  for (const c of colors.values()) histogram[c.index] += c.count;
  const list = [...colors.values()].sort((p, q) => p.index - q.index || q.lum - p.lum)
    .map(({ rgba: c, lum, index, count }) => ({ rgba: c, lum: Math.round(lum), index, count }));
  return { data, report: { mode, exact: mode === 'rank' || opaque.every(nearGrey), histogram, colors: list } };
}

/** @returns {number[]} pixel count per shade 0..3 */
export function shadeHistogram(img) {
  const h = [0, 0, 0, 0];
  for (const v of img.data) h[v & 3]++;
  return h;
}

// ------------------------------------------------------------------ browser loading

/** @type {Map<string, Promise<IndexedImage>>} */
const cache = new Map();

/** Decode a PNG URL to RGBA without colour management (browser only). */
async function decodeRGBA(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`loadIndexed: ${url}: HTTP ${res.status}`);
  const blob = await res.blob();
  let source, width, height;
  if (typeof createImageBitmap === 'function') {
    source = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    width = source.width; height = source.height;
  } else {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`loadIndexed: cannot decode ${url}`));
      img.src = URL.createObjectURL(blob);
    });
    width = source.naturalWidth; height = source.naturalHeight;
  }
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  if (source.close) source.close();
  return { rgba: ctx.getImageData(0, 0, width, height).data, width, height };
}

/**
 * Load a PNG and convert it to shade indices. Cached by URL (the same promise is shared).
 * @param {string} url
 * @param {{mode?: 'auto'|'absolute'|'rank'}} [opts]
 * @returns {Promise<IndexedImage>}
 */
export function loadIndexed(url, opts = {}) {
  const key = opts.mode ? `${url}#${opts.mode}` : url;
  let p = cache.get(key);
  if (!p) {
    p = decodeRGBA(url).then(({ rgba, width, height }) => {
      const { data, report } = rgbaToIndices(rgba, width, height, opts);
      if (!report.exact) console.warn(`loadIndexed: ${url}: colours are not the standard greys`, report.colors);
      return makeIndexedImage(width, height, data, { url, shades: report });
    });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

/** Forget cached images (all, or one URL). */
export function clearGfxCache(url) {
  if (url === undefined) cache.clear();
  else for (const k of [...cache.keys()]) if (k === url || k.startsWith(`${url}#`)) cache.delete(k);
}

/**
 * Verification helper: decode `url` and print/return how its colours map to shades.
 * Usage from the console:  await game.gfx.inspectShades('assets/font/font.png')
 * @param {string} url
 * @returns {Promise<ShadeReport>}
 */
export async function inspectShades(url) {
  const { rgba, width, height } = await decodeRGBA(url);
  const { report } = rgbaToIndices(rgba, width, height);
  if (typeof console !== 'undefined' && console.table) {
    console.table(report.colors.map((c) => ({ rgba: c.rgba.join(','), lum: c.lum, shade: c.index, pixels: c.count })));
  }
  return report;
}
