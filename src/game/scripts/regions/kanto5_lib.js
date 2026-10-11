// Private helpers of the kanto5 region scripts (src/game/scripts/regions/kanto5.js): the small
// text / sound / movement helpers every region needs (copies of the kanto1-3 ones, so the regions
// stay independent) and the tables of the region: the Silph Co. card-key doors, the Rockets that
// leave Saffron City with Giovanni, the Silph Co. elevator, the Seafoam Islands boulder holes and
// currents, the Safari Zone gate's script indices.

import * as lib from '../lib.js';

/** Pokédex numbers of the Pokémon the scripts name (cries, Pokédex pages, gifts); checked in tests. */
export const DEX = Object.freeze({
  PIDGEY: 16, SLOWPOKE: 79, VOLTORB: 100, HITMONLEE: 106, HITMONCHAN: 107, CHANSEY: 113, KANGASKHAN: 115,
  LAPRAS: 131, OMANYTE: 138, KABUTO: 140, ARTICUNO: 144,
});

// =========================================================================== text, sound, movement

/** SetSpriteFacingDirectionAndDelay (home/map_objects.asm): turn an NPC, then 6 frames. */
export function* faceAndDelay(ctx, objectIndex, dir) {
  ctx.faceNpc(objectIndex, dir);
  yield ctx.wait(6);
}

/** PrintText inside a text_asm: print into a fresh box, no wait, keep it open. */
export function print(ctx, label, opts = {}) {
  return ctx.showText(label, { ...opts, wait: false, close: false });
}

/**
 * The end of DisplayTextID after a text_asm printed its last text without a button wait:
 * wait for A/B on what the box shows and close it.
 */
export function* waitAndClose(ctx) {
  yield ctx.showText([{ cmd: 'text_end' }], { open: false, wait: true, close: true });
}

/** Is the player at one of the coordinates (ArePlayerCoordsInArray)? @returns {number} 1-based index or 0 */
export function coordIndex(ctx, coords) {
  const p = ctx.player;
  const i = coords.findIndex(([x, y]) => p.x === x && p.y === y);
  return i + 1;
}

/** Stop the music, then start a song (SFX_STOP_ALL_MUSIC + PlayMusic). */
export function stopAndPlay(ctx, music) {
  const audio = ctx.hooks && ctx.hooks.audio;
  if (audio && typeof audio.stopMusic === 'function') audio.stopMusic();
  ctx.playMusic(music);
}

/** PlayCry without waiting (the cry runs while the box waits for a button). */
export function playCry(ctx, dex) {
  const audio = ctx.hooks && ctx.hooks.audio;
  return audio && typeof audio.playCry === 'function' ? audio.playCry(dex) : undefined;
}

/** PlayCry + WaitForSoundToFinish. */
export function* cry(ctx, dex) {
  const r = playCry(ctx, dex);
  if (r && typeof r.then === 'function') yield* lib.waitFor(r, 300);
}

/** GiveItem: add to the bag (the hook may answer with a promise). @returns {boolean} false = no room */
export function* give(ctx, item, qty = 1) {
  let ok = ctx.giveItem(item, qty);
  if (ok && typeof ok.then === 'function') ok = yield ok;
  return !!ok;
}

/** GameState.scriptVars: free-form persistent script variables (the Safari gate's wNextSafariZoneGateScript). */
export const scriptVars = (ctx) => ctx.state.scriptVars || (ctx.state.scriptVars = {});

// =========================================================================== Silph Co.

/**
 * SilphCo<N>FGateCallbackScript: the card-key doors of every floor. The maps are saved with
 * their doors open (block $0e, $03 on 11F); the callback closes the ones whose
 * EVENT_SILPH_CO_<N>_UNLOCKED_DOOR* flag is not set. {x, y} are block coordinates (the asm's
 * .GateCoordinates, `dbmapcoord x, y`, and the `lb bc, y, x` of ReplaceTileBlock), `closed` the
 * block of the closed door. The order is the asm's: hUnlockedSilphCoDoors counts the matching
 * entry of that list. (data/maps_meta.json cardKeyTables is not what the game uses: those
 * tables are unused in the ROM.)
 */
export const SILPH_DOORS = Object.freeze(Object.fromEntries(Object.entries({
  SilphCo2F: [[2, 2, 0x54, 'EVENT_SILPH_CO_2_UNLOCKED_DOOR1'], [2, 5, 0x54, 'EVENT_SILPH_CO_2_UNLOCKED_DOOR2']],
  SilphCo3F: [[4, 4, 0x5f, 'EVENT_SILPH_CO_3_UNLOCKED_DOOR1'], [8, 4, 0x5f, 'EVENT_SILPH_CO_3_UNLOCKED_DOOR2']],
  SilphCo4F: [[2, 6, 0x54, 'EVENT_SILPH_CO_4_UNLOCKED_DOOR1'], [6, 4, 0x54, 'EVENT_SILPH_CO_4_UNLOCKED_DOOR2']],
  SilphCo5F: [[3, 2, 0x5f, 'EVENT_SILPH_CO_5_UNLOCKED_DOOR1'], [3, 6, 0x5f, 'EVENT_SILPH_CO_5_UNLOCKED_DOOR2'],
    [7, 5, 0x5f, 'EVENT_SILPH_CO_5_UNLOCKED_DOOR3']],
  SilphCo6F: [[2, 6, 0x5f, 'EVENT_SILPH_CO_6_UNLOCKED_DOOR']],
  SilphCo7F: [[5, 3, 0x54, 'EVENT_SILPH_CO_7_UNLOCKED_DOOR1'], [10, 2, 0x54, 'EVENT_SILPH_CO_7_UNLOCKED_DOOR2'],
    [10, 6, 0x54, 'EVENT_SILPH_CO_7_UNLOCKED_DOOR3']],
  SilphCo8F: [[3, 4, 0x5f, 'EVENT_SILPH_CO_8_UNLOCKED_DOOR']],
  SilphCo9F: [[1, 4, 0x5f, 'EVENT_SILPH_CO_9_UNLOCKED_DOOR1'], [9, 2, 0x54, 'EVENT_SILPH_CO_9_UNLOCKED_DOOR2'],
    [9, 5, 0x54, 'EVENT_SILPH_CO_9_UNLOCKED_DOOR3'], [5, 6, 0x5f, 'EVENT_SILPH_CO_9_UNLOCKED_DOOR4']],
  SilphCo10F: [[5, 4, 0x54, 'EVENT_SILPH_CO_10_UNLOCKED_DOOR']],
  SilphCo11F: [[3, 6, 0x20, 'EVENT_SILPH_CO_11_UNLOCKED_DOOR']],
}).map(([map, doors]) => [map, Object.freeze(doors.map(([x, y, closed, flag]) => Object.freeze({ x, y, closed, flag })))])));

/** The map-load half of the gate callback: close every door whose flag is not set. */
export function closeLockedDoors(ctx) {
  for (const d of SILPH_DOORS[ctx.map] || []) {
    if (!ctx.getFlag(d.flag)) ctx.setBlock(d.x, d.y, d.closed);
  }
}

/**
 * The other half (SilphCo2F_SetCardKeyDoorYScript + the floor's UnlockedDoorEventScript): the door
 * the player just opened with the CARD KEY at block (bx, by) gets its unlocked flag.
 * @returns {number} the 1-based index of the door in the floor's list (hUnlockedSilphCoDoors), 0 if none
 */
export function unlockDoorAt(ctx, bx, by) {
  const doors = SILPH_DOORS[ctx.map] || [];
  const i = doors.findIndex((d) => d.x === bx && d.y === by);
  if (i >= 0) ctx.setFlag(doors[i].flag);
  return i + 1;
}

/**
 * SilphCo11FTeamRocketLeavesScript: the Rockets and Silph Co.'s scientists leave, Saffron City's
 * people come back. (SILPH_CO_7F_RIVAL is not in it: the rival leaves on his own.)
 */
export const TEAM_ROCKET_SHOWS = Object.freeze([
  'TOGGLE_SAFFRON_CITY_8', 'TOGGLE_SAFFRON_CITY_9', 'TOGGLE_SAFFRON_CITY_A', 'TOGGLE_SAFFRON_CITY_B',
  'TOGGLE_SAFFRON_CITY_C', 'TOGGLE_SAFFRON_CITY_D',
]);
export const TEAM_ROCKET_HIDES = Object.freeze([
  'TOGGLE_SAFFRON_CITY_1', 'TOGGLE_SAFFRON_CITY_2', 'TOGGLE_SAFFRON_CITY_3', 'TOGGLE_SAFFRON_CITY_4',
  'TOGGLE_SAFFRON_CITY_5', 'TOGGLE_SAFFRON_CITY_6', 'TOGGLE_SAFFRON_CITY_7', 'TOGGLE_SAFFRON_CITY_E',
  'TOGGLE_SAFFRON_CITY_F',
  'TOGGLE_SILPH_CO_2F_2', 'TOGGLE_SILPH_CO_2F_3', 'TOGGLE_SILPH_CO_2F_4', 'TOGGLE_SILPH_CO_2F_5',
  'TOGGLE_SILPH_CO_3F_1', 'TOGGLE_SILPH_CO_3F_2',
  'TOGGLE_SILPH_CO_4F_1', 'TOGGLE_SILPH_CO_4F_2', 'TOGGLE_SILPH_CO_4F_3',
  'TOGGLE_SILPH_CO_5F_1', 'TOGGLE_SILPH_CO_5F_2', 'TOGGLE_SILPH_CO_5F_3', 'TOGGLE_SILPH_CO_5F_4',
  'TOGGLE_SILPH_CO_6F_1', 'TOGGLE_SILPH_CO_6F_2', 'TOGGLE_SILPH_CO_6F_3',
  'TOGGLE_SILPH_CO_7F_1', 'TOGGLE_SILPH_CO_7F_2', 'TOGGLE_SILPH_CO_7F_3', 'TOGGLE_SILPH_CO_7F_4',
  'TOGGLE_SILPH_CO_8F_1', 'TOGGLE_SILPH_CO_8F_2', 'TOGGLE_SILPH_CO_8F_3',
  'TOGGLE_SILPH_CO_9F_1', 'TOGGLE_SILPH_CO_9F_2', 'TOGGLE_SILPH_CO_9F_3',
  'TOGGLE_SILPH_CO_10F_1', 'TOGGLE_SILPH_CO_10F_2',
  'TOGGLE_SILPH_CO_11F_1', 'TOGGLE_SILPH_CO_11F_2', 'TOGGLE_SILPH_CO_11F_3',
]);

/** SilphCoElevatorWarpMaps / SilphCoElevatorFloors: floor label, map and 0-based warp of the lift on that floor. */
export const SILPH_FLOORS = Object.freeze([
  ['1F', 'SilphCo1F', 3], ['2F', 'SilphCo2F', 2], ['3F', 'SilphCo3F', 2], ['4F', 'SilphCo4F', 2],
  ['5F', 'SilphCo5F', 2], ['6F', 'SilphCo6F', 2], ['7F', 'SilphCo7F', 2], ['8F', 'SilphCo8F', 2],
  ['9F', 'SilphCo9F', 2], ['10F', 'SilphCo10F', 2], ['11F', 'SilphCo11F', 1],
].map(([label, map, warpIndex]) => Object.freeze({ label, map, warpIndex })));

// =========================================================================== Seafoam Islands

/**
 * The boulder holes of the Seafoam floors (Seafoam<N>HolesCoords, in steps) and what a boulder
 * falling into hole 1 / 2 does (the asm's .boulder2FellDownHole branches): the floor's
 * EVENT_SEAFOAM<N>_BOULDER<hole>_DOWN_HOLE, hide the boulder of that hole's number here and show
 * its twin on the floor below. (It is the HOLE that decides which toggle is hidden, not the boulder.)
 */
export const SEAFOAM_HOLES = Object.freeze({
  SeafoamIslands1F: Object.freeze({
    holes: [[17, 6], [24, 6]],
    events: ['EVENT_SEAFOAM1_BOULDER1_DOWN_HOLE', 'EVENT_SEAFOAM1_BOULDER2_DOWN_HOLE'],
    hide: ['TOGGLE_SEAFOAM_ISLANDS_1F_BOULDER_1', 'TOGGLE_SEAFOAM_ISLANDS_1F_BOULDER_2'],
    show: ['TOGGLE_SEAFOAM_ISLANDS_B1F_BOULDER_1', 'TOGGLE_SEAFOAM_ISLANDS_B1F_BOULDER_2'],
  }),
  SeafoamIslandsB1F: Object.freeze({
    holes: [[18, 6], [23, 6]],
    events: ['EVENT_SEAFOAM2_BOULDER1_DOWN_HOLE', 'EVENT_SEAFOAM2_BOULDER2_DOWN_HOLE'],
    hide: ['TOGGLE_SEAFOAM_ISLANDS_B1F_BOULDER_1', 'TOGGLE_SEAFOAM_ISLANDS_B1F_BOULDER_2'],
    show: ['TOGGLE_SEAFOAM_ISLANDS_B2F_BOULDER_1', 'TOGGLE_SEAFOAM_ISLANDS_B2F_BOULDER_2'],
  }),
  SeafoamIslandsB2F: Object.freeze({
    holes: [[19, 6], [22, 6]],
    events: ['EVENT_SEAFOAM3_BOULDER1_DOWN_HOLE', 'EVENT_SEAFOAM3_BOULDER2_DOWN_HOLE'],
    hide: ['TOGGLE_SEAFOAM_ISLANDS_B2F_BOULDER_1', 'TOGGLE_SEAFOAM_ISLANDS_B2F_BOULDER_2'],
    show: ['TOGGLE_SEAFOAM_ISLANDS_B3F_BOULDER_3', 'TOGGLE_SEAFOAM_ISLANDS_B3F_BOULDER_4'],
  }),
  SeafoamIslandsB3F: Object.freeze({
    holes: [[3, 16], [6, 16]],
    events: ['EVENT_SEAFOAM4_BOULDER1_DOWN_HOLE', 'EVENT_SEAFOAM4_BOULDER2_DOWN_HOLE'],
    hide: ['TOGGLE_SEAFOAM_ISLANDS_B3F_BOULDER_1', 'TOGGLE_SEAFOAM_ISLANDS_B3F_BOULDER_2'],
    show: ['TOGGLE_SEAFOAM_ISLANDS_B4F_BOULDER_1', 'TOGGLE_SEAFOAM_ISLANDS_B4F_BOULDER_2'],
  }),
});

/**
 * The map script of a Seafoam floor when a boulder was pushed (BIT_PUSHED_BOULDER +
 * CheckBoulderCoords): a boulder that stopped on one of the floor's holes sets that hole's event
 * and swaps the boulders. @returns {number} the 1-based hole (wCoordIndex), 0 when it is not on a hole
 */
export function boulderPushedAt(ctx, x, y) {
  const t = SEAFOAM_HOLES[ctx.map];
  if (!t) return 0;
  const i = t.holes.findIndex(([hx, hy]) => hx === x && hy === y);
  if (i < 0) return 0;
  ctx.setFlag(t.events[i]);
  ctx.hideToggle(t.hide[i]);
  ctx.showToggle(t.show[i]);
  return i + 1;
}

/** Route20BoulderScript's two blocks: when the boulders of floors 3 / 4 are not both down their holes, reset them. */
export function bothSet(ctx, a, b) {
  return !!(ctx.getFlag(a) && ctx.getFlag(b));
}

/**
 * Route20BoulderScript (the first frame on Route 20 after EVENT_IN_SEAFOAM_ISLANDS): boulders that
 * did not plug the B2F holes (SEAFOAM3) come back on 1F and vanish from B1F-B3F; those that did not
 * plug the B3F holes (SEAFOAM4) come back on B3F and vanish from B4F.
 */
export function resetSeafoamBoulders(ctx) {
  if (!bothSet(ctx, 'EVENT_SEAFOAM3_BOULDER1_DOWN_HOLE', 'EVENT_SEAFOAM3_BOULDER2_DOWN_HOLE')) {
    ctx.showToggle('TOGGLE_SEAFOAM_ISLANDS_1F_BOULDER_1');
    ctx.showToggle('TOGGLE_SEAFOAM_ISLANDS_1F_BOULDER_2');
    for (const t of ['TOGGLE_SEAFOAM_ISLANDS_B1F_BOULDER_1', 'TOGGLE_SEAFOAM_ISLANDS_B1F_BOULDER_2',
      'TOGGLE_SEAFOAM_ISLANDS_B2F_BOULDER_1', 'TOGGLE_SEAFOAM_ISLANDS_B2F_BOULDER_2',
      'TOGGLE_SEAFOAM_ISLANDS_B3F_BOULDER_3', 'TOGGLE_SEAFOAM_ISLANDS_B3F_BOULDER_4']) ctx.hideToggle(t);
  }
  if (bothSet(ctx, 'EVENT_SEAFOAM4_BOULDER1_DOWN_HOLE', 'EVENT_SEAFOAM4_BOULDER2_DOWN_HOLE')) return;
  ctx.showToggle('TOGGLE_SEAFOAM_ISLANDS_B3F_BOULDER_1');
  ctx.showToggle('TOGGLE_SEAFOAM_ISLANDS_B3F_BOULDER_2');
  ctx.hideToggle('TOGGLE_SEAFOAM_ISLANDS_B4F_BOULDER_1');
  ctx.hideToggle('TOGGLE_SEAFOAM_ISLANDS_B4F_BOULDER_2');
}

/**
 * The strong currents: the simulated D-pad presses in the order they are WALKED. DecodeRLEList
 * writes an RLE list forwards into wSimulatedJoypadStatesEnd, but the joypad reads that buffer
 * from its end (`dec [wSimulatedJoypadStatesIndex]`), so the asm's lists are walked last entry
 * first: these are the asm's lists reversed (the paths follow the water channel of the maps,
 * which the lists read forwards do not).
 */
export const SEAFOAM_CURRENTS = Object.freeze({
  // SeafoamIslandsB3FDefaultScript (RLEList_ForcedSurfingStrongCurrentNearSteps: DOWN 6, RIGHT 5, DOWN 3):
  // from (15, 8) to the stairs at (20, 17)
  B3F_NEAR_STEPS: Object.freeze([['down', 3], ['right', 5], ['down', 6]]),
  // SeafoamIslandsB3FMoveObjectScript, after falling from B2F onto (18, 7) / (19, 7)
  // (.RLEList_StrongCurrentNearLeftBoulder: DOWN 6, RIGHT 2, DOWN 4)
  B3F_NEAR_LEFT_BOULDER: Object.freeze([['down', 4], ['right', 2], ['down', 6]]),
  // (.RLEList_StrongCurrentNearRightBoulder: DOWN 6, RIGHT 2, DOWN 4, LEFT 1): one step left, then the same way
  B3F_NEAR_RIGHT_BOULDER: Object.freeze([['left', 1], ['down', 4], ['right', 2], ['down', 6]]),
  // SeafoamIslandsB4FMoveObjectScript, after falling from B3F onto (4, 14) / (5, 14)
  // (.RLEList_StrongCurrentNearLeftBoulder: UP 3, RIGHT 3, UP 1 / ...NearRightBoulder: UP 3, RIGHT 2, UP 1)
  B4F_NEAR_LEFT_BOULDER: Object.freeze([['up', 1], ['right', 3], ['up', 3]]),
  B4F_NEAR_RIGHT_BOULDER: Object.freeze([['up', 1], ['right', 2], ['up', 3]]),
});

/** Number of single steps in a [direction, count] list. */
export function stepCount(path) {
  return path.reduce((n, s) => n + (Array.isArray(s) ? s[1] : 1), 0);
}
