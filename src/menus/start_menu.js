// The START menu (home/start_menu.asm DisplayStartMenu / RedisplayStartMenu,
// engine/menus/draw_start_menu.asm DrawStartMenu, engine/menus/start_sub_menus.asm).
//
// Box (10,0): 10×16 with the Pokédex, 10×14 without; items at (12,2) two rows apart; cursor
// column 11; the last choice is remembered (wBattleAndStartSavedMenuItem); up on the first item
// / down past the last wraps; A opens the entry (▷ marks it), B or START closes the menu.
// In the Safari Zone a 9×5 box with the steps and balls is drawn at (0,0).
//
// Resolves with null (closed) or a request for the overworld (see docs/menus.md):
//   {type:'fieldMove', move, monIndex, request, destination?, warp?}
//   {type:'useItem', item, request}

import { MenuScene } from './base.js';
import { PartyMenuScene } from './party_menu.js';
import { BagScene } from './bag_menu.js';
import { PokedexScene } from './pokedex.js';
import { TrainerCardScene } from './trainer_card.js';
import { SaveScene } from './save_menu.js';
import { optionsScreen } from '../intro/options.js';

export const START_ITEMS = Object.freeze(['POKEDEX', 'POKEMON', 'ITEM', 'TRAINER', 'SAVE', 'OPTION', 'EXIT']);

/** Safari Zone maps (SAFARI_ZONE_EAST <= id < CERULEAN_CAVE_2F) show the steps box. */
export function inSafariZone(gd, mapConst) {
  const m = gd.findMap(mapConst);
  if (!m) return false;
  return m.id >= gd.map('SAFARI_ZONE_EAST').id && m.id < gd.map('CERULEAN_CAVE_2F').id;
}

/** The START-menu cursor wrap rules (RedisplayStartMenu .loop). Pure, for tests. */
export function startMenuMove(index, lastIndex, key, count) {
  if (key === 'up') {
    if (index === 0 && lastIndex === 0) return count - 1;
    return index;
  }
  if (key === 'down' && index >= count) return 0;
  return index;
}

export class StartMenuScene extends MenuScene {
  /**
   * @param {object} [params]
   * @param {boolean} [params.sound] play SFX_START_MENU (DisplayStartMenu; the overworld usually does)
   * @param {object} [params.env] overworld facts for field moves / items (see docs/menus.md)
   * @param {boolean} [params.link] BIT_LINK_CONNECTED: RESET instead of SAVE
   */
  constructor(params = {}) {
    super({ ...params, opaque: false, vramMode: 'text' });
  }

  hasDex() {
    try { return this.state.flags.get('EVENT_GOT_POKEDEX'); } catch { return false; }
  }

  /** DrawStartMenu (+ PrintSafariZoneSteps). */
  drawMenu() {
    const s = this.scr;
    const dex = this.hasDex();
    s.box(10, 0, 10, dex ? 16 : 14);
    const items = [];
    if (dex) items.push('POKéDEX');
    items.push('POKéMON', 'ITEM', this.state.playerName, this.params.link ? 'RESET' : 'SAVE', 'OPTION', 'EXIT');
    items.forEach((t, i) => s.text(12, 2 + 2 * i, t));
    const pos = this.state.pos && this.state.pos.map;
    if (pos && inSafariZone(this.gd, pos)) {
      s.box(0, 0, 9, 5);
      s.num(1, 1, this.state.safari.steps | 0, 3);
      s.text(4, 1, '/500');
      s.text(1, 3, 'BALL×× ');
      const balls = this.state.safari.balls | 0;
      if (balls < 10) s.put(5, 3, 0x7f);
      s.num(6, 3, balls, 2);
    }
    return items.length;
  }

  *main() {
    const savedPal = this.savePalette();
    if (this.params.sound) this.sfx('SFX_START_MENU');
    const finish = (r) => { this.restorePalette(savedPal); return r; };
    for (;;) {
      // RedisplayStartMenu
      this.scr.reset();
      const count = this.drawMenu();
      let cur = Math.min(this.ctx.saved.startMenu || 0, count - 1);
      let last = cur;
      let keys;
      for (;;) {
        const r = yield* this.menuInput({
          x: 11, y: 2, max: count, current: cur, last,
          watched: ['up', 'down', 'start', 'b', 'a'],
        });
        const prev = cur;
        cur = r.index;
        keys = r.keys;
        last = prev;
        if (keys.up || keys.down) {
          const n = startMenuMove(cur, prev, keys.up ? 'up' : 'down', count);
          if (n !== cur) { this.eraseCursor(); cur = n; }
          continue;
        }
        break;
      }
      this.hollowCursor();
      this.ctx.saved.startMenu = cur;
      if (keys.b || keys.start) {
        // CloseStartMenu
        return finish(null);
      }
      const choice = START_ITEMS[this.hasDex() ? cur : cur + 1];
      const result = yield* this.openEntry(choice);
      this.restorePalette(savedPal);
      if (result === 'close') return finish(null);
      if (result && typeof result === 'object') return finish(result);
    }
  }

  /** @returns 'redisplay' | 'close' | request object */
  *openEntry(choice) {
    const env = this.params.env || {};
    switch (choice) {
      case 'POKEDEX':
        yield* this.child(new PokedexScene());
        yield 3;
        return 'redisplay';
      case 'POKEMON': {
        if (!this.state.party.length) return 'redisplay';
        const r = yield* this.child(new PartyMenuScene({ start: true, env }));
        return r || 'redisplay';
      }
      case 'ITEM': {
        const r = yield* this.child(new BagScene({ env }));
        return r || 'redisplay';
      }
      case 'TRAINER':
        yield* this.child(new TrainerCardScene());
        return 'redisplay';
      case 'SAVE':
        // StartMenu_SaveReset: in the Cable Club the entry is RESET (jp Init: soft reset)
        if (this.params.link) return { type: 'reset' };
        this.scr.reset();
        yield* this.child(new SaveScene());
        return 'close';
      case 'OPTION':
        // StartMenu_Option: the intro's option screen edits state.options in place
        yield optionsScreen(this.state.options, this.game, { audio: this.snd.audio });
        this.flushInput();
        return 'redisplay';
      case 'EXIT':
      default:
        return 'close';
    }
  }
}
