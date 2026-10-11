// Asset loader: fetches JSON and PNG (as indexed images) with progress reporting.
// Every URL is loaded once; later requests share the same promise.

import { loadIndexed } from './gfx.js';

/** @typedef {import('./gfx.js').IndexedImage} IndexedImage */
/** @typedef {string | {url: string, type?: 'json'|'image'|'text', key?: string}} AssetSpec */

export class Assets {
  /**
   * @param {object} [o]
   * @param {string} [o.base='']  prefix for relative URLs
   * @param {typeof fetch} [o.fetch]
   * @param {(url:string) => Promise<IndexedImage>} [o.loadImage]
   */
  constructor({ base = '', fetch: fetchFn, loadImage = loadIndexed } = {}) {
    this.base = base;
    this._fetch = fetchFn || ((...a) => globalThis.fetch(...a));
    this._loadImage = loadImage;
    /** @type {Map<string, Promise<any>>} */
    this._promises = new Map();
    /** @type {Map<string, any>} */
    this.loaded = new Map();
  }

  /** @private */
  _url(url) {
    return this.base && !/^([a-z]+:)?\/\//i.test(url) && !url.startsWith('/') ? this.base + url : url;
  }

  /** @private */
  _get(url, type) {
    let p = this._promises.get(url);
    if (!p) {
      const full = this._url(url);
      if (type === 'image') p = this._loadImage(full);
      else {
        p = this._fetch(full).then((r) => {
          if (!r.ok) throw new Error(`Assets: ${full}: HTTP ${r.status}`);
          return type === 'text' ? r.text() : r.json();
        });
      }
      p = p.then((v) => { this.loaded.set(url, v); return v; });
      p.catch(() => this._promises.delete(url));
      this._promises.set(url, p);
    }
    return p;
  }

  /** @returns {Promise<any>} parsed JSON */
  json(url) { return this._get(url, 'json'); }
  /** @returns {Promise<IndexedImage>} */
  image(url) { return this._get(url, 'image'); }
  /** @returns {Promise<string>} */
  text(url) { return this._get(url, 'text'); }

  /** Already-loaded asset (or undefined). */
  get(url) { return this.loaded.get(url); }
  has(url) { return this.loaded.has(url); }

  /**
   * Load a list of assets in parallel.
   * @param {AssetSpec[]} list
   * @param {(done:number, total:number, url:string) => void} [onProgress]
   * @returns {Promise<Record<string, any>>} keyed by spec.key or url
   */
  async load(list, onProgress) {
    const specs = list.map((s) => (typeof s === 'string' ? { url: s } : s));
    let done = 0;
    const total = specs.length;
    if (onProgress) onProgress(0, total, '');
    const results = await Promise.all(specs.map(async (s) => {
      const type = s.type || (/\.png$/i.test(s.url) ? 'image' : /\.json$/i.test(s.url) ? 'json' : 'text');
      const v = await this._get(s.url, type);
      done++;
      if (onProgress) onProgress(done, total, s.url);
      return [s.key || s.url, v];
    }));
    return Object.fromEntries(results);
  }
}
