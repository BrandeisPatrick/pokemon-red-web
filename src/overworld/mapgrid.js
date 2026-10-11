// The padded block grid of a map (LoadTileBlockMap, home/overworld.asm) and every tile
// lookup the overworld needs (docs/data-format-maps.md §1, §5, §12.1). Pure: no DOM.
//
// Coordinates:
//   block (bx, by)  map blocks, -3 <= bx < W+3 (3 blocks of border / connection strips)
//   tile  (tx, ty)  map tiles (8x8), block * 4
//   step  (x, y)    player steps (16x16) = 2x2 tiles, origin top-left of the map
// "The tile of a step" is always its bottom-left tile (2x, 2y+1) - that is what every
// collision, door, warp, ledge and grass test of the game reads (screen tile (8,9) for the
// player, GetTileSpriteStandsOn for NPCs).

/** @typedef {{x:number,y:number,w:number,h:number}} Rect */

export const MAP_BORDER = 3; // MAP_BORDER in the ROM

/**
 * Build the padded block grid exactly like LoadTileBlockMap: border block everywhere, the
 * map at (3, 3), then the connection strips copied with the `macro` numbers in the order
 * north, south, west, east.
 * @param {any} map  data/maps/<Map>.json
 * @param {(name:string) => any} getMap  returns another map's JSON (needed for strips)
 * @returns {{blocks: Uint8Array, PW: number, PH: number, missing: string[]}}
 */
export function buildPaddedGrid(map, getMap) {
  const W = map.width, H = map.height;
  const PW = W + 2 * MAP_BORDER, PH = H + 2 * MAP_BORDER;
  const blocks = new Uint8Array(PW * PH).fill(map.borderBlock);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const b = map.blocks[y * W + x];
      blocks[(y + MAP_BORDER) * PW + x + MAP_BORDER] = b === undefined ? map.borderBlock : b;
    }
  }
  const missing = [];
  for (const dir of ['north', 'south', 'west', 'east']) {
    const c = map.connections && map.connections[dir];
    if (!c) continue;
    const other = getMap(c.mapName);
    if (!other) { missing.push(c.mapName); continue; }
    const ob = other.blocks;
    const { stripSrc, stripDest, stripLength, connectedWidth } = c.macro;
    const rows = dir === 'north' || dir === 'south' ? MAP_BORDER : stripLength;
    const cols = dir === 'north' || dir === 'south' ? stripLength : MAP_BORDER;
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < cols; i++) {
        const si = stripSrc + r * connectedWidth + i;
        const di = stripDest + r * PW + i;
        // the ROM copies bytes; a clipped strip (src = -1) writes one garbage block into
        // padded column 0, which is never visible - skip anything outside the arrays
        if (si >= 0 && si < ob.length && di >= 0 && di < blocks.length) blocks[di] = ob[si];
      }
    }
  }
  return { blocks, PW, PH, missing };
}

export class MapGrid {
  /**
   * @param {any} map      data/maps/<Map>.json
   * @param {any} tileset  data/tilesets/<Tileset>.json
   * @param {(name:string) => any} getMap  connected map JSON lookup
   */
  constructor(map, tileset, getMap) {
    this.map = map;
    this.tileset = tileset;
    this.W = map.width;
    this.H = map.height;
    const { blocks, PW, PH, missing } = buildPaddedGrid(map, getMap);
    this.blocks = blocks;
    this.PW = PW;
    this.PH = PH;
    /** connected maps whose strips could not be copied (not loaded) */
    this.missing = missing;
    this.TW = PW * 4;
    this.TH = PH * 4;
    /** tile ids of the whole padded grid, row-major (TW x TH) */
    this.tiles = new Uint8Array(this.TW * this.TH);
    for (let by = 0; by < PH; by++) for (let bx = 0; bx < PW; bx++) this._renderBlock(bx, by);
    /** incremented whenever a block changes (renderers can cache on it) */
    this.version = 0;
  }

  /** @private write the 16 tiles of padded block (bx, by) */
  _renderBlock(bx, by) {
    const def = this.tileset.blocks[this.blocks[by * this.PW + bx]] || this.tileset.blocks[0];
    const TW = this.TW;
    for (let ty = 0; ty < 4; ty++) {
      const row = (by * 4 + ty) * TW + bx * 4;
      for (let tx = 0; tx < 4; tx++) this.tiles[row + tx] = def[ty * 4 + tx];
    }
  }

  /** Width / height of the map in steps. */
  get stepsW() { return this.W * 2; }
  get stepsH() { return this.H * 2; }

  /** Block id at map block (bx, by) (padded area included; outside it: the border block). */
  blockAt(bx, by) {
    const px = bx + MAP_BORDER, py = by + MAP_BORDER;
    if (px < 0 || py < 0 || px >= this.PW || py >= this.PH) return this.map.borderBlock;
    return this.blocks[py * this.PW + px];
  }

  /**
   * Replace a block (ReplaceTileBlock: cut trees, card-key doors, gym gates ...).
   * Only blocks inside the padded grid can change.
   */
  setBlock(bx, by, block) {
    const px = bx + MAP_BORDER, py = by + MAP_BORDER;
    if (px < 0 || py < 0 || px >= this.PW || py >= this.PH) return false;
    this.blocks[py * this.PW + px] = block;
    this._renderBlock(px, py);
    this.version++;
    return true;
  }

  /** Tile id at map tile (tx, ty). Outside the padded grid the border block repeats. */
  tileAt(tx, ty) {
    const gx = tx + MAP_BORDER * 4, gy = ty + MAP_BORDER * 4;
    if (gx >= 0 && gy >= 0 && gx < this.TW && gy < this.TH) return this.tiles[gy * this.TW + gx];
    const def = this.tileset.blocks[this.map.borderBlock];
    return def[(((ty % 4) + 4) % 4) * 4 + (((tx % 4) + 4) % 4)];
  }

  /** Bottom-left tile of step (x, y): the tile the game tests for that cell. */
  cellTile(x, y) { return this.tileAt(2 * x, 2 * y + 1); }
  /** Bottom-right tile (screen (9,9) for the player: wild encounter test). */
  cellTileBR(x, y) { return this.tileAt(2 * x + 1, 2 * y + 1); }
  /** Top-left tile (screen (8,8) for the player: PlayMapChangeSound). */
  cellTileTL(x, y) { return this.tileAt(2 * x, 2 * y); }
  /** Top-right tile. */
  cellTileTR(x, y) { return this.tileAt(2 * x + 1, 2 * y); }

  /** True if step (x, y) is inside the map proper. */
  inMap(x, y) {
    return x >= 0 && y >= 0 && x < this.W * 2 && y < this.H * 2;
  }

  /** Map block containing step (x, y). */
  static blockOfStep(x, y) {
    return { bx: Math.floor(x / 2), by: Math.floor(y / 2) };
  }
}
