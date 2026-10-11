// Bordered vertical menus with the ▶ cursor (home/window.asm HandleMenuInput /
// PlaceMenuCursor) and the YES/NO two-option menu (engine/menus/text_box.asm).
//
// Geometry is in tiles. A menu box at (x, y) of outer size w x h draws items at
// (x + 2, y + top + i*spacing) and the cursor one column left of them, like the start
// menu / main menu (top = 2: blank row before the first item) or the YES/NO box (top = 1).
//
// run() is a coroutine returning the chosen index (or -1 when cancelled with B); open()
// wraps it in a promise via a coroutine runner (a Scene, or anything with run(gen)).

/** @typedef {import('./font.js').Font} Font */
/** @typedef {import('./tilemap.js').TileMap} TileMap */

export class Menu {
  /**
   * @param {object} o
   * @param {Font} o.font
   * @param {TileMap} o.map
   * @param {{pressed:any, held:any, repeat?:Function}} o.input
   * @param {{play:(n:string)=>void}} [o.sfx]
   * @param {string[]} o.items
   * @param {number} [o.x=0]          box left (tiles)
   * @param {number} [o.y=0]          box top (tiles)
   * @param {number} [o.width]        outer width; default fits the longest item
   * @param {number} [o.height]       outer height; default fits the items
   * @param {number} [o.top=2]        row of the first item inside the box
   * @param {number} [o.spacing=2]    rows between items (2 = GB default double spacing)
   * @param {number} [o.textX=2]      item column relative to the box
   * @param {number} [o.cursorX=1]    cursor column relative to the box
   * @param {number} [o.initial=0]
   * @param {boolean} [o.wrap=true]   wrap around top/bottom
   * @param {boolean} [o.cancelable=true]  B returns -1
   * @param {boolean} [o.startCancels=false] START also returns -1 (start menu)
   * @param {boolean} [o.repeat=false] auto-repeat held D-pad (list menus)
   * @param {boolean} [o.restore=true] put back the tiles under the box on close()
   * @param {number} [o.exitDelay=0]  frames to wait after a choice
   * @param {Record<string,string|number>} [o.subs]
   */
  constructor(o) {
    this.font = o.font;
    this.map = o.map;
    this.input = o.input;
    this.sfx = o.sfx || null;
    this.items = o.items.slice();
    this.x = o.x ?? 0;
    this.y = o.y ?? 0;
    this.top = o.top ?? 2;
    this.spacing = o.spacing ?? 2;
    this.textX = o.textX ?? 2;
    this.cursorX = o.cursorX ?? 1;
    this.subs = o.subs;
    const longest = Math.max(0, ...this.items.map((s) => this.font.measure(s, this.subs)));
    this.width = o.width ?? this.textX + longest + 1;
    this.height = o.height ?? this.top + (this.items.length - 1) * this.spacing + 2;
    this.index = Math.min(Math.max(0, o.initial ?? 0), Math.max(0, this.items.length - 1));
    this.wrap = o.wrap ?? true;
    this.cancelable = o.cancelable ?? true;
    this.startCancels = o.startCancels ?? false;
    this.repeat = o.repeat ?? false;
    this.restoreOnClose = o.restore ?? true;
    this.exitDelay = o.exitDelay ?? 0;
    this.isOpen = false;
    this._saved = null;
  }

  /** Draw the box, the items and the cursor (saving what was underneath). */
  draw() {
    if (!this.isOpen && this.restoreOnClose) this._saved = this.map.save(this.x, this.y, this.width, this.height);
    this.isOpen = true;
    this.font.drawBox(this.map, this.x, this.y, this.width, this.height);
    this.items.forEach((label, i) => {
      this.font.putText(this.map, label, this.x + this.textX, this.itemY(i), { subs: this.subs });
    });
    this.placeCursor();
  }

  /** Tile row of item i. */
  itemY(i) {
    return this.y + this.top + i * this.spacing;
  }

  /** Erase all cursors and draw ▶ (or ▷ when `hollow`) at the current item. */
  placeCursor(hollow = false) {
    const cx = this.x + this.cursorX;
    for (let i = 0; i < this.items.length; i++) this.map.set(cx, this.itemY(i), this.font.space);
    this.map.set(cx, this.itemY(this.index), hollow ? this.font.cursor.rightHollow : this.font.cursor.right);
  }

  /** Remove the menu, restoring the tiles that were under it. */
  close() {
    if (!this.isOpen) return;
    if (this._saved) this.map.restore(this._saved);
    else this.map.clearRect(this.x, this.y, this.width, this.height);
    this._saved = null;
    this.isOpen = false;
  }

  /** Move the cursor by delta (with wrap-around if enabled). @returns {boolean} moved */
  move(delta) {
    const n = this.items.length;
    let i = this.index + delta;
    if (i < 0) i = this.wrap ? n - 1 : 0;
    else if (i >= n) i = this.wrap ? 0 : n - 1;
    if (i === this.index) return false;
    this.index = i;
    this.placeCursor();
    return true;
  }

  /**
   * Coroutine: let the player pick. Returns the chosen index, or -1 if cancelled.
   * Leaves the menu drawn (call close() or use `{close: true}`).
   * @param {{close?: boolean}} [opts]
   */
  *run(opts = {}) {
    this.draw();
    const input = this.input;
    let result;
    for (;;) {
      yield 1;
      const p = input.pressed;
      const up = this.repeat && input.repeat ? input.repeat('up') : p.up;
      const down = this.repeat && input.repeat ? input.repeat('down') : p.down;
      if (up) this.move(-1);
      else if (down) this.move(1);
      if (p.a) { this._blip(); result = this.index; break; }
      if (p.b && this.cancelable) { this._blip(); result = -1; break; }
      if (p.start && this.startCancels) { result = -1; break; }
    }
    if (this.exitDelay > 0) yield this.exitDelay;
    if (opts.close) this.close();
    return result;
  }

  /**
   * Promise interface: runner is a Scene (or Tasks) providing run(generator).
   * @param {{run:(gen:Iterator<any>) => PromiseLike<any>}} runner
   * @param {{close?: boolean}} [opts]
   * @returns {Promise<number>}
   */
  open(runner, opts = {}) {
    return Promise.resolve(runner.run(this.run(opts)));
  }

  /** @private */
  _blip() {
    if (this.sfx) this.sfx.play('press');
  }
}

/**
 * The YES/NO box (home/yes_no.asm): 6x5 tiles at (14,7) by default, items two rows apart,
 * B picks the second option, a 15-frame pause after the choice, tiles underneath restored.
 * run() returns true for the first option (YES).
 */
export class YesNoMenu extends Menu {
  /**
   * @param {object} o
   * @param {Font} o.font
   * @param {TileMap} o.map
   * @param {any} o.input
   * @param {any} [o.sfx]
   * @param {number} [o.x=14]
   * @param {number} [o.y=7]
   * @param {[string,string]} [o.labels=['YES','NO']]
   * @param {boolean} [o.defaultNo=false] start on the second option
   */
  constructor({ font, map, input, sfx, x, y, labels = ['YES', 'NO'], defaultNo = false }) {
    const yn = font.textbox && font.textbox.yesNo;
    const two = font.textbox && font.textbox.twoOptionMenus && font.textbox.twoOptionMenus.YES_NO_MENU;
    super({
      font, map, input, sfx,
      items: labels,
      x: x ?? (yn ? yn.x : 14),
      y: y ?? (yn ? yn.y : 7),
      width: Math.max(two ? two.w : 6, 3 + Math.max(...labels.map((l) => font.measure(l)))),
      height: two ? two.h : 5,
      top: 1,
      spacing: 2,
      initial: defaultNo ? 1 : 0,
      wrap: false,
      cancelable: true,
      exitDelay: 15,
    });
  }

  /** Coroutine: true = first option (YES), false = second (NO, also on B). Closes itself. */
  *run() {
    const i = yield* super.run({});
    this.close();
    return i === 0;
  }
}
