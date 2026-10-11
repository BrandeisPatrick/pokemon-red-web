// The Poké Mart (home/text_script.asm DisplayPokemartDialogue, engine/events/pokemart.asm
// DisplayPokemartDialogue_, engine/menus/text_box.asm DoBuySellQuitMenu / DisplayMoneyBox).
//
// "Hi there! May I help you?", the MONEY box (11,0) 9×3 ("MONEY" on its top border, ¥ at
// (12,1)), BUY / SELL / QUIT (0,0) 11×7 with the cursor at (1,1);
// BUY: "Take your time.", the priced list (prices at (11,5+2i)), the priced quantity box
// (7,9) 13×3 (×NN at (8,10), total at (12..18,10)), "<ITEM>? That will be ¥N. OK?" YES/NO,
// "Here you are! Thank you!" + SFX_PURCHASE — or "You don't have enough money." /
// "You can't carry any more items.";
// SELL: "What would you like to sell?", the bag, half price ("I can pay you ¥N for that."),
// key items / HMs "I can't put a price on that.", an empty bag "You don't have anything to
// sell."; then "Is there anything else I can do?" and finally "Thank you!".

import { MenuScene } from './base.js';
import { displayListMenu, chooseQuantity, ListMenuState, LIST_KIND, martTotal } from './list.js';
import { LEADING_ZEROES, MONEY_SIGN } from './format.js';
import { bagEntries } from './bag_menu.js';
import { isKeyItem } from '../pokemon/bag.js';

/**
 * Find a mart (data/items.json marts) by text label ('ViridianMartClerkText'), map name or
 * const ('ViridianMart' / 'VIRIDIAN_MART' -> its first mart), {map, textConst}, or take an
 * explicit item list.
 * @returns {{label:string, items:string[]}|null}
 */
export function findMart(gd, id) {
  const marts = gd.raw.items.marts;
  if (Array.isArray(id)) return { label: 'custom', items: id.map((x) => gd.item(x).const) };
  if (id && typeof id === 'object') {
    return marts.find((m) => m.usedBy.some((u) => (!id.map || u.map === id.map || gd.findMap(id.map)?.name === u.map)
      && (!id.textConst || u.textConst === id.textConst))) || null;
  }
  const byLabel = marts.find((m) => m.label === id);
  if (byLabel) return byLabel;
  const map = gd.findMap(id);
  const name = map ? map.name : id;
  return marts.find((m) => m.usedBy.some((u) => u.map === name)) || null;
}

/**
 * The buy decision after YES (pure): {ok, reason?: 'money'|'bagFull', total}.
 */
export function martBuy(state, item, qty, gd) {
  const price = gd.item(item).price || 0;
  const total = martTotal(price, qty, false);
  if (state.money < total) return { ok: false, reason: 'money', total };
  if (!state.bag.add(item, qty, gd)) return { ok: false, reason: 'bagFull', total };
  state.money -= total;
  return { ok: true, total };
}

/** The sale after YES (pure): money += half price, items removed from the slot. */
export function martSell(state, index, qty, gd) {
  const slot = state.bag.at(index);
  const total = martTotal(gd.item(slot.item).price || 0, qty, true);
  state.money = Math.min(999999, state.money + total);
  state.bag.removeAt(index, qty);
  return { ok: true, total };
}

export class MartScene extends MenuScene {
  /** @param {{mart:any}} params mart id (see findMart) */
  constructor(params = {}) {
    super({ ...params, opaque: false, vramMode: 'text' });
  }

  *main() {
    const gd = this.gd;
    const mart = findMart(gd, this.params.mart);
    if (!mart) throw new Error(`martScene: unknown mart ${JSON.stringify(this.params.mart)}`);
    this.items = mart.items;
    yield* this.print('_PokemartGreetingText');
    for (;;) {
      // .loop
      this.moneyBox();
      const choice = yield* this.buySellQuit();
      if (choice === 0) yield* this.buy();
      else if (choice === 1) yield* this.sell();
      else break;
      this.moneyBox();
      yield* this.print('_PokemartAnythingElseText');
    }
    yield* this.print('_PokemartThankYouText', { wait: true });
    this.scr.reset();
    return null;
  }

  /** DisplayMoneyBox. */
  moneyBox() {
    const s = this.scr;
    s.box(11, 0, 9, 3);
    s.text(13, 0, 'MONEY');
    s.clearArea(13, 1, 6, 1);
    s.bcd(12, 1, this.state.money, 3, LEADING_ZEROES | MONEY_SIGN);
  }

  /** DoBuySellQuitMenu. @returns 0 BUY, 1 SELL, 2 QUIT / B */
  *buySellQuit() {
    const s = this.scr;
    s.box(0, 0, 11, 7);
    s.text(2, 1, 'BUY\nSELL\nQUIT');
    const r = yield* this.menuInput({ x: 1, y: 1, max: 2, current: 0, last: 0 });
    this.hollowCursor();
    return r.keys.b ? 2 : r.index;
  }

  *buy() {
    const gd = this.gd;
    yield* this.print('_PokemartBuyingGreetingText');
    const saved = this.scr.save();
    const st = new ListMenuState(this.items.length);
    const entries = () => this.items.map((c) => {
      const it = gd.item(c);
      return { item: it.const, name: it.name, price: it.price || 0 };
    });
    for (;;) {
      // .buyMenuLoop
      this.scr.restore(saved);
      this.moneyBox();
      st.cursor = 0;
      const sel = yield* displayListMenu(this, { kind: LIST_KIND.PRICED, entries, state: st, prices: true });
      if (!sel) break;
      const qty = yield* chooseQuantity(this, 99, { priced: true, price: sel.entry.price, halve: false });
      if (qty < 0) continue;
      const total = martTotal(sel.entry.price, qty, false);
      yield* this.print('_PokemartTellBuyPriceText', { subs: { wStringBuffer: sel.entry.name, hMoney: total } });
      const yes = yield* this.yesNo();
      if (!yes) continue;
      const r = martBuy(this.state, sel.entry.item, qty, gd);
      if (!r.ok) {
        yield* this.print(r.reason === 'money' ? '_PokemartNotEnoughMoneyText' : '_PokemartItemBagFullText');
        break;
      }
      this.moneyBox();
      yield* this.sfxWait('SFX_PURCHASE');
      yield* this.print('_PokemartBoughtItemText');
    }
    // .returnToMainPokemartMenu
    this.scr.restore(saved);
  }

  *sell() {
    const gd = this.gd;
    if (!this.state.bag.length) {
      yield* this.print('_PokemartItemBagEmptyText');
      return;
    }
    yield* this.print('_PokemonSellingGreetingText');
    const saved = this.scr.save();
    const st = new ListMenuState(this.state.bag.length);
    for (;;) {
      // .sellMenuLoop
      this.scr.restore(saved);
      this.moneyBox();
      st.cursor = 0;
      const sel = yield* displayListMenu(this, {
        kind: LIST_KIND.ITEM, entries: () => bagEntries(gd, this.state.bag), state: st,
        swap: (a, b) => this.state.bag.swap(a, b),
      });
      if (!sel) break;
      if (isKeyItem(sel.entry.item, gd)) {
        yield* this.print('_PokemartUnsellableItemText');
        break;
      }
      const price = gd.item(sel.entry.item).price || 0;
      const qty = yield* chooseQuantity(this, sel.entry.qty, { priced: true, price, halve: true });
      if (qty < 0) continue;
      const total = martTotal(price, qty, true);
      yield* this.print('_PokemartTellSellPriceText', { subs: { hMoney: total } });
      const yes = yield* this.yesNo();
      if (!yes) continue;
      martSell(this.state, sel.index, qty, gd);
      this.moneyBox();
      yield* this.sfxWait('SFX_PURCHASE');
    }
    this.scr.restore(saved);
  }
}
