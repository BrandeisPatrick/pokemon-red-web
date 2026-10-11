// The Pokédex (engine/menus/pokedex.asm): the list (HandlePokedexListMenu), the DATA / CRY /
// AREA / QUIT side menu (HandlePokedexSideMenu) and the data page (ShowPokedexDataInternal).
//
// List: CONTENTS at (1,1); entry i: number (1,2+2i), ball tile $72 for owned mons at (3,3+2i),
// name or "----------" at (4,3+2i); 7 rows, cursor column 0 from row 3; up/down past the ends
// scroll one row, left/right a page of 7; the list ends at the highest seen number.
// Right column: SEEN / OWN counters, DATA CRY AREA QUIT at (16,10..16), cursor column 15.

import { MenuScene } from './base.js';
import { LEADING_ZEROES } from './format.js';
import { SPACE } from './screen.js';
import { NestMapScene } from './town_map.js';
import { drawFlippedPic } from './status_screen.js';

/** PokedexDataDividerLine. */
const DIVIDER = [0x68, 0x69, 0x6b, 0x69, 0x6b, 0x69, 0x6b, 0x69, 0x6b, 0x6b, 0x6b, 0x6b, 0x69, 0x6b, 0x69, 0x6b, 0x69, 0x6b, 0x69, 0x6a];

/** List scrolling of HandlePokedexListMenu (pure). maxSeen = wDexMaxSeenMon. */
export function dexScroll(scroll, key, maxSeen) {
  switch (key) {
    case 'up': return scroll > 0 ? scroll - 1 : scroll;
    case 'down':
      if (maxSeen < 7) return scroll;
      return scroll === maxSeen - 7 ? scroll : scroll + 1;
    case 'right': {
      if (maxSeen < 7) return scroll;
      const s = scroll + 7;
      return s < maxSeen - 6 ? s : maxSeen - 7;
    }
    case 'left': return Math.max(0, scroll - 7);
    default: return scroll;
  }
}

/** The 7 (or fewer) list rows for a scroll offset. */
export function dexRows(pokedex, scroll) {
  const max = pokedex.lastSeen;
  const n = Math.min(7, max);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const dex = scroll + i + 1;
    rows.push({ dex, seen: pokedex.isSeen(dex), owned: pokedex.isOwned(dex) });
  }
  return rows;
}

export class PokedexScene extends MenuScene {
  constructor(params = {}) {
    super({ ...params, opaque: true, vramMode: 'pokedex' });
    this.pic = null;
  }

  *main() {
    const dex = this.state.pokedex;
    this.palWhiteOut();
    this.scr.clear();
    let cursor = 0, scroll = 0;
    let setUp = true;
    for (;;) {
      if (setUp) { this.scr.clear(); this.drawStatic(); }
      setUp = false;
      // HandlePokedexListMenu
      let picked = false;
      for (;;) {
        const maxSeen = dex.lastSeen;
        this.drawList(scroll);
        yield 3;
        this.palNormal();
        const maxItem = Math.max(0, Math.min(7, maxSeen) - 1);
        const r = yield* this.menuInput({
          x: 0, y: 3, max: maxItem, current: Math.min(cursor, maxItem), last: Math.min(cursor, maxItem),
          watched: ['left', 'right', 'b', 'a'], outOfBounds: true, repeat: true,
        });
        cursor = r.index;
        if (r.keys.b) break;
        if (r.keys.up) { scroll = dexScroll(scroll, 'up', maxSeen); continue; }
        if (r.keys.down) { scroll = dexScroll(scroll, 'down', maxSeen); continue; }
        if (r.keys.right) { scroll = dexScroll(scroll, 'right', maxSeen); continue; }
        if (r.keys.left) { scroll = dexScroll(scroll, 'left', maxSeen); continue; }
        if (r.keys.a) { picked = true; break; }
      }
      if (!picked) break;
      const res = yield* this.sideMenu(scroll + cursor + 1);
      if (res === 'quit') break;
      if (res === 'shown') setUp = true;
    }
    this.palWhiteOut();
    yield 3;
    return null;
  }

  /** The parts HandlePokedexListMenu draws once. */
  drawStatic() {
    const s = this.scr;
    const dex = this.state.pokedex;
    for (let x = 15; x < 20; x++) s.put(x, 8, 0x7a); // ─
    s.put(14, 0, 0x71);
    const vline = (y0) => { let b = 0x71; for (let i = 0; i < 9; i++) { s.put(14, y0 + i, b); b ^= 1; } };
    vline(1);
    vline(9);
    s.num(16, 3, dex.seenCount, 3);
    s.num(16, 6, dex.ownedCount, 3);
    s.text(16, 2, 'SEEN');
    s.text(16, 5, 'OWN');
    s.text(1, 1, 'CONTENTS');
    s.text(16, 10, 'DATA\nCRY\nAREA\nQUIT');
  }

  drawList(scroll) {
    const s = this.scr;
    const gd = this.gd;
    s.clearArea(4, 2, 10, 14);
    dexRows(this.state.pokedex, scroll).forEach((r, i) => {
      s.num(1, 2 + 2 * i, r.dex, 3, LEADING_ZEROES);
      s.put(3, 3 + 2 * i, r.owned ? 0x72 : SPACE);
      s.text(4, 3 + 2 * i, r.seen ? gd.species(r.dex).name : '----------');
    });
  }

  /** HandlePokedexSideMenu. @returns 'list' | 'quit' | 'shown' */
  *sideMenu(dexNum) {
    const s = this.scr;
    this.hollowCursor();
    const listCursor = this.menuCursor;
    const exit = () => { for (let y = 3; y < 16; y++) s.put(0, y, SPACE); };
    if (!this.state.pokedex.isSeen(dexNum)) { exit(); return 'list'; }
    let cur = 0;
    for (;;) {
      const r = yield* this.menuInput({ x: 15, y: 10, max: 3, current: cur, last: cur });
      cur = r.index;
      if (r.keys.b) {
        for (let y = 10; y < 17; y++) s.put(15, y, SPACE);
        exit();
        this.menuCursor = listCursor;
        return 'list';
      }
      if (cur === 0) {
        yield* this.child(new PokedexDataScene({ species: dexNum, internal: true }));
        exit();
        return 'shown';
      }
      if (cur === 1) { this.cry(dexNum); continue; }
      if (cur === 2) {
        yield* this.child(new NestMapScene({ species: dexNum }));
        exit();
        return 'shown';
      }
      exit();
      return 'quit';
    }
  }
}

/**
 * ShowPokedexData(Internal): the entry page. Params: {species}. Owned species show height,
 * weight and the two text pages (▼ between them); others only name and species.
 */
export class PokedexDataScene extends MenuScene {
  constructor(params = {}) {
    super({ ...params, opaque: true, vramMode: 'pokedex' });
    this.pic = null;
  }

  *main() {
    const gd = this.gd;
    const sp = gd.species(this.params.species);
    const s = this.scr;
    this.snd.duck(true);
    this.palWhiteOut();
    s.clear();
    for (let x = 0; x < 20; x++) { s.put(x, 0, 0x64); s.put(x, 17, 0x6f); }
    for (let y = 1; y < 17; y++) { s.put(0, y, 0x66); s.put(19, y, 0x67); }
    s.put(0, 0, 0x63); s.put(19, 0, 0x65); s.put(0, 17, 0x6c); s.put(19, 17, 0x6e);
    s.bytesAt(0, 9, DIVIDER);
    s.text(9, 6, 'HT  ?′??″\nWT   ???lb');
    s.text(9, 2, sp.name);
    const entry = sp.dexEntry || {};
    s.text(9, 4, entry.species || '');
    s.put(2, 8, 0x74); // №
    s.put(3, 8, 0xf2); // <DOT>
    s.num(4, 8, sp.dex, 3, LEADING_ZEROES);
    const owned = this.state.pokedex.isOwned(sp.dex);
    yield 3;
    this.palNormal();
    this.pic = yield this.ctx.frontPic(sp.dex);
    // PlayCry: the height, weight and entry are printed after the cry
    yield* this.cryWait(sp.dex);
    if (owned) {
      s.num(12, 6, entry.heightFt | 0, 2);
      s.put(14, 6, 0x60); // ′
      s.num(15, 6, entry.heightIn | 0, 2, LEADING_ZEROES);
      s.put(17, 6, 0x61); // ″
      const w = entry.weightTenthsLb | 0;
      s.num(11, 8, w, 5);
      if (w < 10) s.text(14, 8, '0');
      const last = s.get(15, 8);
      s.put(16, 8, last);
      s.put(15, 8, 0xf2);
      yield* this.dexText(entry.pages || []);
    }
    // .waitForButtonPress
    this.flushInput();
    for (;;) {
      const k = this.poll();
      if (k.a || k.b) break;
      yield 1;
    }
    this.palWhiteOut();
    this.pic = null;
    this.snd.duck(false);
    yield 1;
    return null;
  }

  /** The entry text at (1,11): page 1, ▼ + wait (PageChar), page 2. Printed without delay. */
  *dexText(pages) {
    const s = this.scr;
    for (let p = 0; p < pages.length; p++) {
      if (p > 0) {
        s.put(18, 16, 0xee);
        yield 3;
        yield* this.waitButton();
        this.sfx('SFX_PRESS_AB');
        s.clearArea(1, 10, 18, 7);
        yield 20;
      }
      pages[p].forEach((line, i) => s.text(1, 11 + 2 * i, line));
    }
  }

  drawExtra(fb) {
    if (this.pic) drawFlippedPic(fb, this.pic, 1, 1);
  }
}
