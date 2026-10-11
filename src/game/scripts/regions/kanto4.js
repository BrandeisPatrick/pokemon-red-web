// Region kanto4 story scripts: Lavender Town (+ Pokémon Center, Mart, Cubone's house, Mr. Fuji's
// house, the Name Rater), the Pokémon Tower, Routes 7 / 8 (+ gates and underground paths),
// Celadon City (+ the Dept. Store, Mansion, Gym, Game Corner, Diner, Chief's house, Hotel), the
// Rocket Hideout, Routes 16 / 17 / 18 with the Cycling Road gates and the Fly house
// (docs/scripting.md). Each entry ports vendor/pokered/scripts/<Map>.asm: the w<Map>CurScript state
// machines keep the asm's indices (SCRIPT_* in the comments), per-frame map scripts are onFrame, the
// map-load callbacks (BIT_CUR_MAP_LOADED_1 / _2) are onEnter, text_asm NPCs are onInteract / onSign
// (their box is managed here, so PrintText vs DisplayTextID semantics and
// wDoNotWaitForButtonPressAfterDisplayingText can be honoured) and a text_asm inside a text is
// onTextAsm. Object indices are 1-based (object_event order), sign indices 0-based.
//
// No entry (nothing to port): the Pokémon Centers and the Hotel (nurse, PC, bench guy: the engine /
// hooks), the Marts' clerks, Pokémon Tower 1F, the Celadon Mart's other floors, Celadon Mansion 2F /
// the roof, the Prize Room (script_prize_vendor: hooks), the Chief's house, Route 7, the underground
// paths (their wLastMap = ROUTE_7 / ROUTE_8 is the engine's scriptSetsLastMap), the Route 16 / 18
// gate-upstairs NPCs that only print a text. Maps whose asm script is only the trainer table get
// `{ trainers: true }` (the extracted data already marks their talks as trainer entries).
//
// Known gaps: the Diploma is drawn without the player's picture and the circle tiles; the lucky
// slot machine needs game.menus (the hooks open every machine as a plain one); the elevator shake is
// heard, not seen (lib.elevatorMenu).

import * as lib from '../lib.js';
import { rivalParty } from '../../../pokemon/trainer.js';
import {
  DEX, faceAndDelay, print, coordIndex, stopAndPlay, playCry, cry, randByte,
  setNoBattles, scriptVars, removeGuardDrink, towerRocketExit, coinCaseFull, addCoins, pickLuckySlot,
  drawCoinBox, hideCoinBox, forceBikeAt, isOwnMon, nameRaterScreen, showDiploma,
} from './kanto4_lib.js';

/** Text labels of a text_asm NPC's sub-texts: T('Label.Sub'). */
const sub = (label) => (name) => `${label}.${name}`;

/** NPCs that only pick one of two texts by an event flag (CheckEvent ... PrintText ... TextScriptEnd). */
function flagTalk(flag, ifSet, ifNot) {
  return (ctx) => (function* talk() {
    yield ctx.showText(ctx.getFlag(flag) ? ifSet : ifNot);
  }());
}

// =========================================================================== LavenderTown

const LAVENDERTOWN_LITTLE_GIRL = 1;

/** LavenderTownLittleGirlText: "Do you believe in ghosts?" YES / NO. */
function* believeInGhosts(ctx) {
  const T = sub('LavenderTownLittleGirlText');
  yield print(ctx, T('DoYouBelieveInGhostsText'));
  const yes = yield ctx.yesNo();
  yield ctx.showText(yes ? T('SoThereAreBelieversText') : T('HaHaGuessNotText'));
}

const LavenderTown = {
  onInteract(ctx, i) {
    return i === LAVENDERTOWN_LITTLE_GIRL ? believeInGhosts(ctx) : undefined;
  },
};

// =========================================================================== Lavender houses

const LAVENDERMART_COOLTRAINER_M = 3;

const LavenderMart = {
  onInteract(ctx, i) {
    return i === LAVENDERMART_COOLTRAINER_M
      ? flagTalk('EVENT_RESCUED_MR_FUJI', 'LavenderMartCooltrainerMText.NuggetText', 'LavenderMartCooltrainerMText.ReviveText')(ctx)
      : undefined;
  },
};

const LAVENDERCUBONEHOUSE_BRUNETTE_GIRL = 2;

const LavenderCuboneHouse = {
  onInteract(ctx, i) {
    return i === LAVENDERCUBONEHOUSE_BRUNETTE_GIRL
      ? flagTalk('EVENT_RESCUED_MR_FUJI', 'LavenderCuboneHouseBrunetteGirlText.TheGhostIsGoneText', 'LavenderCuboneHouseBrunetteGirlText.PoorCubonesMotherText')(ctx)
      : undefined;
  },
  onTextAsm(ctx, label) {
    // LavenderCuboneHouseCuboneText: the text, then CUBONE's cry (not waited for)
    if (label !== 'LavenderCuboneHouseCuboneText') return undefined;
    playCry(ctx, DEX.CUBONE);
    return true;
  },
};

const MRFUJISHOUSE_SUPER_NERD = 1;
const MRFUJISHOUSE_LITTLE_GIRL = 2;
const MRFUJISHOUSE_MR_FUJI = 5;

/** MrFujisHouseMrFujiText: the POKé FLUTE, once (EVENT_GOT_POKE_FLUTE); a full bag keeps it for later. */
function* mrFujiGivesFlute(ctx) {
  const T = sub('MrFujisHouseMrFujiText');
  if (ctx.getFlag('EVENT_GOT_POKE_FLUTE')) {
    yield ctx.showText(T('HasMyFluteHelpedYouText'));
    return;
  }
  yield print(ctx, T('IThinkThisMayHelpYourQuestText'));
  const ok = yield* lib.receiveKeyItem(ctx, 'POKE_FLUTE', { text: T('ReceivedPokeFluteText'), noRoomText: T('PokeFluteNoRoomText') });
  if (ok) ctx.setFlag('EVENT_GOT_POKE_FLUTE');
}

const MrFujisHouse = {
  onInteract(ctx, i) {
    switch (i) {
      case MRFUJISHOUSE_SUPER_NERD:
        return flagTalk('EVENT_RESCUED_MR_FUJI', 'MrFujisHouseSuperNerdText.MrFujiHadBeenPrayingText', 'MrFujisHouseSuperNerdText.MrFujiIsntHereText')(ctx);
      case MRFUJISHOUSE_LITTLE_GIRL:
        return flagTalk('EVENT_RESCUED_MR_FUJI', 'MrFujisHouseLittleGirlText.PokemonAreNiceToHugText', 'MrFujisHouseLittleGirlText.ThisIsMrFujisHouseText')(ctx);
      case MRFUJISHOUSE_MR_FUJI:
        return mrFujiGivesFlute(ctx);
      default:
        return undefined;
    }
  },
  onTextAsm(ctx, label) {
    // PSYDUCK's / NIDORINO's text, then the cry (not waited for)
    if (label === 'MrFujisHousePsyduckText') { playCry(ctx, DEX.PSYDUCK); return true; }
    if (label === 'MrFujisHouseNidorinoText') { playCry(ctx, DEX.NIDORINO); return true; }
    return undefined;
  },
};

// =========================================================================== NameRatersHouse

const NAMERATERSHOUSE_NAME_RATER = 1;

/**
 * NameRatersHouseNameRaterText: pick a party Pokémon, give it a new nickname. A Pokémon whose OT is not
 * the player (a trade) is refused with "that is a truly impeccable name!"; B in the party menu, NO
 * and an empty name all end with "come any time you like".
 */
function* nameRater(ctx) {
  const T = sub('NameRatersHouseNameRaterText');
  yield print(ctx, T('WantMeToRateText'));
  const yes = yield ctx.yesNo();
  if (!yes) {
    yield ctx.showText(T('ComeAnyTimeYouLikeText'));
    return;
  }
  yield print(ctx, T('WhichPokemonText'));
  const which = yield* lib.choosePartyMon(ctx, {});
  if (which < 0) {
    yield ctx.showText(T('ComeAnyTimeYouLikeText'));
    return;
  }
  const mon = ctx.state.party[which];
  const subs = { wNameBuffer: mon.nickname };
  if (!isOwnMon(ctx, mon)) {
    yield ctx.showText(T('ATrulyImpeccableNameText'), { subs });
    return;
  }
  yield print(ctx, T('GiveItANiceNameText'), { subs });
  const rename = yield ctx.yesNo();
  if (!rename) {
    yield ctx.showText(T('ComeAnyTimeYouLikeText'));
    return;
  }
  yield print(ctx, T('WhatShouldWeNameItText'));
  const name = yield* nameRaterScreen(ctx, which);
  if (!name) {
    yield ctx.showText(T('ComeAnyTimeYouLikeText'));
    return;
  }
  mon.nickname = name;
  yield ctx.showText(T('PokemonHasBeenRenamedText'), { subs: { wBuffer: name } });
}

const NameRatersHouse = {
  onInteract(ctx, i) {
    return i === NAMERATERSHOUSE_NAME_RATER ? nameRater(ctx) : undefined;
  },
};

// =========================================================================== PokemonTower2F

const POKEMONTOWER2F_RIVAL = 1;
const TOWER2F = Object.freeze({ DEFAULT: 0, DEFEATED_RIVAL: 1, RIVAL_EXITS: 2 });
/** PokemonTower2FRivalEncounterEventCoords: index 1 = (15, 5) right of the rival, 2 = (14, 6) below him. */
const TOWER2F_RIVAL_COORDS = Object.freeze([[15, 5], [14, 6]]);

/**
 * PokemonTower2FRivalDownThenRightMovement (EVENT_POKEMON_TOWER_RIVAL_ON_LEFT set: the player is
 * to his right) / PokemonTower2FRivalRightThenDownMovement (the player is below him).
 */
export function tower2FRivalExit(onLeft) {
  return onLeft
    ? ['down', 'down', 'right', 'right', 'right', 'right', 'down', 'down']
    : ['right', 'down', 'down', 'right', 'down', 'down', 'right', 'right'];
}

/** The rival's team by his starter: Squirtle 4, Bulbasaur 5, else the Charmander team 6. */
function towerRivalParty(ctx) {
  try {
    return rivalParty('POKEMON_TOWER', ctx.state.rivalStarter);
  } catch {
    return { classConst: 'RIVAL2', partyIndex: 6 };
  }
}

/**
 * PokemonTower2FRivalText's .do_battle + PokemonTower2FDefeatedRivalScript + PokemonTower2FRivalExitsScript:
 * both when the player steps next to him (the facing was set by the caller) and when he is talked to.
 */
function* towerRivalFight(ctx) {
  const T = sub('PokemonTower2FRivalText');
  yield ctx.showText(T('WhatBringsYouHereText'));
  const { classConst, partyIndex } = towerRivalParty(ctx);
  lib.setMapScript(ctx, TOWER2F.DEFEATED_RIVAL);
  const outcome = yield* lib.scriptedBattle(ctx, {
    kind: 'trainer', trainerClass: classConst, partyIndex, objectIndex: POKEMONTOWER2F_RIVAL,
    winText: T('DefeatedText'), loseText: T('VictoryText'),
  });
  if (outcome === 'lose') {
    // PokemonTower2FResetRivalEncounter; the blackout follows this script
    lib.setMapScript(ctx, TOWER2F.DEFAULT);
    return;
  }
  // PokemonTower2FDefeatedRivalScript: the same text id again, now "How's your POKéDEX coming?"
  ctx.setFlag('EVENT_BEAT_POKEMON_TOWER_RIVAL');
  yield ctx.showText(T('HowsYourDexText'));
  const exit = ctx.moveNpc(POKEMONTOWER2F_RIVAL, tower2FRivalExit(ctx.getFlag('EVENT_POKEMON_TOWER_RIVAL_ON_LEFT')));
  stopAndPlay(ctx, 'MUSIC_MEET_RIVAL_ALT_START'); // Music_RivalAlternateStart
  lib.setMapScript(ctx, TOWER2F.RIVAL_EXITS);
  yield exit;
  // PokemonTower2FRivalExitsScript
  ctx.hideToggle('TOGGLE_POKEMON_TOWER_2F_RIVAL');
  yield* lib.playMapMusic(ctx);
  lib.setMapScript(ctx, TOWER2F.DEFAULT);
}

/** PokemonTower2FDefaultScript: the player steps next to the rival (index 1: he is on the left). */
function* towerRivalEncounter(ctx, idx) {
  stopAndPlay(ctx, 'MUSIC_MEET_RIVAL');
  ctx.clearFlag('EVENT_POKEMON_TOWER_RIVAL_ON_LEFT');
  if (idx === 1) {
    ctx.setFlag('EVENT_POKEMON_TOWER_RIVAL_ON_LEFT');
    ctx.facePlayer('left');
    yield* faceAndDelay(ctx, POKEMONTOWER2F_RIVAL, 'right');
  } else {
    ctx.facePlayer('up');
    yield* faceAndDelay(ctx, POKEMONTOWER2F_RIVAL, 'down');
  }
  yield* towerRivalFight(ctx);
}

const PokemonTower2F = {
  onFrame(ctx) {
    if (lib.getMapScript(ctx) !== TOWER2F.DEFAULT) return undefined;
    if (ctx.getFlag('EVENT_BEAT_POKEMON_TOWER_RIVAL')) return undefined;
    const idx = coordIndex(ctx, TOWER2F_RIVAL_COORDS);
    return idx ? towerRivalEncounter(ctx, idx) : undefined;
  },
  onInteract(ctx, i) {
    if (i !== POKEMONTOWER2F_RIVAL) return undefined;
    return (function* rival() {
      if (ctx.getFlag('EVENT_BEAT_POKEMON_TOWER_RIVAL')) {
        yield ctx.showText('PokemonTower2FRivalText.HowsYourDexText');
        return;
      }
      yield* towerRivalFight(ctx);
    }());
  },
};

// =========================================================================== PokemonTower5F

/** PokemonTower5FPurifiedZoneCoords (the four tiles around the Channeler's altar). */
const TOWER5F_PURIFIED_ZONE = Object.freeze([[10, 8], [11, 8], [10, 9], [11, 9]]);

/** Stepping into the purified zone: wild battles off, the party healed behind a white fade. */
function* purifiedZone(ctx) {
  setNoBattles(ctx, true);
  yield* lib.healParty(ctx);
  yield ctx.fadeOut('white');
  yield ctx.wait(3);
  yield ctx.wait(3);
  yield ctx.fadeIn('white');
  yield ctx.showText('PokemonTower5FPurifiedZoneText');
}

const PokemonTower5F = {
  trainers: true,
  onFrame(ctx) {
    // PokemonTower5FDefaultScript (the other script states are the engine's trainer flow)
    if (lib.getMapScript(ctx) !== 0) return undefined;
    if (coordIndex(ctx, TOWER5F_PURIFIED_ZONE)) {
      if (ctx.getFlag('EVENT_IN_PURIFIED_ZONE')) { // CheckAndSetEvent: nothing the second time
        setNoBattles(ctx, true); // a Continue inside the zone: the overworld starts with battles on
        return undefined;
      }
      ctx.setFlag('EVENT_IN_PURIFIED_ZONE');
      return purifiedZone(ctx);
    }
    setNoBattles(ctx, false);
    ctx.clearFlag('EVENT_IN_PURIFIED_ZONE');
    return undefined;
  },
};

// =========================================================================== PokemonTower6F

const TOWER6F = Object.freeze({ DEFAULT: 0, START_BATTLE: 1, END_BATTLE: 2, PLAYER_MOVING: 3, MAROWAK_BATTLE: 4 });
/** PokemonTower6FMarowakCoords: the tile next to the stairs up. */
const TOWER6F_MAROWAK_COORDS = Object.freeze([[10, 16]]);

/** PokemonTower6FMarowakDepartedText: the GHOST was CUBONE's mother, her cry, the soul was calmed. */
function* marowakDeparted(ctx) {
  yield print(ctx, 'PokemonTower6FGhostWasCubonesMotherText');
  yield* cry(ctx, DEX.MAROWAK); // RESTLESS_SOUL = MAROWAK
  yield ctx.wait(30);
  yield ctx.showText('PokemonTower6FSoulWasCalmedText');
}

/**
 * PokemonTower6FDefaultScript + PokemonTower6FMarowakBattleScript: "Be gone...", the level 30 ghost
 * (a battle nobody can win without the SILPH SCOPE: the battle layer prints the ghost texts by the bag);
 * a win sets EVENT_BEAT_GHOST_MAROWAK, anything but a win or a loss pushes the player one step right.
 */
function* marowakGhost(ctx) {
  yield ctx.showText('PokemonTower6FBeGoneText');
  lib.setMapScript(ctx, TOWER6F.MAROWAK_BATTLE);
  const outcome = yield* lib.scriptedBattle(ctx, { kind: 'ghost', species: DEX.MAROWAK, level: 30, restlessSoul: true });
  if (outcome === 'lose') { // PokemonTower6FSetDefaultScript; the blackout follows
    lib.setMapScript(ctx, TOWER6F.DEFAULT);
    return;
  }
  if (outcome === 'win') {
    ctx.setFlag('EVENT_BEAT_GHOST_MAROWAK');
    yield* marowakDeparted(ctx);
    lib.setMapScript(ctx, TOWER6F.DEFAULT);
    return;
  }
  // .did_not_defeat: one simulated step right, then the default script again
  lib.setMapScript(ctx, TOWER6F.PLAYER_MOVING);
  yield ctx.movePlayer(['right']);
  yield ctx.wait(3);
  lib.setMapScript(ctx, TOWER6F.DEFAULT);
}

const PokemonTower6F = {
  trainers: true,
  onFrame(ctx) {
    if (lib.getMapScript(ctx) !== TOWER6F.DEFAULT) return undefined;
    if (ctx.getFlag('EVENT_BEAT_GHOST_MAROWAK')) return undefined;
    return coordIndex(ctx, TOWER6F_MAROWAK_COORDS) ? marowakGhost(ctx) : undefined;
  },
};

// =========================================================================== PokemonTower7F

const POKEMONTOWER7F_MR_FUJI = 4;
const TOWER7F = Object.freeze({ DEFAULT: 0, START_BATTLE: 1, END_BATTLE: 2, HIDE_NPC: 3, WARP_TO_MR_FUJI_HOUSE: 4 });
/** The three Rockets (object index = sprite index): beaten flag, toggle, after-battle text. */
const TOWER7F_ROCKETS = Object.freeze([1, 2, 3].map((n) => Object.freeze({
  object: n,
  flag: `EVENT_BEAT_POKEMONTOWER_7_TRAINER_${n - 1}`,
  toggle: `TOGGLE_POKEMON_TOWER_7F_ROCKET_${n}`,
  text: `PokemonTower7FRocket${n}AfterBattleText`,
})));

/**
 * PokemonTower7FEndBattleScript + PokemonTower7FRocketLeaveMovementScript + PokemonTower7FHideNPCScript:
 * once the Rocket's fight is won (the engine sets his flag; his object stays unless the trainer end
 * leaves it) his after-battle text is shown again, he walks off by where the player stands and is hidden.
 */
function* towerRocketLeaves(ctx, rocket) {
  const p = ctx.player;
  lib.setMapScript(ctx, TOWER7F.HIDE_NPC);
  ctx.npcFacePlayer(rocket.object);
  yield ctx.showText(rocket.text);
  yield ctx.moveNpc(rocket.object, towerRocketExit(rocket.object, p.x, p.y));
  ctx.hideToggle(rocket.toggle);
  lib.setMapScript(ctx, TOWER7F.DEFAULT);
}

/**
 * PokemonTower7FMrFujiText + PokemonTower7FWarpToMrFujiHouseScript: the rescue text, the flags and
 * the moved Saffron Rockets, then Mr. Fuji vanishes and the player is warped to his house (warp 2,
 * facing up, wLastMap = LAVENDER_TOWN).
 */
function* rescueMrFuji(ctx) {
  yield ctx.showText('PokemonTower7FMrFujiText.RescueText');
  ctx.setFlag('EVENT_RESCUED_MR_FUJI');
  ctx.setFlag('EVENT_RESCUED_MR_FUJI_2');
  ctx.showToggle('TOGGLE_MR_FUJIS_HOUSE_MR_FUJI');
  ctx.hideToggle('TOGGLE_SAFFRON_CITY_E');
  ctx.showToggle('TOGGLE_SAFFRON_CITY_F');
  // SCRIPT_POKEMONTOWER7F_WARP_TO_MR_FUJI_HOUSE on the next frame: Mr. Fuji vanishes, the script is reset
  ctx.hideToggle('TOGGLE_POKEMON_TOWER_7F_MR_FUJI');
  ctx.facePlayer('up');
  lib.setMapScript(ctx, TOWER7F.DEFAULT);
  yield ctx.warp('MrFujisHouse', 1, { facing: 'up' });
}

const PokemonTower7F = {
  trainers: true,
  onFrame(ctx) {
    if (lib.getMapScript(ctx) !== TOWER7F.DEFAULT) return undefined;
    for (const r of TOWER7F_ROCKETS) {
      if (ctx.getFlag(r.flag) && !ctx.state.missables.isHidden(r.toggle)) return towerRocketLeaves(ctx, r);
    }
    return undefined;
  },
  onInteract(ctx, i) {
    return i === POKEMONTOWER7F_MR_FUJI ? rescueMrFuji(ctx) : undefined;
  },
};

// =========================================================================== Saffron gates (Routes 7 / 8)

const ROUTE8GATE_GUARD = 1;
const ROUTE7GATE_GUARD = 1;
const GATE = Object.freeze({ DEFAULT: 0, PLAYER_MOVING: 1 });
const ROUTE8GATE_COORDS = Object.freeze([[2, 3], [2, 4]]);
const ROUTE7GATE_COORDS = Object.freeze([[3, 3], [3, 4]]);

/** Route8GateMovePlayerRightScript / Route7GateMovePlayerLeftScript + the PLAYER_MOVING state of `map`. */
function* gatePushPlayer(ctx, dir, map) {
  lib.setMapScript(ctx, GATE.PLAYER_MOVING, map);
  yield ctx.movePlayer([dir]);
  yield ctx.wait(3);
  lib.setMapScript(ctx, GATE.DEFAULT, map);
}

/**
 * SaffronGateGuardText (text_asm of Route5Gate.asm shared by the four gates): the drink makes him
 * let the player through for good. Without one he is thirsty and Route5GateMovePlayerUpScript pushes
 * the player back one step UP, whatever gate it is (the asm shares the code and sets wRoute5GateCurScript).
 */
function* saffronGateGuard(ctx) {
  if (lib.statusFlag(ctx, 'BIT_GAVE_SAFFRON_GUARDS_DRINK')) {
    yield ctx.showText('SaffronGateGuardThanksForTheDrinkText');
    return;
  }
  if (removeGuardDrink(ctx)) {
    yield ctx.showText('SaffronGateGuardGiveDrinkText');
    lib.setStatusFlag(ctx, 'BIT_GAVE_SAFFRON_GUARDS_DRINK');
    return;
  }
  yield ctx.showText('SaffronGateGuardGeeImThirstyText');
  yield* gatePushPlayer(ctx, 'up', 'Route5Gate');
}

/** Route8GateDefaultScript / Route7DefaultScript: stepping up to the guard without his drink. */
function saffronGateDefaultScript(ctx, { coords, facing, pushDir }) {
  if (lib.statusFlag(ctx, 'BIT_GAVE_SAFFRON_GUARDS_DRINK')) return undefined;
  if (!coordIndex(ctx, coords)) return undefined;
  return (function* gateGuard() {
    ctx.facePlayer(facing);
    if (removeGuardDrink(ctx)) {
      lib.setStatusFlag(ctx, 'BIT_GAVE_SAFFRON_GUARDS_DRINK');
      yield ctx.showText('SaffronGateGuardGiveDrinkText');
      return;
    }
    yield ctx.showText('SaffronGateGuardGeeImThirstyText');
    yield* gatePushPlayer(ctx, pushDir, ctx.map);
  }());
}

const Route8Gate = {
  onFrame(ctx) {
    if (lib.getMapScript(ctx) !== GATE.DEFAULT) return undefined;
    return saffronGateDefaultScript(ctx, { coords: ROUTE8GATE_COORDS, facing: 'left', pushDir: 'right' });
  },
  onInteract(ctx, i) {
    return i === ROUTE8GATE_GUARD ? saffronGateGuard(ctx) : undefined;
  },
};

const Route7Gate = {
  onFrame(ctx) {
    if (lib.getMapScript(ctx) !== GATE.DEFAULT) return undefined;
    return saffronGateDefaultScript(ctx, { coords: ROUTE7GATE_COORDS, facing: 'up', pushDir: 'left' });
  },
  onInteract(ctx, i) {
    return i === ROUTE7GATE_GUARD ? saffronGateGuard(ctx) : undefined;
  },
};

// =========================================================================== CeladonCity

const CELADONCITY_GRAMPS3 = 5;

/** CeladonCityGramps3Text: TM41 (SOFTBOILED), once; a full bag keeps it for later. */
function* celadonGramps3(ctx) {
  const T = sub('CeladonCityGramps3Text');
  if (ctx.getFlag('EVENT_GOT_TM41')) {
    yield ctx.showText(T('TM41ExplanationText'));
    return;
  }
  yield print(ctx, T('Text'));
  const ok = yield* lib.receiveItem(ctx, 'TM_SOFTBOILED', 1, { text: T('ReceivedTM41Text'), noRoomText: T('TM41NoRoomText') });
  if (ok) ctx.setFlag('EVENT_GOT_TM41');
}

const CeladonCity = {
  onFrame(ctx) {
    // CeladonCity_Script: ResetEvents EVENT_1B8, EVENT_1BF; ResetEvent EVENT_67F (unused leftovers)
    ctx.clearFlag('EVENT_1B8');
    ctx.clearFlag('EVENT_1BF');
    ctx.clearFlag('EVENT_67F');
    return undefined;
  },
  onInteract(ctx, i) {
    return i === CELADONCITY_GRAMPS3 ? celadonGramps3(ctx) : undefined;
  },
  onTextAsm(ctx, label) {
    // CeladonCityPoliwrathText: the text, then POLIWRATH's cry (not waited for)
    if (label !== 'CeladonCityPoliwrathText') return undefined;
    playCry(ctx, DEX.POLIWRATH);
    return true;
  },
};

// =========================================================================== Celadon Dept. Store

const CELADONMART3F_CLERK = 1;

/** CeladonMart3FClerkText: the TM counter's TM18 (COUNTER), once. */
function* martCounterTM18(ctx) {
  const T = sub('CeladonMart3FClerkText');
  if (ctx.getFlag('EVENT_GOT_TM18')) {
    yield ctx.showText(T('TM18ExplanationText'));
    return;
  }
  yield print(ctx, T('TM18PreReceiveText'));
  const ok = yield* lib.receiveItem(ctx, 'TM_COUNTER', 1, { text: T('ReceivedTM18Text'), noRoomText: T('TM18NoRoomText') });
  if (ok) ctx.setFlag('EVENT_GOT_TM18');
}

const CeladonMart3F = {
  onInteract(ctx, i) {
    return i === CELADONMART3F_CLERK ? martCounterTM18(ctx) : undefined;
  },
};

/** CeladonMartElevatorFloors / CeladonMartElevatorWarpMaps (warp number 1-based in the asm). */
export const CELADON_MART_FLOORS = Object.freeze([
  Object.freeze({ label: '1F', map: 'CeladonMart1F', warpIndex: 5 }),
  Object.freeze({ label: '2F', map: 'CeladonMart2F', warpIndex: 2 }),
  Object.freeze({ label: '3F', map: 'CeladonMart3F', warpIndex: 2 }),
  Object.freeze({ label: '4F', map: 'CeladonMart4F', warpIndex: 2 }),
  Object.freeze({ label: '5F', map: 'CeladonMart5F', warpIndex: 2 }),
]);

const CeladonMartElevator = {
  onSign(ctx, i) {
    if (i !== 0) return undefined;
    // CeladonMartElevatorText: "Which floor do you want?" (the script keeps the box from waiting afterwards)
    return (function* elevator() { yield* lib.elevatorMenu(ctx, CELADON_MART_FLOORS, 0); }());
  },
};

const CELADONMARTROOF_LITTLE_GIRL = 2;
/** CeladonMartRoofDrinkList: the drink and the TM (+ its event) the girl pays with it. */
const ROOF_DRINKS = Object.freeze([
  Object.freeze({ item: 'FRESH_WATER', tm: 'TM_ICE_BEAM', event: 'EVENT_GOT_TM13', yay: 'CeladonMartRoofLittleGirlYayFreshWaterText', got: 'CeladonMartRoofLittleGirlReceivedTM13Text' }),
  Object.freeze({ item: 'SODA_POP', tm: 'TM_ROCK_SLIDE', event: 'EVENT_GOT_TM48', yay: 'CeladonMartRoofLittleGirlYaySodaPopText', got: 'CeladonMartRoofLittleGirlReceivedTM48Text' }),
  Object.freeze({ item: 'LEMONADE', tm: 'TM_TRI_ATTACK', event: 'EVENT_GOT_TM49', yay: 'CeladonMartRoofLittleGirlYayLemonadeText', got: 'CeladonMartRoofLittleGirlReceivedTM49Text' }),
]);

/**
 * CeladonMartRoofLittleGirlText + CeladonMartRoofScript_GiveDrinkToGirl: the drinks in the bag in a
 * list at the top left, one TM per drink (the drink is taken first, a full bag loses it), "I'm not
 * thirsty" once that TM was given. Every one of her texts waits for a button itself (text_waitbutton).
 */
function* roofGirl(ctx) {
  const T = sub('CeladonMartRoofLittleGirlText');
  const drinks = ROOF_DRINKS.filter((d) => lib.hasItem(ctx, d.item));
  if (!drinks.length) {
    yield ctx.showText(T('ImThirstyText'));
    return;
  }
  yield print(ctx, T('GiveHerADrinkText'));
  const yes = yield ctx.yesNo();
  if (!yes) {
    ctx.closeText();
    return;
  }
  yield print(ctx, 'CeladonMartRoofLittleGirlGiveHerWhichDrinkText');
  const names = drinks.map((d) => lib.itemName(d.item));
  // TextBoxBorder at (0, 0), 12 wide, the names two rows apart from (2, 2)
  const choice = yield ctx.menu(names, { x: 0, y: 0, width: 14, top: 2, spacing: 2, wrap: false });
  if (choice < 0 || choice >= drinks.length) {
    ctx.closeText();
    return;
  }
  const drink = drinks[choice];
  if (ctx.getFlag(drink.event)) {
    yield print(ctx, 'CeladonMartRoofLittleGirlImNotThirstyText');
    ctx.closeText();
    return;
  }
  yield print(ctx, drink.yay);
  lib.takeItem(ctx, drink.item, 1);
  // GiveItem + PrintText: her texts end in text_waitbutton and the script sets
  // wDoNotWaitForButtonPressAfterDisplayingText, so no wait of its own follows (lib.receiveItem would add one)
  let given = ctx.giveItem(drink.tm, 1);
  if (given && typeof given.then === 'function') given = yield given;
  if (!given) {
    yield print(ctx, 'CeladonMartRoofLittleGirlNoRoomText');
    ctx.closeText();
    return;
  }
  yield print(ctx, drink.got, { subs: { wStringBuffer: lib.itemName(drink.tm) } });
  ctx.closeText();
  ctx.setFlag(drink.event);
}

const CeladonMartRoof = {
  onInteract(ctx, i) {
    return i === CELADONMARTROOF_LITTLE_GIRL ? roofGirl(ctx) : undefined;
  },
};

// =========================================================================== Celadon Mansion

const CELADONMANSION3F_GAME_DESIGNER = 4;
/** NUM_POKEMON - 1: the designer asks for everything but MEW. */
const NUM_POKEMON_WITHOUT_MEW = 150;

const CeladonMansion1F = {
  onTextAsm(ctx, label) {
    // CeladonMansion1_PlayCryScript: the text, then the cry (not waited for)
    switch (label) {
      case 'CeladonMansion1FMeowthText': playCry(ctx, DEX.MEOWTH); return true;
      case 'CeladonMansion1FClefairyText': playCry(ctx, DEX.CLEFAIRY); return true;
      case 'CeladonMansion1FNidoranFText': playCry(ctx, DEX.NIDORAN_F); return true;
      default: return undefined;
    }
  },
};

const CeladonMansion3F = {
  onInteract(ctx, i) {
    if (i !== CELADONMANSION3F_GAME_DESIGNER) return undefined;
    // CeladonMansion3FGameDesignerText: 150 Pokémon (all but MEW) owned shows the Diploma
    return (function* designer() {
      if (lib.dexOwnedCount(ctx) < NUM_POKEMON_WITHOUT_MEW) {
        yield ctx.showText('CeladonMansion3FGameDesignerText.Text');
        return;
      }
      // the text, the prompt, DisplayDiploma (its text_asm: onTextAsm below); no button wait afterwards
      yield ctx.showText('CeladonMansion3FGameDesignerText.CompletedDexText', { wait: false });
    }());
  },
  onTextAsm(ctx, label) {
    return label === 'CeladonMansion3FGameDesignerText.CompletedDexText' ? showDiploma(ctx) : undefined;
  },
};

const CELADONMANSION_ROOF_HOUSE_EEVEE_POKEBALL = 2;

const CeladonMansionRoofHouse = {
  onInteract(ctx, i) {
    if (i !== CELADONMANSION_ROOF_HOUSE_EEVEE_POKEBALL) return undefined;
    // CeladonMansionRoofHouseEeveePokeballText: GivePokemon EEVEE, level 25; the ball is gone once it was received
    return (function* eevee() {
      const ok = yield* lib.receivePokemon(ctx, { dex: DEX.EEVEE, level: 25 });
      if (ok) ctx.hideToggle('TOGGLE_CELADON_MANSION_EEVEE_GIFT');
    }());
  },
};

// =========================================================================== CeladonGym

const CELADONGYM_ERIKA = 1;
const CELADON_GYM_TRAINER_FLAGS = Object.freeze([0, 1, 2, 3, 4, 5, 6].map((n) => `EVENT_BEAT_CELADON_GYM_TRAINER_${n}`));

/**
 * CeladonGymErikaText + CeladonGymErikaPostBattleScript / CeladonGymReceiveTM21: the RAINBOWBADGE
 * (EVENT_BEAT_ERIKA), TM21 (MEGA DRAIN, offered again when the bag was full), the seven gym trainers
 * give up (lib.gymLeader).
 */
function* erika(ctx) {
  return yield* lib.gymLeader(ctx, {
    trainerClass: 'ERIKA', partyIndex: 1, gymLeaderNo: 4, objectIndex: CELADONGYM_ERIKA,
    badge: 'RAINBOWBADGE', badgeFlag: 'EVENT_BEAT_ERIKA',
    tm: 'TM_MEGA_DRAIN', tmFlag: 'EVENT_GOT_TM21',
    textBefore: 'CeladonGymErikaText.PreBattleText',
    textWin: 'CeladonGymErikaText.ReceivedRainbowBadgeText',
    textBadge: 'CeladonGymRainbowBadgeInfoText',
    textTm: 'CeladonGymReceivedTM21Text',
    textNoRoom: 'CeladonGymTM21NoRoomText',
    textAfter: 'CeladonGymErikaText.PostBattleAdviceText',
    trainerFlags: CELADON_GYM_TRAINER_FLAGS,
  });
}

const CeladonGym = {
  trainers: true,
  onInteract(ctx, i) {
    return i === CELADONGYM_ERIKA ? erika(ctx) : undefined;
  },
};

// =========================================================================== GameCorner

const GAMECORNER_CLERK1 = 2;
const GAMECORNER_FISHING_GURU = 5;
const GAMECORNER_GYM_GUIDE = 7;
const GAMECORNER_CLERK2 = 9;
const GAMECORNER_GENTLEMAN = 10;
const GAMECORNER_ROCKET = 11;
const GAMECORNER_POSTER_SIGN = 0;
const GAMECORNER = Object.freeze({ DEFAULT: 0, ROCKET_BATTLE: 1, ROCKET_EXIT: 2 });
/** The block of the Rocket Hideout's stairs at block (x 8, y 2): $2a wall until the switch, $43 stairs. */
const HIDEOUT_STAIRS = Object.freeze({ bx: 8, by: 2, wall: 0x2a, stairs: 0x43 });

/** GameCornerSetRocketHideoutDoorTile (BIT_CUR_MAP_LOADED_1) + GameCornerSelectLuckySlotMachine (_2). */
function gameCornerOnLoad(ctx) {
  if (!ctx.getFlag('EVENT_FOUND_ROCKET_HIDEOUT')) ctx.setBlock(HIDEOUT_STAIRS.bx, HIDEOUT_STAIRS.by, HIDEOUT_STAIRS.wall);
  scriptVars(ctx).luckySlot = pickLuckySlot(randByte(ctx));
}

/** GameCornerRocketBattleScript: the Rocket walks off, straight when the player is on his row or column. */
export function gameCornerRocketExit(player) {
  if (player.y === 6 || player.x === 8) return ['right', 'right', 'right', 'right', 'right']; // WalkDirect
  return ['down', 'right', 'right', 'up', 'right', 'right', 'right', 'right']; // WalkAroundPlayer
}

/**
 * GameCornerRocketText + GameCornerRocketBattleScript + GameCornerRocketExitScript: the Rocket guarding
 * the poster fights (ROCKET party 7), tells where the switch is, walks away and is hidden.
 */
function* gameCornerRocket(ctx) {
  yield ctx.showText('GameCornerRocketText.ImGuardingThisPosterText');
  lib.setMapScript(ctx, GAMECORNER.ROCKET_BATTLE);
  const outcome = yield* lib.scriptedBattle(ctx, {
    kind: 'trainer', trainerClass: 'ROCKET', partyIndex: 7, objectIndex: GAMECORNER_ROCKET,
    winText: 'GameCornerRocketText.BattleEndText', loseText: 'GameCornerRocketText.BattleEndText',
  });
  if (outcome === 'lose') { // GameCornerReenterMapAfterPlayerLoss; the blackout follows
    lib.setMapScript(ctx, GAMECORNER.DEFAULT);
    return;
  }
  yield ctx.showText('GameCornerRocketAfterBattleText');
  lib.setMapScript(ctx, GAMECORNER.ROCKET_EXIT);
  yield ctx.moveNpc(GAMECORNER_ROCKET, gameCornerRocketExit(ctx.player));
  ctx.hideToggle('TOGGLE_GAME_CORNER_ROCKET');
  lib.setMapScript(ctx, GAMECORNER.DEFAULT);
  gameCornerOnLoad(ctx); // BIT_CUR_MAP_LOADED_1 / _2 are set again: the tile and the lucky machine
}

/**
 * GameCornerPosterText: "A switch behind the poster!? Let's push it!" (SFX_SWITCH from the text's own
 * text_asm: onTextAsm below), SFX_GO_INSIDE, EVENT_FOUND_ROCKET_HIDEOUT, the stairs block appears; the
 * box closes without a button wait.
 */
function* gameCornerPoster(ctx) {
  yield ctx.showText('GameCornerPosterText.SwitchBehindPosterText', { wait: false, close: false });
  yield* lib.fanfare(ctx, 'SFX_GO_INSIDE');
  ctx.setFlag('EVENT_FOUND_ROCKET_HIDEOUT');
  ctx.setBlock(HIDEOUT_STAIRS.bx, HIDEOUT_STAIRS.by, HIDEOUT_STAIRS.stairs);
  ctx.closeText();
}

/** GameCornerClerk1Text: 50 coins for ¥1000 (COIN CASE with room for 9 more coins, ¥1000). */
function* coinClerk(ctx) {
  const T = sub('GameCornerClerk1Text');
  drawCoinBox(ctx);
  yield print(ctx, T('DoYouNeedSomeGameCoins'));
  const yes = yield ctx.yesNo();
  let label = 'PleaseComePlaySometime';
  if (yes) {
    if (!lib.hasItem(ctx, 'COIN_CASE')) label = 'DontHaveCoinCase';
    else if (coinCaseFull(ctx)) label = 'CoinCaseIsFull';
    else if (lib.money(ctx) < 1000) label = 'CantAffordTheCoins';
    else {
      lib.takeMoney(ctx, 1000);
      addCoins(ctx, 50);
      drawCoinBox(ctx);
      label = 'ThanksHereAre50Coins';
    }
  }
  yield ctx.showText(T(label));
  hideCoinBox(ctx);
}

/**
 * The three NPCs that give coins once: the fishing guru (10, closes without a wait), the second clerk (20)
 * and the gentleman (20, who checks `jr z` for exactly 9990 coins, not "9990 or more").
 */
function* coinGiver(ctx, o) {
  const T = sub(o.label);
  if (ctx.getFlag(o.event)) {
    yield ctx.showText(T(o.again));
    return;
  }
  yield print(ctx, T(o.intro));
  if (!lib.hasItem(ctx, 'COIN_CASE')) {
    yield ctx.showText('GameCornerOopsForgotCoinCaseText');
    return;
  }
  if (o.full(ctx)) {
    yield ctx.showText(T(o.fullText));
    return;
  }
  addCoins(ctx, o.coins);
  ctx.setFlag(o.event);
  if (o.noWait) {
    yield print(ctx, T(o.received));
    ctx.closeText();
    return;
  }
  yield ctx.showText(T(o.received));
}

/** GameCornerGymGuideText. */
function* gameCornerGymGuide(ctx) {
  yield ctx.showText(ctx.getFlag('EVENT_BEAT_ERIKA') ? 'GameCornerGymGuideTheyOfferRarePokemonText' : 'GameCornerGymGuideChampInMakingText');
}

/** StartSlotMachine's out-of-order texts by hidden-event argument. */
const SLOT_MESSAGES = Object.freeze({
  SLOTS_OUTOFORDER: 'GameCornerOutOfOrderText',
  SLOTS_OUTTOLUNCH: 'GameCornerOutToLunchText',
  SLOTS_SOMEONESKEYS: 'GameCornerSomeonesKeysText',
});

/**
 * StartSlotMachine (engine/slots/game_corner_slots.asm): the three broken machines print their texts;
 * AbleToPlaySlotsCheck needs the player facing left or right (image index & 8), then the lucky machine
 * (hidden event index + 1 == wLuckySlotHiddenEventIndex) gets wSlotMachineSevenAndBarModeChance 250
 * instead of 253. The COIN CASE / coin checks and the play are the menus' slotsScene.
 * @returns {Generator|any} ctx.DEFAULT (the hooks' plain machine) when game.menus is not there
 */
function* startSlotMachine(ctx, entry) {
  const message = SLOT_MESSAGES[entry && entry.arg];
  if (message) {
    yield ctx.showText(message);
    return undefined;
  }
  const facing = ctx.player.facing;
  if (facing !== 'left' && facing !== 'right') return undefined; // not able: a silent return
  const menus = ctx.ov && ctx.ov.game && ctx.ov.game.menus;
  if (!menus || typeof menus.slotsScene !== 'function') return ctx.DEFAULT;
  const list = (ctx.mapData && ctx.mapData.hiddenObjects) || [];
  const index = list.findIndex((h) => h === entry || (h.x === entry.x && h.y === entry.y && h.routine === entry.routine));
  const lucky = index >= 0 && index + 1 === scriptVars(ctx).luckySlot;
  yield menus.slotsScene({ lucky });
  return undefined;
}

const GameCorner = {
  onEnter(ctx) {
    gameCornerOnLoad(ctx);
    return undefined;
  },
  onInteract(ctx, i) {
    switch (i) {
      case GAMECORNER_CLERK1:
        return coinClerk(ctx);
      case GAMECORNER_FISHING_GURU:
        return coinGiver(ctx, {
          label: 'GameCornerFishingGuruText', event: 'EVENT_GOT_10_COINS', again: 'WinsComeAndGoText', intro: 'WantToPlayText',
          coins: 10, received: 'Received10CoinsText', fullText: 'DontNeedMyCoinsText', full: coinCaseFull, noWait: true,
        });
      case GAMECORNER_GYM_GUIDE:
        return gameCornerGymGuide(ctx);
      case GAMECORNER_CLERK2:
        return coinGiver(ctx, {
          label: 'GameCornerClerk2Text', event: 'EVENT_GOT_20_COINS_2', again: 'INeedMoreCoinsText', intro: 'WantSomeCoinsText',
          coins: 20, received: 'Received20CoinsText', fullText: 'YouHaveLotsOfCoinsText', full: coinCaseFull,
        });
      case GAMECORNER_GENTLEMAN:
        return coinGiver(ctx, {
          label: 'GameCornerGentlemanText', event: 'EVENT_GOT_20_COINS', again: 'CloselyWatchTheReelsText', intro: 'ThrowingMeOffText',
          coins: 20, received: 'Received20CoinsText', fullText: 'YouGotYourOwnCoinsText', full: (c) => (c.state.coins | 0) === 9990,
        });
      case GAMECORNER_ROCKET:
        return gameCornerRocket(ctx);
      default:
        return undefined;
    }
  },
  onSign(ctx, i) {
    return i === GAMECORNER_POSTER_SIGN ? gameCornerPoster(ctx) : undefined;
  },
  onHiddenObject(ctx, routine, entry) {
    return routine === 'StartSlotMachine' ? startSlotMachine(ctx, entry) : undefined;
  },
  onTextAsm(ctx, label) {
    // the poster's text_asm: SFX_SWITCH, waited for
    return label === 'GameCornerPosterText.SwitchBehindPosterText' ? lib.fanfare(ctx, 'SFX_SWITCH') : undefined;
  },
};

// =========================================================================== CeladonDiner

const CELADONDINER_GYM_GUIDE = 5;

/** CeladonDinerGymGuideText: the COIN CASE, once. */
function* dinerCoinCase(ctx) {
  const T = sub('CeladonDinerGymGuideText');
  if (ctx.getFlag('EVENT_GOT_COIN_CASE')) {
    yield ctx.showText(T('WinItBackText'));
    return;
  }
  yield print(ctx, T('ImFlatOutBustedText'));
  const ok = yield* lib.receiveKeyItem(ctx, 'COIN_CASE', { text: T('ReceivedCoinCaseText'), noRoomText: T('CoinCaseNoRoomText') });
  if (ok) ctx.setFlag('EVENT_GOT_COIN_CASE');
}

const CeladonDiner = {
  onInteract(ctx, i) {
    return i === CELADONDINER_GYM_GUIDE ? dinerCoinCase(ctx) : undefined;
  },
};

// =========================================================================== Rocket Hideout

/**
 * The B1F door (block 12, 8): $54 closed until the guard at the elevator (trainer 4) is beaten; then
 * SFX_GO_INSIDE and the floor block $0e. EVENT_ENTERED_ROCKET_HIDEOUT is never set by the game (its own
 * "BUG" comment), so the sound plays every time the map is loaded after the fight.
 */
const HIDEOUT_B1F_DOOR = Object.freeze({ bx: 12, by: 8, closed: 0x54, open: 0x0e });
/** B1F: which state object has the door shown open (the block itself is not readable from a test ctx). */
const b1fDoorShown = new WeakMap();

function hideoutB1FDoor(ctx) {
  const d = HIDEOUT_B1F_DOOR;
  let open = true;
  if (!ctx.getFlag('EVENT_ENTERED_ROCKET_HIDEOUT')) {
    if (ctx.getFlag('EVENT_BEAT_ROCKET_HIDEOUT_1_TRAINER_4')) ctx.playSfx('SFX_GO_INSIDE');
    else open = false;
  }
  ctx.setBlock(d.bx, d.by, open ? d.open : d.closed);
  b1fDoorShown.set(ctx.state, open);
}

const RocketHideoutB1F = {
  trainers: true,
  onEnter(ctx) {
    hideoutB1FDoor(ctx);
    return undefined;
  },
  onFrame(ctx) {
    // EndTrainerBattle sets BIT_CUR_MAP_LOADED_1 again: the door callback runs after the guard's fight
    if (ctx.getFlag('EVENT_BEAT_ROCKET_HIDEOUT_1_TRAINER_4') && !b1fDoorShown.get(ctx.state)) hideoutB1FDoor(ctx);
    return undefined;
  },
};

const RocketHideoutB2F = { trainers: true, spinners: true };
const RocketHideoutB3F = { trainers: true, spinners: true };

const ROCKETHIDEOUTB4F_GIOVANNI = 1;
const HIDEOUT_B4F = Object.freeze({ DEFAULT: 0, START_BATTLE: 1, END_BATTLE: 2, BEAT_GIOVANNI: 3 });
/** The B4F door (block 12, 5): $2d until both guards beside it (trainers 0 and 1) are beaten. */
const HIDEOUT_B4F_DOOR = Object.freeze({ bx: 12, by: 5, closed: 0x2d, open: 0x0e });

function hideoutB4FDoor(ctx) {
  const d = HIDEOUT_B4F_DOOR;
  if (!ctx.getFlag('EVENT_ROCKET_HIDEOUT_4_DOOR_UNLOCKED')) {
    if (!(ctx.getFlag('EVENT_BEAT_ROCKET_HIDEOUT_4_TRAINER_0') && ctx.getFlag('EVENT_BEAT_ROCKET_HIDEOUT_4_TRAINER_1'))) {
      ctx.setBlock(d.bx, d.by, d.closed);
      return;
    }
    ctx.playSfx('SFX_GO_INSIDE');
    ctx.setFlag('EVENT_ROCKET_HIDEOUT_4_DOOR_UNLOCKED');
  }
  ctx.setBlock(d.bx, d.by, d.open);
}

/**
 * RocketHideoutB4FGiovanniText + RocketHideoutB4FBeatGiovanniScript: the fight (GIOVANNI party 1), his
 * parting speech, a fade to black in which he disappears and the SILPH SCOPE appears where he stood.
 */
function* hideoutGiovanni(ctx) {
  const T = sub('RocketHideoutB4FGiovanniText');
  if (ctx.getFlag('EVENT_BEAT_ROCKET_HIDEOUT_GIOVANNI')) {
    yield ctx.showText('RocketHideoutB4FGiovanniHopeWeMeetAgainText');
    return;
  }
  yield ctx.showText(T('ImpressedYouGotHereText'));
  lib.setMapScript(ctx, HIDEOUT_B4F.BEAT_GIOVANNI);
  const outcome = yield* lib.scriptedBattle(ctx, {
    kind: 'trainer', trainerClass: 'GIOVANNI', partyIndex: 1, objectIndex: ROCKETHIDEOUTB4F_GIOVANNI,
    winText: T('WhatCannotBeText'), loseText: T('WhatCannotBeText'),
  });
  if (outcome === 'lose') { // RocketHideoutB4FSetDefaultScript; the blackout follows
    lib.setMapScript(ctx, HIDEOUT_B4F.DEFAULT);
    return;
  }
  ctx.setFlag('EVENT_BEAT_ROCKET_HIDEOUT_GIOVANNI');
  yield ctx.showText('RocketHideoutB4FGiovanniHopeWeMeetAgainText');
  yield ctx.fadeOut('black');
  ctx.hideToggle('TOGGLE_ROCKET_HIDEOUT_B4F_GIOVANNI');
  ctx.showToggle('TOGGLE_ROCKET_HIDEOUT_B4F_ITEM_4'); // the SILPH SCOPE
  yield ctx.fadeIn('black');
  hideoutB4FDoor(ctx); // BIT_CUR_MAP_LOADED_1 is set again
  lib.setMapScript(ctx, HIDEOUT_B4F.DEFAULT);
}

const RocketHideoutB4F = {
  trainers: true,
  onEnter(ctx) {
    hideoutB4FDoor(ctx);
    return undefined;
  },
  onFrame(ctx) {
    // the two guards beaten: the door callback (EndTrainerBattle sets BIT_CUR_MAP_LOADED_1)
    if (lib.getMapScript(ctx) !== HIDEOUT_B4F.DEFAULT) return undefined;
    if (!ctx.getFlag('EVENT_ROCKET_HIDEOUT_4_DOOR_UNLOCKED')
        && ctx.getFlag('EVENT_BEAT_ROCKET_HIDEOUT_4_TRAINER_0') && ctx.getFlag('EVENT_BEAT_ROCKET_HIDEOUT_4_TRAINER_1')) hideoutB4FDoor(ctx);
    return undefined;
  },
  onInteract(ctx, i) {
    return i === ROCKETHIDEOUTB4F_GIOVANNI ? hideoutGiovanni(ctx) : undefined;
  },
  onTextAsm(ctx, label) {
    if (label !== 'RocketHideoutB4FRocket3AfterBattleText') return undefined;
    // the third Rocket drops the LIFT KEY the first time he is talked to after the fight
    return (function* liftKey() {
      yield print(ctx, 'RocketHideoutB4FRocket3AfterBattleText.Text');
      if (ctx.getFlag('EVENT_ROCKET_DROPPED_LIFT_KEY')) return;
      ctx.setFlag('EVENT_ROCKET_DROPPED_LIFT_KEY');
      ctx.showToggle('TOGGLE_ROCKET_HIDEOUT_B4F_ITEM_5');
    }());
  },
};

/** RocketHideoutElevatorFloors / RocketHideoutElevatorWarpMaps. */
export const ROCKET_HIDEOUT_FLOORS = Object.freeze([
  Object.freeze({ label: 'B1F', map: 'RocketHideoutB1F', warpIndex: 4 }),
  Object.freeze({ label: 'B2F', map: 'RocketHideoutB2F', warpIndex: 4 }),
  Object.freeze({ label: 'B4F', map: 'RocketHideoutB4F', warpIndex: 2 }),
]);

const RocketHideoutElevator = {
  onSign(ctx, i) {
    if (i !== 0) return undefined;
    // RocketHideoutElevatorText: the LIFT KEY, else "It appears to need a key" (text_waitbutton, no more wait)
    return (function* elevator() {
      if (!lib.hasItem(ctx, 'LIFT_KEY')) {
        yield print(ctx, 'RocketHideoutElevatorText.AppearsToNeedKeyText');
        ctx.closeText();
        return;
      }
      yield* lib.elevatorMenu(ctx, ROCKET_HIDEOUT_FLOORS, 0);
    }());
  },
};

// =========================================================================== Route 16 and the Cycling Road

const ROUTE16 = Object.freeze({ DEFAULT: 0, START_BATTLE: 1, END_BATTLE: 2, SNORLAX_POST_BATTLE: 3 });
/** CheckForceBikeOrSurf: the gate's west door tiles on Route 16 / Route 18 put the player on the bike. */
const ROUTE16_BIKE_COORDS = Object.freeze([[17, 10], [17, 11]]);
const ROUTE18_BIKE_COORDS = Object.freeze([[33, 8], [33, 9]]);

/**
 * Route16DefaultScript + Route16SnorlaxPostBattleScript: the POKé FLUTE woke SNORLAX (the flute's
 * request set EVENT_FIGHT_ROUTE16_SNORLAX, see hooks.lastPokeFlute): its text, it disappears from the
 * map, the level 30 wild battle. A loss resets the script (the road stays open, as in the asm); a win,
 * a catch or running away set EVENT_BEAT_ROUTE16_SNORLAX, with "returned to the mountains" unless it was
 * caught / escaped from (wBattleResult == 2).
 */
function* route16Snorlax(ctx) {
  yield ctx.showText('Route16SnorlaxWokeUpText');
  ctx.hideToggle('TOGGLE_ROUTE_16_SNORLAX');
  lib.setMapScript(ctx, ROUTE16.SNORLAX_POST_BATTLE);
  const outcome = yield* lib.scriptedBattle(ctx, { kind: 'wild', species: DEX.SNORLAX, level: 30 });
  if (outcome === 'lose') {
    lib.setMapScript(ctx, ROUTE16.DEFAULT); // Route16ResetScripts
    return;
  }
  if (outcome !== 'caught' && outcome !== 'ran') yield ctx.showText('Route16SnorlaxReturnedToMountainsText');
  ctx.setFlag('EVENT_BEAT_ROUTE16_SNORLAX');
  yield ctx.wait(3);
  lib.setMapScript(ctx, ROUTE16.DEFAULT);
}

const Route16 = {
  trainers: true,
  onEnter(ctx) {
    forceBikeAt(ctx, ROUTE16_BIKE_COORDS);
    return undefined;
  },
  onFrame(ctx) {
    if (lib.getMapScript(ctx) !== ROUTE16.DEFAULT) return undefined;
    if (ctx.getFlag('EVENT_BEAT_ROUTE16_SNORLAX') || !ctx.getFlag('EVENT_FIGHT_ROUTE16_SNORLAX')) return undefined;
    ctx.clearFlag('EVENT_FIGHT_ROUTE16_SNORLAX');
    return route16Snorlax(ctx);
  },
};

const ROUTE16GATE1F_GUARD = 1;
const ROUTE18GATE1F_GUARD = 1;
const CYCLING_GATE = Object.freeze({ DEFAULT: 0, PLAYER_MOVING_UP: 1, GUARD: 2, PLAYER_MOVING_RIGHT: 3 });
/** Route16Gate1FDefaultScript.StopsPlayerCoords / Route18Gate1FDefaultScript.StopsPlayerCoords. */
const ROUTE16GATE1F_STOPS = Object.freeze([[4, 7], [4, 8], [4, 9], [4, 10]]);
const ROUTE18GATE1F_STOPS = Object.freeze([[4, 3], [4, 4], [4, 5], [4, 6]]);

/** Route16Gate1FGuardText / Route18Gate1FGuardText: the bicycle decides the text. */
function* cyclingGateGuardText(ctx, o) {
  yield ctx.showText(lib.hasItem(ctx, 'BICYCLE') ? o.withBike : o.withoutBike);
}

/**
 * Route16Gate1FDefaultScript .. Route16Gate1FPlayerMovingRightScript: walking the Cycling Road's
 * gate without a BICYCLE in the bag, the guard calls out ("Wait up!" / "Excuse me!"), the player
 * is walked up to the counter (index 1 = already there), the guard refuses, and the player is
 * pushed one step right (back towards the town).
 */
function* cyclingGateStopsPedestrian(ctx, idx, o) {
  yield ctx.showText(o.callOut); // DisplayTextID TEXT_..._GUARD_WAIT_UP / _EXCUSE_ME
  if (idx !== 1) {
    lib.setMapScript(ctx, CYCLING_GATE.PLAYER_MOVING_UP);
    yield ctx.movePlayer([['up', idx - 1]]);
  }
  lib.setMapScript(ctx, CYCLING_GATE.GUARD);
  yield* cyclingGateGuardText(ctx, o);
  lib.setMapScript(ctx, CYCLING_GATE.PLAYER_MOVING_RIGHT);
  yield ctx.movePlayer(['right']);
  lib.setMapScript(ctx, CYCLING_GATE.DEFAULT);
}

/** The ground floor of a Cycling Road gate (both are the same script). */
function cyclingGate1F({ stops, callOut, withBike, withoutBike }) {
  const o = { callOut, withBike, withoutBike };
  return {
    onFrame(ctx) {
      lib.setStatusFlag(ctx, 'BIT_ALWAYS_ON_BIKE', false); // inside the gate the bike is optional again
      if (lib.getMapScript(ctx) !== CYCLING_GATE.DEFAULT) return undefined;
      if (lib.hasItem(ctx, 'BICYCLE')) return undefined;
      const idx = coordIndex(ctx, stops);
      return idx ? cyclingGateStopsPedestrian(ctx, idx, o) : undefined;
    },
    onInteract(ctx, i) {
      return i === 1 ? cyclingGateGuardText(ctx, o) : undefined;
    },
  };
}

const Route16Gate1F = cyclingGate1F({
  stops: ROUTE16GATE1F_STOPS,
  callOut: 'Route16Gate1FGuardWaitUpText',
  withBike: 'Route16Gate1FGuardText.CyclingRoadExplanationText',
  withoutBike: 'Route16Gate1FGuardText.NoPedestriansAllowedText',
});

const Route18Gate1F = cyclingGate1F({
  stops: ROUTE18GATE1F_STOPS,
  callOut: 'Route18Gate1FGuardExcuseMeText',
  withBike: 'Route18Gate1FGuardText.CyclingRoadUphillText',
  withoutBike: 'Route18Gate1FGuardText.YouNeedABicycleText',
});

/** GateUpstairsScript_PrintIfFacingUp: a binocular only answers when the player faces up. */
const binocularsNeedFacingUp = (ctx) => (ctx.player.facing === 'up' ? undefined : true);

const Route16Gate2F = {
  onSign(ctx) {
    return binocularsNeedFacingUp(ctx); // both binoculars (the engine prints their text)
  },
};

const ROUTE16FLYHOUSE_BRUNETTE_GIRL = 1;

/** Route16FlyHouseBrunetteGirlText: HM02 (FLY), once; a full bag keeps it for later. */
function* flyHouseGirl(ctx) {
  const T = sub('Route16FlyHouseBrunetteGirlText');
  if (ctx.getFlag('EVENT_GOT_HM02')) {
    yield ctx.showText(T('HM02ExplanationText'));
    return;
  }
  yield print(ctx, T('Text'));
  const ok = yield* lib.receiveItem(ctx, 'HM_FLY', 1, { text: T('ReceivedHM02Text'), noRoomText: T('HM02NoRoomText') });
  if (ok) ctx.setFlag('EVENT_GOT_HM02');
}

const Route16FlyHouse = {
  onInteract(ctx, i) {
    if (i === ROUTE16FLYHOUSE_BRUNETTE_GIRL) return flyHouseGirl(ctx);
    return undefined;
  },
  onTextAsm(ctx, label) {
    // Route16FlyHouseFearowText: the text, FEAROW's cry, waited for
    if (label !== 'Route16FlyHouseFearowText') return undefined;
    return (function* fearow() {
      yield print(ctx, 'Route16FlyHouseFearowText.Text');
      yield* cry(ctx, DEX.FEAROW);
    }());
  },
};

const ROUTE18GATE2F_YOUNGSTER = 1;

const Route18Gate2F = {
  onInteract(ctx, i) {
    if (i !== ROUTE18GATE2F_YOUNGSTER) return undefined;
    return (function* trade() { yield* lib.npcTrade(ctx, 'TRADE_FOR_MARC'); }());
  },
  onSign(ctx) {
    return binocularsNeedFacingUp(ctx);
  },
};

export default {
  LavenderTown,
  LavenderMart,
  LavenderCuboneHouse,
  MrFujisHouse,
  NameRatersHouse,
  PokemonTower2F,
  PokemonTower3F: { trainers: true },
  PokemonTower4F: { trainers: true },
  PokemonTower5F,
  PokemonTower6F,
  PokemonTower7F,
  Route8: { trainers: true },
  Route8Gate,
  Route7Gate,
  CeladonCity,
  CeladonMart3F,
  CeladonMartElevator,
  CeladonMartRoof,
  CeladonMansion1F,
  CeladonMansion3F,
  CeladonMansionRoofHouse,
  CeladonGym,
  GameCorner,
  CeladonDiner,
  RocketHideoutB1F,
  RocketHideoutB2F,
  RocketHideoutB3F,
  RocketHideoutB4F,
  RocketHideoutElevator,
  Route16,
  Route16Gate1F,
  Route16Gate2F,
  Route16FlyHouse,
  Route17: { trainers: true },
  Route18: {
    trainers: true,
    onEnter(ctx) {
      forceBikeAt(ctx, ROUTE18_BIKE_COORDS);
      return undefined;
    },
  },
  Route18Gate1F,
  Route18Gate2F,
};
