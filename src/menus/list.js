// The scrolling list menu (home/list_menu.asm DisplayListMenuID / PrintListMenuEntries),
// SELECT item swapping (engine/menus/swap_items.asm) and the quantity picker
// (DisplayChooseQuantityMenu). The state machines are pure (ListMenuState, QuantityState) and
// unit tested; displayListMenu / chooseQuantity are the coroutines that draw them.
//
// Geometry (LIST_MENU_BOX): box (4,2)-(19,12); four entries, names at (6,4+2i); the cursor
// moves over the first three rows only (wMaxMenuItem 2) — pressing down on the third row
// scrolls the list (wMenuWatchMovingOutOfBounds); CANCEL ends the list; a ▼ at (18,11) when
// four real entries are shown; item quantities "×NN" at (14,5+2i), prices at (11,5+2i),
// Pokémon levels at (14,5+2i).

import { SPACE, CURSOR_HOLLOW, DOWN_ARROW } from './screen.js';
import { LEADING_ZEROES, MONEY_SIGN, printNumber } from './format.js';

export const LIST_KIND = Object.freeze({ POKEMON: 0, ITEM: 1, PRICED: 2, MOVES: 3 });

/** Cursor + scroll state of a list of `count` entries followed by CANCEL. */
export class ListMenuState {
  /**
   * @param {number} count number of entries (wListCount), CANCEL is entry `count`
   * @param {{cursor?:number, scroll?:number}} [o]
   */
  constructor(count, { cursor = 0, scroll = 0 } = {}) {
    this.count = count;
    this.cursor = cursor;
    this.scroll = scroll;
    this.clamp();
  }

  /** wMaxMenuItem: 1 when the list has fewer than 2 entries, else 2. */
  get maxItem() { return this.count < 2 ? 1 : 2; }

  /** Keep cursor/scroll valid after the list changed (items removed, merged). */
  clamp() {
    const maxScroll = Math.max(0, this.count - 2);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    if (this.scroll < 0) this.scroll = 0;
    if (this.cursor > this.maxItem) this.cursor = this.maxItem;
    if (this.cursor < 0) this.cursor = 0;
    return this;
  }

  /** Change the entry count (the list changed). */
  setCount(n) {
    this.count = n;
    return this.clamp();
  }

  /** Index of the entry under the cursor (== count for CANCEL). */
  get selected() { return this.scroll + this.cursor; }

  /** Is the cursor on CANCEL (or past the end, or the list is empty)? */
  get onCancel() { return this.count === 0 || this.selected >= this.count; }

  /** Down pressed on the last cursor row: scroll if scroll + 3 <= count. @returns {boolean} */
  scrollDown() {
    if (this.scroll + 3 <= this.count) {
      this.scroll++;
      return true;
    }
    return false;
  }

  /** Up pressed on the first cursor row. @returns {boolean} */
  scrollUp() {
    if (this.scroll > 0) {
      this.scroll--;
      return true;
    }
    return false;
  }

  /**
   * Rows shown (PrintListMenuEntries): up to 4 entries from `scroll`; CANCEL ends the list.
   * @returns {{rows: Array<{index:number, cancel:boolean}>, arrow:boolean}}
   */
  visible() {
    const rows = [];
    for (let i = 0; i < 4; i++) {
      const idx = this.scroll + i;
      if (idx >= this.count) {
        rows.push({ index: idx, cancel: true });
        return { rows, arrow: false };
      }
      rows.push({ index: idx, cancel: false });
    }
    return { rows, arrow: true };
  }
}

/** DisplayChooseQuantityMenu state: 1..max with wrap-around, optional total price. */
export class QuantityState {
  /**
   * @param {number} max wMaxItemQuantity
   * @param {{price?:number, halve?:boolean}} [o] unit price (hItemPrice) and hHalveItemPrices
   */
  constructor(max, { price = 0, halve = false } = {}) {
    this.max = Math.max(1, max | 0);
    this.qty = 1;
    this.price = price;
    this.halve = halve;
  }

  /** Up: +1, wrapping to 1 above the max. */
  up() {
    this.qty = this.qty + 1 > this.max ? 1 : this.qty + 1;
    return this.qty;
  }

  /** Down: -1, wrapping to the max below 1. */
  down() {
    this.qty = this.qty - 1 < 1 ? this.max : this.qty - 1;
    return this.qty;
  }

  /** hMoney: price added qty times (BCD, 6 digits), halved when selling. */
  total() {
    const t = (this.price * this.qty) % 1000000;
    return this.halve ? Math.floor(t / 2) : t;
  }
}

/** Total paid / received for a mart transaction (same math as QuantityState.total). */
export function martTotal(price, qty, sell = false) {
  const q = new QuantityState(99, { price, halve: sell });
  q.qty = qty;
  return q.total();
}

/**
 * PrintListMenuEntries.
 * @param {import('./base.js').MenuScene} s
 * @param {object} cfg see displayListMenu
 * @param {ListMenuState} st
 * @param {number} swapMarker wMenuItemToSwap (1-based, 0 = none)
 */
export function printListEntries(s, cfg, st, swapMarker = 0) {
  const scr = s.scr;
  scr.clearArea(5, 3, 14, 9);
  const entries = cfg.entries();
  const { rows, arrow } = st.visible();
  rows.forEach((r, i) => {
    const y = 4 + 2 * i;
    if (r.cancel) {
      scr.text(6, y, 'CANCEL');
      return;
    }
    const e = entries[r.index];
    scr.text(6, y, e.name);
    if (cfg.kind === LIST_KIND.PRICED || cfg.prices) scr.bcd(11, y + 1, e.price || 0, 3, LEADING_ZEROES | MONEY_SIGN);
    if (cfg.kind === LIST_KIND.POKEMON) scr.level(14, y + 1, e.level);
    if (cfg.kind === LIST_KIND.ITEM && !e.keyItem) {
      scr.put(14, y + 1, 0xf1); // ×
      scr.text(15, y + 1, printNumber(e.qty, 2));
    }
    if (cfg.kind === LIST_KIND.ITEM && swapMarker && swapMarker === r.index + 1) scr.put(5, y, CURSOR_HOLLOW);
  });
  if (arrow) scr.put(18, 11, DOWN_ARROW);
}

/**
 * DisplayListMenuID as a coroutine.
 * @param {import('./base.js').MenuScene} s
 * @param {object} cfg
 * @param {number} cfg.kind LIST_KIND
 * @param {() => Array<{name:string, qty?:number, keyItem?:boolean, price?:number, level?:number}>} cfg.entries
 * @param {ListMenuState} cfg.state persistent cursor/scroll (wCurrentMenuItem, wListScrollOffset)
 * @param {(first:number, second:number) => void} [cfg.swap] SELECT swap for item lists
 * @param {boolean} [cfg.prices] wPrintItemPrices
 * @param {boolean} [cfg.drawBox=true]
 * @param {boolean} [cfg.oldMan] the Old Man battle: picks the first entry automatically
 * @param {boolean} [cfg.silent] BIT_NO_MENU_BUTTON_SOUND (no blip on A/B)
 * @returns {Generator<any, {index:number, entry:any}|null>} null = cancelled (B or CANCEL)
 */
export function* displayListMenu(s, cfg) {
  const scr = s.scr;
  const st = cfg.state;
  // the box and the entries are drawn with hAutoBGTransferEnabled = 0: the old screen stays
  // up for the 10 frames, then box + entries appear together
  if (typeof s.freezeBg === 'function') s.freezeBg();
  st.setCount(cfg.entries().length);
  if (cfg.drawBox !== false) scr.box(4, 2, 16, 11);
  yield 10;
  let swapMarker = 0;
  for (;;) {
    st.setCount(cfg.entries().length);
    printListEntries(s, cfg, st, swapMarker);
    if (typeof s.thawBg === 'function') s.thawBg();
    yield 3;
    if (cfg.oldMan) {
      scr.put(5, 4, 0xed);
      yield 80;
      st.cursor = 0;
      s.menuCursor = { x: 5, y: 4 };
      break;
    }
    const r = yield* s.menuInput({
      x: 5, y: 4, max: st.maxItem, current: st.cursor, last: st.cursor,
      watched: ['a', 'b', 'select'], outOfBounds: true, repeat: true, blink: { x: 18, y: 11 },
      sound: !cfg.silent,
    });
    st.cursor = r.index;
    if (r.keys.a) break;
    if (r.keys.b) return null;
    if (r.keys.select) {
      if (cfg.kind !== LIST_KIND.ITEM || !cfg.swap) continue;
      const sel = st.selected;
      if (sel >= st.count) continue; // can't swap CANCEL
      if (!swapMarker) {
        swapMarker = sel + 1;
        yield 20;
        continue;
      }
      if (swapMarker === sel + 1) continue;
      yield 20;
      const before = cfg.entries().length;
      cfg.swap(swapMarker - 1, sel);
      swapMarker = 0;
      if (cfg.entries().length !== before) {
        // merged into one slot: back to the top of the list
        st.scroll = 0;
        st.cursor = 0;
      }
      continue;
    }
    if (r.outOfBounds && r.keys.down) st.scrollDown();
    else if (r.outOfBounds && r.keys.up) st.scrollUp();
  }
  // A pressed
  s.hollowCursor();
  if (st.onCancel) return null;
  const entries = cfg.entries();
  return { index: st.selected, entry: entries[st.selected] };
}

/**
 * DisplayChooseQuantityMenu. @returns {Generator<any, number>} quantity, or -1 on B
 * @param {import('./base.js').MenuScene} s
 * @param {number} max wMaxItemQuantity
 * @param {{priced?:boolean, price?:number, halve?:boolean}} [o]
 */
export function* chooseQuantity(s, max, o = {}) {
  const scr = s.scr;
  const priced = !!o.priced;
  const q = new QuantityState(max, { price: o.price || 0, halve: !!o.halve });
  if (priced) scr.box(7, 9, 13, 3);
  else scr.box(15, 9, 5, 3);
  scr.text(priced ? 8 : 16, 10, '×01');
  const show = () => {
    if (priced) {
      scr.clearArea(12, 10, 6, 1);
      scr.bcd(12, 10, q.total(), 3, LEADING_ZEROES | MONEY_SIGN);
      scr.num(9, 10, q.qty, 2, LEADING_ZEROES);
    } else {
      scr.num(17, 10, q.qty, 2, LEADING_ZEROES);
    }
  };
  show();
  s.flushInput();
  for (;;) {
    yield 1;
    const k = s.poll();
    if (k.a) return q.qty;
    if (k.b) return -1;
    if (k.up) { q.up(); show(); } else if (k.down) { q.down(); show(); }
  }
}

export { SPACE };
