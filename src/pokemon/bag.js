// Bag (20 slots) and PC item storage (50 slots), money and Game Corner coins.
//
// Items are referenced by their const ("POTION", "TM_MEGA_PUNCH", "HM_CUT"). Gen 1 keeps key
// items, TMs and HMs in the same list. A slot holds at most 99; AddItemToInventory_
// (engine/items/inventory.asm) tops the first matching slot up to 99 and spills the rest into a
// new slot, so the same item can occupy two slots. Money is 3-byte BCD (0-999999, AddBCD clamps
// at 999999, SubBCD at 0), coins 2-byte BCD (0-9999).

import { getGameData } from './data.js';

export const BAG_ITEM_CAPACITY = 20;
export const PC_ITEM_CAPACITY = 50;
export const MAX_ITEM_QUANTITY = 99;
export const MAX_MONEY = 999999;
export const MAX_COINS = 9999;

/** @typedef {{item:string, qty:number}} ItemSlot */

function itemConst(item, gd) {
  return gd.item(item).const;
}

/**
 * IsKeyItem_: key items (data/items/key_items.asm) and HMs; TMs are NOT key items (they can be
 * tossed and sold).
 */
export function isKeyItem(item, gd = getGameData()) {
  const it = gd.item(item);
  if (it.hm) return true;
  if (it.tm) return false;
  return !!it.keyItem;
}

/** Key items and HMs can't be tossed (TossItem_: "That's too important to toss!"). */
export function canToss(item, gd = getGameData()) {
  return !isKeyItem(item, gd);
}

/** Mart sell price (half the price; 0 = can't be sold: key items, HMs, price-0 items). */
export function sellPrice(item, gd = getGameData()) {
  const it = gd.item(item);
  if (isKeyItem(item, gd)) return 0;
  return Math.floor((it.price || 0) / 2);
}

export class Bag {
  /**
   * @param {{capacity?:number, items?:ItemSlot[]}} [o]
   */
  constructor({ capacity = BAG_ITEM_CAPACITY, items = [] } = {}) {
    this.capacity = capacity;
    /** @type {ItemSlot[]} in display order */
    this.items = items.map((s) => ({ item: s.item, qty: s.qty }));
  }

  get length() { return this.items.length; }
  get isFull() { return this.items.length >= this.capacity; }

  /** Slot at index (or undefined). */
  at(index) { return this.items[index]; }

  /** Total quantity of an item over all its slots. */
  count(item, gd = getGameData()) {
    const c = itemConst(item, gd);
    return this.items.reduce((n, s) => n + (s.item === c ? s.qty : 0), 0);
  }

  /** @returns {boolean} at least `qty` of the item */
  has(item, qty = 1, gd = getGameData()) {
    return this.count(item, gd) >= qty;
  }

  /** Index of the first slot holding the item, or -1. */
  indexOf(item, gd = getGameData()) {
    const c = itemConst(item, gd);
    return this.items.findIndex((s) => s.item === c);
  }

  /**
   * AddItemToInventory_: add `qty` (1-99) of an item.
   * - not present: needs a free slot;
   * - present: if the sum is < 100 it is stored; otherwise, if a free slot exists, the first
   *   slot becomes 99 and the remainder continues into the next slot of that item or a new slot;
   *   with no free slot nothing changes and it fails.
   * @returns {boolean} success
   */
  add(item, qty = 1, gd = getGameData()) {
    const c = itemConst(item, gd);
    qty |= 0;
    if (qty <= 0 || qty > MAX_ITEM_QUANTITY) throw new RangeError(`Bag.add: quantity ${qty}`);
    const free = this.capacity - this.items.length;
    let remaining = qty;
    for (let i = 0; i < this.items.length; i++) {
      const s = this.items[i];
      if (s.item !== c) continue;
      const sum = s.qty + remaining;
      if (sum < 100) {
        s.qty = sum;
        return true;
      }
      if (free === 0) return false;
      remaining = sum - MAX_ITEM_QUANTITY;
      s.qty = MAX_ITEM_QUANTITY;
    }
    if (free === 0) return false;
    this.items.push({ item: c, qty: remaining });
    return true;
  }

  /**
   * RemoveItemFromInventory_: remove `qty` from the slot at `index`; an emptied slot is deleted
   * and the following slots move up.
   * @returns {boolean} false if the slot doesn't hold that many
   */
  removeAt(index, qty = 1) {
    const s = this.items[index];
    if (!s || qty <= 0 || s.qty < qty) return false;
    s.qty -= qty;
    if (s.qty === 0) this.items.splice(index, 1);
    return true;
  }

  /**
   * Remove `qty` of an item, starting with its first slot (RemoveItemByID removes one from the
   * first slot). Fails without changes if there aren't enough.
   * @returns {boolean}
   */
  remove(item, qty = 1, gd = getGameData()) {
    const c = itemConst(item, gd);
    if (this.count(c, gd) < qty) return false;
    let left = qty;
    while (left > 0) {
      const i = this.items.findIndex((s) => s.item === c);
      const take = Math.min(left, this.items[i].qty);
      this.removeAt(i, take);
      left -= take;
    }
    return true;
  }

  /**
   * SELECT-swap in an item list (HandleItemListSwapping): `first` = the slot chosen first,
   * `second` = the slot chosen second. Different items swap places; the same item merges into
   * the second slot (if the total is >= 100 the second gets 99 and the first keeps the rest).
   */
  swap(first, second) {
    if (first === second) return;
    const a = this.items[first];
    const b = this.items[second];
    if (!a || !b) throw new RangeError('Bag.swap: index out of range');
    if (a.item !== b.item) {
      this.items[first] = b;
      this.items[second] = a;
      return;
    }
    const sum = a.qty + b.qty;
    if (sum >= 100) {
      a.qty = sum - MAX_ITEM_QUANTITY;
      b.qty = MAX_ITEM_QUANTITY;
      return;
    }
    b.qty = sum;
    this.items.splice(first, 1);
  }

  /**
   * TossItem_ without the YES/NO prompt: key items and HMs are refused.
   * @returns {{ok:boolean, text:string}} text = data/text/common.json label
   */
  toss(index, qty = 1, gd = getGameData()) {
    const s = this.items[index];
    if (!s) throw new RangeError(`Bag.toss: no slot ${index}`);
    if (!canToss(s.item, gd)) return { ok: false, text: '_TooImportantToTossText' };
    if (!this.removeAt(index, qty)) return { ok: false, text: '_ItemUseNoEffectText' };
    return { ok: true, text: '_ThrewAwayItemText' };
  }

  toJSON() { return this.items.map((s) => ({ item: s.item, qty: s.qty })); }

  /** @param {ItemSlot[]|{items:ItemSlot[]}} o @param {number} [capacity] */
  static fromJSON(o, capacity = BAG_ITEM_CAPACITY) {
    const items = Array.isArray(o) ? o : (o && o.items) || [];
    return new Bag({ capacity, items });
  }
}

/** A 50-slot PC item box. */
export function makePCItems(items = []) {
  return new Bag({ capacity: PC_ITEM_CAPACITY, items });
}

/**
 * Move `qty` of the item in bag slot `index` into the PC (Player's PC DEPOSIT ITEM) or back
 * (WITHDRAW ITEM). Fails ("no room") without changes if the destination can't take it.
 * @returns {boolean}
 */
export function transferItem(from, to, index, qty, gd = getGameData()) {
  const s = from.at(index);
  if (!s || s.qty < qty) return false;
  if (!to.add(s.item, qty, gd)) return false;
  from.removeAt(index, qty);
  return true;
}

// ------------------------------------------------------------------------------- money / coins

/** HasEnoughMoney. */
export function hasEnoughMoney(state, amount) {
  return state.money >= amount;
}

/** AddBCD on wPlayerMoney: clamps at 999999. @returns {number} new money */
export function addMoney(state, amount) {
  state.money = Math.min(MAX_MONEY, state.money + Math.max(0, amount | 0));
  return state.money;
}

/**
 * SubBCD on wPlayerMoney: a borrow sets it to 0 (callers check hasEnoughMoney first).
 * @returns {boolean} false if there was not enough (money is then 0, like the game)
 */
export function subtractMoney(state, amount) {
  const ok = state.money >= amount;
  state.money = ok ? state.money - amount : 0;
  return ok;
}

/** Money lost on a blackout/loss: half of it (DivideBCDPredef3, floor). @returns {number} amount lost */
export function halveMoney(state) {
  const lost = state.money - Math.floor(state.money / 2);
  state.money = Math.floor(state.money / 2);
  return lost;
}

/** AddBCD on wPlayerCoins: clamps at 9999. @returns {number} new coins */
export function addCoins(state, amount) {
  state.coins = Math.min(MAX_COINS, state.coins + Math.max(0, amount | 0));
  return state.coins;
}

/** SubBCD on wPlayerCoins (0 on borrow). @returns {boolean} enough coins */
export function subtractCoins(state, amount) {
  const ok = state.coins >= amount;
  state.coins = ok ? state.coins - amount : 0;
  return ok;
}

/** The Game Corner clerk only sells while the case has room for 9 more coins (Has9990Coins). */
export function hasRoomForCoins(state) {
  return state.coins < 9990;
}
