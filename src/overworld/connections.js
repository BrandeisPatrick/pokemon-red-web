// Map connections (CheckMapConnections, home/overworld.asm; docs/data-format-maps.md §5).
// Pure.

/**
 * After a completed step, the connection the player walked into, or null.
 * Coordinates are steps; W/H are the map size in blocks.
 * @param {any} map data/maps/<Map>.json
 * @param {number} x
 * @param {number} y
 * @returns {{dir:string, connection:any}|null}
 */
export function connectionAt(map, x, y) {
  const c = map.connections || {};
  // same order as the ROM: west, east, north, south
  if (x === -1) return c.west ? { dir: 'west', connection: c.west } : null;
  if (x === map.width * 2) return c.east ? { dir: 'east', connection: c.east } : null;
  if (y === -1) return c.north ? { dir: 'north', connection: c.north } : null;
  if (y === map.height * 2) return c.south ? { dir: 'south', connection: c.south } : null;
  return null;
}

/**
 * Coordinates in the connected map (wXCoord/wYCoord after CheckMapConnections):
 *   west:  x = xAlign (= cW*2-1),  y += yAlign (= -2*offset)
 *   east:  x = xAlign (= 0),       y += yAlign
 *   north: y = yAlign (= cH*2-1),  x += xAlign (= -2*offset)
 *   south: y = yAlign (= 0),       x += xAlign
 * @param {string} dir
 * @param {any} connection map.connections[dir]
 * @param {number} x
 * @param {number} y
 * @returns {{map: string, x: number, y: number}}
 */
export function translateThroughConnection(dir, connection, x, y) {
  const m = connection.macro;
  switch (dir) {
    case 'west':
    case 'east':
      return { map: connection.mapName, x: m.xAlign, y: y + m.yAlign };
    case 'north':
    case 'south':
      return { map: connection.mapName, x: x + m.xAlign, y: m.yAlign };
    default:
      throw new Error(`translateThroughConnection: bad direction ${dir}`);
  }
}

/**
 * Convenience: if (x, y) is just outside `map` through a connection, the new map/x/y.
 * @returns {{dir:string, map:string, x:number, y:number}|null}
 */
export function crossConnection(map, x, y) {
  const hit = connectionAt(map, x, y);
  if (!hit) return null;
  return { dir: hit.dir, ...translateThroughConnection(hit.dir, hit.connection, x, y) };
}
