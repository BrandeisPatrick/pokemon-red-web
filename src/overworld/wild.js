// Wild encounters (TryDoWildEncounter, engine/battle/wild_encounters.asm;
// docs/data-format-pokemon.md §3.6). Pure.

import { TILE } from './constants.js';

/** WildMonEncounterSlotChances cumulative thresholds (chance total - 1). */
export const SLOT_THRESHOLDS = Object.freeze([50, 101, 140, 165, 190, 215, 228, 241, 252, 255]);

/**
 * Encounter slot for a random byte (hRandomSub): the first slot whose cumulative threshold is
 * >= the byte.
 * @param {number} r 0..255
 * @param {number[]} [thresholds]
 */
export function encounterSlot(r, thresholds = SLOT_THRESHOLDS) {
  for (let i = 0; i < thresholds.length; i++) if (r <= thresholds[i]) return i;
  return thresholds.length - 1;
}

/**
 * Which encounter table applies on a cell, and its rate.
 * @param {{grass?:{rate:number,slots:any[]}, water?:{rate:number,slots:any[]}}|null} wild
 *        data/wild/encounters.json maps[MAP_CONST] (null = none)
 * @param {number} tileBL bottom-left tile of the player's cell (screen (8,9))
 * @param {number} tileBR bottom-right tile (screen (9,9))
 * @param {number|null} grassTile tileset grass tile
 * @param {boolean} indoor map id >= FIRST_INDOOR_MAP
 * @param {string} tilesetConst e.g. 'FOREST'
 * @returns {{rate:number, slots:any[], kind:'grass'|'water'}|null}
 */
export function encounterTable(wild, tileBL, tileBR, grassTile, indoor, tilesetConst) {
  const grass = (wild && wild.grass) || { rate: 0, slots: [] };
  const water = (wild && wild.water) || { rate: 0, slots: [] };
  let rate;
  if (grassTile != null && tileBR === grassTile) rate = grass.rate;
  else if (tileBR === TILE.WATER) rate = water.rate;
  else if (indoor && tilesetConst !== 'FOREST') rate = grass.rate;
  else return null;
  // the WATER list only if the bottom-left tile is water too ("left shore" cells use grass)
  const useWater = tileBL === TILE.WATER;
  return { rate, slots: useWater ? water.slots : grass.slots, kind: useWater ? 'water' : 'grass' };
}

/**
 * The encounter roll: hRandomAdd < rate -> encounter; hRandomSub picks the slot.
 * @param {{rate:number, slots:any[]}} table
 * @param {{randByte:()=>number}} rng
 * @returns {{slot:number, mon:any}|null}
 */
export function rollEncounter(table, rng) {
  const add = rng.randByte();
  if (!(add < table.rate)) return null;
  const sub = rng.randByte();
  const slot = encounterSlot(sub);
  const mon = table.slots[slot];
  return mon ? { slot, mon } : null;
}
