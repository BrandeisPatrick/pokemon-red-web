// Transcribed from vendor/pokered map scripts (these tables are script data that the map
// extractor does not emit). tests/overworld/special_data.test.js re-parses the asm and checks
// every entry, so a typo here fails the tests.
//
// SPINNER_ARROWS: map_coord_movement tables of the spinner-tile maps (ViridianGymArrowTilePlayerMovement,
// RocketHideout2/3ArrowTilePlayerMovement). Each list is the ROM's RLE list of [direction, count]
// pairs *as written in the source*; the game reads it backwards (DecodeRLEList +
// wSimulatedJoypadStatesIndex counting down), see arrowPath().
//
// DEFAULT_HOLES: the hole coordinates map scripts pass to IsPlayerOnDungeonWarp, with the
// destination map (wDungeonWarpDestinationMap) and which dungeon warp each coordinate is
// (wWhichDungeonWarp = 1-based index in the coordinate list). Landing spots are in
// data/maps_meta.json dungeonWarps.

export const SPINNER_ARROWS = Object.freeze({
  ViridianGym: Object.freeze([
    Object.freeze({ x: 19, y: 11, rle: [["up",9]] }), // ViridianGymArrowMovement1
    Object.freeze({ x: 19, y: 1, rle: [["left",8]] }), // ViridianGymArrowMovement2
    Object.freeze({ x: 18, y: 2, rle: [["down",9]] }), // ViridianGymArrowMovement3
    Object.freeze({ x: 11, y: 2, rle: [["right",6]] }), // ViridianGymArrowMovement4
    Object.freeze({ x: 16, y: 10, rle: [["down",2]] }), // ViridianGymArrowMovement5
    Object.freeze({ x: 4, y: 6, rle: [["down",7]] }), // ViridianGymArrowMovement6
    Object.freeze({ x: 5, y: 13, rle: [["right",8]] }), // ViridianGymArrowMovement7
    Object.freeze({ x: 4, y: 14, rle: [["right",9]] }), // ViridianGymArrowMovement8
    Object.freeze({ x: 0, y: 15, rle: [["up",8]] }), // ViridianGymArrowMovement9
    Object.freeze({ x: 1, y: 15, rle: [["up",6]] }), // ViridianGymArrowMovement10
    Object.freeze({ x: 13, y: 16, rle: [["left",6]] }), // ViridianGymArrowMovement11
    Object.freeze({ x: 13, y: 17, rle: [["left",12]] }), // ViridianGymArrowMovement12
  ]),
  RocketHideoutB2F: Object.freeze([
    Object.freeze({ x: 4, y: 9, rle: [["left",2]] }), // RocketHideout2ArrowMovement1
    Object.freeze({ x: 4, y: 11, rle: [["right",4]] }), // RocketHideout2ArrowMovement2
    Object.freeze({ x: 4, y: 15, rle: [["up",4],["right",4]] }), // RocketHideout2ArrowMovement3
    Object.freeze({ x: 4, y: 16, rle: [["up",4],["right",4],["up",1]] }), // RocketHideout2ArrowMovement4
    Object.freeze({ x: 4, y: 19, rle: [["left",2]] }), // RocketHideout2ArrowMovement1
    Object.freeze({ x: 4, y: 22, rle: [["left",2],["up",3]] }), // RocketHideout2ArrowMovement5
    Object.freeze({ x: 5, y: 14, rle: [["down",2],["right",4]] }), // RocketHideout2ArrowMovement6
    Object.freeze({ x: 6, y: 22, rle: [["up",2]] }), // RocketHideout2ArrowMovement7
    Object.freeze({ x: 6, y: 24, rle: [["up",4]] }), // RocketHideout2ArrowMovement8
    Object.freeze({ x: 8, y: 9, rle: [["left",6]] }), // RocketHideout2ArrowMovement9
    Object.freeze({ x: 8, y: 12, rle: [["up",1]] }), // RocketHideout2ArrowMovement10
    Object.freeze({ x: 8, y: 15, rle: [["up",4]] }), // RocketHideout2ArrowMovement8
    Object.freeze({ x: 8, y: 19, rle: [["left",6]] }), // RocketHideout2ArrowMovement9
    Object.freeze({ x: 8, y: 23, rle: [["left",6],["up",4]] }), // RocketHideout2ArrowMovement11
    Object.freeze({ x: 9, y: 14, rle: [["down",2]] }), // RocketHideout2ArrowMovement12
    Object.freeze({ x: 9, y: 22, rle: [["down",2]] }), // RocketHideout2ArrowMovement12
    Object.freeze({ x: 10, y: 9, rle: [["left",8]] }), // RocketHideout2ArrowMovement13
    Object.freeze({ x: 10, y: 10, rle: [["left",8],["up",1]] }), // RocketHideout2ArrowMovement14
    Object.freeze({ x: 10, y: 15, rle: [["left",8],["up",6]] }), // RocketHideout2ArrowMovement15
    Object.freeze({ x: 10, y: 17, rle: [["up",2],["right",4]] }), // RocketHideout2ArrowMovement16
    Object.freeze({ x: 10, y: 19, rle: [["up",2],["right",4],["up",2]] }), // RocketHideout2ArrowMovement17
    Object.freeze({ x: 10, y: 25, rle: [["right",4]] }), // RocketHideout2ArrowMovement2
    Object.freeze({ x: 11, y: 14, rle: [["down",2],["right",4],["down",2]] }), // RocketHideout2ArrowMovement18
    Object.freeze({ x: 11, y: 16, rle: [["down",2],["right",4]] }), // RocketHideout2ArrowMovement19
    Object.freeze({ x: 11, y: 18, rle: [["down",2]] }), // RocketHideout2ArrowMovement12
    Object.freeze({ x: 12, y: 9, rle: [["left",10]] }), // RocketHideout2ArrowMovement20
    Object.freeze({ x: 12, y: 11, rle: [["left",10],["up",2]] }), // RocketHideout2ArrowMovement21
    Object.freeze({ x: 12, y: 13, rle: [["left",10],["up",4]] }), // RocketHideout2ArrowMovement22
    Object.freeze({ x: 12, y: 17, rle: [["up",2],["right",2]] }), // RocketHideout2ArrowMovement23
    Object.freeze({ x: 13, y: 10, rle: [["right",1],["down",2]] }), // RocketHideout2ArrowMovement24
    Object.freeze({ x: 13, y: 12, rle: [["right",1]] }), // RocketHideout2ArrowMovement25
    Object.freeze({ x: 13, y: 16, rle: [["down",2],["right",2]] }), // RocketHideout2ArrowMovement26
    Object.freeze({ x: 13, y: 18, rle: [["down",2],["left",2]] }), // RocketHideout2ArrowMovement27
    Object.freeze({ x: 13, y: 19, rle: [["up",2],["right",4],["up",2],["left",3]] }), // RocketHideout2ArrowMovement28
    Object.freeze({ x: 13, y: 22, rle: [["down",2],["left",4]] }), // RocketHideout2ArrowMovement29
    Object.freeze({ x: 13, y: 23, rle: [["left",6],["up",4],["left",5]] }), // RocketHideout2ArrowMovement30
    Object.freeze({ x: 14, y: 17, rle: [["up",2]] }), // RocketHideout2ArrowMovement31
    Object.freeze({ x: 15, y: 16, rle: [["down",2]] }), // RocketHideout2ArrowMovement12
    Object.freeze({ x: 16, y: 14, rle: [["up",1]] }), // RocketHideout2ArrowMovement32
    Object.freeze({ x: 16, y: 16, rle: [["up",3]] }), // RocketHideout2ArrowMovement33
    Object.freeze({ x: 16, y: 18, rle: [["up",5]] }), // RocketHideout2ArrowMovement34
    Object.freeze({ x: 17, y: 10, rle: [["right",1],["down",2],["left",4]] }), // RocketHideout2ArrowMovement35
    Object.freeze({ x: 17, y: 11, rle: [["left",10],["up",2],["left",5]] }), // RocketHideout2ArrowMovement36
  ]),
  RocketHideoutB3F: Object.freeze([
    Object.freeze({ x: 10, y: 13, rle: [["right",4]] }), // RocketHideout3ArrowMovement6
    Object.freeze({ x: 10, y: 19, rle: [["right",4],["up",4],["right",4]] }), // RocketHideout3ArrowMovement1
    Object.freeze({ x: 11, y: 18, rle: [["down",4],["right",4]] }), // RocketHideout3ArrowMovement2
    Object.freeze({ x: 12, y: 11, rle: [["left",2]] }), // RocketHideout3ArrowMovement3
    Object.freeze({ x: 12, y: 17, rle: [["right",4],["up",2],["right",2]] }), // RocketHideout3ArrowMovement4
    Object.freeze({ x: 12, y: 20, rle: [["right",4],["up",2],["right",2],["up",3]] }), // RocketHideout3ArrowMovement5
    Object.freeze({ x: 13, y: 16, rle: [["right",4]] }), // RocketHideout3ArrowMovement6
    Object.freeze({ x: 14, y: 11, rle: [["right",2]] }), // RocketHideout3ArrowMovement7
    Object.freeze({ x: 14, y: 15, rle: [["right",4]] }), // RocketHideout3ArrowMovement6
    Object.freeze({ x: 14, y: 17, rle: [["right",4],["up",2]] }), // RocketHideout3ArrowMovement8
    Object.freeze({ x: 14, y: 19, rle: [["right",4],["up",4]] }), // RocketHideout3ArrowMovement9
    Object.freeze({ x: 15, y: 16, rle: [["right",2]] }), // RocketHideout3ArrowMovement7
    Object.freeze({ x: 15, y: 18, rle: [["down",4]] }), // RocketHideout3ArrowMovement10
    Object.freeze({ x: 16, y: 13, rle: [["up",2]] }), // RocketHideout3ArrowMovement11
    Object.freeze({ x: 17, y: 12, rle: [["down",4]] }), // RocketHideout3ArrowMovement10
    Object.freeze({ x: 18, y: 16, rle: [["up",1]] }), // RocketHideout3ArrowMovement12
  ]),
});

export const DEFAULT_HOLES = Object.freeze({
  // scripts/SeafoamIslands1F.asm Seafoam1HolesCoords
  SeafoamIslands1F: Object.freeze({ dest: 'SEAFOAM_ISLANDS_B1F', coords: Object.freeze([[17, 6], [24, 6]]) }),
  // scripts/SeafoamIslandsB1F.asm Seafoam2HolesCoords
  SeafoamIslandsB1F: Object.freeze({ dest: 'SEAFOAM_ISLANDS_B2F', coords: Object.freeze([[18, 6], [23, 6]]) }),
  // scripts/SeafoamIslandsB2F.asm Seafoam3HolesCoords
  SeafoamIslandsB2F: Object.freeze({ dest: 'SEAFOAM_ISLANDS_B3F', coords: Object.freeze([[19, 6], [22, 6]]) }),
  // scripts/SeafoamIslandsB3F.asm Seafoam4HolesCoords
  SeafoamIslandsB3F: Object.freeze({ dest: 'SEAFOAM_ISLANDS_B4F', coords: Object.freeze([[3, 16], [6, 16]]) }),
  // scripts/PokemonMansion3F.asm .holeCoords: warps 1 and 2 -> 1F, warp 3 -> 2F
  PokemonMansion3F: Object.freeze({ dest: ['POKEMON_MANSION_1F', 'POKEMON_MANSION_1F', 'POKEMON_MANSION_2F'], coords: Object.freeze([[16, 14], [17, 14], [19, 14]]) }),
  // scripts/VictoryRoad3F.asm .SwitchOrHoleCoords: entry 1 is the boulder switch, entry 2 the hole
  VictoryRoad3F: Object.freeze({ dest: 'VICTORY_ROAD_2F', coords: Object.freeze([null, [23, 15]]) }),
});

/**
 * LoadGymLeaderAndCityName strings of the gym scripts (.CityName / .LeaderName), used by the
 * gym statues' text (wGymCityName / wGymLeaderName). Keyed by map const.
 */
export const GYM_NAMES = Object.freeze({
  PEWTER_GYM: Object.freeze({ wGymCityName: 'PEWTER CITY', wGymLeaderName: 'BROCK' }),
  CERULEAN_GYM: Object.freeze({ wGymCityName: 'CERULEAN CITY', wGymLeaderName: 'MISTY' }),
  VERMILION_GYM: Object.freeze({ wGymCityName: 'VERMILION CITY', wGymLeaderName: 'LT.SURGE' }),
  CELADON_GYM: Object.freeze({ wGymCityName: 'CELADON CITY', wGymLeaderName: 'ERIKA' }),
  FUCHSIA_GYM: Object.freeze({ wGymCityName: 'FUCHSIA CITY', wGymLeaderName: 'KOGA' }),
  SAFFRON_GYM: Object.freeze({ wGymCityName: 'SAFFRON CITY', wGymLeaderName: 'SABRINA' }),
  CINNABAR_GYM: Object.freeze({ wGymCityName: 'CINNABAR ISLAND', wGymLeaderName: 'BLAINE' }),
  VIRIDIAN_GYM: Object.freeze({ wGymCityName: 'VIRIDIAN CITY', wGymLeaderName: 'GIOVANNI' }),
});

/**
 * The simulated D-pad presses of an arrow tile, in the order they are walked (the ROM reads
 * the RLE list from its end).
 * @param {Array<[string, number]>} rle
 * @returns {string[]}
 */
export function arrowPath(rle) {
  const forward = [];
  for (const [dir, n] of rle) for (let i = 0; i < n; i++) forward.push(dir);
  return forward.reverse();
}
