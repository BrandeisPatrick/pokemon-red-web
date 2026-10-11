// Tile-based collision / warp / ledge rules (docs/data-format-maps.md §13, §14).
// Pure functions over the tileset JSON; the "tile" of a cell is always its bottom-left tile
// (MapGrid.cellTile).

import { TILE } from './constants.js';

const infoCache = new WeakMap();

/**
 * Lookup sets for a tileset JSON (cached per object).
 * @param {any} ts data/tilesets/<Tileset>.json
 */
export function tilesetInfo(ts) {
  let info = infoCache.get(ts);
  if (!info) {
    info = {
      walkable: new Set(ts.walkableTiles || []),
      doors: new Set(ts.doorTiles || []),
      warps: new Set(ts.warpTiles || []),
      counters: new Set(ts.counterTiles || []),
      surf: new Set(ts.surfTiles || []),
      pairLand: ts.pairCollisionsLand || [],
      pairWater: ts.pairCollisionsWater || [],
      ledges: ts.ledges || [],
      bookshelves: new Map((ts.bookshelfTiles || []).map((b) => [b.tile, b])),
      padsHoles: new Map((ts.warpPadHoleTiles || []).map((p) => [p.tile, p])),
      cutTiles: new Set((ts.cut && ts.cut.tiles) || []),
      cutSwaps: new Map(((ts.cut && ts.cut.blockSwaps) || []).map(([a, b]) => [a, b])),
    };
    infoCache.set(ts, info);
  }
  return info;
}

/** CheckTilePassable / CanWalkOntoTile: only walkableTiles are passable. */
export function isWalkable(ts, tile) {
  return tilesetInfo(ts).walkable.has(tile);
}

/**
 * CheckForTilePairCollisions: the move is blocked if {standing, front} is a listed pair
 * (either order) for this tileset.
 * @param {boolean} water use pairCollisionsWater (surfing) instead of pairCollisionsLand
 */
export function isPairBlocked(ts, standingTile, frontTile, water = false) {
  const pairs = water ? tilesetInfo(ts).pairWater : tilesetInfo(ts).pairLand;
  for (const [a, b] of pairs) {
    if ((a === standingTile && b === frontTile) || (b === standingTile && a === frontTile)) return true;
  }
  return false;
}

/**
 * HandleLedges: ledge entry matching (facing, standing tile, front tile), or null.
 * Only the OVERWORLD tileset has ledges (its JSON is the only one with a `ledges` list).
 */
export function findLedge(ts, facing, standingTile, frontTile) {
  for (const l of tilesetInfo(ts).ledges) {
    if (l.facing === facing && l.standingTile === standingTile && l.ledgeTile === frontTile) return l;
  }
  return null;
}

/**
 * CollisionCheckOnWater after the sprite and tile-pair checks:
 * 'surf' (keep surfing), 'land' (step onto land and stop surfing) or 'blocked'.
 */
export function waterMove(ts, frontTile) {
  if (frontTile === TILE.WATER) return 'surf';
  if (frontTile === TILE.SHORE_EAST) return ts.const === 'SHIP_PORT' ? 'land' : 'surf';
  if (frontTile === TILE.SHORE_SAFARI) return 'surf';
  return isWalkable(ts, frontTile) ? 'land' : 'blocked';
}

/** IsNextTileShoreOrWater: may the player start surfing onto `frontTile`? */
export function canStartSurf(ts, frontTile) {
  return !!ts.isWaterTileset && tilesetInfo(ts).surf.has(frontTile);
}

export function isDoorTile(ts, tile) { return tilesetInfo(ts).doors.has(tile); }
export function isWarpTile(ts, tile) { return tilesetInfo(ts).warps.has(tile); }
export function isCounterTile(ts, tile) { return tilesetInfo(ts).counters.has(tile); }

/** IsPlayerStandingOnWarpPadOrHole: 0 none, 1 warp pad, 2 hole. */
export function warpPadOrHole(ts, tile) {
  const e = tilesetInfo(ts).padsHoles.get(tile);
  return e ? e.value : 0;
}

/** PrintBookshelfText: bookshelf entry for the tile in front (caller checks facing up). */
export function bookshelfAt(ts, tile) {
  return tilesetInfo(ts).bookshelves.get(tile) || null;
}

/** UsedCut: can the tile in front be cut? */
export function isCuttable(ts, tile) {
  return tilesetInfo(ts).cutTiles.has(tile);
}

/** Cut tree block swap for a block id (CutTreeBlockSwaps), or undefined. */
export function cutBlockSwap(ts, block) {
  return tilesetInfo(ts).cutSwaps.get(block);
}

/**
 * ExtraWarpCheck (home/overworld.asm) - the condition a warp on a non-door, non-warp tile
 * needs, besides a direction being held.
 * @param {string} kind map.extraWarpCheck: 'warpTileInFront' | 'facingEdgeOfMap' | 'ssAnneBowTile'
 * @param {{x:number,y:number,facing:string,frontTile:number,W:number,H:number,carpets:Record<string,number[]>}} p
 */
export function extraWarpCheck(kind, p) {
  if (kind === 'warpTileInFront') return (p.carpets[p.facing] || []).includes(p.frontTile);
  if (kind === 'ssAnneBowTile') return p.frontTile === TILE.SS_ANNE_BOW_WARP;
  // IsPlayerFacingEdgeOfMap
  switch (p.facing) {
    case 'down': return p.y === p.H * 2 - 1;
    case 'up': return p.y === 0;
    case 'left': return p.x === 0;
    case 'right': return p.x === p.W * 2 - 1;
    default: return false;
  }
}

/** IsPlayerJustOutsideMap: one step outside the map (about to cross a connection). */
export function isJustOutsideMap(x, y, W, H) {
  return y === -1 || y === H * 2 || x === -1 || x === W * 2;
}
