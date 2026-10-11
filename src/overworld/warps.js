// Warp resolution and wLastMap bookkeeping (WarpFound2, home/overworld.asm;
// docs/data-format-maps.md §6, §13.4-13.6). Pure.
//
// state.lastOutdoor = { map, x, y, warpIndex }:
//   map        name of the outdoor map the player last left through a warp (wLastMap); LAST_MAP
//              warps go there. Connections never change it. Special warps (fly, escape rope,
//              blackout, new game) set it to their destination.
//   x, y       the player's position on that map when leaving (the warp's cell), or null
//   warpIndex  0-based index of the warp used to leave it (wWarpedFromWhichWarp), or null

/**
 * Where a warp leads.
 * @param {any} warp entry of map.warps
 * @param {{map?:string}|null} lastOutdoor state.lastOutdoor
 * @returns {{map: string, warpIndex: number}|null} null if the warp leads nowhere (LAST_MAP with
 *   no last map, or a placeholder id rewritten by a script)
 */
export function resolveWarp(warp, lastOutdoor) {
  if (warp.destMapId === -1 || warp.destMap === 'LAST_MAP') {
    if (!lastOutdoor || !lastOutdoor.map) return null;
    return { map: lastOutdoor.map, warpIndex: warp.destWarpIndex };
  }
  if (!warp.destMapName) return null;
  return { map: warp.destMapName, warpIndex: warp.destWarpIndex };
}

/**
 * WarpFound2: leaving an outside map through a warp records it as wLastMap.
 * @param {any} fromMap data/maps/<Map>.json of the map being left
 * @param {number} warpIndex 0-based warp used
 * @param {number} x
 * @param {number} y
 * @returns {{map:string,x:number,y:number,warpIndex:number}|null} new lastOutdoor, or null
 *   when the map is not an outside map (lastOutdoor unchanged)
 */
export function lastOutdoorAfterWarp(fromMap, warpIndex, x, y) {
  if (!fromMap.isOutside) return null;
  return { map: fromMap.name, x, y, warpIndex };
}

/**
 * Map scripts that overwrite wLastMap every frame (map.scriptSetsLastMap, §13.6).
 * PokemonTower7F only does it when Mr. Fuji warps you out - that is story scripting.
 * Route22Gate picks ROUTE_23 when y < 4, else ROUTE_22 (scripts/Route22Gate.asm).
 * @param {any} map
 * @param {number} x
 * @param {number} y
 * @returns {string|null} map const forced into wLastMap, or null
 */
export function scriptLastMapOverride(map, x, y) {
  const list = map.scriptSetsLastMap;
  if (!list || list.length === 0) return null;
  if (map.const === 'POKEMON_TOWER_7F') return null;
  if (map.const === 'ROUTE_22_GATE') return y < 4 ? 'ROUTE_23' : 'ROUTE_22';
  return list.length === 1 ? list[0] : null;
}
