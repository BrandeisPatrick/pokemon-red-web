// Region kanto6 story scripts: Cinnabar Island (+ the Gym with its quiz machines, the Pokémon Lab
// with the fossil revival, the Pokémon Center and Mart), the Pokémon Mansion (1F-3F, B1F), Route 23
// and its badge guards, Victory Road 1F-3F, the Indigo Plateau lobby, the four Elite Four rooms,
// the Champion's room, the Hall of Fame (the ending: src/game/scripts/regions/kanto6_ending.js) and
// the Cerulean Cave (docs/scripting.md). Each entry ports vendor/pokered/scripts/<Map>.asm: the
// w<Map>CurScript state machines keep the asm's indices (SCRIPT_* in the comments), per-frame map
// scripts are onFrame, the map-load callbacks (BIT_CUR_MAP_LOADED_1 / _2) are onEnter, text_asm
// NPCs are onInteract (their box is managed here, so PrintText vs DisplayTextID semantics and
// wDoNotWaitForButtonPressAfterDisplayingText can be honoured), the hidden events (the Mansion's
// statue switches and the Gym's quiz machines) are onHiddenObject and the boulder switches of
// Victory Road are onBoulderPushed (BIT_PUSHED_BOULDER + CheckBoulderCoords). Object indices are
// 1-based (object_event order), sign indices 0-based.
//
// No entry (nothing to port): CinnabarLab (texts only), the Cinnabar Pokémon Center and Mart (nurse,
// PC, clerk and link receptionist are the engine's / hooks.js'), IndigoPlateau (outside; only the
// HQ sign), Cerulean Cave 1F / 2F (item balls), TradeCenter and Colosseum (their script only turns
// the link partner's sprite: there is no link here, the receptionists answer "reserved for 2
// friends" through hooks.js' script_cable_club_receptionist). The trainers of the Mansion, Victory
// Road and Cerulean Cave, Moltres and Mewtwo are the engine's trainer flow (the cries are the
// onTextAsm of their battle texts); the Elite Four and the Champion are fought from here so the
// post-battle texts, the opened way on and the script states of the asm are kept.
//
// Known gaps: none of the gym quiz / Mansion / Victory Road puzzles is simplified; the ending's
// pictures are drawn by kanto6_ending.js on the intro's Game Boy screen model (see its header).

import * as lib from '../lib.js';
import {
  DEX, faceAndDelay, print, waitAndClose, coordIndex, cry, waitForSound, playTrainerMusic, setMansionDoors, MANSION_SWITCHES, updateGymGates, CINNABAR_GYM_TRAINERS,
  CINNABAR_QUIZ_WALKS, cinnabarTrainerFlag, cinnabarGateFlag, FOSSILS, FOSSIL_MON_LEVEL, fossilGiven,
  ROUTE23_GUARDS, VICTORY_ROAD_RESET_EVENTS, VICTORY_ROAD, E4_ENTRANCE_COORDS, E4_ROOMS,
  LANCE_TRIGGER_COORDS, LANCE_WALK, LANCE_ENTRANCE, E4_STATE, CHAMPION, CHAMPION_MOVES, championParty,
  starterName, HALL_OF_FAME, HOF_ENTRY_MOVE,
} from './kanto6_lib.js';
import { playEnding } from './kanto6_ending.js';

/** A wait state seen by onFrame is stale (the asm's wait states end within one script here): back to default. */
function resetStale(ctx, def = 0) {
  if (lib.getMapScript(ctx) === def) return false;
  lib.setMapScript(ctx, def);
  return true;
}

// =========================================================================== CinnabarIsland

const CINNABAR_ISLAND = Object.freeze({ DEFAULT: 0, PLAYER_MOVING: 1 });
/** The tile below the Gym door (wYCoord 4, wXCoord 18). */
const CINNABAR_GYM_DOOR_TILE = Object.freeze({ x: 18, y: 4 });

/** CinnabarIslandDefaultScript: no SECRET KEY - "The door is locked...", one step back down. */
function* cinnabarDoorLocked(ctx) {
  ctx.facePlayer('up');
  yield ctx.showText('CinnabarIslandDoorIsLockedText');
  lib.setMapScript(ctx, CINNABAR_ISLAND.PLAYER_MOVING);
  ctx.facePlayer('down');
  yield ctx.movePlayer(['down']);
  yield ctx.wait(3);
  lib.setMapScript(ctx, CINNABAR_ISLAND.DEFAULT);
}

const CinnabarIsland = {
  onFrame(ctx) {
    // CinnabarIsland_Script: the Mansion's switch and the lab's "still reviving" event reset every frame
    ctx.clearFlag('EVENT_MANSION_SWITCH_ON');
    ctx.clearFlag('EVENT_LAB_STILL_REVIVING_FOSSIL');
    if (resetStale(ctx, CINNABAR_ISLAND.DEFAULT)) return undefined;
    if (lib.hasItem(ctx, 'SECRET_KEY')) return undefined;
    const p = ctx.player;
    if (p.y !== CINNABAR_GYM_DOOR_TILE.y || p.x !== CINNABAR_GYM_DOOR_TILE.x) return undefined;
    return cinnabarDoorLocked(ctx);
  },
};

// =========================================================================== CinnabarGym

const CINNABARGYM_BLAINE = 1;
const CINNABARGYM_GYM_GUIDE = 9;
const CINNABAR_GYM_TRAINER_FLAGS = Object.freeze([0, 1, 2, 3, 4, 5, 6].map((n) => `EVENT_BEAT_CINNABAR_GYM_TRAINER_${n}`));

const QUIZ_CORRECT = Object.freeze([
  { cmd: 'sound', sound: 'sound_get_item_1' }, { cmd: 'text_far', label: '_CinnabarGymQuizCorrectText' },
  { cmd: 'text_promptbutton' }, { cmd: 'text_end' },
]);
const QUIZ_INCORRECT = Object.freeze([{ cmd: 'text_far', label: '_CinnabarGymQuizIncorrectText' }, { cmd: 'text_end' }]);
const quizQuestion = (gate) => [{ cmd: 'text_far', label: `_CinnabarQuizQuestionsText${gate}` }, { cmd: 'text_end' }];

/**
 * CinnabarGymSuperNerdN (text_asm via CinnabarGymSetTrainerHeader) + CinnabarGymStartBattleScript +
 * CinnabarGymOpenGateScript: a beaten trainer says his after-battle text; otherwise his battle text,
 * the fight, and the win sets his event, unlocks the gate (with SFX_GO_INSIDE the first time) and
 * redraws the gates. Their sprites have no sight range: only the quiz (or a talk) brings the fight.
 * @param {number} obj object index 2-8
 */
function* cinnabarGymTrainer(ctx, obj) {
  const t = CINNABAR_GYM_TRAINERS[obj];
  const label = `CinnabarGymSuperNerd${obj - 1}`;
  ctx.npcFacePlayer(obj);
  if (ctx.getFlag(cinnabarTrainerFlag(obj))) {
    yield ctx.showText(`${label}.AfterBattleText`);
    return;
  }
  yield ctx.showText(`${label}.BattleText`);
  playTrainerMusic(ctx, t.trainerClass);
  const outcome = yield* lib.scriptedBattle(ctx, {
    kind: 'trainer', trainerClass: t.trainerClass, partyIndex: t.partyIndex, objectIndex: obj, winText: `${label}.EndBattleText`,
  });
  if (outcome !== 'win') return; // CinnabarGymResetScripts; the blackout follows this script
  // CinnabarGymOpenGateScript
  if (!ctx.getFlag(cinnabarTrainerFlag(obj))) {
    yield* waitForSound(ctx);
    yield* lib.fanfare(ctx, 'SFX_GO_INSIDE');
  }
  ctx.setFlag(cinnabarTrainerFlag(obj));
  ctx.setFlag(cinnabarGateFlag(obj));
  updateGymGates(ctx);
}

/**
 * PrintCinnabarQuiz (hidden event, facing up) + CinnabarGymQuiz: the intro text, one of six
 * questions, YES / NO. The hidden event's argument is (answer << 4) | gate; a right answer plays the
 * jingle, unlocks the gate (SFX_GO_INSIDE the first time) and opens its door; a wrong one plays
 * SFX_DENIED and - unless that gate's trainer was beaten already - the trainer beside the machine steps
 * up (CinnabarGymDefaultScript: Super Nerd 3 left then up, the others left) and fights.
 */
function* cinnabarQuiz(ctx, entry) {
  if (ctx.player.facing !== 'up') return;
  const arg = Number(entry && (entry.argValue ?? entry.arg)) & 0xff;
  const gate = arg & 0x0f;
  const answer = arg >> 4; // wCurrentMenuItem of the right answer: 0 = YES, 1 = NO
  yield print(ctx, 'CinnabarGymQuizIntroText');
  yield print(ctx, quizQuestion(gate));
  const yes = yield ctx.yesNo();
  if ((yes ? 0 : 1) === answer) {
    const flag = `EVENT_CINNABAR_GYM_GATE${gate}_UNLOCKED`;
    const already = ctx.getFlag(flag);
    yield print(ctx, QUIZ_CORRECT);
    if (!already) { // the text's text_asm
      yield* waitForSound(ctx);
      yield* lib.fanfare(ctx, 'SFX_GO_INSIDE');
    }
    ctx.setFlag(flag);
    ctx.closeText();
    updateGymGates(ctx);
    return;
  }
  yield* waitForSound(ctx);
  yield* lib.fanfare(ctx, 'SFX_DENIED');
  yield print(ctx, QUIZ_INCORRECT);
  ctx.closeText();
  const obj = gate + 2; // wOpponentAfterWrongAnswer
  if (ctx.getFlag(cinnabarTrainerFlag(obj))) return;
  const walk = CINNABAR_QUIZ_WALKS[obj] || CINNABAR_QUIZ_WALKS.default;
  ctx.facePlayer(walk.playerFacing);
  yield ctx.moveNpc(obj, [...walk.path]);
  yield* cinnabarGymTrainer(ctx, obj);
}

/** CinnabarGymBlaineText + CinnabarGymBlainePostBattleScript / CinnabarGymReceiveTM38 (VOLCANOBADGE, TM38). */
function cinnabarBlaine(ctx) {
  return lib.gymLeader(ctx, {
    trainerClass: 'BLAINE', partyIndex: 1, gymLeaderNo: 7, objectIndex: CINNABARGYM_BLAINE,
    badge: 'VOLCANOBADGE', badgeFlag: 'EVENT_BEAT_BLAINE', tm: 'TM_FIRE_BLAST', tmFlag: 'EVENT_GOT_TM38',
    textBefore: 'CinnabarGymBlaineText.PreBattleText',
    textWin: 'CinnabarGymBlaineText.ReceivedVolcanoBadgeText',
    textBadge: 'CinnabarGymBlaineVolcanoBadgeInfoText',
    textTm: 'CinnabarGymBlaineReceivedTM38Text',
    textNoRoom: 'CinnabarGymBlaineTM38NoRoomText',
    textAfter: 'CinnabarGymBlaineText.PostBattleAdviceText',
    trainerFlags: CINNABAR_GYM_TRAINER_FLAGS,
    onVictory: updateGymGates, // BIT_CUR_MAP_LOADED_1
  });
}

const CinnabarGym = {
  onEnter(ctx) {
    updateGymGates(ctx);
    return undefined;
  },
  onFrame(ctx) {
    ctx.clearFlag('EVENT_2A7'); // CinnabarGymSetMapAndTiles: ResetEvent EVENT_2A7 (unused leftover)
    return undefined;
  },
  onInteract(ctx, i) {
    if (i === CINNABARGYM_BLAINE) return cinnabarBlaine(ctx);
    if (CINNABAR_GYM_TRAINERS[i]) return cinnabarGymTrainer(ctx, i);
    if (i === CINNABARGYM_GYM_GUIDE) {
      return (function* guide() {
        yield ctx.showText(ctx.getFlag('EVENT_BEAT_BLAINE') ? 'CinnabarGymGymGuideText.BeatBlaineText' : 'CinnabarGymGymGuideText.ChampInMakingText');
      }());
    }
    return undefined;
  },
  onHiddenObject(ctx, routine, entry) {
    return routine === 'PrintCinnabarQuiz' ? cinnabarQuiz(ctx, entry) : undefined;
  },
};

// =========================================================================== Cinnabar Lab

const CINNABARLABTRADEROOM_GRAMPS = 2;
const CINNABARLABTRADEROOM_BEAUTY = 3;

const CinnabarLabTradeRoom = {
  onInteract(ctx, i) {
    // CinnabarLabTradeRoomGrampsText / BeautyText: TRADE_FOR_DORIS / TRADE_FOR_CRINKLES (DoInGameTradeDialogue)
    const trade = i === CINNABARLABTRADEROOM_GRAMPS ? 'TRADE_FOR_DORIS' : i === CINNABARLABTRADEROOM_BEAUTY ? 'TRADE_FOR_CRINKLES' : null;
    if (!trade) return undefined;
    return (function* npcTrade() { yield* lib.npcTrade(ctx, trade); }());
  },
};

const CINNABARLABMETRONOMEROOM_SCIENTIST1 = 1;

/** CinnabarLabMetronomeRoomScientist1Text: TM35 (METRONOME), once; a full bag keeps it for later. */
function* metronomeScientist(ctx) {
  const T = (n) => `CinnabarLabMetronomeRoomScientist1Text.${n}`;
  if (ctx.getFlag('EVENT_GOT_TM35')) {
    yield ctx.showText(T('TM35ExplanationText'));
    return;
  }
  yield print(ctx, T('Text'));
  const ok = yield* lib.receiveItem(ctx, 'TM_METRONOME', 1, { text: T('ReceivedTM35Text'), noRoomText: T('TM35NoRoomText') });
  if (ok) ctx.setFlag('EVENT_GOT_TM35');
}

const CinnabarLabMetronomeRoom = {
  onInteract(ctx, i) {
    return i === CINNABARLABMETRONOMEROOM_SCIENTIST1 ? metronomeScientist(ctx) : undefined;
  },
};

const CINNABARLABFOSSILROOM_SCIENTIST1 = 1;
const CINNABARLABFOSSILROOM_SCIENTIST2 = 2;

const fossilText = (label) => [{ cmd: 'text_far', label }, { cmd: 'text_end' }];

/**
 * GiveFossilToCinnabarLab: a list of the fossils in the bag (DOME FOSSIL, HELIX FOSSIL, OLD AMBER),
 * "Oh! That is X! ... fossil of Y" YES / NO, the fossil is handed over, "go for a walk".
 */
function* giveFossilToLab(ctx, owned) {
  const names = owned.map((f) => lib.itemName(f.item));
  const choice = yield ctx.menu(names, { x: 0, y: 0, width: 15, top: 2, spacing: 2, wrap: false });
  if (choice < 0 || choice >= owned.length) {
    yield ctx.showText(fossilText('_CinnabarLabFossilRoomScientist1ComeAgainText'));
    return;
  }
  const f = owned[choice];
  ctx.state.fossilChoice = { item: f.item, mon: f.dex }; // wFossilItem / wFossilMon
  const subs = { wNameBuffer: lib.itemName(f.item), wStringBuffer: lib.speciesName(f.dex) };
  yield print(ctx, fossilText('_CinnabarLabFossilRoomScientist1SeesFossilText'), { subs });
  const yes = yield ctx.yesNo();
  if (!yes) {
    yield ctx.showText(fossilText('_CinnabarLabFossilRoomScientist1ComeAgainText'));
    return;
  }
  yield print(ctx, fossilText('_CinnabarLabFossilRoomScientist1TakesFossilText'), { subs });
  lib.takeItem(ctx, f.item, 1);
  yield ctx.showText(fossilText('_CinnabarLabFossilRoomScientist1GoForAWalkText2'));
  ctx.setFlag('EVENT_GAVE_FOSSIL_TO_LAB');
  ctx.setFlag('EVENT_LAB_STILL_REVIVING_FOSSIL');
}

/**
 * CinnabarLabFossilRoomScientist1Text: hand in a fossil; the revival is done as soon as the player
 * has been out on Cinnabar Island (its script clears EVENT_LAB_STILL_REVIVING_FOSSIL), then the
 * Pokémon (level 30) is handed over; a full party and box keep it for the next talk.
 */
function* fossilScientist(ctx) {
  const T = (n) => `CinnabarLabFossilRoomScientist1Text.${n}`;
  if (!ctx.getFlag('EVENT_GAVE_FOSSIL_TO_LAB')) {
    yield print(ctx, T('Text'));
    const owned = FOSSILS.filter((f) => lib.hasItem(ctx, f.item));
    if (!owned.length) {
      yield ctx.showText(T('NoFossilsText'));
      return;
    }
    yield* giveFossilToLab(ctx, owned);
    return;
  }
  if (ctx.getFlag('EVENT_LAB_STILL_REVIVING_FOSSIL')) {
    yield ctx.showText(T('GoForAWalkText'));
    return;
  }
  const f = fossilGiven(ctx);
  const subs = f ? { wNameBuffer: lib.itemName(f.item), wStringBuffer: lib.speciesName(f.dex) } : {};
  yield print(ctx, T('FossilIsBackToLifeText'), { subs });
  ctx.setFlag('EVENT_LAB_HANDING_OVER_FOSSIL_MON');
  const ok = f ? yield* lib.receivePokemon(ctx, { dex: f.dex, level: FOSSIL_MON_LEVEL }) : false;
  if (ok) {
    ctx.clearFlag('EVENT_GAVE_FOSSIL_TO_LAB');
    ctx.clearFlag('EVENT_LAB_STILL_REVIVING_FOSSIL');
    ctx.clearFlag('EVENT_LAB_HANDING_OVER_FOSSIL_MON');
  }
}

const CinnabarLabFossilRoom = {
  onInteract(ctx, i) {
    if (i === CINNABARLABFOSSILROOM_SCIENTIST1) return fossilScientist(ctx);
    if (i === CINNABARLABFOSSILROOM_SCIENTIST2) {
      // CinnabarLabFossilRoomScientist2Text: TRADE_FOR_SAILOR
      return (function* npcTrade() { yield* lib.npcTrade(ctx, 'TRADE_FOR_SAILOR'); }());
    }
    return undefined;
  },
};

// =========================================================================== Pokémon Mansion

/**
 * PokemonMansion<N>F(Switch)Text: "A secret switch! Press it?" YES / NO. YES: "Who wouldn't?", SFX_GO_INSIDE
 * and the switch (EVENT_MANSION_SWITCH_ON) flips, which swaps the doors of this floor (the other floors
 * follow when they load); NO: "Not quite yet!".
 */
function* mansionSwitch(ctx, cfg) {
  const T = (n) => `${cfg.base}.${n}`;
  yield print(ctx, T('Text'));
  const yes = yield ctx.yesNo();
  if (!yes) {
    yield ctx.showText(T(cfg.notPressed));
    return;
  }
  yield print(ctx, T('PressedText'));
  ctx.closeText(); // wDoNotWaitForButtonPressAfterDisplayingText
  ctx.playSfx('SFX_GO_INSIDE');
  if (ctx.getFlag('EVENT_MANSION_SWITCH_ON')) ctx.clearFlag('EVENT_MANSION_SWITCH_ON');
  else ctx.setFlag('EVENT_MANSION_SWITCH_ON');
  setMansionDoors(ctx); // BIT_CUR_MAP_LOADED_1: the doors follow on the next frame
}

/** The script of one Mansion floor: the doors by the switch when it loads, the statue switch(es). */
const mansionFloor = (map) => ({
  trainers: true,
  onEnter(ctx) {
    setMansionDoors(ctx);
    return undefined;
  },
  onHiddenObject(ctx, routine) {
    const cfg = MANSION_SWITCHES[map];
    if (routine !== cfg.routine) return undefined;
    // Mansion<N>Script_Switches: only from the front (facing up)
    if (ctx.player.facing !== 'up') return true;
    return mansionSwitch(ctx, cfg);
  },
});

const PokemonMansion1F = mansionFloor('PokemonMansion1F');
const PokemonMansion2F = mansionFloor('PokemonMansion2F');
const PokemonMansion3F = mansionFloor('PokemonMansion3F'); // the holes: the engine's DEFAULT_HOLES
const PokemonMansionB1F = mansionFloor('PokemonMansionB1F');

// =========================================================================== Route23

const ROUTE23 = Object.freeze({ DEFAULT: 0, PLAYER_MOVING: 1, RESET_TO_DEFAULT: 2 });

/**
 * Route23CheckForBadgeScript (the text_asm of every guard, and Route23DefaultScript's DisplayTextID):
 * without the badge the denied sound and the player is pushed one step back down; with it "go right
 * ahead" and the guard remembers (EVENT_PASSED_<badge>_CHECK).
 */
function* route23Check(ctx, g) {
  const subs = { wNameBuffer: g.badge };
  if (!lib.hasBadge(ctx, g.badge)) {
    yield print(ctx, '_Route23YouDontHaveTheBadgeYetText', { subs });
    yield* lib.fanfare(ctx, 'SFX_DENIED'); // the text's text_asm
    yield* waitAndClose(ctx);
    lib.setMapScript(ctx, ROUTE23.PLAYER_MOVING);
    ctx.facePlayer('down');
    yield ctx.movePlayer(['down']);
    yield ctx.wait(3);
    lib.setMapScript(ctx, ROUTE23.DEFAULT);
    return;
  }
  yield ctx.showText('Route23OhThatIsTheBadgeText', { subs });
  ctx.setFlag(g.flag);
  lib.setMapScript(ctx, ROUTE23.DEFAULT); // SCRIPT_ROUTE23_RESET_TO_DEFAULT
}

const Route23 = {
  onEnter(ctx) {
    // Route23SetVictoryRoadBoulders: the boulder puzzles start again
    for (const f of VICTORY_ROAD_RESET_EVENTS) ctx.clearFlag(f);
    ctx.showToggle('TOGGLE_VICTORY_ROAD_3F_BOULDER');
    ctx.hideToggle('TOGGLE_VICTORY_ROAD_2F_BOULDER');
    return undefined;
  },
  onFrame(ctx) {
    if (resetStale(ctx, ROUTE23.DEFAULT)) return undefined;
    // Route23DefaultScript: walking onto a guard's row without having passed his check starts it
    const p = ctx.player;
    const g = ROUTE23_GUARDS.find((x) => x.y === p.y);
    if (!g) return undefined;
    if (g.y === 35 && p.x >= 14) return undefined; // the east side of the first guard's row
    if (ctx.getFlag(g.flag)) return undefined;
    return (function* guardRow() {
      ctx.npcFacePlayer(g.object);
      yield* route23Check(ctx, g);
    }());
  },
  onInteract(ctx, i) {
    const g = ROUTE23_GUARDS[i - 1];
    return g ? route23Check(ctx, g) : undefined;
  },
};

// =========================================================================== Victory Road

const VictoryRoad1F = {
  trainers: true,
  onEnter(ctx) {
    // .next: the barrier opens again while the boulder stays on the switch
    if (ctx.getFlag('EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH')) {
      const d = VICTORY_ROAD.VictoryRoad1F.door;
      ctx.setBlock(d.bx, d.by, d.block);
    }
    return undefined;
  },
  onBoulderPushed(ctx, objectIndex, x, y) {
    // VictoryRoad1FDefaultScript: a boulder on the switch opens the barrier
    if (ctx.getFlag('EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH')) return;
    const [sx, sy] = VICTORY_ROAD.VictoryRoad1F.switches[0];
    if (x !== sx || y !== sy) return;
    ctx.setFlag('EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH');
    const d = VICTORY_ROAD.VictoryRoad1F.door;
    ctx.setBlock(d.bx, d.by, d.block);
  },
};

/** VictoryRoad2FCheckBoulderEventScript: the barriers of the switches that are pressed. */
function victoryRoad2Doors(ctx) {
  const doors = VICTORY_ROAD.VictoryRoad2F.doors;
  if (ctx.getFlag('EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH1')) ctx.setBlock(doors[0].bx, doors[0].by, doors[0].block);
  if (ctx.getFlag('EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH2')) ctx.setBlock(doors[1].bx, doors[1].by, doors[1].block);
}

const VictoryRoad2F = {
  trainers: true,
  onEnter(ctx) {
    // VictoryRoad2FResetBoulderEventScript + VictoryRoad2FCheckBoulderEventScript
    ctx.clearFlag('EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH');
    victoryRoad2Doors(ctx);
    return undefined;
  },
  onBoulderPushed(ctx, objectIndex, x, y) {
    // VictoryRoad2FDefaultScript: SwitchCoords (1, 16) = switch 1, (9, 16) = switch 2
    const i = VICTORY_ROAD.VictoryRoad2F.switches.findIndex(([sx, sy]) => sx === x && sy === y);
    if (i < 0) return;
    ctx.setFlag(i === 0 ? 'EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH1' : 'EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH2');
    victoryRoad2Doors(ctx);
  },
  onTextAsm(ctx, label) {
    // VictoryRoad2FMoltresBattleText: MOLTRES' cry, waited for, before the battle
    return label === 'VictoryRoad2FMoltresBattleText' ? cry(ctx, DEX.MOLTRES) : undefined;
  },
};

const VictoryRoad3F = {
  trainers: true,
  onEnter(ctx) {
    // VictoryRoad3FCheckBoulderEventScript
    if (ctx.getFlag('EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH1')) {
      const d = VICTORY_ROAD.VictoryRoad3F.door;
      ctx.setBlock(d.bx, d.by, d.block);
    }
    return undefined;
  },
  onBoulderPushed(ctx, objectIndex, x, y) {
    const { switch: sw, hole, door } = VICTORY_ROAD.VictoryRoad3F;
    if (x === sw[0] && y === sw[1]) {
      ctx.setFlag('EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH1');
      ctx.setBlock(door.bx, door.by, door.block);
    } else if (x === hole[0] && y === hole[1]) {
      // .handle_hole: the boulder falls down to 2F, once
      if (ctx.getFlag('EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH2')) return;
      ctx.setFlag('EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH2');
      ctx.hideToggle('TOGGLE_VICTORY_ROAD_3F_BOULDER');
      ctx.showToggle('TOGGLE_VICTORY_ROAD_2F_BOULDER');
    }
  },
};

// =========================================================================== IndigoPlateauLobby

const IndigoPlateauLobby = {
  onEnter(ctx) {
    ctx.clearFlag('EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH');
    // "Reset Elite Four events if the player started challenging them before"
    if (lib.statusFlag(ctx, 'BIT_STARTED_ELITE_4')) {
      lib.setStatusFlag(ctx, 'BIT_STARTED_ELITE_4', false);
      ctx.state.flags.clearRange('INDIGO_PLATEAU_EVENTS_START', 'EVENT_LANCES_ROOM_LOCK_DOOR');
    }
    return undefined;
  },
};

// =========================================================================== Elite Four

const E4_MEMBER = 1; // LORELEISROOM_LORELEI = BRUNOSROOM_BRUNO = AGATHASROOM_AGATHA = LANCESROOM_LANCE

/**
 * TalkToTrainer + the room's EndBattleScript for an Elite Four member (sight range 0: only a talk, or
 * for Lance a step next to him, starts it). Beaten: the after-battle text again. Otherwise the
 * before-battle text, the fight (lib.scriptedBattle: a loss is the blackout, and the lobby resets the
 * rooms), and on a win the event and the after-battle text (DisplayTextID); `onDone` runs once that text
 * is over (the next frame of the room's script: the way on opens, the Champion's room is armed).
 */
function* eliteFourTalk(ctx, room, { onDone } = {}) {
  ctx.npcFacePlayer(E4_MEMBER);
  if (ctx.getFlag(room.flag)) {
    yield ctx.showText(room.after);
    return;
  }
  yield ctx.showText(room.before);
  playTrainerMusic(ctx, room.trainerClass);
  const outcome = yield* lib.scriptedBattle(ctx, {
    kind: 'trainer', trainerClass: room.trainerClass, partyIndex: room.partyIndex, objectIndex: E4_MEMBER, winText: room.end,
  });
  if (outcome !== 'win') return; // Reset<Name>Script; the blackout follows this script
  ctx.setFlag(room.flag); // EndTrainerBattle
  yield ctx.showText(room.after);
  if (onDone) onDone(ctx);
}

/** <Name>ShowOrHideExitBlock: the way on (`lb bc, 0, 2`) is blocked until the member is beaten. */
function e4ExitBlock(ctx, room) {
  ctx.setBlock(2, 0, ctx.getFlag(room.flag) ? room.open : room.closed);
}

/**
 * <Name>RoomDefaultScript: the tiles at the room's entrance. The first time the player arrives (the
 * two bottom tiles) he is walked six steps into the room; later, or one tile above the way out, a
 * voice says "Don't run away!" and he is pushed one step up.
 */
function* e4Entrance(ctx, room, idx) {
  if (idx >= 3 && !ctx.getFlag(room.autowalk)) { // CheckAndSetEvent EVENT_AUTOWALKED_INTO_...
    ctx.setFlag(room.autowalk);
    lib.setMapScript(ctx, E4_STATE.PLAYER_IS_MOVING);
    yield ctx.movePlayer([['up', 6]]);
    yield ctx.wait(3);
    lib.setMapScript(ctx, E4_STATE.DEFAULT);
    return;
  }
  yield ctx.showText(room.dontRun);
  lib.setMapScript(ctx, E4_STATE.PLAYER_IS_MOVING);
  yield ctx.movePlayer(['up']);
  yield ctx.wait(3);
  lib.setMapScript(ctx, E4_STATE.DEFAULT);
}

/** The script of the first three Elite Four rooms. */
function eliteFourRoom(map, { onWin } = {}) {
  const room = E4_ROOMS[map];
  return {
    trainers: true,
    onEnter(ctx) {
      if (room.startsElite4) lib.setStatusFlag(ctx, 'BIT_STARTED_ELITE_4', true); // wElite4Flags
      e4ExitBlock(ctx, room);
      return undefined;
    },
    onFrame(ctx) {
      if (resetStale(ctx, E4_STATE.DEFAULT)) return undefined;
      const idx = coordIndex(ctx, E4_ENTRANCE_COORDS);
      return idx ? e4Entrance(ctx, room, idx) : undefined;
    },
    onInteract(ctx, i) {
      if (i !== E4_MEMBER) return undefined;
      return eliteFourTalk(ctx, room, { onDone: (c) => { e4ExitBlock(c, room); if (onWin) onWin(c); } });
    },
  };
}

const LoreleisRoom = eliteFourRoom('LoreleisRoom');
const BrunosRoom = eliteFourRoom('BrunosRoom');
// AgathasRoomAgathaEndBattleScript: the Champion's room starts its script (SCRIPT_CHAMPIONSROOM_PLAYER_ENTERS)
const AgathasRoom = eliteFourRoom('AgathasRoom', { onWin: (ctx) => lib.setMapScript(ctx, CHAMPION.PLAYER_ENTERS, 'ChampionsRoom') });

const LANCES_ROOM = Object.freeze({
  trainerClass: 'LANCE', partyIndex: 1, flag: 'EVENT_BEAT_LANCES_ROOM_TRAINER_0',
  before: 'LancesRoomLanceBeforeBattleText', end: 'LancesRoomLanceEndBattleText', after: 'LancesRoomLanceAfterBattleText',
});

/** LanceShowOrHideEntranceBlocks: the entrance stairs' two blocks are open floor or locked. */
function lanceEntranceBlocks(ctx) {
  const locked = ctx.getFlag('EVENT_LANCES_ROOM_LOCK_DOOR');
  for (const b of LANCE_ENTRANCE) ctx.setBlock(b.bx, b.by, locked ? b.locked : b.open);
}

/** WalkToLance: down the hallway from the entrance stairs, input ignored. */
function* walkToLance(ctx) {
  lib.setMapScript(ctx, E4_STATE.PLAYER_IS_MOVING);
  yield ctx.movePlayer(LANCE_WALK);
  yield ctx.wait(3);
  lib.setMapScript(ctx, E4_STATE.DEFAULT);
}

const LancesRoom = {
  trainers: true,
  onEnter(ctx) {
    lanceEntranceBlocks(ctx);
    return undefined;
  },
  onFrame(ctx) {
    if (resetStale(ctx, E4_STATE.DEFAULT)) return undefined;
    if (ctx.getFlag('EVENT_BEAT_LANCE')) return undefined;
    const idx = coordIndex(ctx, LANCE_TRIGGER_COORDS);
    if (!idx) return undefined;
    if (idx < 3) return eliteFourTalk(ctx, LANCES_ROOM); // next to Lance's sprite
    if (idx === 5) return walkToLance(ctx); // on the entrance staircase
    // the doorway: the door locks behind the player, once
    if (ctx.getFlag('EVENT_LANCES_ROOM_LOCK_DOOR')) return undefined;
    ctx.setFlag('EVENT_LANCES_ROOM_LOCK_DOOR');
    ctx.playSfx('SFX_GO_INSIDE');
    lanceEntranceBlocks(ctx);
    return undefined;
  },
  onInteract(ctx, i) {
    return i === E4_MEMBER ? eliteFourTalk(ctx, LANCES_ROOM) : undefined;
  },
  onTextAsm(ctx, label) {
    // LancesRoomLanceAfterBattleText: SetEvent EVENT_BEAT_LANCE after the text
    if (label !== 'LancesRoomLanceAfterBattleText') return undefined;
    ctx.setFlag('EVENT_BEAT_LANCE');
    return true;
  },
};

// =========================================================================== ChampionsRoom

const CHAMPIONSROOM_RIVAL = 1;
const CHAMPIONSROOM_OAK = 2;

/**
 * ChampionsRoomPlayerEntersScript ... ChampionsRoomCleanupScript: the player walks up to the rival, who
 * is the Champion (his party by his starter); a win: his defeat text, OAK's voice, OAK arrives and
 * congratulates the player, scolds the rival and asks the player to follow him up to the Hall of Fame.
 * Every stage writes the asm's script index. A loss resets the script (ResetRivalScript; the blackout
 * follows and the Elite Four start again).
 */
function* championsRoomCutscene(ctx) {
  // ChampionsRoomPlayerEntersScript
  lib.setMapScript(ctx, CHAMPION.RIVAL_READY_TO_BATTLE);
  yield ctx.movePlayer(CHAMPION_MOVES.playerEnters);
  // ChampionsRoomRivalReadyToBattleScript
  yield ctx.wait(3);
  ctx.state.options.battleAnimations = true; // res BIT_BATTLE_ANIMATION: the final battle shows its animations
  yield ctx.showText('ChampionsRoomRivalText.IntroText');
  yield ctx.wait(3);
  const { classConst, partyIndex } = championParty(ctx);
  lib.setMapScript(ctx, CHAMPION.RIVAL_DEFEATED);
  const outcome = yield* lib.scriptedBattle(ctx, {
    kind: 'trainer', trainerClass: classConst, partyIndex, objectIndex: CHAMPIONSROOM_RIVAL,
    winText: 'RivalDefeatedText', loseText: 'RivalVictoryText',
  });
  if (outcome !== 'win') {
    lib.setMapScript(ctx, CHAMPION.DEFAULT); // ResetRivalScript
    return;
  }
  // ChampionsRoomRivalDefeatedScript
  ctx.setFlag('EVENT_BEAT_CHAMPION_RIVAL');
  yield ctx.showText('ChampionsRoomRivalAfterBattleText');
  lib.setMapScript(ctx, CHAMPION.OAK_ARRIVES);
  // ChampionsRoomOakArrivesScript: Music_Cities1AlternateTempo (a fade out, then the alternate tempo song)
  const audio = ctx.hooks && ctx.hooks.audio;
  if (audio && typeof audio.fadeOutMusic === 'function') audio.fadeOutMusic(10);
  yield ctx.wait(100);
  ctx.playMusic('MUSIC_CITIES1_ALT_TEMPO');
  yield ctx.showText('ChampionsRoomOakText');
  ctx.showToggle('TOGGLE_CHAMPIONS_ROOM_OAK');
  lib.setMapScript(ctx, CHAMPION.OAK_CONGRATULATES_PLAYER);
  yield ctx.moveNpc(CHAMPIONSROOM_OAK, CHAMPION_MOVES.oakEnters);
  // ChampionsRoomOakCongratulatesPlayerScript
  ctx.facePlayer('left');
  yield* faceAndDelay(ctx, CHAMPIONSROOM_RIVAL, 'left');
  yield* faceAndDelay(ctx, CHAMPIONSROOM_OAK, 'down');
  yield ctx.showText('ChampionsRoomOakCongratulatesPlayerText.Text', { subs: { wNameBuffer: starterName(ctx) } });
  lib.setMapScript(ctx, CHAMPION.OAK_DISAPPOINTED_WITH_RIVAL);
  // ChampionsRoomOakDisappointedWithRivalScript
  yield* faceAndDelay(ctx, CHAMPIONSROOM_OAK, 'right');
  yield ctx.showText('ChampionsRoomOakDisappointedWithRivalText');
  lib.setMapScript(ctx, CHAMPION.OAK_COME_WITH_ME);
  // ChampionsRoomOakComeWithMeScript
  yield* faceAndDelay(ctx, CHAMPIONSROOM_OAK, 'down');
  yield ctx.showText('ChampionsRoomOakComeWithMeText');
  lib.setMapScript(ctx, CHAMPION.OAK_EXITS);
  yield ctx.moveNpc(CHAMPIONSROOM_OAK, CHAMPION_MOVES.oakExits);
  // ChampionsRoomOakExitsScript
  ctx.hideToggle('TOGGLE_CHAMPIONS_ROOM_OAK');
  lib.setMapScript(ctx, CHAMPION.PLAYER_FOLLOWS_OAK);
  // ChampionsRoomPlayerFollowsOakScript: up the room and through the warp into the Hall of Fame
  lib.setMapScript(ctx, CHAMPION.CLEANUP);
  yield ctx.movePlayer(CHAMPION_MOVES.playerFollowsOak);
  // ChampionsRoomCleanupScript (the walk ends in the Hall of Fame: the room's state is set by name)
  lib.setMapScript(ctx, CHAMPION.DEFAULT, 'ChampionsRoom');
}

const ChampionsRoom = {
  onFrame(ctx) {
    const s = lib.getMapScript(ctx);
    if (s === CHAMPION.DEFAULT) return undefined;
    if (s === CHAMPION.PLAYER_ENTERS) return championsRoomCutscene(ctx);
    lib.setMapScript(ctx, CHAMPION.DEFAULT); // a later stage of an interrupted cutscene: ResetRivalScript
    return undefined;
  },
  onInteract(ctx, i) {
    if (i !== CHAMPIONSROOM_RIVAL) return undefined;
    // ChampionsRoomRivalText: his intro until he is beaten, then the after-battle text
    return (function* rival() {
      yield ctx.showText(ctx.getFlag('EVENT_BEAT_CHAMPION_RIVAL') ? 'ChampionsRoomRivalAfterBattleText' : 'ChampionsRoomRivalText.IntroText');
    }());
  },
};

// =========================================================================== HallOfFame

/**
 * HallOfFameDefaultScript / HallOfFameOakCongratulationsScript / HallOfFameResetEventsAndSaveScript:
 * the player walks up to OAK, who congratulates him (and the Cerulean Cave's guard leaves his post);
 * then the Hall of Fame and the credits (kanto6_ending.js), the Elite Four's events and scripts are
 * reset, the game is saved and the game starts over at the title screen.
 */
function* hallOfFameEntry(ctx) {
  lib.setMapScript(ctx, HALL_OF_FAME.OAK_CONGRATULATIONS);
  yield ctx.movePlayer(HOF_ENTRY_MOVE);
}

function* hallOfFameOak(ctx) {
  ctx.facePlayer('right');
  yield* faceAndDelay(ctx, 1, 'left'); // HALLOFFAME_OAK
  yield ctx.wait(3);
  yield ctx.showText('HallOfFameOakText');
  ctx.hideToggle('TOGGLE_CERULEAN_CAVE_GUY');
  lib.setMapScript(ctx, HALL_OF_FAME.RESET_EVENTS_AND_SAVE);
}

function* hallOfFameEnding(ctx) {
  yield ctx.wait(3); // Delay3
  yield* playEnding(ctx);
}

const HallOfFame = {
  onFrame(ctx) {
    switch (lib.getMapScript(ctx)) {
      case HALL_OF_FAME.DEFAULT: return hallOfFameEntry(ctx);
      case HALL_OF_FAME.OAK_CONGRATULATIONS: return hallOfFameOak(ctx);
      case HALL_OF_FAME.RESET_EVENTS_AND_SAVE: return hallOfFameEnding(ctx);
      default: return undefined;
    }
  },
};

// =========================================================================== Cerulean Cave

const CeruleanCaveB1F = {
  trainers: true,
  onTextAsm(ctx, label) {
    // MewtwoBattleText: MEWTWO's cry, waited for, before the battle
    return label === 'MewtwoBattleText' ? cry(ctx, DEX.MEWTWO) : undefined;
  },
};

export default {
  CinnabarIsland,
  CinnabarGym,
  CinnabarLabTradeRoom,
  CinnabarLabMetronomeRoom,
  CinnabarLabFossilRoom,
  PokemonMansion1F,
  PokemonMansion2F,
  PokemonMansion3F,
  PokemonMansionB1F,
  Route23,
  VictoryRoad1F,
  VictoryRoad2F,
  VictoryRoad3F,
  IndigoPlateauLobby,
  LoreleisRoom,
  BrunosRoom,
  AgathasRoom,
  LancesRoom,
  ChampionsRoom,
  HallOfFame,
  CeruleanCaveB1F,
};
