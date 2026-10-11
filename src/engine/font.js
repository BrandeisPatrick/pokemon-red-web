// The Gen-1 font: string -> tile indices (1 character = 1 tile, 8 px advance).
//
// data/font.json (tools/extract_font.py) maps every printable character of
// constants/charmap.asm to a tile of assets/font/font.png. On page 0 of that sheet the
// tile index *is* the GB charmap byte ($80 'A' -> tile 128); battle-only glyphs (<LV>,
// <ID>, No, HP bar) live on page 1 (256 + byte).
//
// Encoding mirrors the game:
//   * `{PLAYER}`, `{RIVAL}` (and any `{KEY}`) come from a substitution map; the charmap
//     tags <PLAYER> <RIVAL> <USER> <TARGET> are accepted as aliases.
//   * `#` -> "POKé", <PKMN> -> <PK><MN>, <PC> <TM> <TRAINER> <ROCKET> <……> expand.
//   * Greedy longest match against the charmap, so "'s" "'d" "'l" "'t" "'v" "'r" "'m"
//     become their single ligature tiles exactly like rgbds' charmap does.
//   * '@' terminates the string.

import { loadIndexed } from './gfx.js';

/** @typedef {import('./gfx.js').IndexedImage} IndexedImage */
/** @typedef {import('./tilemap.js').TileMap} TileMap */
/** @typedef {import('./framebuffer.js').FrameBuffer} FrameBuffer */

/** Default names used when no substitution is given (Red's defaults). */
export const DEFAULT_SUBS = Object.freeze({ PLAYER: 'RED', RIVAL: 'BLUE' });

export class Font {
  /**
   * @param {any} json        data/font.json
   * @param {IndexedImage} gfx assets/font/font.png (shade indices)
   * @param {any} [textbox]   data/textbox.json
   */
  constructor(json, gfx, textbox = null) {
    this.json = json;
    this.gfx = gfx;
    /** text box geometry/timing/frame data (data/textbox.json) */
    this.textbox = textbox;
    /** @type {Record<string, number>} */
    this.chars = json.chars;
    this.expansions = json.expansions || {};
    this.placeholders = json.placeholders || {};
    this.space = json.space;
    this.unknown = json.unknown;
    this.cursor = json.cursor; // {right, rightHollow, down}
    this.frame = json.frame; // {topLeft, top, topRight, left, right, bottomLeft, bottom, bottomRight, fill}
    this.hpBar = json.hpBar;
    this.vram = json.vram;
    this.subs = { ...DEFAULT_SUBS };
    this._warned = new Set();
    /** first character -> keys starting with it, longest first */
    this._byFirst = new Map();
    for (const key of Object.keys(this.chars).sort((a, b) => b.length - a.length)) {
      const list = this._byFirst.get(key[0]) || [];
      list.push(key);
      this._byFirst.set(key[0], list);
    }
  }

  /**
   * Load data/font.json, data/textbox.json and the sheet.
   * @param {{json:(u:string)=>Promise<any>, image:(u:string)=>Promise<IndexedImage>}} [assets]
   * @param {{fontUrl?:string, boxUrl?:string}} [opts]
   */
  static async load(assets, { fontUrl = 'data/font.json', boxUrl = 'data/textbox.json' } = {}) {
    const getJSON = assets ? (u) => assets.json(u) : (u) => fetch(u).then((r) => {
      if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
      return r.json();
    });
    const getImage = assets ? (u) => assets.image(u) : (u) => loadIndexed(u);
    const [json, textbox] = await Promise.all([getJSON(fontUrl), getJSON(boxUrl)]);
    const gfx = await getImage(json.sheet);
    return new Font(json, gfx, textbox);
  }

  /** Tile index for one charmap key ("A", "'s", "<PK>", "▼" ...) or the '?' tile. */
  tile(key) {
    const t = this.chars[key];
    if (t !== undefined) return t;
    this._warn(`font: no glyph for ${JSON.stringify(key)}`);
    return this.unknown;
  }

  /** True if the charmap has this key. */
  has(key) {
    return this.chars[key] !== undefined;
  }

  /**
   * Apply placeholders and macro expansions; returns the string that will be encoded.
   * @param {string} str
   * @param {Record<string,string|number>} [subs]
   */
  expand(str, subs) {
    const s = String(str);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '@') break;
      if (c === '#') { out += this.expansions['#'] || 'POKé'; continue; }
      if (c === '{') {
        const j = s.indexOf('}', i + 1);
        if (j > i) {
          out += this._sub(s.slice(i + 1, j), subs);
          i = j;
          continue;
        }
      }
      if (c === '<') {
        const j = s.indexOf('>', i + 1);
        if (j > i) {
          const tag = s.slice(i, j + 1);
          if (this.placeholders[tag]) {
            out += this._sub(this.placeholders[tag].slice(1, -1), subs);
            i = j;
            continue;
          }
          if (this.expansions[tag] !== undefined) {
            out += this.expansions[tag];
            i = j;
            continue;
          }
        }
      }
      out += c;
    }
    return out;
  }

  /** @private */
  _sub(key, subs) {
    if (subs && subs[key] !== undefined) return String(subs[key]);
    if (this.subs[key] !== undefined) return String(this.subs[key]);
    this._warn(`font: no substitution for {${key}}`);
    return key;
  }

  /**
   * Encode a string to tile indices (after expand()).
   * @param {string} str
   * @param {Record<string,string|number>} [subs]
   * @returns {number[]}
   */
  encode(str, subs) {
    return this.tokenize(this.expand(str, subs)).map((k) => this.tile(k));
  }

  /**
   * Split an already-expanded string into charmap keys (greedy longest match).
   * Characters with no glyph are returned as-is (they encode to '?').
   * @param {string} s
   * @returns {string[]}
   */
  tokenize(s) {
    const out = [];
    for (let i = 0; i < s.length;) {
      if (s[i] === '@') break;
      const cands = this._byFirst.get(s[i]);
      let hit = null;
      if (cands) for (const k of cands) if (s.startsWith(k, i)) { hit = k; break; }
      if (hit) { out.push(hit); i += hit.length; }
      else { out.push(s[i]); i++; }
    }
    return out;
  }

  /** Width in tiles of the encoded string. */
  measure(str, subs) {
    return this.tokenize(this.expand(str, subs)).length;
  }

  /**
   * Write a string into a TileMap at tile (tx, ty). '\n' moves to the next line
   * `lineStep` rows down (default 2, like <NEXT>). @returns {number} x after the text
   * @param {TileMap} map
   */
  putText(map, str, tx, ty, { subs, lineStep = 2 } = {}) {
    let x = tx, y = ty;
    for (const line of String(str).split('\n')) {
      x = map.putTiles(tx, y, this.encode(line, subs));
      y += lineStep;
    }
    return x;
  }

  /**
   * Draw a string straight into the framebuffer at pixel (x, y).
   * @param {FrameBuffer} fb
   */
  drawText(fb, str, x, y, { subs, lineStep = 2, transparent = false } = {}) {
    let cy = y;
    const opts = transparent ? { transparent: true } : undefined;
    for (const line of String(str).split('\n')) {
      let cx = x;
      for (const t of this.encode(line, subs)) {
        fb.drawTile(this.gfx, t, cx, cy, opts);
        cx += 8;
      }
      cy += lineStep * 8;
    }
  }

  /**
   * TextBoxBorder: draw a w x h (outer size, in tiles) bordered box with a blank inside.
   * @param {TileMap} map
   */
  drawBox(map, x, y, w, h) {
    const f = this.frame;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const top = yy === 0, bottom = yy === h - 1, left = xx === 0, right = xx === w - 1;
        let t = f.fill;
        if (top) t = left ? f.topLeft : right ? f.topRight : f.top;
        else if (bottom) t = left ? f.bottomLeft : right ? f.bottomRight : f.bottom;
        else if (left) t = f.left;
        else if (right) t = f.right;
        map.set(x + xx, y + yy, t);
      }
    }
  }

  /** @private */
  _warn(msg) {
    if (this._warned.has(msg)) return;
    this._warned.add(msg);
    console.warn(msg);
  }
}
