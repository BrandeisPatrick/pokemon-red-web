// Pokémon Red battle engine: public entry points. See docs/battle.md.
//
//   import { startBattle } from './src/battle/index.js';
//   const result = await startBattle(game, { species: 'PIDGEY', level: 5 });
//
// game: { scenes, fb, input, palette, font, assets, rng, state (GameState), audio?, hooks? }

import { getGameData } from '../pokemon/data.js';
import { startBattle } from './scene.js';
import { Battle } from './core.js';
import { HeadlessUI, RandomController, ScriptController, runToEnd } from './headless_ui.js';
import { TextLibrary } from './text.js';

export { startBattle, BattleScene, loadBattleResources, battleImageUrls } from './scene.js';
export { Battle, hpBarPixels, isDungeonMap } from './core.js';
export { SceneUI, PicCache, formatBCD } from './scene_ui.js';
export { HeadlessUI, RandomController, ScriptController, runToEnd } from './headless_ui.js';
export { soakBattles, runSoakBattle, randomBattleSetup, randomMon } from './soak.js';
export { EvolutionScene, evolveHook } from './evolution_scene.js';
export { TextLibrary, flattenText, oneLine, far } from './text.js';
export { TransitionGrid, battleTransition, TRANSITION_NAMES } from './transitions.js';
export * as hud from './hud.js';
export { EFFECT_HANDLERS } from './effects.js';
export * from './constants.js';

/**
 * Run a battle without a screen (tests, tools): returns {result, battle, ui}.
 * @param {object} o
 * @param {any} o.state GameState
 * @param {object} o.params startBattle params
 * @param {{randByte:()=>number}} o.rng
 * @param {object} [o.controller] RandomController / ScriptController
 * @param {TextLibrary|object} [o.texts] TextLibrary or data/text/common.json
 */
export function runBattleHeadless({ state, params, rng, controller, texts, gd = getGameData(), verbose = false }) {
  const library = texts instanceof TextLibrary ? texts : new TextLibrary(texts || {});
  const ui = new HeadlessUI({ controller, text: library, verbose });
  const battle = new Battle({ state, params, rng, ui, text: library, gd });
  ui.attach(battle);
  const result = runToEnd(battle.run());
  return { result, battle, ui };
}

/** The overworld's result strings ('win', 'lose', 'blackout', 'run', 'caught', ...). */
export function overworldResult(r) {
  if (!r) return 'win';
  if (r.outcome === 'lose') return r.blackout ? 'blackout' : 'lose';
  if (r.outcome === 'ran') return 'run';
  return r.outcome;
}

/**
 * Hooks for src/overworld (OverworldScene({hooks})): wild and trainer battles through
 * startBattle, resolving to the strings the overworld expects. The full result object is kept
 * in game.lastBattleResult.
 * @param {any} game
 * @param {{params?: object}} [o] extra startBattle params for every battle
 */
export function battleHooks(game, { params = {} } = {}) {
  const done = (r) => {
    game.lastBattleResult = r;
    return overworldResult(r);
  };
  return {
    onWildEncounter(dex, level, info = {}) {
      return startBattle(game, { ...params, kind: 'wild', species: dex, level, mapName: info.map, map: info.mapConst }).then(done);
    },
    onTrainerBattle(mapName, objectIndex, trainerClass, partyIndex, texts = {}) {
      return startBattle(game, {
        ...params, kind: 'trainer', trainerClass, partyIndex, mapName, endBattleText: texts.end || null,
      }).then(done);
    },
  };
}
