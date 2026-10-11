// Private helpers of the kanto6 region scripts (src/game/scripts/regions/kanto6.js): the small
// text / sound / movement helpers every region needs (copies of the kanto1-5 ones, so the
// regions stay independent) and the tables of the region transcribed from the asm: the Pokémon
// Mansion's switch doors, the Cinnabar Gym's quiz gates and trainers, the fossils, Route 23's
// badge guards, the Victory Road boulder switches, the Elite Four rooms and the Champion.
// tests/story/kanto6.test.js checks them against the asm and the extracted map data.

import * as lib from '../lib.js';
import { getGameData } from '../../../pokemon/data.js';
import { rivalParty } from '../../../pokemon/trainer.js';

/** Pokédex numbers of the Pokémon the scripts name (cries, fossil revivals); checked in tests. */
export const DEX = Object.freeze({ OMANYTE: 138, KABUTO: 140, AERODACTYL: 142, MOLTRES: 146, MEWTWO: 150 });

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

/** SFX_STOP_ALL_MUSIC. */
export function stopMusic(ctx) {
  const audio = ctx.hooks && ctx.hooks.audio;
  if (audio && typeof audio.stopMusic === 'function') audio.stopMusic();
}

/** Stop the music, then start a song (SFX_STOP_ALL_MUSIC + PlayMusic). */
export function stopAndPlay(ctx, music) {
  stopMusic(ctx);
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

/** WaitForSoundToFinish (the last sound effect). */
export function* waitForSound(ctx) {
  const audio = ctx.hooks && ctx.hooks.audio;
  const r = audio && typeof audio.waitForSfx === 'function' ? audio.waitForSfx() : null;
  if (r && typeof r.then === 'function') yield* lib.waitFor(r, 300);
}

/** PlaySound + WaitForSoundToFinish. */
export function* playAndWait(ctx, sfx) {
  yield* lib.fanfare(ctx, sfx);
}

/**
 * PlayTrainerMusic (home/trainers.asm): the "meet" jingle of a trainer class, played when a
 * trainer is engaged (not for the rival, whose scripts pick their own).
 */
export function playTrainerMusic(ctx, trainerClass) {
  let music = null;
  try { music = getGameData().trainerClass(trainerClass).encounterMusic; } catch { music = null; }
  if (music) ctx.playMusic(music);
}

/** w<Map>CurScript setters by map name (scripts that write another map's state machine). */
export const setScriptOf = (ctx, map, index) => lib.setMapScript(ctx, index, map);

// =========================================================================== Pokémon Mansion

/**
 * The switch doors of the four floors: [bx, by, block with the switch off, block with it on]
 * (the asm's Mansion{1,2,3}CheckReplaceSwitchDoorBlocks / MansionB1FCheck... : `lb bc, Y, X`
 * ReplaceTileBlock with $0e = clear floor, $2d / $54 = horizontal gates, $5f = a vertical gate).
 * EVENT_MANSION_SWITCH_ON picks the column; Cinnabar Island clears the event every frame.
 */
export const MANSION_DOORS = Object.freeze({
  PokemonMansion1F: Object.freeze([[12, 6, 0x0e, 0x2d], [8, 3, 0x2d, 0x0e], [10, 8, 0x2d, 0x0e], [13, 13, 0x2d, 0x0e]]),
  PokemonMansion2F: Object.freeze([[4, 2, 0x0e, 0x5f], [9, 4, 0x54, 0x0e], [3, 11, 0x5f, 0x0e]]),
  PokemonMansion3F: Object.freeze([[7, 2, 0x0e, 0x5f], [7, 5, 0x5f, 0x0e]]),
  PokemonMansionB1F: Object.freeze([[13, 8, 0x0e, 0x2d], [6, 11, 0x0e, 0x5f], [4, 3, 0x5f, 0x0e], [8, 8, 0x54, 0x0e]]),
});

/** Mansion<N>CheckReplaceSwitchDoorBlocks: put the doors the switch asks for into the current floor. */
export function setMansionDoors(ctx) {
  const doors = MANSION_DOORS[ctx.map];
  if (!doors) return;
  const on = ctx.getFlag('EVENT_MANSION_SWITCH_ON');
  for (const [bx, by, off, onBlock] of doors) ctx.setBlock(bx, by, on ? onBlock : off);
}

/**
 * The statue switch of each floor: the hidden-event routine (Mansion<N>Script_Switches, facing up)
 * and the text_asm labels of its three texts. 3F and B1F use the 2F text script.
 */
export const MANSION_SWITCHES = Object.freeze({
  PokemonMansion1F: Object.freeze({ routine: 'Mansion1Script_Switches', base: 'PokemonMansion1FSwitchText', notPressed: 'NotPressedText' }),
  PokemonMansion2F: Object.freeze({ routine: 'Mansion2Script_Switches', base: 'PokemonMansion2FSwitchText', notPressed: 'NotPressed' }),
  PokemonMansion3F: Object.freeze({ routine: 'Mansion3Script_Switches', base: 'PokemonMansion2FSwitchText', notPressed: 'NotPressed' }),
  PokemonMansionB1F: Object.freeze({ routine: 'Mansion4Script_Switches', base: 'PokemonMansion2FSwitchText', notPressed: 'NotPressed' }),
});

// =========================================================================== Cinnabar Gym

/**
 * CinnabarGymGateCoords: quiz gate n (1-6) = entry n - 1, [bx, by, closed block]. $54 is the horizontal
 * gate, $5f the vertical one; an unlocked gate (EVENT_CINNABAR_GYM_GATE<n>_UNLOCKED) is clear floor $0e.
 */
export const CINNABAR_GATES = Object.freeze([
  Object.freeze({ bx: 9, by: 3, closed: 0x54 }),
  Object.freeze({ bx: 6, by: 3, closed: 0x54 }),
  Object.freeze({ bx: 6, by: 6, closed: 0x54 }),
  Object.freeze({ bx: 3, by: 8, closed: 0x5f }),
  Object.freeze({ bx: 2, by: 6, closed: 0x54 }),
  Object.freeze({ bx: 2, by: 3, closed: 0x54 }),
]);
export const CINNABAR_GATE_OPEN = 0x0e;

/** UpdateCinnabarGymGateTileBlocks: open floor blocks or locked gate blocks by the gate events. */
export function updateGymGates(ctx) {
  CINNABAR_GATES.forEach((g, i) => {
    ctx.setBlock(g.bx, g.by, ctx.getFlag(`EVENT_CINNABAR_GYM_GATE${i + 1}_UNLOCKED`) ? CINNABAR_GATE_OPEN : g.closed);
  });
}

/**
 * The seven gym trainers (objects 2-8 = CINNABARGYM_SUPER_NERD1-7, the text ids 2-8): the trainer's
 * class and party (object_event), the beaten event EVENT_BEAT_CINNABAR_GYM_TRAINER_<id - 2> and the
 * gate they open (EVENT_CINNABAR_GYM_GATE<id - 2>_UNLOCKED; the first one's "gate 0" has no door).
 */
export const CINNABAR_GYM_TRAINERS = Object.freeze({
  2: Object.freeze({ trainerClass: 'SUPER_NERD', partyIndex: 9 }),
  3: Object.freeze({ trainerClass: 'BURGLAR', partyIndex: 4 }),
  4: Object.freeze({ trainerClass: 'SUPER_NERD', partyIndex: 10 }),
  5: Object.freeze({ trainerClass: 'BURGLAR', partyIndex: 5 }),
  6: Object.freeze({ trainerClass: 'SUPER_NERD', partyIndex: 11 }),
  7: Object.freeze({ trainerClass: 'BURGLAR', partyIndex: 6 }),
  8: Object.freeze({ trainerClass: 'SUPER_NERD', partyIndex: 12 }),
});

/** CinnabarGymDefaultScript: the walk a trainer makes next to the quiz machine (Super Nerd 3 goes left then up). */
export const CINNABAR_QUIZ_WALKS = Object.freeze({
  4: Object.freeze({ path: Object.freeze(['left', 'up']), playerFacing: 'down' }),
  default: Object.freeze({ path: Object.freeze(['left']), playerFacing: 'right' }),
});

export const cinnabarTrainerFlag = (obj) => `EVENT_BEAT_CINNABAR_GYM_TRAINER_${obj - 2}`;
export const cinnabarGateFlag = (obj) => `EVENT_CINNABAR_GYM_GATE${obj - 2}_UNLOCKED`;

// =========================================================================== Cinnabar Lab

/** FossilsList: the fossil item, the Pokémon it becomes (GiveFossilToCinnabarLab) in the menu's order. */
export const FOSSILS = Object.freeze([
  Object.freeze({ item: 'DOME_FOSSIL', mon: 'KABUTO', dex: DEX.KABUTO }),
  Object.freeze({ item: 'HELIX_FOSSIL', mon: 'OMANYTE', dex: DEX.OMANYTE }),
  Object.freeze({ item: 'OLD_AMBER', mon: 'AERODACTYL', dex: DEX.AERODACTYL }),
]);

/** The level the revived fossil Pokémon comes back at (`ld c, 30` / GivePokemon). */
export const FOSSIL_MON_LEVEL = 30;

/** The fossil the lab was given: wFossilItem / wFossilMon (state.fossilChoice). */
export function fossilGiven(ctx) {
  const c = ctx.state.fossilChoice || {};
  return FOSSILS.find((f) => f.item === c.item) || FOSSILS.find((f) => f.dex === c.mon) || null;
}

// =========================================================================== Route 23

/**
 * Route23GuardsYCoords + the badge order of BadgeTextPointers: the object (1-based), the row it
 * checks, the badge it wants and its EVENT_PASSED_<badge>_CHECK event.
 */
export const ROUTE23_GUARDS = Object.freeze([
  ['EARTHBADGE', 35], ['VOLCANOBADGE', 56], ['MARSHBADGE', 85], ['SOULBADGE', 96],
  ['RAINBOWBADGE', 105], ['THUNDERBADGE', 119], ['CASCADEBADGE', 136],
].map(([badge, y], i) => Object.freeze({ object: i + 1, y, badge, flag: `EVENT_PASSED_${badge}_CHECK` })));

/** The Victory Road boulder events Route23SetVictoryRoadBoulders resets when the route is loaded. */
export const VICTORY_ROAD_RESET_EVENTS = Object.freeze([
  'EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH1', 'EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH2',
  'EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH1', 'EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH2',
]);

// =========================================================================== Victory Road

/** The boulder switches (dbmapcoord, in steps) and the block each one opens (`lb bc, Y, X` -> bx, by, block). */
export const VICTORY_ROAD = Object.freeze({
  VictoryRoad1F: Object.freeze({ switches: Object.freeze([[17, 13]]), door: Object.freeze({ bx: 4, by: 6, block: 0x1d }) }),
  VictoryRoad2F: Object.freeze({
    switches: Object.freeze([[1, 16], [9, 16]]),
    doors: Object.freeze([Object.freeze({ bx: 3, by: 4, block: 0x15 }), Object.freeze({ bx: 11, by: 7, block: 0x1d })]),
  }),
  VictoryRoad3F: Object.freeze({
    switch: Object.freeze([3, 5]), hole: Object.freeze([23, 15]), door: Object.freeze({ bx: 3, by: 5, block: 0x1d }),
  }),
});

// =========================================================================== Elite Four

/** LoreleiEntranceCoords / BrunoEntranceCoords / AgathaEntranceCoords (index 1-2: one tile above the way out). */
export const E4_ENTRANCE_COORDS = Object.freeze([[4, 10], [5, 10], [4, 11], [5, 11]]);

/**
 * The first three Elite Four rooms: the trainer's class and party, the beaten and "autowalked in"
 * events, the block that closes / opens the way on (`lb bc, 0, 2`: block (2, 0)), the texts.
 */
export const E4_ROOMS = Object.freeze({
  LoreleisRoom: Object.freeze({
    trainerClass: 'LORELEI', partyIndex: 1, flag: 'EVENT_BEAT_LORELEIS_ROOM_TRAINER_0',
    autowalk: 'EVENT_AUTOWALKED_INTO_LORELEIS_ROOM', startsElite4: true,
    open: 0x05, closed: 0x24,
    before: 'LoreleisRoomLoreleiBeforeBattleText', end: 'LoreleisRoomLoreleiEndBattleText',
    after: 'LoreleisRoomLoreleiAfterBattleText', dontRun: 'LoreleisRoomLoreleiDontRunAwayText',
  }),
  BrunosRoom: Object.freeze({
    trainerClass: 'BRUNO', partyIndex: 1, flag: 'EVENT_BEAT_BRUNOS_ROOM_TRAINER_0',
    autowalk: 'EVENT_AUTOWALKED_INTO_BRUNOS_ROOM', startsElite4: false,
    open: 0x05, closed: 0x24,
    before: 'BrunoBeforeBattleText', end: 'BrunoEndBattleText',
    after: 'BrunoAfterBattleText', dontRun: 'BrunosRoomBrunoDontRunAwayText',
  }),
  AgathasRoom: Object.freeze({
    trainerClass: 'AGATHA', partyIndex: 1, flag: 'EVENT_BEAT_AGATHAS_ROOM_TRAINER_0',
    autowalk: 'EVENT_AUTOWALKED_INTO_AGATHAS_ROOM', startsElite4: false,
    open: 0x0e, closed: 0x3b,
    before: 'AgathaBeforeBattleText', end: 'AgathaEndBattleText',
    after: 'AgathaAfterBattleText', dontRun: 'AgathasRoomAgathaDontRunAwayText',
  }),
});

/** LanceTriggerMovementCoords (index 1-2: next to Lance, 3-4: the doorway, 5: the entrance stairs). */
export const LANCE_TRIGGER_COORDS = Object.freeze([[5, 1], [6, 2], [5, 11], [6, 11], [24, 16]]);

/**
 * WalkToLance_RLEList (PAD_UP 12, PAD_LEFT 12, PAD_DOWN 7, PAD_LEFT 6): DecodeRLEList writes the presses
 * in the order of the source and JoypadOverworld reads them from the end (wSimulatedJoypadStatesIndex counts
 * down), so the walk is the list reversed: along the corridor from the entrance stairs (24, 16) left,
 * down, left, up the hall to the doorway (6, 11).
 */
export const LANCE_WALK = Object.freeze([['left', 6], ['down', 7], ['left', 12], ['up', 12]]);

/** LanceShowOrHideEntranceBlocks: the two blocks of the entrance (`lb bc, 6, 2` / `6, 3`), open / locked. */
export const LANCE_ENTRANCE = Object.freeze([
  Object.freeze({ bx: 2, by: 6, open: 0x31, locked: 0x72 }),
  Object.freeze({ bx: 3, by: 6, open: 0x32, locked: 0x73 }),
]);

/** Wait states of the Elite Four rooms' scripts (SCRIPT_*_PLAYER_IS_MOVING). */
export const E4_STATE = Object.freeze({ DEFAULT: 0, START_BATTLE: 1, END_BATTLE: 2, PLAYER_IS_MOVING: 3, NOOP: 4 });

// =========================================================================== Champion

/** w ChampionsRoomCurScript (SCRIPT_CHAMPIONSROOM_*). */
export const CHAMPION = Object.freeze({
  DEFAULT: 0, PLAYER_ENTERS: 1, RIVAL_READY_TO_BATTLE: 2, RIVAL_DEFEATED: 3, OAK_ARRIVES: 4,
  OAK_CONGRATULATES_PLAYER: 5, OAK_DISAPPOINTED_WITH_RIVAL: 6, OAK_COME_WITH_ME: 7, OAK_EXITS: 8,
  PLAYER_FOLLOWS_OAK: 9, CLEANUP: 10,
});

/**
 * RivalEntrance_RLEMovement (UP 1, RIGHT 1, UP 3) and WalkToHallOfFame_RLEMovement (UP 4, LEFT 1) are RLE
 * lists the game reads backwards (see LANCE_WALK): the player walks from the entrance (3, 7) up three, right,
 * up one to (4, 3) below the rival; later one step left to OAK's column and up four: three steps to the door
 * tile (3, 0) and the last press against the edge of the map, which is the warp into the Hall of Fame.
 * OakEntranceAfterVictoryMovement / OakExitChampionsRoomMovement are NPC movement lists (read forwards).
 */
export const CHAMPION_MOVES = Object.freeze({
  playerEnters: Object.freeze([['up', 3], ['right', 1], ['up', 1]]),
  oakEnters: Object.freeze([['up', 5]]),
  oakExits: Object.freeze([['up', 2]]),
  playerFollowsOak: Object.freeze([['left', 1], ['up', 4]]),
});

/**
 * ChampionsRoomRivalReadyToBattleScript: the rival's team by his starter (wRivalStarter: STARTER2 -> 1,
 * STARTER3 -> 2, else 3). Without a recorded starter (a debug warp) the "else" team is used.
 * @returns {{classConst:string, partyIndex:number}}
 */
export function championParty(ctx) {
  try {
    return rivalParty('CHAMPION', ctx.state.rivalStarter);
  } catch {
    return { classConst: 'RIVAL3', partyIndex: 3 };
  }
}

/** GetMonName of wPlayerStarter for the congratulations text. */
export function starterName(ctx) {
  const s = ctx.state.starterChoice;
  try {
    return s == null ? 'PIKACHU' : lib.speciesName(s);
  } catch {
    return String(s);
  }
}

// =========================================================================== Hall of Fame

/** w HallOfFameCurScript (SCRIPT_HALLOFFAME_*). */
export const HALL_OF_FAME = Object.freeze({ DEFAULT: 0, OAK_CONGRATULATIONS: 1, RESET_EVENTS_AND_SAVE: 2, NOOP: 3 });

/** HallOfFameEntryMovement. */
export const HOF_ENTRY_MOVE = Object.freeze([['up', 5]]);
