// Out-of-battle menus of Pokémon Red as scenes on the engine's scene stack.
//
//   import { installMenus } from './menus/index.js';
//   installMenus(game);                       // game.menus = { startMenu, partyMenu, ... }
//   const req = await game.menus.startMenu(); // null, or a request for the overworld
//
// Every entry point pushes a scene on game.scenes and resolves with its result when it pops
// (await it, or `yield` the promise inside a scene coroutine). game.state must hold the
// GameState. See docs/menus.md for the requests, hooks and the env object.

import { ensureMenus, menuContext } from './context.js';
import { StartMenuScene } from './start_menu.js';
import { PartyMenuScene, PARTY_MENU } from './party_menu.js';
import { StatusScreenScene } from './status_screen.js';
import { BagScene } from './bag_menu.js';
import { PokedexScene, PokedexDataScene } from './pokedex.js';
import { PcScene, dexRating } from './pc.js';
import { MartScene } from './mart.js';
import { PokecenterScene } from './pokecenter.js';
import { GameCornerScene } from './game_corner.js';
import { SlotsScene } from './slots.js';
import { TownMapScene, FlyMapScene, NestMapScene } from './town_map.js';
import { TradeScene, TradeAnimScene } from './trade.js';
import { SaveScene } from './save_menu.js';
import { TrainerCardScene } from './trainer_card.js';
import { MenuScene } from './base.js';
import { visitedFlyDestinations } from '../pokemon/items_effects.js';

async function open(game, scene, params) {
  await ensureMenus(game);
  const pal = game.palette;
  // restored synchronously when the scene pops (MenuScene.exit), like LoadGBPal
  if (pal && pal.bgp) scene.restorePaletteOnExit = { bgp: pal.bgp.slice(), obp0: pal.obp0.slice(), obp1: pal.obp1.slice() };
  game.scenes.push(scene, params);
  return scene.finished;
}

/**
 * The START menu. @param {{env?:object, sound?:boolean, link?:boolean}} [opts]
 * @returns {Promise<null|object>} null when closed, or {type:'fieldMove'|'useItem', ...}
 */
export function startMenu(game, opts = {}) { return open(game, new StartMenuScene(opts)); }

/**
 * The party menu. opts.mode = PARTY_MENU.* (message / ABLE column), opts.item for TM/stone
 * menus, opts.forceChoose; opts.start runs the START-menu flow (returns a request or null).
 * @returns {Promise<number|object|null>} the chosen index, -1 for B
 */
export function partyMenu(game, opts = {}) { return open(game, new PartyMenuScene(opts)); }

/** The status screen (2 pages) of a party or box mon. */
export function statsScreen(game, mon, opts = {}) { return open(game, new StatusScreenScene({ ...opts, mon })); }

/** The ITEM menu. @returns {Promise<null|object>} null, or {type:'useItem', item, request} */
export function bagMenu(game, opts = {}) { return open(game, new BagScene(opts)); }

/** The Pokédex; {species} opens the entry page directly (ShowPokedexData). */
export function pokedexScene(game, opts = {}) {
  return open(game, opts.species ? new PokedexDataScene(opts) : new PokedexScene(opts));
}

/** A PC: kind 'pokecenter' (default), 'bills' or 'players'. */
export function pcScene(game, kind = 'pokecenter', opts = {}) { return open(game, new PcScene({ ...opts, kind })); }

/** A Poké Mart by mart label / map / {map, textConst} / item list. */
export function martScene(game, martId, opts = {}) { return open(game, new MartScene({ ...opts, mart: martId })); }

/** The Pokémon Center nurse. @param {{nurse?:any, mapMusic?:string}} [opts] */
export function healScene(game, opts = {}) { return open(game, new PokecenterScene(opts)); }

/** Game Corner: {mode:'coins'} the coin clerk, {mode:'prizes', menu:0|1|2} the prize windows. */
export function gameCornerScene(game, opts = { mode: 'coins' }) { return open(game, new GameCornerScene(opts)); }

/** The slot machine. @param {{lucky?:boolean, check?:boolean}} [opts] */
export function slotsScene(game, opts = {}) { return open(game, new SlotsScene(opts)); }

/** The TOWN MAP item. */
export function townMapScene(game, opts = {}) { return open(game, new TownMapScene(opts)); }

/** The Fly destination map. @returns {Promise<{map,x,y}|null>} */
export async function flyMapScene(game, opts = {}) {
  await ensureMenus(game);
  const destinations = opts.destinations || visitedFlyDestinations(game.state, menuContext(game).gd);
  return open(game, new FlyMapScene({ ...opts, destinations }));
}

/** A species' nests (Pokédex AREA). */
export function nestMapScene(game, species, opts = {}) { return open(game, new NestMapScene({ ...opts, species })); }

/** An in-game NPC trade (dialogue + animation). @returns {Promise<{traded:boolean, mon?}>} */
export function tradeScene(game, tradeId, opts = {}) { return open(game, new TradeScene({ ...opts, trade: tradeId })); }

/** Only the trade animation. @param {{left:{species,otName,otId}, right:{...}, enemyName?}} opts */
export function tradeAnimScene(game, opts) { return open(game, new TradeAnimScene(opts)); }

/** SAVE from the START menu. @returns {Promise<{saved:boolean}>} */
export function saveFlow(game, opts = {}) { return open(game, new SaveScene(opts)); }

/** The trainer card. */
export function trainerCard(game, opts = {}) { return open(game, new TrainerCardScene(opts)); }

/** Oak's Pokédex rating as a standalone text scene (the lab / Oak's PC). */
export function dexRatingScene(game) {
  class DexRatingScene extends MenuScene {
    *main() { yield* dexRating(this); this.scr.reset(); return null; }
  }
  return open(game, new DexRatingScene());
}

/** Load the menu assets (optional: every entry point does it on first use). */
export function preloadMenus(game) { return ensureMenus(game); }

/** game.menus = every entry point bound to `game`. */
export function installMenus(game) {
  const bind = (fn) => (...args) => fn(game, ...args);
  game.menus = {
    startMenu: bind(startMenu), partyMenu: bind(partyMenu), statsScreen: bind(statsScreen), bagMenu: bind(bagMenu),
    pokedexScene: bind(pokedexScene), pcScene: bind(pcScene), martScene: bind(martScene), healScene: bind(healScene),
    gameCornerScene: bind(gameCornerScene), slotsScene: bind(slotsScene), townMapScene: bind(townMapScene),
    flyMapScene: bind(flyMapScene), nestMapScene: bind(nestMapScene), tradeScene: bind(tradeScene),
    tradeAnimScene: bind(tradeAnimScene), saveFlow: bind(saveFlow), trainerCard: bind(trainerCard),
    dexRatingScene: bind(dexRatingScene), preload: () => ensureMenus(game), PARTY_MENU,
  };
  return game.menus;
}

export {
  PARTY_MENU, StartMenuScene, PartyMenuScene, StatusScreenScene, BagScene, PokedexScene, PokedexDataScene, PcScene,
  MartScene, PokecenterScene, GameCornerScene, SlotsScene, TownMapScene, FlyMapScene, NestMapScene, TradeScene,
  TradeAnimScene, SaveScene, TrainerCardScene, MenuScene, ensureMenus,
};
