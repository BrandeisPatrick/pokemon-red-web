// Celadon Game Corner: the coin clerk (scripts/GameCorner.asm GameCornerClerk1Text +
// GameCornerDrawCoinBox) and the prize vendors (engine/events/prize_menu.asm
// CeladonPrizeMenu), with prizes from data/events.json gameCornerPrizes.
//
//   GameCornerScene({mode:'coins'})          ¥1000 for 50 coins (COIN CASE, < 9990 coins)
//   GameCornerScene({mode:'prizes', menu:n}) prize window n (0 = Abra/Clefairy/Nidorina,
//                                            1 = Dratini/Scyther/Porygon, 2 = TM23/15/50)
// Prize Pokémon go through _GivePokemon ("RED got X!", the nickname prompt with the intro's
// naming screen, or "sent to POKéMON BOX N").

import { MenuScene } from './base.js';
import { LEADING_ZEROES, MONEY_SIGN } from './format.js';
import { addCoins, subtractCoins, hasRoomForCoins } from '../pokemon/bag.js';
import { makeMon } from '../pokemon/mon.js';
import { giveMon } from '../pokemon/party.js';
import { namingScreen } from '../intro/naming.js';

/** Buying 50 coins (pure): {ok, reason?: 'noCoinCase'|'coinCaseFull'|'money'}. */
export function buyCoins(state, gd) {
  if (!state.bag.has('COIN_CASE', 1, gd)) return { ok: false, reason: 'noCoinCase' };
  if (!hasRoomForCoins(state)) return { ok: false, reason: 'coinCaseFull' };
  if (state.money < 1000) return { ok: false, reason: 'money' };
  state.money -= 1000;
  addCoins(state, 50);
  return { ok: true };
}

/** The three prizes of window n: [{kind, species|item, level?, coins, name}] */
export function prizeList(gd, menu) {
  const m = gd.events.gameCornerPrizes[menu];
  return m.prizes.map((p) => ({
    ...p,
    name: p.kind === 'pokemon' ? gd.species(p.species).name : gd.item(p.item).name,
  }));
}

/**
 * _GivePokemon + AskName as a coroutine inside a MenuScene (prize mons, gifts).
 * @returns {Generator<any, {ok:boolean, where?:'party'|'box'}>}
 */
export function* givePokemonFlow(s, species, level) {
  const gd = s.gd;
  const st = s.state;
  const sp = gd.species(species);
  const mon = makeMon({ species: sp.dex, level, otName: st.playerName, otId: st.playerId, rng: s.game.rng }, gd);
  const partyHasRoom = st.party.length < 6;
  const r = giveMon(st, mon);
  if (!r.ok) {
    yield* s.print('_BoxIsFullText');
    return { ok: false };
  }
  // SetPokedexOwnedFlag: "RED got X!" + the item jingle
  yield* s.print([{ cmd: 'text_far', label: '_GotMonText' }, { cmd: 'sound_get_item_1' }, { cmd: 'text_end' }], { subs: { wNameBuffer: sp.name } });
  if (partyHasRoom) {
    // AddPartyMon -> AskName
    yield* s.print('_DoYouWantToNicknameText', { subs: { wNameBuffer: sp.name } });
    const yes = yield* s.yesNo();
    if (yes) {
      const name = yield namingScreen({ kind: 'nickname', speciesForIcon: sp.dex, fallback: sp.name, audio: s.snd.audio }, s.game);
      s.flushInput();
      const added = st.party[st.party.length - 1];
      if (added && name) added.nickname = name;
    }
    return { ok: true, where: 'party' };
  }
  yield* s.print('_SentToBoxText', { subs: { wBoxMonNicks: sp.name, wStringBuffer: String(r.boxNumber) } });
  return { ok: true, where: 'box' };
}

export class GameCornerScene extends MenuScene {
  /** @param {{mode:'coins'|'prizes', menu?:number}} params */
  constructor(params = {}) {
    super({ ...params, opaque: false, vramMode: 'text' });
    this.mapName = 'GameCorner';
  }

  *main() {
    if (this.params.mode === 'prizes') return yield* this.prizes(this.params.menu | 0);
    return yield* this.coins();
  }

  /** GameCornerDrawCoinBox: (11,0) 9×7, MONEY / ¥ / COIN / coins. */
  coinBox() {
    const s = this.scr;
    s.box(11, 0, 9, 7);
    s.clearArea(12, 1, 7, 4);
    s.text(12, 2, 'MONEY');
    s.bcd(12, 3, this.state.money, 3, MONEY_SIGN | LEADING_ZEROES);
    s.text(12, 4, 'COIN');
    s.bcd(15, 5, this.state.coins, 2, LEADING_ZEROES);
  }

  *coins() {
    yield this.ctx.loadMapText('GameCorner');
    this.coinBox();
    const t = (label) => ({ label: `GameCornerClerk1Text.${label}` });
    yield* this.print(t('DoYouNeedSomeGameCoins'), { map: 'GameCorner' });
    const yes = yield* this.yesNo();
    let label = 'PleaseComePlaySometime';
    if (yes) {
      const r = buyCoins(this.state, this.gd);
      if (r.ok) { this.coinBox(); label = 'ThanksHereAre50Coins'; } else {
        label = { noCoinCase: 'DontHaveCoinCase', coinCaseFull: 'CoinCaseIsFull', money: 'CantAffordTheCoins' }[r.reason];
      }
    }
    yield* this.print(t(label), { map: 'GameCorner', wait: true });
    this.scr.reset();
    return null;
  }

  /** PrintPrizePrice: (11,0) 9×3, COIN on the border, coins at (13,1). */
  prizeCoinBox() {
    const s = this.scr;
    s.box(11, 0, 9, 3);
    s.text(12, 0, 'COIN');
    s.clearArea(13, 1, 6, 1);
    s.bcd(13, 1, this.state.coins, 2, LEADING_ZEROES);
  }

  *prizes(menu) {
    const gd = this.gd;
    const st = this.state;
    if (!st.bag.has('COIN_CASE', 1, gd)) {
      yield* this.print([{ cmd: 'text_far', label: '_RequireCoinCaseText' }, { cmd: 'text_waitbutton' }, { cmd: 'text_end' }]);
      this.scr.reset();
      return null;
    }
    yield* this.print('_ExchangeCoinsForPrizesText', { instant: true });
    this.prizeCoinBox();
    const s = this.scr;
    s.box(0, 2, 18, 10);
    const list = prizeList(gd, menu);
    list.forEach((p, i) => {
      s.text(2, 4 + 2 * i, p.name);
      s.bcd(13, 5 + 2 * i, p.coins, 2, LEADING_ZEROES);
    });
    s.text(2, 10, 'NO THANKS');
    yield* this.print('_WhichPrizeText', { instant: true });
    const r = yield* this.menuInput({ x: 1, y: 4, max: 3, current: 0, last: 0 });
    if (r.keys.b || r.index === 3) { this.scr.reset(); return null; }
    const prize = list[r.index];
    // HandlePrizeChoice
    yield* this.print('_SoYouWantPrizeText', { subs: { wNameBuffer: prize.name } });
    const yes = yield* this.yesNo();
    const wb = (label) => [{ cmd: 'text_far', label }, { cmd: 'text_waitbutton' }, { cmd: 'text_end' }];
    if (!yes) {
      yield* this.print(wb('_OhFineThenText'));
    } else if (st.coins < prize.coins) {
      yield* this.print(wb('_SorryNeedMoreCoinsText'));
    } else if (prize.kind === 'item') {
      if (!st.bag.add(prize.item, 1, gd)) {
        yield* this.print(wb('_OopsYouDontHaveEnoughRoomText'));
      } else {
        subtractCoins(st, prize.coins);
        this.prizeCoinBox();
      }
    } else {
      const g = yield* givePokemonFlow(this, prize.species, prize.level);
      if (g.where !== 'party') yield* this.waitButton();
      if (g.ok) {
        subtractCoins(st, prize.coins);
        this.prizeCoinBox();
      }
    }
    this.scr.reset();
    return null;
  }
}
