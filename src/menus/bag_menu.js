// The ITEM menu (engine/menus/start_sub_menus.asm StartMenu_Item / ItemMenuLoop) over the
// START menu: the scrolling bag list (list.js), USE / TOSS at (13,10), the quantity picker for
// tossing, and UseItem dispatch:
//
//   party-menu items, TMs/HMs  -> a PartyMenuScene running item_use.js flows, then the bag again
//   UsableItems_CloseMenu       -> run over the map (menus hidden), then close the START menu
//                                  with {type:'useItem', item, request}
//   BICYCLE                     -> same as close-menu items (no USE/TOSS box)
//   anything else               -> text over the bag (Repel, Coin Case, Town Map, not the time…)

import { MenuScene } from './base.js';
import { displayListMenu, chooseQuantity, ListMenuState, LIST_KIND } from './list.js';
import { SPACE } from './screen.js';
import { PartyMenuScene } from './party_menu.js';
import { partyItemFlow, itemUseKind } from './item_use.js';
import { TownMapScene } from './town_map.js';
import { useItem } from '../pokemon/items_effects.js';
import { isKeyItem } from '../pokemon/bag.js';

/** Bag entries for the list menu. */
export function bagEntries(gd, bag) {
  return bag.items.map((s) => {
    const it = gd.item(s.item);
    return { item: it.const, name: it.name, qty: s.qty, keyItem: isKeyItem(it.const, gd) };
  });
}

export class BagScene extends MenuScene {
  /**
   * @param {object} [params]
   * @param {object} [params.env] overworld facts: {facingWater, map, tileset, coords,
   *   hiddenItemNear(), alwaysOnBike, link}
   */
  constructor(params = {}) {
    super({ ...params, opaque: false, vramMode: 'text' });
  }

  *main() {
    const env = this.params.env || {};
    if (env.link) {
      yield* this.print('_CannotUseItemsHereText');
      return null;
    }
    const gd = this.gd;
    const saved = this.ctx.saved.bag;
    const st = new ListMenuState(this.state.bag.length, { cursor: saved.cursor, scroll: saved.scroll });
    const remember = () => { saved.cursor = st.cursor; saved.scroll = st.scroll; };
    for (;;) {
      // ItemMenuLoop: LoadScreenTilesFromBuffer2DisableBGTransfer (the list reappears with
      // its entries 10 frames later, see displayListMenu)
      this.freezeBg();
      this.hideMenusBelow = false;
      this.scr.reset();
      const n0 = this.state.bag.length;
      const sel = yield* displayListMenu(this, {
        kind: LIST_KIND.ITEM,
        entries: () => bagEntries(gd, this.state.bag),
        state: st,
        swap: (a, b) => this.state.bag.swap(a, b),
      });
      remember();
      if (!sel) return null;
      const item = sel.entry.item;
      // .choseItem: erase the list cursors, ▷ on the item
      for (const y of [4, 6, 8, 10]) this.scr.put(5, y, SPACE);
      this.hollowCursor();
      let choice = 0;
      if (item !== 'BICYCLE') {
        this.scr.box(13, 10, 7, 5);
        this.scr.text(15, 11, 'USE\nTOSS');
        const r = yield* this.menuInput({ x: 14, y: 11, max: 1, current: 0, last: 0 });
        this.hollowCursor();
        if (r.keys.b) continue;
        choice = r.index;
      }
      const result = choice === 1 ? yield* this.toss(sel.index, sel.entry) : yield* this.use(item, sel.index);
      // RemoveItemFromInventory: an emptied slot resets the list to the top
      if (this.state.bag.length < n0) { st.cursor = 0; st.scroll = 0; }
      st.setCount(this.state.bag.length);
      remember();
      if (result && typeof result === 'object') return result;
    }
  }

  /** .tossItem */
  *toss(index, entry) {
    const gd = this.gd;
    let qty = 1;
    if (!entry.keyItem) {
      qty = yield* chooseQuantity(this, entry.qty);
      if (qty < 0) return null;
    }
    // TossItem_
    if (entry.keyItem) {
      yield* this.print('_TooImportantToTossText');
      return null;
    }
    yield* this.print('_IsItOKToTossItemText', { subs: { wStringBuffer: entry.name } });
    const yes = yield* this.yesNo();
    if (!yes) return null;
    this.state.bag.removeAt(index, qty);
    yield* this.print('_ThrewAwayItemText', { subs: { wNameBuffer: gd.item(entry.item).name } });
    return null;
  }

  /** .useOrTossItem -> UseItem. @returns null (back to the list) or a close request */
  *use(item, index) {
    const gd = this.gd;
    const env = this.params.env || {};
    const kind = itemUseKind(gd, item);
    const name = gd.item(item).name;
    if (kind === 'bicycle') {
      let always = false;
      try { always = !!(env.alwaysOnBike || this.state.statusFlags.get('BIT_ALWAYS_ON_BIKE')); } catch { /* */ }
      if (always) {
        yield* this.print('_CannotGetOffHereText');
        return null;
      }
      const r = useItem(this.state, item, { ...env });
      if (!r.ok) {
        yield* this.print(r.text, { subs: r.vars });
        return null;
      }
      // ItemUseReloadOverworldData: the menus disappear, the text shows over the map
      yield* this.overMap();
      yield* this.print(r.text, { subs: { ...r.vars, wStringBuffer: name } });
      return { type: 'useItem', item, request: r.request };
    }
    if (kind === 'party' || kind === 'tm') {
      if (kind === 'tm') {
        // ItemUseTMHM: "Booted up a TM!" / "It contained X! Teach X to a POKéMON?"
        const it = gd.item(item);
        const move = gd.move(it.move);
        yield* this.print(it.hm ? '_BootedUpHMText' : '_BootedUpTMText');
        yield* this.print('_TeachMachineMoveText', { subs: { wStringBuffer: move.name } });
        const yes = yield* this.yesNo();
        if (!yes) return null; // wActionResultOrTookBattleTurn = 2: the party menu never showed
      }
      const p = new PartyMenuScene({ mode: 0, item, flow: (scene) => partyItemFlow(scene, item) });
      const r = yield* this.child(p);
      if (r && r.partyShown === false) return null;
      // GBPalWhiteOutWithDelay3 + RestoreScreenTilesAndReloadTilePatterns + LoadGBPal
      this.palWhiteOut();
      yield 3;
      this.palNormal();
      return null;
    }
    if (kind === 'close') return yield* this.useCloseMenuItem(item, name, env);
    // other items
    const it = gd.item(item);
    const effect = (it.effect && it.effect.kind) || 'none';
    if (effect === 'townMap') {
      yield* this.child(new TownMapScene());
      this.palNormal();
      return null;
    }
    if (effect === 'pokedex') {
      const { PokedexScene } = yield import('./pokedex.js');
      yield* this.child(new PokedexScene());
      this.palNormal();
      return null;
    }
    const r = useItem(this.state, item, { ...env });
    if (effect === 'repel' && r.ok) {
      // PrintItemUseTextAndRemoveItem
      yield* this.print(r.text, { subs: { ...r.vars, wStringBuffer: name } });
      this.sfx('SFX_HEAL_AILMENT');
      yield* this.waitButton();
      return null;
    }
    if (r.text) yield* this.print(r.text, { subs: { ...r.vars, wStringBuffer: name } });
    return null;
  }

  /** Escape Rope, Itemfinder, Poké Flute, the rods (.useItem_closeMenu). */
  *useCloseMenuItem(item, name, env) {
    const gd = this.gd;
    const it = gd.item(item);
    const effect = it.effect && it.effect.kind;
    const r = useItem(this.state, item, { ...env });
    if (!r.ok && r.text) {
      yield* this.print(r.text, { subs: r.vars });
      return null;
    }
    const close = (request = r.request || null, extra = {}) => ({ type: 'useItem', item, request, ...extra });
    switch (effect) {
      case 'escapeRope':
        yield* this.overMap();
        yield 30;
        return close();
      case 'itemfinder': {
        if (typeof env.hiddenItemNear !== 'function') return close();
        yield* this.overMap();
        const near = !!env.hiddenItemNear();
        if (near) {
          for (let k = 0; k < 4; k++) {
            yield* this.sfxWait('SFX_HEALING_MACHINE');
            yield* this.sfxWait('SFX_PURCHASE');
          }
        }
        yield* this.print(near ? '_ItemfinderFoundItemText' : '_ItemfinderFoundNothingText');
        return close(r.request, { found: near });
      }
      case 'pokeFlute': {
        yield* this.overMap();
        if (r.request && r.request.kind === 'wakeSnorlax') {
          yield* this.print([{ cmd: 'text_far', label: '_PlayedFluteHadEffectText' }, { cmd: 'text_promptbutton' }]);
          // the out-of-battle flute tune (SFX_POKEFLUTE as music, 576 frames) until channel 3
          // is silent; PlayDefaultMusic (the map music) is up to the overworld
          const prev = this.snd.currentMusic();
          this.snd.stopMusic();
          this.snd.music('SFX_POKEFLUTE', { loop: false });
          yield* this.snd.waitMusicEnd('SFX_POKEFLUTE', 576, 900);
          if (prev && prev !== 'SFX_POKEFLUTE') this.snd.music(prev);
          return close();
        }
        yield* this.print('_PlayedFluteNoEffectText');
        return close();
      }
      case 'rod': {
        // FishingInit: "RED used OLD ROD!", SFX_HEAL_AILMENT, 80 frames; the bite and the
        // FishingAnim belong to the overworld
        yield* this.overMap();
        yield* this.print(['_ItemUseText001', { cmd: 'text_low' }, '_ItemUseText002'].map((x) => (typeof x === 'string' ? { cmd: 'text_far', label: x } : x)), { subs: { wStringBuffer: name } });
        this.sfx('SFX_HEAL_AILMENT');
        yield 80;
        return close();
      }
      default:
        if (r.text) yield* this.print(r.text, { subs: r.vars });
        return close();
    }
  }

  /** ItemUseReloadOverworldData: hide every menu tile, the map shows. */
  *overMap() {
    this.scr.reset();
    this.hideMenusBelow = true;
    yield 1;
  }
}
