// The PCs (engine/menus/pc.asm ActivatePC, engine/pokemon/bills_pc.asm, engine/menus/
// players_pc.asm, engine/menus/oaks_pc.asm, engine/menus/league_pc.asm,
// engine/events/pokedex_rating.asm, engine/menus/save.asm ChangeBox).
//
//   PcScene({kind:'pokecenter'})  "RED turned on the PC." -> SOMEONE's/BILL's PC, RED's PC,
//                                  PROF.OAK's PC, <PKMN>LEAGUE, LOG OFF (box (0,0) 16 wide)
//   PcScene({kind:'bills'})        Bill's PC accessed directly ("Switch on!")
//   PcScene({kind:'players'})      Red's bedroom PC ("RED turned on the PC.")
//
// PC sound: SFX_TURN_ON_PC / SFX_ENTER_PC / SFX_TURN_OFF_PC; the generic PC menus are silent
// on A/B (BIT_NO_MENU_BUTTON_SOUND).

import { MenuScene } from './base.js';
import { displayListMenu, chooseQuantity, ListMenuState, LIST_KIND } from './list.js';
import { bagEntries } from './bag_menu.js';
import { StatusScreenScene, drawPic } from './status_screen.js';
import { LEADING_ZEROES } from './format.js';
import { SPACE } from './screen.js';
import { deposit, withdraw, release, changeBox, currentBox, isCurrentBoxFull, MONS_PER_BOX } from '../pokemon/party.js';
import { transferItem, isKeyItem } from '../pokemon/bag.js';
import { saveGame } from '../game/save.js';
import { menuSaveStore } from './save_menu.js';

/** DexRatingsTable: the rating text label for an owned count. */
export function dexRatingLabel(owned) {
  const bounds = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 152];
  const names = ['0To9', '10To19', '20To29', '30To39', '40To49', '50To59', '60To69', '70To79', '80To89', '90To99',
    '100To109', '110To119', '120To129', '130To139', '140To149', '150To151'];
  const i = bounds.findIndex((b) => owned < b);
  return `_DexRatingText_Own${names[i < 0 ? names.length - 1 : i]}`;
}

/** PlayPokedexRatingSfx: the jingle for an owned count. */
export function dexRatingSfx(owned) {
  const bounds = [10, 40, 60, 90, 120, 150];
  const sfx = ['SFX_DENIED', 'SFX_POKEDEX_RATING', 'SFX_GET_ITEM_1', 'SFX_CAUGHT_MON', 'SFX_LEVEL_UP', 'SFX_GET_KEY_ITEM', 'SFX_GET_ITEM_2'];
  const i = bounds.findIndex((b) => owned < b);
  return sfx[i < 0 ? sfx.length - 1 : i];
}

/** "BOX No." number cells: 1-9 at (x+1), 10-12 as "1" + digit. */
function boxNumber(s, x, y, box) {
  if (box >= 9) { s.text(x - 1, y, '1'); s.text(x, y, String(box - 9)); } else s.text(x, y, String(box + 1));
}

export class PcScene extends MenuScene {
  /** @param {{kind?:'pokecenter'|'bills'|'players'}} [params] */
  constructor(params = {}) {
    super({ ...params, opaque: false, vramMode: 'text' });
  }

  *main() {
    const kind = this.params.kind || 'pokecenter';
    if (kind === 'bills') {
      yield* this.child(new BillsPcScene({ direct: true }));
      return null;
    }
    if (kind === 'players') {
      yield* this.child(new PlayersPcScene({ direct: true }));
      return null;
    }
    // ActivatePC
    const sound = this.sfx('SFX_TURN_ON_PC');
    yield* this.print('_TurnedOnPC1Text');
    yield* this.waitFor(sound, 120);
    this.scr.reset();
    yield 3;
    for (;;) {
      const items = this.drawMainMenu();
      const r = yield* this.menuInput({ x: 1, y: 2, max: items.length - 1, current: 0, last: 0, sound: false });
      const choice = r.keys.b ? 'logoff' : items[r.index];
      if (choice === 'logoff') {
        this.scr.reset();
        yield* this.sfxWait('SFX_TURN_OFF_PC');
        return null;
      }
      yield* this.sfxWait('SFX_ENTER_PC');
      if (choice === 'bills') {
        const met = this.flag('EVENT_MET_BILL');
        yield* this.print(met ? '_AccessedBillsPCText' : '_AccessedSomeonesPCText');
        yield* this.child(new BillsPcScene({ direct: false }));
      } else if (choice === 'players') {
        yield* this.print('_AccessedMyPCText');
        yield* this.child(new PlayersPcScene({ direct: false }));
      } else if (choice === 'oak') {
        yield* this.oaksPc();
      } else if (choice === 'league') {
        yield* this.child(new LeaguePcScene());
      }
      this.scr.reset();
    }
  }

  flag(name) {
    try { return this.state.flags.get(name); } catch { return false; }
  }

  /** DisplayPCMainMenu. @returns {string[]} the entries in order */
  drawMainMenu() {
    const s = this.scr;
    s.reset();
    const dex = this.flag('EVENT_GOT_POKEDEX');
    const hof = (this.state.hallOfFameCount | 0) > 0;
    const h = hof ? 12 : dex ? 10 : 8;
    s.box(0, 0, 16, h);
    s.text(2, 2, this.flag('EVENT_MET_BILL') ? "BILL's PC" : "SOMEONE's PC");
    const end = s.text(2, 4, this.state.playerName);
    s.text(end.x, 4, "'s PC");
    const items = ['bills', 'players'];
    if (dex) {
      s.text(2, 6, "PROF.OAK's PC");
      items.push('oak');
      if (hof) { s.text(2, 8, '<PKMN>LEAGUE'); items.push('league'); }
    }
    s.text(2, 2 + 2 * items.length, 'LOG OFF');
    items.push('logoff');
    return items;
  }

  /** OpenOaksPC + DisplayDexRating. */
  *oaksPc() {
    this.scr.reset();
    yield* this.print('_AccessedOaksPCText');
    yield* this.print('_GetDexRatedText');
    const yes = yield* this.yesNo();
    if (yes) yield* dexRating(this);
    yield* this.print([{ cmd: 'text_far', label: '_ClosedOaksPCText' }, { cmd: 'text_waitbutton' }, { cmd: 'text_end' }]);
    this.scr.reset();
  }
}

/** DisplayDexRating (Oak's PC; also usable by Oak's lab scripts). */
export function* dexRating(s) {
  const dex = s.state.pokedex;
  const seen = dex.seenCount, owned = dex.ownedCount;
  const subs = { hDexRatingNumMonsSeen: seen, hDexRatingNumMonsOwned: owned };
  yield* s.print('_DexCompletionText', { subs });
  yield* s.print(dexRatingLabel(owned), { subs });
  // PlayPokedexRatingSfx: SFX_STOP_ALL_MUSIC, the jingle (an SFX on channels 5-8), then
  // PlayDefaultMusic, which first waits for the SFX channels to be free
  const prev = s.snd.currentMusic();
  s.snd.stopMusic();
  yield* s.snd.waitSfx(dexRatingSfx(owned));
  if (prev) s.snd.music(prev);
  yield* s.waitButton();
}

// =============================================================================== Bill's PC

export class BillsPcScene extends MenuScene {
  /** @param {{direct?:boolean}} [params] direct: TX_SCRIPT_BILLS_PC (own on/off sounds) */
  constructor(params = {}) {
    super({ ...params, opaque: false, vramMode: 'billsPc' });
    this.hideMenusBelow = true;
    this.parentItem = 0;
  }

  get silent() { return !this.params.direct; }

  *main() {
    if (this.params.direct) {
      this.sfx('SFX_TURN_ON_PC');
      yield* this.print('_SwitchOnText');
    }
    for (;;) {
      // BillsPCMenu
      const s = this.scr;
      s.reset();
      s.box(0, 0, 14, 12);
      s.text(2, 2, 'WITHDRAW <PKMN>\nDEPOSIT <PKMN>\nRELEASE <PKMN>\nCHANGE BOX\nSEE YA!');
      yield* this.print('_WhatText', { instant: true });
      s.box(9, 14, 11, 4);
      boxNumber(s, 18, 16, this.state.currentBox);
      s.text(10, 16, 'BOX No.');
      yield 3;
      const r = yield* this.menuInput({ x: 1, y: 2, max: 4, current: this.parentItem, last: this.parentItem, sound: !this.silent });
      if (r.keys.b) break;
      this.hollowCursor();
      this.parentItem = r.index;
      if (r.index === 0) yield* this.withdraw();
      else if (r.index === 1) yield* this.deposit();
      else if (r.index === 2) yield* this.release();
      else if (r.index === 3) yield* this.changeBoxFlow();
      else break;
    }
    // ExitBillsPC
    this.scr.reset();
    if (this.params.direct) yield* this.sfxWait('SFX_TURN_OFF_PC');
    return null;
  }

  /** DisplayMonListMenu over the party or the current box. */
  *monList(fromBox) {
    const gd = this.gd;
    const list = () => (fromBox ? currentBox(this.state) : this.state.party).map((m) => ({
      name: m.nickname || gd.species(m.species).name, level: m.level, mon: m,
    }));
    const st = new ListMenuState(list().length);
    return yield* displayListMenu(this, { kind: LIST_KIND.POKEMON, entries: list, state: st, silent: this.silent });
  }

  /** DisplayDepositWithdrawMenu: box (9,10) 11×8. @returns {Generator<any, boolean>} confirmed */
  *depositWithdrawMenu(isDeposit, mon, fromBox) {
    const s = this.scr;
    const saved = s.save();
    for (;;) {
      s.box(9, 10, 11, 8);
      s.text(11, 12, isDeposit ? 'DEPOSIT' : 'WITHDRAW');
      s.text(11, 14, 'STATS\nCANCEL');
      const r = yield* this.menuInput({ x: 10, y: 12, max: 2, current: 0, last: 0, sound: !this.silent });
      if (r.keys.b || r.index === 2) { s.restore(saved); return false; }
      if (r.index === 0) return true;
      yield* this.child(new StatusScreenScene({ mon, box: fromBox }));
      this.palNormal();
    }
  }

  *withdraw() {
    if (!currentBox(this.state).length) { yield* this.print('_NoMonText'); return; }
    if (this.state.party.length >= 6) { yield* this.print('_CantTakeMonText'); return; }
    const sel = yield* this.monList(true);
    if (!sel) return;
    const ok = yield* this.depositWithdrawMenu(false, sel.entry.mon, true);
    if (!ok) return;
    const name = sel.entry.name;
    yield* this.cryWait(sel.entry.mon.species);
    withdraw(this.state, sel.index, this.gd);
    yield* this.print('_MonIsTakenOutText', { subs: { wStringBuffer: name } });
  }

  *deposit() {
    if (this.state.party.length <= 1) { yield* this.print('_CantDepositLastMonText'); return; }
    if (isCurrentBoxFull(this.state)) { yield* this.print('_BoxFullText'); return; }
    const sel = yield* this.monList(false);
    if (!sel) return;
    const ok = yield* this.depositWithdrawMenu(true, sel.entry.mon, false);
    if (!ok) return;
    yield* this.cryWait(sel.entry.mon.species);
    const r = deposit(this.state, sel.index);
    if (!r.ok) return;
    yield* this.print('_MonWasStoredText', { subs: { wStringBuffer: sel.entry.name, wBoxNumString: String(r.boxNumber) } });
  }

  *release() {
    if (!currentBox(this.state).length) { yield* this.print('_NoMonText'); return; }
    for (;;) {
      const sel = yield* this.monList(true);
      if (!sel) return;
      const name = sel.entry.name;
      yield* this.print('_OnceReleasedText', { subs: { wStringBuffer: name } });
      const yes = yield* this.yesNo();
      if (!yes) continue;
      const species = sel.entry.mon.species;
      release(this.state, sel.index);
      // WaitForSoundToFinish + PlayCry (waits for the cry)
      yield* this.cryWait(species);
      yield* this.print('_MonWasReleasedText', { subs: { wStringBuffer: name } });
      return;
    }
  }

  /** ChangeBox (engine/menus/save.asm): confirm, pick a box, save the game. */
  *changeBoxFlow() {
    yield* this.print('_WhenYouChangeBoxText');
    const yes = yield* this.yesNo();
    if (!yes) return;
    const s = this.scr;
    const saved = s.save();
    s.box(0, 0, 11, 4);
    yield* this.print('_ChooseABoxText');
    s.box(11, 0, 9, 14);
    const names = [];
    for (let i = 1; i <= 12; i++) names.push(i < 10 ? `BOX ${i}` : `BOX${i}`);
    s.text(13, 1, names.join('\n'), { lineStep: 1 });
    boxNumber(s, 9, 2, this.state.currentBox);
    s.text(1, 2, 'BOX No.');
    for (let i = 0; i < 12; i++) if (this.state.pcBoxes[i].length) s.put(18, 1 + i, 0x78);
    const r = yield* this.menuInput({ x: 12, y: 1, max: 11, current: this.state.currentBox, last: this.state.currentBox, step: 1, sound: !this.silent });
    s.restore(saved);
    if (r.keys.b) return;
    changeBox(this.state, r.index);
    const store = this.params.store || menuSaveStore(this.game);
    const res = saveGame(this.state, store);
    if (!res.ok) console.warn('[menus] change box save failed:', res.error);
    yield* this.sfxWait('SFX_SAVE');
  }
}

// =============================================================================== player's PC

export class PlayersPcScene extends MenuScene {
  /** @param {{direct?:boolean}} [params] direct: the bedroom PC (own on/off sounds) */
  constructor(params = {}) {
    super({ ...params, opaque: false, vramMode: 'text' });
    this.hideMenusBelow = true;
    this.parentItem = 0;
  }

  *main() {
    if (this.params.direct) {
      this.sfx('SFX_TURN_ON_PC');
      yield* this.print('_TurnedOnPC2Text');
    }
    let first = true;
    for (;;) {
      // PlayerPCMenu
      const s = this.scr;
      s.reset();
      s.box(0, 0, 16, 10);
      s.text(2, 2, 'WITHDRAW ITEM\nDEPOSIT ITEM\nTOSS ITEM\nLOG OFF');
      yield* this.print('_WhatDoYouWantText', { instant: first });
      first = false;
      const r = yield* this.menuInput({ x: 1, y: 2, max: 3, current: this.parentItem, last: this.parentItem, sound: false });
      if (r.keys.b || r.index === 3) break;
      this.hollowCursor();
      this.parentItem = r.index;
      if (r.index === 0) yield* this.withdrawItems();
      else if (r.index === 1) yield* this.depositItems();
      else yield* this.tossItems();
    }
    this.scr.reset();
    if (this.params.direct) yield* this.sfxWait('SFX_TURN_OFF_PC');
    return null;
  }

  *itemList(bag) {
    const st = new ListMenuState(bag.length);
    return yield* displayListMenu(this, {
      kind: LIST_KIND.ITEM, entries: () => bagEntries(this.gd, bag), state: st, swap: (a, b) => bag.swap(a, b),
    });
  }

  *move(from, to, verbs) {
    const gd = this.gd;
    if (!from.length) { yield* this.print(verbs.empty); return; }
    for (;;) {
      yield* this.print(verbs.what);
      const sel = yield* this.itemList(from);
      if (!sel) return;
      let qty = 1;
      if (!sel.entry.keyItem) {
        yield* this.print('_DepositHowManyText');
        qty = yield* chooseQuantity(this, sel.entry.qty);
        if (qty < 0) continue;
      }
      if (!transferItem(from, to, sel.index, qty, gd)) {
        yield* this.print(verbs.noRoom);
        continue;
      }
      yield* this.sfxWait('SFX_WITHDRAW_DEPOSIT');
      yield* this.print(verbs.done, { subs: { wNameBuffer: gd.item(sel.entry.item).name } });
      if (!from.length) return;
    }
  }

  *withdrawItems() {
    yield* this.move(this.state.pcItems, this.state.bag, {
      empty: '_NothingStoredText', what: '_WhatToWithdrawText', noRoom: '_CantCarryMoreText', done: '_WithdrewItemText',
    });
  }

  *depositItems() {
    yield* this.move(this.state.bag, this.state.pcItems, {
      empty: '_NothingToDepositText', what: '_WhatToDepositText', noRoom: '_NoRoomToStoreText', done: '_ItemWasStoredText',
    });
  }

  *tossItems() {
    const gd = this.gd;
    const box = this.state.pcItems;
    if (!box.length) { yield* this.print('_NothingStoredText'); return; }
    for (;;) {
      yield* this.print('_WhatToTossText');
      const sel = yield* this.itemList(box);
      if (!sel) return;
      let qty = 1;
      const key = isKeyItem(sel.entry.item, gd);
      if (!key) {
        yield* this.print('_TossHowManyText');
        qty = yield* chooseQuantity(this, sel.entry.qty);
        if (qty < 0) continue;
      }
      if (key) { yield* this.print('_TooImportantToTossText'); continue; }
      const name = gd.item(sel.entry.item).name;
      yield* this.print('_IsItOKToTossItemText', { subs: { wStringBuffer: name } });
      const yes = yield* this.yesNo();
      if (!yes) continue;
      box.removeAt(sel.index, qty);
      yield* this.print('_ThrewAwayItemText', { subs: { wNameBuffer: name } });
      if (!box.length) return;
    }
  }
}

// =============================================================================== Hall of Fame

/** PKMNLeaguePC: every recorded team, mon by mon (B held at a wait leaves). */
export class LeaguePcScene extends MenuScene {
  constructor(params = {}) {
    super({ ...params, opaque: false, vramMode: 'text' });
    this.pic = null;
  }

  *main() {
    yield* this.print('_AccessedHoFPCText');
    const teams = this.state.hallOfFame || [];
    const first = Math.max(0, (this.state.hallOfFameCount | 0) - teams.length);
    this.opaque = true;
    outer: for (let t = 0; t < teams.length; t++) {
      for (const m of teams[t]) {
        yield* this.showMon(m, first + t + 1);
        yield* this.waitButton();
        if (this.input.held && this.input.held.b) break outer;
      }
    }
    this.pic = null;
    this.palWhiteOut();
    yield 3;
    this.palNormal();
    this.opaque = false;
    this.scr.reset();
    return null;
  }

  *showMon(m, teamNo) {
    const s = this.scr;
    const gd = this.gd;
    this.palWhiteOut();
    yield 3;
    s.clear();
    this.pic = yield this.ctx.frontPic(m.species);
    this.palNormal();
    s.box(0, 13, 20, 4);
    s.text(1, 15, 'HALL OF FAME No   ');
    s.num(16, 15, teamNo, 3);
    // HoFDisplayMonInfo
    s.box(0, 2, 12, 11);
    s.text(2, 6, 'LEVEL/\nTYPE1/\nTYPE2/');
    s.text(1, 4, m.nickname || gd.species(m.species).name);
    s.text(8, 7, String(m.level));
    const sp = gd.species(m.species);
    s.text(3, 9, gd.typeName(sp.types[0]));
    if (sp.types[0] === sp.types[1]) s.clearArea(2, 10, 6, 1);
    else s.text(3, 11, gd.typeName(sp.types[1]));
    // jp PlayCry: the next WaitForTextScrollButtonPress starts after the cry
    yield* this.cryWait(sp.dex);
  }

  drawExtra(fb) {
    if (this.pic) drawPic(fb, this.pic, 12, 5);
  }
}

export { SPACE, LEADING_ZEROES, MONS_PER_BOX };
