// The party menu (engine/menus/party_menu.asm RedrawPartyMenu_, home/pokemon.asm
// DisplayPartyMenu / HandlePartyMenuInput) and the START-menu POKéMON flow
// (engine/menus/start_sub_menus.asm StartMenu_Pokemon: STATS / SWITCH / CANCEL and the field
// moves of the chosen mon).
//
// Layout: mon i -> icon OBJ at (8, 16i), name (3,2i), level (13,2i), status (17,2i), HP bar
// (4,2i+1) with "hp/max" at (13,2i+1) — or "ABLE"/"NOT ABLE" at (12,2i+1) for TM/HM and stone
// menus; cursor column 0 on the HP row (wTopMenuItemY 1), wrap-around; the selected mon's
// icon animates (5/16/32 frames per frame for green/yellow/red HP, +1 off SGB).

import { MenuScene } from './base.js';
import { hpBarPixels, hpBarColor } from './format.js';
import { SPACE, CURSOR_HOLLOW, HP_BAR_PARTY } from './screen.js';
import { StatusScreenScene } from './status_screen.js';
import { canLearnTM } from '../pokemon/learnset.js';
import { useFieldMove, visitedFlyDestinations } from '../pokemon/items_effects.js';
import { partySwap } from '../pokemon/party.js';
import { FlyMapScene } from './town_map.js';

export const PARTY_MENU = Object.freeze({ NORMAL: 0, USE_ITEM: 1, BATTLE: 2, USE_TM: 3, SWAP: 4, EVO_STONE: 5 });

/** PartyMenuMessagePointers. */
const MENU_TEXT = ['_PartyMenuNormalText', '_PartyMenuItemUseText', '_PartyMenuBattleText',
  '_PartyMenuUseTMText', '_PartyMenuSwapMonText', '_PartyMenuItemUseText'];

/** PartyMenuItemUseMessagePointers (ANTIDOTE_MSG .. RARE_CANDY_MSG). */
export const ITEM_MSG = Object.freeze({
  ANTIDOTE: '_AntidoteText', BURN_HEAL: '_BurnHealText', ICE_HEAL: '_IceHealText', AWAKENING: '_AwakeningText',
  PARLYZ_HEAL: '_ParlyzHealText', POTION: '_PotionText', FULL_HEAL: '_FullHealText', REVIVE: '_ReviveText',
  // RareCandyText: text_far _RareCandyText, sound_get_item_1, text_promptbutton
  RARE_CANDY: Object.freeze([{ cmd: 'text_far', label: '_RareCandyText' }, { cmd: 'sound_get_item_1' },
    { cmd: 'text_promptbutton' }, { cmd: 'text_end' }]),
});

/** PartyMonSpeeds (frames per icon frame for green / yellow / red HP). */
export const PARTY_MON_SPEEDS = Object.freeze([5, 16, 32]);
/** wOnSGB = 0 (DMG timings: one frame longer). */
export const ON_SGB = false;

/** Field moves in FieldMoveDisplayData order (data/items.json fieldMoves). */
export function monFieldMoves(mon, gd) {
  const table = gd.raw.items.fieldMoves;
  const out = [];
  for (const slot of mon.moves) {
    const fm = table.find((f) => f.move === slot.move);
    if (fm) out.push(fm);
    if (out.length >= 4) break;
  }
  return out;
}

export class PartyMenuScene extends MenuScene {
  /**
   * @param {object} params
   * @param {number} [params.mode] PARTY_MENU.* (message + ABLE/NOT ABLE column)
   * @param {boolean} [params.start] run the START-menu POKéMON flow (returns a request or null)
   * @param {(scene: PartyMenuScene) => Generator} [params.flow] custom flow with the menu up
   * @param {string} [params.item] TM/HM or stone item (ABLE / NOT ABLE)
   * @param {boolean} [params.forceChoose] B disabled (wForcePlayerToChooseMon)
   * @param {object} [params.env] overworld facts for field moves ({facingWater, map, tileset, coords, canCut(), surfAllowed})
   */
  constructor(params = {}) {
    super({ ...params, opaque: true, vramMode: 'menu' });
    this.mode = params.mode || PARTY_MENU.NORMAL;
    /** wMenuItemToSwap (1-based, 0 = none) */
    this.swapFrom = 0;
    /** icon animation: index of the animating mon and whether frame 2 shows */
    this.anim = { index: -1, frame2: false };
    /** icons hidden per row (SwitchPartyMon_ClearGfx) */
    this.hiddenIcons = new Set();
    this.showIcons = true;
  }

  get party() { return this.state.party; }

  get cursor() { return Math.min(this.ctx.saved.party || 0, Math.max(0, this.party.length - 1)); }
  set cursor(v) { this.ctx.saved.party = v; }

  *main() {
    if (this.params.flow) return yield* this.params.flow(this);
    if (this.params.start) return yield* this.startFlow();
    yield* this.display(this.mode);
    return yield* this.choose({ forceChoose: !!this.params.forceChoose });
  }

  // ------------------------------------------------------------------ drawing

  /** DisplayPartyMenu: white out, clear, draw. */
  *display(mode = this.mode) {
    this.mode = mode;
    yield* this.whiteOutDelay3();
    this.scr.clear();
    this.hiddenIcons.clear();
    yield* this.redraw();
  }

  /**
   * RedrawPartyMenu_ (+ .printMessage). `message` overrides the menu text: a PARTY_MENU mode or
   * an item-use message {label, index}.
   */
  *redraw(message) {
    const msg = message ?? this.mode;
    const s = this.scr;
    if (msg !== PARTY_MENU.SWAP) {
      for (let i = 0; i < 6; i++) s.put(0, 1 + 2 * i, SPACE); // ErasePartyMenuCursors
      this.party.forEach((mon, i) => this.drawEntry(i));
      this.hiddenIcons.clear();
    }
    if (typeof msg === 'number') {
      yield* this.print(MENU_TEXT[msg] || MENU_TEXT[0], { instant: true });
    } else if (msg && msg.label) {
      const mon = this.party[msg.index ?? 0];
      yield* this.print(msg.label, { instant: true, subs: { wNameBuffer: mon ? mon.nickname : '', ...(msg.subs || {}) } });
    }
    yield 3;
    this.palNormal();
  }

  /** One mon's rows. */
  drawEntry(i) {
    const s = this.scr, gd = this.gd;
    const mon = this.party[i];
    const y = 2 * i;
    s.clearArea(0, y, 20, 2);
    s.text(3, y, mon.nickname || gd.species(mon.species).name);
    if (this.swapFrom && this.swapFrom - 1 === i) s.put(0, y, CURSOR_HOLLOW);
    if (this.mode === PARTY_MENU.USE_TM) {
      s.text(12, y + 1, canLearnTM(mon.species, this.params.item, gd) ? 'ABLE' : 'NOT ABLE');
    } else if (this.mode === PARTY_MENU.EVO_STONE) {
      const able = (gd.species(mon.species).evolutions || []).some((e) => e.method === 'item' && e.item === gd.item(this.params.item).const);
      s.text(12, y + 1, able ? 'ABLE' : 'NOT ABLE');
    } else {
      s.status(17, y, mon.hp, mon.status);
      s.hp(4, y + 1, mon.hp, mon.maxHP, HP_BAR_PARTY);
    }
    s.level(13, y, mon.level);
  }

  /** wPartyMenuHPBarColors[i]. */
  hpColor(i) {
    const mon = this.party[i];
    if (!mon) return 0;
    return hpBarColor(mon.hp > 0 ? hpBarPixels(mon.hp, mon.maxHP) : 0);
  }

  /** AnimatePartyMon for the menu cursor's mon (called every frame of HandleMenuInput). */
  animIdle(i, f) {
    const c = PARTY_MON_SPEEDS[this.hpColor(i)] + (ON_SGB ? 0 : 1);
    this.anim = { index: i, frame2: (f % (2 * c)) >= c };
  }

  drawExtra(fb) {
    if (!this.showIcons) return;
    this.party.forEach((mon, i) => {
      if (this.hiddenIcons.has(i)) return;
      const icon = this.ctx.icon(mon.species);
      if (!icon.img) return;
      const f2 = this.anim.index === i && this.anim.frame2;
      if (icon.bob) fb.blit(icon.img, 0, 0, 16, 16, 8, 16 * i + (f2 ? 1 : 0), { obj: 0 });
      else fb.blit(icon.img, 0, f2 ? 16 : 0, 16, 16, 8, 16 * i, { obj: 0 });
    });
  }

  // ------------------------------------------------------------------ input

  /**
   * HandlePartyMenuInput (incl. the swap state). @returns {Generator<any, number>} index or -1
   */
  *choose({ forceChoose = false } = {}) {
    for (;;) {
      const n = this.party.length;
      const r = yield* this.menuInput({
        x: 0, y: 1, max: Math.max(0, n - 1), current: this.cursor, last: this.cursor, wrap: true,
        watched: forceChoose ? ['a'] : ['a', 'b'], idle: (i, f) => this.animIdle(i, f),
      });
      this.anim = { index: -1, frame2: false };
      this.hollowCursor();
      this.cursor = r.index;
      if (this.swapFrom) {
        if (r.keys.b) {
          for (let i = 0; i < 6; i++) this.scr.put(0, 1 + 2 * i, SPACE);
          this.swapFrom = 0;
          this.mode = PARTY_MENU.NORMAL;
          yield* this.redraw();
          continue;
        }
        yield* this.switchMon(r.index);
        continue;
      }
      if (r.keys.b || n === 0) return -1;
      return r.index;
    }
  }

  /** SwitchPartyMon: swap the data, clear both rows (SFX_SWAP each), redraw. */
  *switchMon(index) {
    const first = this.swapFrom - 1;
    this.swapFrom = 0;
    this.mode = PARTY_MENU.NORMAL;
    if (first !== index) partySwap(this.state, first, index);
    for (const row of [first, index]) {
      this.scr.clearArea(0, 2 * row, 20, 2);
      this.hiddenIcons.add(row);
      yield* this.sfxWait('SFX_SWAP');
    }
    yield* this.redraw();
  }

  // ------------------------------------------------------------------ HP bar / stats box

  /**
   * UpdateHPBar2 on the party menu (row of party index `i`): HP moves 1 point per step; every
   * step reprints the number (1 frame) and draws each pixel of change (2 frames each).
   */
  *animateHP(i, from, to, maxHp) {
    const s = this.scr;
    const x = 4, y = 1 + 2 * i;
    if (from === to) return;
    const delta = to < from ? -1 : 1;
    const px = (hp) => (hp > 0 ? hpBarPixels(hp, maxHp) : 0);
    let old = from;
    const printNum = (hp) => {
      s.clearArea(x + 9, y, 3, 1);
      s.num(x + 9, y, hp, 3);
    };
    while (old !== to) {
      const next = old + delta;
      const oldPx = px(old), newPx = px(next);
      printNum(old);
      yield 1;
      const diff = Math.abs(newPx - oldPx);
      let e = oldPx;
      for (let k = 0; k < diff; k++) {
        s.hpBarPixels(x, y, e, HP_BAR_PARTY);
        yield 2;
        e += delta;
        if (e > 48) break;
      }
      old = next;
    }
    printNum(to);
    s.hpBarPixels(x, y, px(to), HP_BAR_PARTY);
    yield 2;
    yield 3;
  }

  /** PrintStatsBox (LEVEL_UP_STATS_BOX): box (9,2) 11×10, labels (11,3), values (15,4..10). */
  levelUpStatsBox(stats) {
    const s = this.scr;
    s.box(9, 2, 11, 10);
    s.text(11, 3, 'ATTACK\nDEFENSE\nSPEED\nSPECIAL');
    [stats.atk, stats.def, stats.spd, stats.spc].forEach((v, k) => s.num(15, 4 + 2 * k, v, 3));
  }

  // ------------------------------------------------------------------ START menu flow

  /**
   * StartMenu_Pokemon. @returns {Generator<any, object|null>} null back to the START menu, or a
   * request for the overworld ({type:'fieldMove', ...}).
   */
  *startFlow() {
    let redisplay = true;
    for (;;) {
      if (redisplay) {
        this.swapFrom = 0;
        this.mode = PARTY_MENU.NORMAL;
        yield* this.display(PARTY_MENU.NORMAL);
      }
      redisplay = false;
      const i = yield* this.choose();
      if (i < 0) {
        yield* this.whiteOutDelay3();
        return null;
      }
      const res = yield* this.monSubmenu(i);
      if (res === 'exit') {
        yield* this.whiteOutDelay3();
        return null;
      }
      if (res === 'redisplay') { redisplay = true; continue; }
      if (res === 'loop') {
        // .loop: GoBackToPartyMenu (no white-out, redraw with "Choose a POKéMON.")
        this.mode = PARTY_MENU.NORMAL;
        yield* this.redraw();
        continue;
      }
      if (res === 'swap') {
        // .choseSwitch: wMenuItemToSwap = mon + 1, "Move POKéMON where?"
        this.swapFrom = i + 1;
        this.mode = PARTY_MENU.SWAP;
        yield* this.redraw(PARTY_MENU.SWAP);
        continue;
      }
      if (res && typeof res === 'object') return res;
    }
  }

  /**
   * DisplayFieldMoveMonMenu + the choice. @returns 'loop' | 'exit' | 'redisplay' | 'swap' | request
   */
  *monSubmenu(i) {
    const gd = this.gd;
    const mon = this.party[i];
    const moves = monFieldMoves(mon, gd);
    const s = this.scr;
    const saved = s.save(); // SaveScreenTilesToBuffer1
    // wFieldMovesLeftmostXCoord: starts at 12, the smallest "leftmost tile" of the moves
    // (data/items.json menuTileColumn is that value + 1: the column of the first letter)
    let left = 12;
    for (const fm of moves) left = Math.min(left, fm.menuTileColumn - 1);
    const n = moves.length;
    if (n === 0) {
      s.box(11, 11, 9, 7);
      s.text(13, 12, 'STATS\nSWITCH\nCANCEL');
      left = 12;
    } else {
      const top = 11 - 2 * n - 1;
      s.box(left - 1, top, 21 - left, 17 - top + 1);
      s.text(left + 1, 12 - 2 * n, moves.map((m) => m.menuName).join('\n'));
      s.text(left + 1, 12, 'STATS\nSWITCH\nCANCEL');
    }
    const r = yield* this.menuInput({ x: left, y: 12 - 2 * n, max: 2 + n, current: 0, last: 0 });
    s.restore(saved); // LoadScreenTilesFromBuffer1
    if (r.keys.b) return 'loop';
    const choice = r.index;
    if (choice === n + 2) return 'exit';
    if (choice === n + 1) {
      if (this.party.length < 2) return 'redisplay';
      return 'swap';
    }
    if (choice === n) {
      yield* this.child(new StatusScreenScene({ mon, box: false }));
      return 'redisplay';
    }
    return yield* this.fieldMove(moves[choice].move, i);
  }

  /** .choseOutOfBattleMove */
  *fieldMove(move, i) {
    const env = this.params.env || {};
    const mon = this.party[i];
    const vars = { wNameBuffer: mon.nickname };
    if (move === 'SOFTBOILED') return yield* this.softboiled(i);
    const r = useFieldMove(this.state, move, { ...env, user: i });
    if (!r.ok) {
      if (r.text) yield* this.print(r.text, { subs: { ...vars, ...r.vars } });
      return 'loop';
    }
    const request = (extra = {}) => ({ type: 'fieldMove', move, monIndex: i, request: r.request || null, ...extra });
    switch (move) {
      case 'CUT': {
        if (typeof env.canCut === 'function' && !env.canCut()) {
          yield* this.print('_NothingToCutText');
          return 'loop';
        }
        return request();
      }
      case 'FLY': {
        const dest = yield* this.child(new FlyMapScene({ destinations: visitedFlyDestinations(this.state, this.gd) }));
        if (!dest) return 'redisplay';
        return request({ destination: dest.map, warp: dest });
      }
      case 'SURF': {
        if (env.surfAllowed === false) return 'loop';
        if (r.request && r.request.kind === 'stopSurfing') return request();
        yield* this.print('_SurfingGotOnText', { subs: vars });
        yield* this.whiteOutDelay3();
        return request();
      }
      case 'STRENGTH': {
        yield* this.print([{ cmd: 'text_far', label: '_UsedStrengthText' }], { subs: vars });
        // text_asm: PlayCry (plays and waits for the cry), Delay3
        yield* this.cryWait(mon.species);
        yield 3;
        // PrintStrengthTxt: a second PrintText (fresh box)
        yield* this.print('_CanMoveBouldersText', { subs: vars });
        yield* this.whiteOutDelay3();
        return request();
      }
      case 'FLASH': {
        yield* this.print('_FlashLightsAreaText');
        yield* this.whiteOutDelay3();
        return request();
      }
      case 'DIG': {
        yield* this.whiteOutDelay3();
        return request();
      }
      case 'TELEPORT': {
        yield* this.print('_WarpToLastPokemonCenterText');
        yield 60;
        yield* this.whiteOutDelay3();
        return request();
      }
      default:
        return 'loop';
    }
  }

  /**
   * SOFTBOILED: needs HP > max/5 ("Not healthy enough."), then "Use item on which POKéMON?"
   * (choosing the user again forces another choice), both HP bars animate, "X recovered by N!".
   */
  *softboiled(user) {
    const u = this.party[user];
    const amount = Math.floor(u.maxHP / 5);
    if (u.hp <= amount) {
      yield* this.print('_NotHealthyEnoughText');
      return 'loop';
    }
    const savedCursor = this.cursor;
    for (;;) {
      this.mode = PARTY_MENU.USE_ITEM;
      yield* this.redraw(PARTY_MENU.USE_ITEM);
      const t = yield* this.choose();
      if (t < 0) { this.cursor = savedCursor; return 'loop'; }
      if (t === user) continue;
      const target = this.party[t];
      if (target.hp === 0 || target.hp === target.maxHP) {
        yield* this.print('_ItemUseNoEffectText');
        this.cursor = savedCursor;
        return 'loop';
      }
      const uFrom = u.hp, tFrom = target.hp;
      u.hp -= amount;
      target.hp = Math.min(target.maxHP, target.hp + amount);
      this.sfx('SFX_HEAL_HP');
      yield* this.animateHP(user, uFrom, u.hp, u.maxHP);
      this.sfx('SFX_HEAL_HP');
      yield* this.animateHP(t, tFrom, target.hp, target.maxHP);
      this.mode = PARTY_MENU.NORMAL;
      this.scr.clear();
      yield* this.redraw({ label: ITEM_MSG.POTION, index: t, subs: { wHPBarHPDifference: target.hp - tFrom } });
      yield 50;
      yield* this.waitButton();
      this.cursor = savedCursor;
      return 'loop';
    }
  }
}
