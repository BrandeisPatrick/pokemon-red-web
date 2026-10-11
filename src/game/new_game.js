// newGame(): the exact state a NEW GAME starts with (OakSpeech → InitPlayerData2,
// engine/movie/oak_speech/*.asm; PrepareForSpecialWarp → NewGameWarp).

import { getGameData } from '../pokemon/data.js';
import { Rng } from '../engine/rng.js';
import { GameState, DEFAULT_OPTIONS } from './state.js';
import { Missables } from './flags.js';
import { makePCItems } from '../pokemon/bag.js';

/** START_MONEY = $3000 BCD = ¥3000. */
export const START_MONEY = 3000;
/** Default names offered by the naming menus (Red version). */
export const DEFAULT_PLAYER_NAMES = Object.freeze(['RED', 'ASH', 'JACK']);
export const DEFAULT_RIVAL_NAMES = Object.freeze(['BLUE', 'GARY', 'JOHN']);

/**
 * A fresh game:
 *  - player ID = two random bytes (hRandomSub → high byte, hRandomAdd → low byte),
 *  - ¥3000, 0 coins, no badges, empty party / boxes / bag / Pokédex,
 *  - all event flags and map scripts cleared, toggleable objects at their initial state,
 *  - one POTION in the PC (OakSpeech adds it to wBoxItems),
 *  - in Red's room (data/maps_meta.json newGame: REDS_HOUSE_2F 3,6) facing down, last
 *    outdoor map / blackout map Pallet Town.
 * @param {{playerName?:string, rivalName?:string, seed?:number, options?:object}} [o]
 * @returns {GameState}
 */
export function newGame({ playerName = 'RED', rivalName = 'BLUE', seed, options } = {}, gd = getGameData()) {
  const usedSeed = seed === undefined || seed === null ? Date.now() >>> 0 : seed >>> 0;
  const rng = new Rng(usedSeed);
  const hi = rng.randByte();
  const lo = rng.randByte();
  const start = gd.mapsMeta.newGame;
  // wLastMap = PALLET_TOWN (PrepareForSpecialWarp). The game stores only the map; x/y/warpIndex
  // are Pallet Town's warp 0 (5,5) = Red's house door, where REDS_HOUSE_1F's LAST_MAP exit leads.
  const lastOutdoor = { map: 'PALLET_TOWN', x: 5, y: 5, warpIndex: 0 };
  const state = new GameState({
    playerName,
    rivalName,
    playerId: (hi << 8) | lo,
    money: START_MONEY,
    coins: 0,
    badges: 0,
    flags: [],
    hiddenItems: [],
    party: [],
    bag: [],
    pcItems: [],
    pos: { map: start.map, x: start.x, y: start.y, facing: 'down' },
    lastOutdoor,
    lastBlackoutMap: 'PALLET_TOWN',
    options: { ...DEFAULT_OPTIONS, ...(options || {}) },
    safari: { steps: 0, balls: 0, gameOver: false },
    seed: usedSeed,
  }, gd);
  state.missables = Missables.initial(gd);
  state.pcItems = makePCItems();
  state.pcItems.add('POTION', 1, gd);
  return state;
}
