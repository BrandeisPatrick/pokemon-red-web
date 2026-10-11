// Everything the menu scenes share: the game data, the combined tile sheet, the per-screen
// VRAM tables, the common texts, the UI images, the sound adapter. Built once per game by
// ensureMenus(game) (async: fetches JSON + PNGs through game.assets) and cached on the game.

import { loadGameData, getGameData } from '../pokemon/data.js';
import { textResolver } from '../engine/text.js';
import { buildCharmap, combineSheets, makeVram, vramRange } from './screen.js';
import { MenuSound } from './sound.js';

/** UI images loaded up front (name -> path). Pokémon front pics are loaded lazily. */
export const MENU_IMAGES = Object.freeze({
  pokedex: 'assets/ui/pokedex.png',
  balls: 'assets/battle/balls.png',
  badges: 'assets/ui/trainer_card/badges.png',
  badgeNumbers: 'assets/ui/trainer_card/badge_numbers.png',
  blankNames: 'assets/ui/trainer_card/blank_leader_names.png',
  circle: 'assets/ui/trainer_card/circle_tile.png',
  trainerInfo: 'assets/ui/trainer_card/trainer_info.png',
  redPic: 'assets/trainers/red.png',
  townMap: 'assets/town_map/town_map.png',
  townMapCursor: 'assets/town_map/town_map_cursor.png',
  nestIcon: 'assets/town_map/mon_nest_icon.png',
  upArrow: 'assets/town_map/up_arrow.png',
  redSprite: 'assets/sprites/red.png',
  birdSprite: 'assets/sprites/bird.png',
  slotsBg: 'assets/slots/slots_bg_tiles.png',
  slotsSymbols: 'assets/slots/red_slots_2.png',
  tradeGameBoy: 'assets/ui/trade/game_boy_tiles.png',
  tradeLinkCable: 'assets/ui/trade/link_cable.png',
  tradeCableBall: 'assets/ui/trade/cable_ball.png',
  tradeBubble: 'assets/ui/trade/bubble.png',
  healMachine: 'assets/overworld/heal_machine.png',
  icon_MON: 'assets/ui/icons/mon.png',
  icon_BALL: 'assets/ui/icons/ball.png',
  icon_HELIX: 'assets/ui/icons/helix.png',
  icon_FAIRY: 'assets/ui/icons/fairy.png',
  icon_BIRD: 'assets/ui/icons/bird.png',
  icon_WATER: 'assets/ui/icons/water.png',
  icon_BUG: 'assets/ui/icons/bug.png',
  icon_GRASS: 'assets/ui/icons/grass.png',
  icon_SNAKE: 'assets/ui/icons/snake.png',
  icon_QUADRUPED: 'assets/ui/icons/quadruped.png',
});

/** Images whose tiles go into the combined sheet (in this order). */
const SHEET_IMAGES = ['pokedex', 'balls', 'badges', 'badgeNumbers', 'blankNames', 'circle', 'trainerInfo',
  'redPic', 'townMap', 'upArrow', 'slotsBg', 'tradeGameBoy', 'tradeLinkCable'];

/** Icons animated by moving the image 1 px instead of swapping frames (AnimatePartyMon). */
export const BOB_ICONS = new Set(['ICON_BALL', 'ICON_HELIX']);

export class MenuContext {
  constructor(game, { gd, common, townMap, images }) {
    this.game = game;
    this.gd = gd;
    this.font = game.font;
    this.common = common;
    this.townMap = townMap;
    this.images = images;
    this.charmap = buildCharmap(this.font);
    const extras = SHEET_IMAGES.filter((n) => images[n]).map((name) => ({ name, img: images[name] }));
    this.sheet = combineSheets(this.font.gfx, extras);
    this.sound = new MenuSound(game);
    this.resolveCommon = textResolver(common);
    /** map name -> loaded data/text/<Map>.json */
    this.mapTexts = new Map();
    /** dex -> front pic IndexedImage */
    this.pics = new Map();
    this.vram = this._buildVrams();
    /** remembered cursor positions (wBattleAndStartSavedMenuItem, wBagSavedMenuItem, ...) */
    this.saved = { startMenu: 0, bag: { cursor: 0, scroll: 0 }, party: 0, billsPc: 0 };
  }

  /** @private */
  _buildVrams() {
    const f = this.font, sb = this.sheet.base;
    // a missing image (failed load) leaves its bytes as they are instead of breaking
    const b = new Proxy(sb, { get: (t, k) => (k in t ? t[k] : f.space) });
    const v = {};
    v.text = makeVram(f, 'text');
    v.menu = makeVram(f, 'menu');
    v.status = makeVram(f, 'status');
    v.battle = makeVram(f, 'battle');
    // LoadPokedexTilePatterns: HP/status tiles, then the Pokédex tiles at $60, the ball at $72
    v.pokedex = makeVram(f, 'menu', [...vramRange(0x60, b.pokedex, 18), [0x72, b.balls]]);
    // BillsPCMenu: PokeballTileGraphics over $78
    v.billsPc = makeVram(f, 'menu', [[0x78, b.balls]]);
    // DisplayNamingScreen: HP/status tiles (underscores $76/$77) + the ED tile at $F0
    v.naming = makeVram(f, 'menu', [[0xf0, f.chars['<ED>']]]);
    // DrawTrainerInfo
    v.trainerCard = makeVram(f, 'text', [
      ...vramRange(0x20, b.badges, 64),
      ...vramRange(0x60, b.blankNames, 22),
      [0x76, b.circle],
      ...vramRange(0x77, b.trainerInfo, 8),
      [0xd6, f.chars['<COLON>']],
      [0xd7, b.trainerInfo + 8],
      ...vramRange(0xd8, b.badgeNumbers, 8),
    ]);
    // LoadTownMap: map tiles at $60; LoadTownMap_Fly: the up arrow at $ED
    v.townMap = makeVram(f, 'text', [...vramRange(0x60, b.townMap, 16), [0xed, b.upArrow]]);
    // LoadSlotMachineTiles: red_slots_1 at $00, red_slots_2 at $25 (slots_bg_tiles = VRAM order)
    v.slots = makeVram(f, 'text', vramRange(0x00, b.slotsBg, 64));
    // LoadTradingGFXAndMonNames (after LoadHpBarAndStatusTilePatterns): game boy + cable at $31
    v.trade = makeVram(f, 'menu', [...vramRange(0x31, b.tradeGameBoy, 34), ...vramRange(0x53, b.tradeLinkCable, 15)]);
    return v;
  }

  /** The loaded GameState (game.state). */
  get state() { return this.game.state; }

  /** Text commands for a label (common texts, then the given map texts). */
  textCommands(label, mapName) {
    if (mapName) {
      const doc = this.mapTexts.get(mapName);
      const t = doc && doc.texts && doc.texts[label];
      if (t && t.commands) return t.commands;
    }
    return this.resolveCommon(label);
  }

  /** Load data/text/<Map>.json (cached). */
  async loadMapText(mapName) {
    if (this.mapTexts.has(mapName)) return this.mapTexts.get(mapName);
    const doc = await this.game.assets.json(`data/text/${mapName}.json`);
    this.mapTexts.set(mapName, doc);
    return doc;
  }

  /** Front pic of a species (dex or ref), cached. @returns {Promise<IndexedImage>} */
  async frontPic(species) {
    const sp = this.gd.species(species);
    if (this.pics.has(sp.dex)) return this.pics.get(sp.dex);
    const img = await this.game.assets.image(sp.sprites.front);
    this.pics.set(sp.dex, img);
    return img;
  }

  /** The cached front pic or null (synchronous). */
  frontPicSync(species) {
    const sp = this.gd.findSpecies(species);
    return (sp && this.pics.get(sp.dex)) || null;
  }

  /** Party icon image + animation kind for a species. */
  icon(species) {
    const sp = this.gd.species(species);
    const name = sp.menuIcon || 'ICON_MON';
    return { img: this.images[`icon_${name.replace(/^ICON_/, '')}`] || this.images.icon_MON, bob: BOB_ICONS.has(name), name };
  }
}

/**
 * Load everything the menus need (idempotent; concurrent calls share one load).
 * @param {any} game  needs game.font and game.assets ({json(url), image(url)})
 * @returns {Promise<MenuContext>}
 */
export function ensureMenus(game) {
  if (game._menuCtx) return Promise.resolve(game._menuCtx);
  if (game._menuCtxLoading) return game._menuCtxLoading;
  game._menuCtxLoading = (async () => {
    const gd = game.gameData || await loadGameData();
    const assets = game.assets;
    const [common, townMap] = await Promise.all([
      assets.json('data/text/common.json'),
      assets.json('data/town_map.json'),
    ]);
    const images = {};
    await Promise.all(Object.entries(MENU_IMAGES).map(async ([name, path]) => {
      try {
        images[name] = await assets.image(path);
      } catch (err) {
        console.warn(`[menus] cannot load ${path}:`, err && err.message ? err.message : err);
      }
    }));
    const ctx = new MenuContext(game, { gd, common, townMap, images });
    game._menuCtx = ctx;
    return ctx;
  })();
  game._menuCtxLoading.catch(() => { game._menuCtxLoading = null; });
  return game._menuCtxLoading;
}

/** The context if already loaded (throws otherwise). */
export function menuContext(game) {
  if (!game._menuCtx) throw new Error('menus: call `await ensureMenus(game)` first');
  return game._menuCtx;
}

export { getGameData };
