// Per-map SGB palette (SetPal_Overworld, engine/gfx/palettes.asm; docs/data-format-maps.md §11)
// and the palette display modes of the overworld. Pure.

import { PALETTES } from '../engine/palette.js';

/** Palette display modes: the map's SGB palette, or one of the engine's DMG colour sets. */
export const PALETTE_MODES = Object.freeze(['sgb', 'dmg', 'gray', 'pocket', 'dmgClassic']);

/**
 * Name of the SGB palette SetPal_Overworld picks for a map.
 * @param {{id:number, tileset:string}} map  current map (map_index entry or map JSON)
 * @param {{id:number}|null} lastMap         map_index entry of wLastMap (state.lastOutdoor.map)
 * @param {{order:string[]}} sgb             data/sgb_palettes.json
 * @param {{firstIndoorMap:number, numCityMaps:number, ids: Record<string, number>}} idx
 *        map id constants: ids.CERULEAN_CAVE_2F, CERULEAN_CAVE_1F, LORELEIS_ROOM, BRUNOS_ROOM
 * @returns {string} e.g. 'PAL_PALLET'
 */
export function overworldPaletteName(map, lastMap, sgb, idx) {
  if (map.tileset === 'CEMETERY') return 'PAL_GRAYMON';
  if (map.tileset === 'CAVERN') return 'PAL_CAVE';
  const id = map.id;
  let a;
  if (id < idx.firstIndoorMap) {
    a = id;
  } else if (id >= idx.ids.CERULEAN_CAVE_2F && id <= idx.ids.CERULEAN_CAVE_1F) {
    return 'PAL_CAVE';
  } else if (id === idx.ids.LORELEIS_ROOM) {
    return sgb.order[1]; // xor a, then the town "+1": PAL_PALLET
  } else if (id === idx.ids.BRUNOS_ROOM) {
    return 'PAL_CAVE';
  } else {
    a = lastMap ? lastMap.id : 0; // .normalDungeonOrBuilding: wLastMap
  }
  return a < idx.numCityMaps ? sgb.order[a + 1] : 'PAL_ROUTE';
}

/**
 * The 4 colours (shade 0..3) for a palette mode.
 * @param {string} mode 'sgb' | 'dmg' | 'gray' | ...
 * @param {string} sgbName palette name for 'sgb'
 * @param {{palettes: Record<string, number[][]>}} sgb
 */
export function paletteColors(mode, sgbName, sgb) {
  if (mode === 'sgb') {
    const c = sgb.palettes[sgbName];
    if (c) return c;
    return PALETTES.dmg;
  }
  return PALETTES[mode] || PALETTES.dmg;
}
