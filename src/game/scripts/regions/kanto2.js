// Region kanto2 story scripts: Pewter City (+ museum, gym, houses), Route 3, Mt. Moon, Route 4,
// Cerulean City (+ gym, houses, the bike shop and the badge house), Routes 24 / 25 and Bill's
// house, Route 5 / 6 (+ gates, underground paths, the Daycare). Each entry ports
// vendor/pokered/scripts/<Map>.asm (docs/scripting.md): the w<Map>CurScript state machine
// keeps the asm's indices (SCRIPT_* in the comments), per-frame map scripts are onFrame,
// text_asm NPCs are onInteract (their text box is managed here, so
// wDoNotWaitForButtonPressAfterDisplayingText can be honoured). Object indices are 1-based
// (object_event order), sign indices 0-based. Maps whose script only runs the standard trainer
// code (Route 3 / 4 / 6, Mt. Moon 1F / B1F, the marts, the plain houses ...) need no entry: the
// engine does the trainers, signs and item balls.

import * as lib from '../lib.js';
import { getGameData } from '../../../pokemon/data.js';
import { rivalParty } from '../../../pokemon/trainer.js';
import { dayCareDeposit, dayCareQuote, dayCareWithdraw } from '../../../pokemon/party.js';
import {
  faceAndDelay, waitAndClose, print, coordIndex, stopMusic, stopAndPlay, cry, randByte, setNoBattles,
  give, listMenu, monPopup,
} from './kanto2_lib.js';

/** Pokédex numbers (data/pokemon.json checks them in tests/story/kanto2.test.js). */
export const DEX = Object.freeze({ NIDORAN_M: 32, MAGIKARP: 129, KABUTOPS: 141, AERODACTYL: 142 });

/** NO_INPUT in the asm's simulated joypad lists: one iteration without a button. */
const WAIT = null;

// =========================================================================== PewterCity

// object_const_def order of data/maps/objects/PewterCity.asm
const PEWTERCITY_SUPER_NERD1 = 3;   // the museum guide
const PEWTERCITY_SUPER_NERD2 = 4;   // the REPEL sprayer
const PEWTERCITY_YOUNGSTER = 5;     // the gym guide
const PEWTER = Object.freeze({
  DEFAULT: 0, SUPER_NERD1_SHOWS_PLAYER_MUSEUM: 1, HIDE_SUPER_NERD1: 2, RESET_SUPER_NERD1: 3,
  YOUNGSTER_SHOWS_PLAYER_GYM: 4, HIDE_YOUNGSTER: 5, RESET_YOUNGSTER: 6,
});
/** PewterCityPlayerLeavingEastCoords (x, y). */
const PEWTER_LEAVING_EAST = Object.freeze([[35, 17], [36, 17], [37, 18], [37, 19]]);

/**
 * engine/events/pewter_guys.asm PewterGuys: the simulated joypad lists are read from their end,
 * and PewterGuys writes its position-dependent moves over the last byte of the player's list
 * (its "this decrement causes it to overwrite the last byte" - the first press of the list is
 * lost). So the player first makes the moves of the table (written order reversed), then the
 * list of RLEList_Pewter*Player without its first step, the guide always one step ahead.
 */
const PEWTER_MUSEUM_PLAYER = Object.freeze([['up', 5], ['left', 13], ['up', 3], WAIT]);
const PEWTER_MUSEUM_GUY = Object.freeze([['up', 6], ['left', 13], ['up', 3], ['left', 1]]);
/** PewterMuseumGuyCoords (the cell below, above, left and right of the guide at (27, 17)). */
const PEWTER_MUSEUM_ADJUST = Object.freeze({
  '27,18': ['up', 'up'], '27,16': ['left', 'right'], '26,17': ['right', 'up'], '28,17': ['left', 'up'],
});
const PEWTER_GYM_PLAYER = Object.freeze([['left', 14], ['up', 5], ['left', 11], ['down', 5], ['right', 2], WAIT]);
const PEWTER_GYM_GUY = Object.freeze([['down', 2], ['left', 15], ['up', 5], ['left', 11], ['down', 5], ['right', 3]]);
const WAIT8 = Object.freeze(Array(8).fill(WAIT));
/** PewterGymGuyCoords (the guide stands at (35, 16): its left, the three trigger cells, (37, 18) / (37, 19)). */
const PEWTER_GYM_ADJUST = Object.freeze({
  '34,16': ['right', 'down', 'down', 'left'], '35,17': ['left', 'right', 'down', 'left'],
  '37,18': [...WAIT8, 'left', 'left', 'left'], '37,19': ['left', 'up', 'left', 'left'],
  '36,17': [...WAIT8, 'left', 'down', 'left'],
});

/** The player's whole walk behind the museum guide from his cell (x, y). */
export function pewterMuseumPlayerPath(x, y) {
  return [...(PEWTER_MUSEUM_ADJUST[`${x},${y}`] || []), ...PEWTER_MUSEUM_PLAYER];
}

/**
 * The player's whole walk behind the gym guide from (x, y). The cell right of the guide
 * (36, 16) is not in the asm's table (PewterGuys would read on past it); the player steps down
 * to (36, 17) first.
 */
export function pewterGymPlayerPath(x, y) {
  const adj = PEWTER_GYM_ADJUST[`${x},${y}`];
  if (adj) return [...adj, ...PEWTER_GYM_PLAYER];
  if (x === 36 && y === 16) return ['down', ...PEWTER_GYM_ADJUST['36,17'], ...PEWTER_GYM_PLAYER];
  return [...PEWTER_GYM_PLAYER];
}

/** PewterCitySuperNerd1Text: ".YouHaveToGoText" starts PewterMovementScript_WalkToMuseum. */
function* pewterMuseumGuide(ctx) {
  const guide = PEWTERCITY_SUPER_NERD1;
  yield print(ctx, 'PewterCitySuperNerd1Text.DidYouCheckOutMuseumText');
  const yes = yield ctx.yesNo();
  if (yes) {
    yield ctx.showText('PewterCitySuperNerd1Text.WerentThoseFossilsAmazingText');
    return;
  }
  yield ctx.showText('PewterCitySuperNerd1Text.YouHaveToGoText');
  lib.setMapScript(ctx, PEWTER.SUPER_NERD1_SHOWS_PLAYER_MUSEUM);
  // PewterMovementScript_WalkToMuseum: the music, the guide leads the player to the museum
  ctx.playMusic('MUSIC_MUSEUM_GUY');
  const p = ctx.player;
  const walk = ctx.moveNpc(guide, PEWTER_MUSEUM_GUY, { sync: true });
  yield ctx.movePlayer(pewterMuseumPlayerPath(p.x, p.y));
  yield walk;
  // PewterCitySuperNerd1ShowsPlayerMuseumScript
  yield* faceAndDelay(ctx, guide, 'up');
  yield* lib.playMapMusic(ctx);
  yield ctx.showText('PewterCitySuperNerd1ItsRightHereText');
  ctx.placeObject(guide, 13, 8, 'up'); // SetSpritePosition1 (map coords 17, 12)
  lib.setMapScript(ctx, PEWTER.HIDE_SUPER_NERD1);
  yield ctx.moveNpc(guide, [['down', 4]]); // MovementData_PewterMuseumGuyExit
  // PewterCityHideSuperNerd1Script / PewterCityResetSuperNerd1Script: back to his place
  ctx.hideToggle('TOGGLE_MUSEUM_GUY');
  lib.setMapScript(ctx, PEWTER.RESET_SUPER_NERD1);
  ctx.placeObject(guide, 27, 17, 'down'); // SetSpritePosition2
  ctx.showToggle('TOGGLE_MUSEUM_GUY');
  lib.setMapScript(ctx, PEWTER.DEFAULT);
}

/** PewterCitySuperNerd2Text. */
function* pewterSprayer(ctx) {
  yield print(ctx, 'PewterCitySuperNerd2Text.DoYouKnowWhatImDoingText');
  const yes = yield ctx.yesNo();
  yield ctx.showText(yes ? 'PewterCitySuperNerd2Text.ThatsRightText' : 'PewterCitySuperNerd2Text.ImSprayingRepelText');
}

/**
 * PewterCityYoungsterText (A button, or PewterCityCheckPlayerLeavingEastScript when the player
 * heads east before BROCK is beaten): ".YoureATrainerFollowMeText" starts
 * PewterMovementScript_WalkToGym.
 */
function* pewterGymGuide(ctx) {
  const guide = PEWTERCITY_YOUNGSTER;
  ctx.npcFacePlayer(guide);
  yield ctx.showText('PewterCityYoungsterText.YoureATrainerFollowMeText');
  lib.setMapScript(ctx, PEWTER.YOUNGSTER_SHOWS_PLAYER_GYM);
  ctx.playMusic('MUSIC_MUSEUM_GUY');
  const p = ctx.player;
  const walk = ctx.moveNpc(guide, PEWTER_GYM_GUY, { sync: true });
  yield ctx.movePlayer(pewterGymPlayerPath(p.x, p.y));
  yield walk;
  // PewterCityYoungsterShowsPlayerGymScript
  yield* faceAndDelay(ctx, guide, 'left');
  yield* lib.playMapMusic(ctx);
  yield ctx.showText('PewterCityYoungsterGoTakeOnBrockText');
  ctx.placeObject(guide, 12, 18, 'left'); // SetSpritePosition1 (map coords 16, 22)
  lib.setMapScript(ctx, PEWTER.HIDE_YOUNGSTER);
  yield ctx.moveNpc(guide, [['right', 5]]); // MovementData_PewterGymGuyExit
  ctx.hideToggle('TOGGLE_GYM_GUY');
  lib.setMapScript(ctx, PEWTER.RESET_YOUNGSTER);
  ctx.placeObject(guide, 35, 16, 'down');
  ctx.showToggle('TOGGLE_GYM_GUY');
  lib.setMapScript(ctx, PEWTER.DEFAULT);
}

const PewterCity = {
  onFrame(ctx) {
    if (lib.getMapScript(ctx) !== PEWTER.DEFAULT) return undefined;
    // PewterCityDefaultScript: the museum wants a new ticket at every visit
    lib.setMapScript(ctx, 0, 'Museum1F');
    ctx.clearFlag('EVENT_BOUGHT_MUSEUM_TICKET');
    // PewterCityCheckPlayerLeavingEastScript
    if (ctx.getFlag('EVENT_BEAT_BROCK')) return undefined;
    if (!coordIndex(ctx, PEWTER_LEAVING_EAST)) return undefined;
    return pewterGymGuide(ctx);
  },
  onInteract(ctx, i) {
    switch (i) {
      case PEWTERCITY_SUPER_NERD1: return pewterMuseumGuide(ctx);
      case PEWTERCITY_SUPER_NERD2: return pewterSprayer(ctx);
      case PEWTERCITY_YOUNGSTER: return pewterGymGuide(ctx);
      default: return undefined;
    }
  },
};

// =========================================================================== Museum1F

const MUSEUM1F_SCIENTIST1 = 1;   // the ticket desk
const MUSEUM1F_SCIENTIST2 = 3;   // the OLD AMBER
const MUSEUM1F = Object.freeze({ DEFAULT: 0, NOOP: 1 });
const MUSEUM_TICKET_PRICE = 50;

/** Museum1FScientist1Text (also Museum1FDefaultScript, at (9, 4) / (10, 4)). */
function* museumTicketDesk(ctx) {
  const p = ctx.player;
  const bought = () => ctx.getFlag('EVENT_BOUGHT_MUSEUM_TICKET');
  const T = (n) => `Museum1FScientist1Text.${n}`;
  // behind the counter: (13, 4) and (12, 3); at y = 4 the ticket is checked, elsewhere he asks to go to the other side
  const behindCounter = (p.y === 4 && p.x === 13) || (p.y === 3 && p.x === 12);
  if (behindCounter) {
    yield print(ctx, T('DoYouKnowWhatAmberIsText'));
    const yes = yield ctx.yesNo();
    yield ctx.showText(yes ? T('TheresALabSomewhereText') : T('AmberIsFossilizedTreeSapText'));
    return;
  }
  if (p.y !== 4) {
    yield ctx.showText(bought() ? T('TakePlentyOfTimeText') : T('GoToOtherSideText'));
    return;
  }
  if (bought()) {
    yield ctx.showText(T('TakePlentyOfTimeText'));
    return;
  }
  // .no_ticket
  lib.showMoneyBox(ctx);
  yield print(ctx, T('WouldYouLikeToComeInText'));
  const yes = yield ctx.yesNo();
  if (yes) {
    if (lib.money(ctx) >= MUSEUM_TICKET_PRICE) {
      // .buy_ticket
      yield print(ctx, T('ThankYouText'));
      ctx.setFlag('EVENT_BOUGHT_MUSEUM_TICKET');
      lib.takeMoney(ctx, MUSEUM_TICKET_PRICE);
      lib.showMoneyBox(ctx);
      yield* lib.fanfare(ctx, 'SFX_PURCHASE');
      lib.setMapScript(ctx, MUSEUM1F.NOOP); // .allow_entry
      yield* waitAndClose(ctx);
      lib.hideMoneyBox(ctx);
      return;
    }
    yield print(ctx, T('DontHaveEnoughMoneyText'));
  }
  // .deny_entry: "Come again!", then one step back down
  yield ctx.showText(T('ComeAgainText'));
  lib.hideMoneyBox(ctx);
  yield ctx.movePlayer(['down']);
}

/** Museum1FScientist2Text: the OLD AMBER. */
function* museumOldAmber(ctx) {
  const T = (n) => `Museum1FScientist2Text.${n}`;
  if (ctx.getFlag('EVENT_GOT_OLD_AMBER')) {
    yield ctx.showText(T('GetTheOldAmberCheckText'));
    return;
  }
  yield print(ctx, T('TakeThisToAPokemonLabText'));
  if (!(yield* give(ctx, 'OLD_AMBER', 1))) {
    yield ctx.showText(T('YouDontHaveSpaceText'));
    return;
  }
  ctx.setFlag('EVENT_GOT_OLD_AMBER');
  ctx.hideToggle('TOGGLE_OLD_AMBER');
  yield ctx.showText(T('ReceivedOldAmberText'));
}

/**
 * AerodactylFossil / KabutopsFossil (the display cases at (2, 3) and (2, 6)): the Pokémon's
 * front sprite in a box, then "AERODACTYL Fossil: A primitive and rare POKéMON."
 */
function* museumFossilCase(ctx, dex, text) {
  yield* monPopup(ctx, dex);
  yield ctx.showText(text);
}

const Museum1F = {
  onHiddenObject(ctx, routine) {
    if (routine === 'AerodactylFossil') return museumFossilCase(ctx, DEX.AERODACTYL, 'AerodactylFossilText');
    if (routine === 'KabutopsFossil') return museumFossilCase(ctx, DEX.KABUTOPS, 'KabutopsFossilText');
    return undefined;
  },
  onFrame(ctx) {
    // Museum1FDefaultScript
    if (lib.getMapScript(ctx) !== MUSEUM1F.DEFAULT) return undefined;
    const p = ctx.player;
    if (p.y !== 4 || (p.x !== 9 && p.x !== 10)) return undefined;
    return museumTicketDesk(ctx);
  },
  onInteract(ctx, i) {
    if (i === MUSEUM1F_SCIENTIST1) return museumTicketDesk(ctx);
    if (i === MUSEUM1F_SCIENTIST2) return museumOldAmber(ctx);
    return undefined;
  },
};

// =========================================================================== PewterGym

const PEWTERGYM_BROCK = 1;
const PEWTERGYM_GYM_GUIDE = 3;

/** PewterGymBrockText + PewterGymBrockPostBattle / PewterGymScriptReceiveTM34. */
function pewterBrock(ctx) {
  return lib.gymLeader(ctx, {
    trainerClass: 'BROCK', partyIndex: 1, gymLeaderNo: 1, objectIndex: PEWTERGYM_BROCK,
    badge: 'BOULDERBADGE', badgeFlag: 'EVENT_BEAT_BROCK', tm: 'TM_BIDE', tmFlag: 'EVENT_GOT_TM34',
    textBefore: 'PewterGymBrockText.PreBattleText',
    textWin: 'PewterGymBrockReceivedBoulderBadgeText',
    textBadge: 'PewterGymBrockWaitTakeThisText',
    textTm: 'PewterGymReceivedTM34Text',
    textNoRoom: 'PewterGymTM34NoRoomText',
    textAfter: 'PewterGymBrockText.PostBattleAdviceText',
    trainerFlags: ['EVENT_BEAT_PEWTER_GYM_TRAINER_0'],
    onVictory(c) {
      // .gymVictory: the Pewter guides and the Route 22 rival are done
      c.hideToggle('TOGGLE_GYM_GUY');
      c.hideToggle('TOGGLE_ROUTE_22_RIVAL_1');
      c.clearFlag('EVENT_1ST_ROUTE22_RIVAL_BATTLE');
      c.clearFlag('EVENT_ROUTE22_RIVAL_WANTS_BATTLE');
    },
  });
}

/** PewterGymGuideText. */
function* pewterGymGuideNpc(ctx) {
  if (lib.hasBadge(ctx, 'BOULDERBADGE')) { // wBeatGymFlags
    yield ctx.showText('PewterGymGuidePostBattleText');
    return;
  }
  yield print(ctx, 'PewterGymGuidePreAdviceText');
  const yes = yield ctx.yesNo();
  yield print(ctx, yes ? 'PewterGymGuideBeginAdviceText' : 'PewterGymGuideFreeServiceText');
  yield ctx.showText('PewterGymGuideAdviceText');
}

const PewterGym = {
  onInteract(ctx, i) {
    if (i === PEWTERGYM_BROCK) return pewterBrock(ctx);
    if (i === PEWTERGYM_GYM_GUIDE) return pewterGymGuideNpc(ctx);
    return undefined;
  },
};

// =========================================================================== PewterNidoranHouse

/** PewterNidoranHouseNidoranText: "NIDORAN: Bowbow!", then text_asm plays NIDORAN M's cry. */
const PewterNidoranHouse = {
  onTextAsm(ctx, label) {
    if (label !== 'PewterNidoranHouseNidoranText') return undefined;
    return cry(ctx, DEX.NIDORAN_M);
  },
};

// =========================================================================== PewterPokecenter

const PEWTERPOKECENTER_JIGGLYPUFF = 3;
/** MUSIC_JIGGLYPUFF_SONG lasts 397 frames (both channels). */
const JIGGLYPUFF_SONG_FRAMES = 397;

/** PewterPokecenterJigglypuffText: the song, JIGGLYPUFF turns round every 24 frames until it ends. */
function* pewterJigglypuff(ctx) {
  const jigglypuff = PEWTERPOKECENTER_JIGGLYPUFF;
  yield print(ctx, 'PewterPokecenterJigglypuffText.Text');
  stopMusic(ctx);
  yield ctx.wait(32);
  // .FacingDirections: down, left, up, right - starting at the one it faces now
  const dirs = ['down', 'left', 'up', 'right'];
  let k = Math.max(0, dirs.indexOf(ctx.npc(jigglypuff).facing));
  ctx.playMusic('MUSIC_JIGGLYPUFF_SONG');
  let played = 0;
  do {
    ctx.faceNpc(jigglypuff, dirs[k++ % 4]);
    yield ctx.wait(24);
    played += 24;
  } while (played < JIGGLYPUFF_SONG_FRAMES);
  yield ctx.wait(48);
  yield* lib.playMapMusic(ctx);
  ctx.closeText(); // wDoNotWaitForButtonPressAfterDisplayingText
}

const PewterPokecenter = {
  onInteract(ctx, i) {
    return i === PEWTERPOKECENTER_JIGGLYPUFF ? pewterJigglypuff(ctx) : undefined;
  },
};

// =========================================================================== MtMoonB2F

const MTMOONB2F_SUPER_NERD = 1;
const MTMOONB2F_DOME_FOSSIL = 6;
const MTMOONB2F_HELIX_FOSSIL = 7;
const MTMOONB2F = Object.freeze({
  DEFAULT: 0, START_BATTLE: 1, END_BATTLE: 2, DEFEATED_SUPER_NERD: 3, MOVE_SUPER_NERD: 4,
  SUPER_NERD_TAKES_OTHER_FOSSIL: 5,
});
/** MtMoonB2FFossilAreaCoords: x 11-14, y 5-8 (no wild battles there once the exit's Super Nerd is beaten). */
const MTMOONB2F_FOSSIL_AREA = Object.freeze([5, 6, 7, 8].flatMap((y) => [11, 12, 13, 14].map((x) => [x, y])));
const MTMOONB2F_NEAR_DOME = Object.freeze([[12, 7], [11, 6], [12, 5]]);
const MTMOONB2F_NEAR_HELIX = Object.freeze([[13, 7], [14, 6], [14, 5]]);

/**
 * MtMoonB2FMoveSuperNerdScript: where the Super Nerd walks, by the player's cell (x, y):
 * MtMoon3FSuperNerdMoveRightMovementData (right, up) next to the DOME FOSSIL,
 * MoveUpMovementData (up) next to the HELIX FOSSIL, null elsewhere (he waits).
 */
export function mtMoonNerdPath(x, y) {
  const near = (list) => list.some(([px, py]) => px === x && py === y);
  if (near(MTMOONB2F_NEAR_DOME)) return ['right', 'up'];
  if (near(MTMOONB2F_NEAR_HELIX)) return ['up'];
  return null;
}

/** MtMoonB2FSuperNerdText: the fight for the fossils, or his two other lines. */
function* mtMoonNerd(ctx) {
  if (ctx.getFlag('EVENT_BEAT_MT_MOON_EXIT_SUPER_NERD')) {
    const got = ctx.getFlag('EVENT_GOT_DOME_FOSSIL') || ctx.getFlag('EVENT_GOT_HELIX_FOSSIL');
    yield ctx.showText(got ? 'MtMoonB2FSuperNerdTheresAPokemonLabText' : 'MtMoonB2fSuperNerdEachTakeOneText');
    return;
  }
  yield ctx.showText('MtMoonB2FSuperNerdTheyreBothMineText');
  const outcome = yield* lib.scriptedBattle(ctx, {
    kind: 'trainer', trainerClass: 'SUPER_NERD', partyIndex: 2, objectIndex: MTMOONB2F_SUPER_NERD,
    winText: 'MtMoonB2FSuperNerdOkIllShareText', loseText: 'MtMoonB2FSuperNerdOkIllShareText',
  });
  lib.setMapScript(ctx, MTMOONB2F.DEFEATED_SUPER_NERD);
  if (outcome === 'lose') {
    // MtMoonB2FResetScripts; the blackout follows this script
    lib.setMapScript(ctx, MTMOONB2F.DEFAULT);
    return;
  }
  // MtMoonB2FDefeatedSuperNerdScript
  yield ctx.wait(3);
  ctx.setFlag('EVENT_BEAT_MT_MOON_EXIT_SUPER_NERD');
  lib.setMapScript(ctx, MTMOONB2F.DEFAULT);
}

/** MtMoonB2FDomeFossilText / MtMoonB2FHelixFossilText. */
function* mtMoonFossil(ctx, { item, toggle, flag, youWant }) {
  // wDoNotWaitForButtonPressAfterDisplayingText = 1: the box closes after the last text
  yield print(ctx, youWant);
  const yes = yield ctx.yesNo();
  if (!yes) { ctx.closeText(); return; }
  if (!(yield* give(ctx, item, 1))) {
    yield print(ctx, 'MtMoonB2FYouHaveNoRoomText.Text'); // text_waitbutton inside
    ctx.closeText();
    return;
  }
  yield print(ctx, 'MtMoonB2FReceivedFossilText.Text', { subs: { wStringBuffer: lib.itemName(item) } }); // key item jingle + text_waitbutton
  ctx.hideToggle(toggle);
  ctx.setFlag(flag);
  lib.setMapScript(ctx, MTMOONB2F.MOVE_SUPER_NERD);
  ctx.closeText();
}

/** MtMoonB2FSuperNerdTakesOtherFossilScript. */
function* mtMoonNerdTakesOther(ctx) {
  // the movement is over (yield on it); "Then this is mine!" without a button wait
  yield ctx.showText('MtMoonB2FSuperNerdThenThisIsMineText', { wait: false });
  ctx.hideToggle(ctx.getFlag('EVENT_GOT_DOME_FOSSIL') ? 'TOGGLE_MT_MOON_B2F_FOSSIL_2' : 'TOGGLE_MT_MOON_B2F_FOSSIL_1');
  lib.setMapScript(ctx, MTMOONB2F.DEFAULT);
}

const MtMoonB2F = {
  // trainers: CheckFightingMapTrainers runs in the default state until a fossil is taken, and
  // while the nerd waits for the player to stand next to a fossil; updated by onFrame
  trainers: true,
  onFrame(ctx) {
    const state = lib.getMapScript(ctx);
    const gotFossil = ctx.getFlag('EVENT_GOT_DOME_FOSSIL') || ctx.getFlag('EVENT_GOT_HELIX_FOSSIL');
    MtMoonB2F.trainers = (state === MTMOONB2F.DEFAULT && !gotFossil) || state === MTMOONB2F.MOVE_SUPER_NERD;
    let script;
    if (state === MTMOONB2F.DEFAULT) {
      // MtMoonB2FDefaultScript: the nerd stops the player at (13, 8)
      if (!ctx.getFlag('EVENT_BEAT_MT_MOON_EXIT_SUPER_NERD') && ctx.player.y === 8 && ctx.player.x === 13) script = mtMoonNerd(ctx);
    } else if (state === MTMOONB2F.MOVE_SUPER_NERD) {
      // MtMoonB2FMoveSuperNerdScript: the nerd walks to the fossil the player did not take
      const path = mtMoonNerdPath(ctx.player.x, ctx.player.y);
      if (path) {
        script = (function* nerdWalks() {
          lib.setMapScript(ctx, MTMOONB2F.SUPER_NERD_TAKES_OTHER_FOSSIL);
          yield ctx.moveNpc(MTMOONB2F_SUPER_NERD, path);
          yield* mtMoonNerdTakesOther(ctx);
        }());
      }
    } else if (state === MTMOONB2F.SUPER_NERD_TAKES_OTHER_FOSSIL) {
      // only after a reload: the walk is over
      script = mtMoonNerdTakesOther(ctx);
    } else if (state === MTMOONB2F.DEFEATED_SUPER_NERD) {
      lib.setMapScript(ctx, MTMOONB2F.DEFAULT);
    }
    // wild battles are off in the fossil area once the nerd is beaten
    if (ctx.getFlag('EVENT_BEAT_MT_MOON_EXIT_SUPER_NERD')) setNoBattles(ctx, coordIndex(ctx, MTMOONB2F_FOSSIL_AREA) > 0);
    return script;
  },
  onInteract(ctx, i) {
    switch (i) {
      case MTMOONB2F_SUPER_NERD: return mtMoonNerd(ctx);
      case MTMOONB2F_DOME_FOSSIL:
        return mtMoonFossil(ctx, { item: 'DOME_FOSSIL', toggle: 'TOGGLE_MT_MOON_B2F_FOSSIL_1', flag: 'EVENT_GOT_DOME_FOSSIL', youWant: 'MtMoonB2FDomeFossilText.YouWantText' });
      case MTMOONB2F_HELIX_FOSSIL:
        return mtMoonFossil(ctx, { item: 'HELIX_FOSSIL', toggle: 'TOGGLE_MT_MOON_B2F_FOSSIL_2', flag: 'EVENT_GOT_HELIX_FOSSIL', youWant: 'MtMoonB2FHelixFossilText.YouWantText' });
      default: return undefined;
    }
  },
};

// =========================================================================== MtMoonPokecenter

const MTMOONPOKECENTER_MAGIKARP_SALESMAN = 4;
const MAGIKARP_PRICE = 500;

/** MtMoonPokecenterMagikarpSalesmanText: MAGIKARP for ¥500, once. */
function* magikarpSalesman(ctx) {
  const T = (n) => `MtMoonPokecenterMagikarpSalesmanText.${n}`;
  if (ctx.getFlag('EVENT_BOUGHT_MAGIKARP')) {
    yield ctx.showText(T('NoRefundsText'));
    return;
  }
  lib.showMoneyBox(ctx);
  yield print(ctx, T('IGotADealText'));
  const yes = yield ctx.yesNo();
  if (!yes) {
    yield ctx.showText(T('NoText'));
    lib.hideMoneyBox(ctx);
    return;
  }
  if (lib.money(ctx) < MAGIKARP_PRICE) {
    yield ctx.showText(T('NoMoneyText'));
    lib.hideMoneyBox(ctx);
    return;
  }
  const party = lib.partyCount(ctx);
  // GivePokemon (MAGIKARP, level 5): the party (with AskName) or the box; false = no room anywhere
  if (!(yield* lib.receivePokemon(ctx, { dex: DEX.MAGIKARP, level: 5, askNickname: true }))) {
    lib.hideMoneyBox(ctx);
    return;
  }
  lib.takeMoney(ctx, MAGIKARP_PRICE);
  lib.showMoneyBox(ctx);
  ctx.setFlag('EVENT_BOUGHT_MAGIKARP');
  // a party mon sets wDoNotWaitForButtonPressAfterDisplayingText; the box text already waited
  if (lib.partyCount(ctx) > party) ctx.closeText();
  lib.hideMoneyBox(ctx);
}

const MtMoonPokecenter = {
  onInteract(ctx, i) {
    return i === MTMOONPOKECENTER_MAGIKARP_SALESMAN ? magikarpSalesman(ctx) : undefined;
  },
};

// =========================================================================== CeruleanCity

const CERULEANCITY_RIVAL = 1;
const CERULEANCITY_ROCKET = 2;
const CERULEANCITY_COOLTRAINER_F1 = 7;
const CERULEANCITY_SLOWBRO = 8;
const CERULEAN = Object.freeze({ DEFAULT: 0, RIVAL_BATTLE: 1, RIVAL_DEFEATED: 2, RIVAL_CLEANUP: 3, ROCKET_DEFEATED: 4 });
/** CeruleanCityCoords1 (above / below the Rocket at (30, 8)), CeruleanCityCoords2 (the bridge) as (x, y). */
const CERULEAN_ROCKET_COORDS = Object.freeze([[30, 7], [30, 9]]);
const CERULEAN_RIVAL_COORDS = Object.freeze([[20, 6], [21, 6]]);

/** CeruleanCityClearScripts. */
function ceruleanClearScripts(ctx) {
  lib.setMapScript(ctx, CERULEAN.DEFAULT);
  ctx.hideToggle('TOGGLE_CERULEAN_RIVAL');
}

/** The Rocket's text: the fight, or (once beaten) the TM28 he stole and his exit. */
function* ceruleanRocket(ctx) {
  const T = (n) => `CeruleanCityRocketText.${n}`;
  if (!ctx.getFlag('EVENT_BEAT_CERULEAN_ROCKET_THIEF')) {
    yield ctx.showText(T('Text'));
    lib.setMapScript(ctx, CERULEAN.ROCKET_DEFEATED);
    const outcome = yield* lib.scriptedBattle(ctx, {
      kind: 'trainer', trainerClass: 'ROCKET', partyIndex: 5, objectIndex: CERULEANCITY_ROCKET,
      winText: T('IGiveUpText'), loseText: T('IGiveUpText'),
    });
    if (outcome === 'lose') { // CeruleanCityRocketDefeatedScript: back to the default script
      ceruleanClearScripts(ctx);
      return;
    }
    ctx.setFlag('EVENT_BEAT_CERULEAN_ROCKET_THIEF');
    lib.setMapScript(ctx, CERULEAN.DEFAULT);
  }
  // .beatRocketThief
  yield print(ctx, T('IllReturnTheTMText'));
  if (!(yield* give(ctx, 'TM_DIG', 1))) {
    yield ctx.showText(T('TM28NoRoomText'));
    return;
  }
  yield print(ctx, T('ReceivedTM28Text')); // jingle, "I better get moving!", text_waitbutton
  // CeruleanHideRocket: the screen fades out, the guard that blocked the house leaves
  yield ctx.fadeOut('black');
  ctx.showToggle('TOGGLE_CERULEAN_GUARD_1');
  ctx.hideToggle('TOGGLE_CERULEAN_GUARD_2');
  ctx.hideToggle('TOGGLE_CERULEAN_ROCKET');
  yield ctx.fadeIn('black');
  ctx.closeText();
}

/** CeruleanCityDefaultScript, the rival on the bridge: SCRIPT_CERULEANCITY_RIVAL_BATTLE ... RIVAL_CLEANUP. */
function* ceruleanRival(ctx) {
  const rival = CERULEANCITY_RIVAL;
  const x = ctx.player.x;
  if (ctx.player.mode !== 'walk') stopMusic(ctx); // on the bike / surfing
  ctx.playMusic('MUSIC_MEET_RIVAL');
  if (x !== 20) ctx.placeObject(rival, 21, 2, 'down'); // the player stands on the right side of the bridge
  ctx.showToggle('TOGGLE_CERULEAN_RIVAL');
  lib.setMapScript(ctx, CERULEAN.RIVAL_BATTLE);
  yield ctx.moveNpc(rival, [['down', 3]]); // CeruleanCityMovement1
  // CeruleanCityRivalBattleScript
  yield ctx.showText('CeruleanCityRivalText.PreBattleText');
  // wRivalStarter: SQUIRTLE -> 7, BULBASAUR -> 8, anything else CHARMANDER's 9
  const starter = ctx.state.rivalStarter;
  const { classConst, partyIndex } = rivalParty('CERULEAN_CITY', starter != null && getGameData().findSpecies(starter) ? starter : 'CHARMANDER');
  ctx.faceNpc(rival, 'down'); // CeruleanCityFaceRivalScript
  lib.setMapScript(ctx, CERULEAN.RIVAL_DEFEATED);
  const outcome = yield* lib.scriptedBattle(ctx, {
    kind: 'trainer', trainerClass: classConst, partyIndex, objectIndex: rival,
    winText: 'CeruleanCityRivalDefeatedText', loseText: 'CeruleanCityRivalVictoryText',
  });
  if (outcome === 'lose') { // CeruleanCityRivalDefeatedScript: LOST_BATTLE
    ceruleanClearScripts(ctx);
    return;
  }
  yield* faceAndDelay(ctx, rival, 'down');
  ctx.setFlag('EVENT_BEAT_CERULEAN_RIVAL');
  yield ctx.showText('CeruleanCityRivalIWentToBillsText');
  stopAndPlay(ctx, 'MUSIC_MEET_RIVAL_ALT_START');
  lib.setMapScript(ctx, CERULEAN.RIVAL_CLEANUP);
  // CeruleanCityMovement3 (left of the player: LEFT, DOWN x6) / Movement4 (x = 20: RIGHT, DOWN x6)
  yield ctx.moveNpc(rival, [x === 20 ? 'right' : 'left', ['down', 6]]);
  // CeruleanCityRivalCleanupScript
  ctx.hideToggle('TOGGLE_CERULEAN_RIVAL');
  yield* lib.playMapMusic(ctx);
  lib.setMapScript(ctx, CERULEAN.DEFAULT);
}

const CeruleanCity = {
  onFrame(ctx) {
    if (lib.getMapScript(ctx) !== CERULEAN.DEFAULT) return undefined;
    if (!ctx.getFlag('EVENT_BEAT_CERULEAN_ROCKET_THIEF')) {
      const at = coordIndex(ctx, CERULEAN_ROCKET_COORDS);
      if (at) {
        // the player faces the Rocket, who faces back
        return (function* rocketEncounter() {
          ctx.facePlayer(at === 1 ? 'down' : 'up');
          ctx.faceNpc(CERULEANCITY_ROCKET, at === 1 ? 'up' : 'down');
          yield ctx.wait(3);
          yield* ceruleanRocket(ctx);
        }());
      }
    }
    if (ctx.getFlag('EVENT_BEAT_CERULEAN_RIVAL')) return undefined;
    if (!coordIndex(ctx, CERULEAN_RIVAL_COORDS)) return undefined;
    return ceruleanRival(ctx);
  },
  onInteract(ctx, i) {
    switch (i) {
      case CERULEANCITY_RIVAL:
        return (function* rivalText() {
          // CeruleanCityRivalText: he only talks about BILL's once beaten
          yield ctx.showText(ctx.getFlag('EVENT_BEAT_CERULEAN_RIVAL') ? 'CeruleanCityRivalIWentToBillsText' : 'CeruleanCityRivalText.PreBattleText');
        }());
      case CERULEANCITY_ROCKET: return ceruleanRocket(ctx);
      case CERULEANCITY_COOLTRAINER_F1:
        return (function* slowbroTrainer() {
          // hRandomAdd: >= 180 (76/256), >= 100 (80/256), else (100/256)
          const r = randByte(ctx);
          yield ctx.showText(r >= 180 ? 'CeruleanCityCooltrainerF1Text.SlowbroUseSonicboomText'
            : r >= 100 ? 'CeruleanCityCooltrainerF1Text.SlowbroPunchText' : 'CeruleanCityCooltrainerF1Text.SlowbroWithdrawText');
        }());
      case CERULEANCITY_SLOWBRO:
        return (function* slowbro() {
          // >= 180 (76/256), >= 120 (60), >= 60 (60), else (60)
          const r = randByte(ctx);
          yield ctx.showText(r >= 180 ? 'CeruleanCitySlowbroText.TookASnoozeText'
            : r >= 120 ? 'CeruleanCitySlowbroText.IsLoafingAroundText'
              : r >= 60 ? 'CeruleanCitySlowbroText.TurnedAwayText' : 'CeruleanCitySlowbroText.IgnoredOrdersText');
        }());
      default: return undefined;
    }
  },
};

// =========================================================================== CeruleanTrashedHouse / CeruleanTradeHouse

const CERULEANTRASHEDHOUSE_FISHING_GURU = 1;

const CeruleanTrashedHouse = {
  onInteract(ctx, i) {
    if (i !== CERULEANTRASHEDHOUSE_FISHING_GURU) return undefined;
    return (function* fishingGuru() {
      // the TM28 in the bag (GetQuantityOfItemInBag)
      yield ctx.showText(lib.hasItem(ctx, 'TM_DIG')
        ? 'CeruleanTrashedHouseFishingGuruText.WhatsLostIsLostText' : 'CeruleanTrashedHouseFishingGuruText.TheyStoleATMText');
    }());
  },
};

const CERULEANTRADEHOUSE_GAMBLER = 2;

const CeruleanTradeHouse = {
  onInteract(ctx, i) {
    if (i !== CERULEANTRADEHOUSE_GAMBLER) return undefined;
    return (function* trade() { yield* lib.npcTrade(ctx, 'TRADE_FOR_LOLA'); }());
  },
};

// =========================================================================== CeruleanGym

const CERULEANGYM_MISTY = 1;
const CERULEANGYM_GYM_GUIDE = 4;

/** CeruleanGymMistyText + CeruleanGymMistyPostBattleScript / CeruleanGymReceiveTM11. */
function ceruleanMisty(ctx) {
  return lib.gymLeader(ctx, {
    trainerClass: 'MISTY', partyIndex: 1, gymLeaderNo: 2, objectIndex: CERULEANGYM_MISTY,
    badge: 'CASCADEBADGE', badgeFlag: 'EVENT_BEAT_MISTY', tm: 'TM_BUBBLEBEAM', tmFlag: 'EVENT_GOT_TM11',
    textBefore: 'CeruleanGymMistyText.PreBattleText',
    textWin: 'CeruleanGymMistyReceivedCascadeBadgeText',
    textBadge: 'CeruleanGymMistyCascadeBadgeInfoText',
    textTm: 'CeruleanGymMistyReceivedTM11Text',
    textNoRoom: 'CeruleanGymMistyTM11NoRoomText',
    textAfter: 'CeruleanGymMistyText.TM11ExplanationText',
    trainerFlags: ['EVENT_BEAT_CERULEAN_GYM_TRAINER_0', 'EVENT_BEAT_CERULEAN_GYM_TRAINER_1'],
  });
}

const CeruleanGym = {
  onInteract(ctx, i) {
    if (i === CERULEANGYM_MISTY) return ceruleanMisty(ctx);
    if (i === CERULEANGYM_GYM_GUIDE) {
      return (function* guide() {
        yield ctx.showText(ctx.getFlag('EVENT_BEAT_MISTY') ? 'CeruleanGymGymGuideText.BeatMistyText' : 'CeruleanGymGymGuideText.ChampInMakingText');
      }());
    }
    return undefined;
  },
};

// =========================================================================== BikeShop

const BIKESHOP_CLERK = 1;
const BIKESHOP_YOUNGSTER = 3;

/** BikeShopClerkText: the BIKE VOUCHER for the BICYCLE, else the (unaffordable) ¥1000000 menu. */
function* bikeShopClerk(ctx) {
  if (ctx.getFlag('EVENT_GOT_BICYCLE')) {
    yield ctx.showText('BikeShopClerkHowDoYouLikeYourBicycleText');
    return;
  }
  if (lib.hasItem(ctx, 'BIKE_VOUCHER')) {
    yield print(ctx, 'BikeShopClerkOhThatsAVoucherText');
    if (!(yield* give(ctx, 'BICYCLE', 1))) {
      yield ctx.showText('BikeShopBagFullText');
      return;
    }
    lib.takeItem(ctx, 'BIKE_VOUCHER', 1);
    ctx.setFlag('EVENT_GOT_BICYCLE');
    yield ctx.showText('BikeShopExchangedVoucherText');
    return;
  }
  yield print(ctx, 'BikeShopClerkWelcomeText');
  // the BICYCLE / CANCEL box at (0, 0) (TextBoxBorder 15x4 inside), the price at (8, 3)
  yield print(ctx, 'BikeShopClerkDoYouLikeItText');
  const menu = ctx.menu(['BICYCLE', 'CANCEL'], { x: 0, y: 0, width: 17, height: 6, top: 2, spacing: 2, wrap: false });
  yield ctx.wait(2);
  const ov = ctx.ov;
  if (ov && ov.font && ov.ui && !menu.done) ov.font.putText(ov.ui, '¥1000000', 8, 3);
  const choice = yield menu;
  if (choice === 0) yield print(ctx, 'BikeShopCantAffordText'); // it costs more than the most money one can have
  yield ctx.showText('BikeShopComeAgainText');
}

const BikeShop = {
  onInteract(ctx, i) {
    if (i === BIKESHOP_CLERK) return bikeShopClerk(ctx);
    if (i === BIKESHOP_YOUNGSTER) {
      return (function* youngster() {
        yield ctx.showText(ctx.getFlag('EVENT_GOT_BICYCLE') ? 'BikeShopYoungsterText.CoolBikeText' : 'BikeShopYoungsterText.TheseBikesAreExpensiveText');
      }());
    }
    return undefined;
  },
};

// =========================================================================== CeruleanBadgeHouse

const CERULEANBADGEHOUSE_MIDDLE_AGED_MAN = 1;
/** CeruleanBadgeHouseBadgeTextPointers (BOULDERBADGE ... EARTHBADGE). */
const BADGE_HOUSE_TEXTS = Object.freeze(['Boulder', 'Cascade', 'Thunder', 'Rainbow', 'Soul', 'Marsh', 'Volcano', 'Earth']
  .map((n) => `CeruleanBadgeHouse${n}BadgeText`));

/** CeruleanBadgeHouseMiddleAgedManText: the list of the 8 badges, each explained until CANCEL. */
function* badgeHouseMan(ctx) {
  yield print(ctx, 'CeruleanBadgeHouseMiddleAgedManText.Text');
  let index = 0;
  for (;;) {
    yield print(ctx, 'CeruleanBadgeHouseMiddleAgedManText.WhichBadgeText');
    index = yield* listMenu(ctx, lib.BADGES, Math.max(0, index));
    if (index < 0) break;
    yield print(ctx, BADGE_HOUSE_TEXTS[index]);
  }
  yield ctx.showText('CeruleanBadgeHouseMiddleAgedManText.VisitAnyTimeText');
}

const CeruleanBadgeHouse = {
  onInteract(ctx, i) {
    return i === CERULEANBADGEHOUSE_MIDDLE_AGED_MAN ? badgeHouseMan(ctx) : undefined;
  },
};

// =========================================================================== Route24

const ROUTE24_COOLTRAINER_M1 = 1;   // the ROCKET on the bridge (TOGGLE_NUGGET_BRIDGE_GUY)
const ROUTE24 = Object.freeze({ DEFAULT: 0, START_BATTLE: 1, END_BATTLE: 2, AFTER_ROCKET_BATTLE: 3, PLAYER_MOVING: 4 });
const ROUTE24_ROCKET_COORDS = Object.freeze([[10, 15]]);

/**
 * Route24CooltrainerM1Text: the NUGGET for winning the contest, the invitation to TEAM ROCKET
 * and the battle when he is refused; "You could become a top leader" afterwards.
 * @returns {boolean} false when the bag had no room for the NUGGET
 */
function* route24Rocket(ctx) {
  const T = (n) => `Route24CooltrainerM1Text.${n}`;
  ctx.clearFlag('EVENT_NUGGET_REWARD_AVAILABLE');
  if (ctx.getFlag('EVENT_GOT_NUGGET')) {
    yield ctx.showText(T('YouCouldBecomeATopLeaderText'));
    return true;
  }
  yield print(ctx, T('YouBeatOurContestText'));
  if (!(yield* give(ctx, 'NUGGET', 1))) {
    yield ctx.showText(T('NoRoomText'));
    ctx.setFlag('EVENT_NUGGET_REWARD_AVAILABLE');
    return false;
  }
  ctx.setFlag('EVENT_GOT_NUGGET');
  yield print(ctx, T('ReceivedNuggetText'), { subs: { wStringBuffer: lib.itemName('NUGGET') } });
  yield print(ctx, T('JoinTeamRocketText'));
  yield* waitAndClose(ctx); // TextScriptEnd, then the battle
  lib.setMapScript(ctx, ROUTE24.AFTER_ROCKET_BATTLE);
  const outcome = yield* lib.scriptedBattle(ctx, {
    kind: 'trainer', trainerClass: 'ROCKET', partyIndex: 6, objectIndex: ROUTE24_COOLTRAINER_M1,
    winText: T('DefeatedText'), loseText: T('DefeatedText'),
  });
  if (outcome === 'lose') { // Route24SetDefaultScript
    lib.setMapScript(ctx, ROUTE24.DEFAULT);
    return true;
  }
  // Route24AfterRocketBattleScript
  ctx.setFlag('EVENT_BEAT_ROUTE24_ROCKET');
  yield ctx.showText(T('YouCouldBecomeATopLeaderText'));
  lib.setMapScript(ctx, ROUTE24.DEFAULT);
  return true;
}

const Route24 = {
  onFrame(ctx) {
    if (lib.getMapScript(ctx) !== ROUTE24.DEFAULT) return undefined;
    // Route24DefaultScript: the Rocket stops the player at (10, 15) until he gave the NUGGET
    if (ctx.getFlag('EVENT_GOT_NUGGET')) return undefined;
    if (!coordIndex(ctx, ROUTE24_ROCKET_COORDS)) return undefined;
    return (function* nuggetBridge() {
      yield* route24Rocket(ctx);
      // CheckAndResetEvent EVENT_NUGGET_REWARD_AVAILABLE: no room for it - one step down
      if (!ctx.getFlag('EVENT_NUGGET_REWARD_AVAILABLE')) return;
      ctx.clearFlag('EVENT_NUGGET_REWARD_AVAILABLE');
      lib.setMapScript(ctx, ROUTE24.PLAYER_MOVING);
      yield ctx.movePlayer(['down']);
      yield ctx.wait(3);
      lib.setMapScript(ctx, ROUTE24.DEFAULT);
    }());
  },
  onInteract(ctx, i) {
    if (i !== ROUTE24_COOLTRAINER_M1) return undefined;
    return (function* rocketText() { yield* route24Rocket(ctx); }());
  },
};

// =========================================================================== Route25

const Route25 = {
  onEnter(ctx) {
    // Route25ToggleBillsScript (map loaded)
    if (ctx.getFlag('EVENT_LEFT_BILLS_HOUSE_AFTER_HELPING')) return;
    if (!ctx.getFlag('EVENT_MET_BILL_2')) {
      ctx.clearFlag('EVENT_BILL_SAID_USE_CELL_SEPARATOR');
      ctx.showToggle('TOGGLE_BILL_POKEMON');
      return;
    }
    if (!ctx.getFlag('EVENT_GOT_SS_TICKET')) return;
    ctx.setFlag('EVENT_LEFT_BILLS_HOUSE_AFTER_HELPING');
    ctx.hideToggle('TOGGLE_NUGGET_BRIDGE_GUY');
    ctx.hideToggle('TOGGLE_BILL_1');
    ctx.showToggle('TOGGLE_BILL_2');
  },
};

// =========================================================================== BillsHouse

const BILLSHOUSE_BILL_POKEMON = 1;
const BILLSHOUSE_BILL1 = 2;
const BILLS = Object.freeze({
  DEFAULT: 0, POKEMON_WALK_TO_MACHINE: 1, POKEMON_ENTERS_MACHINE: 2, BILL_EXITS_MACHINE: 3, CLEANUP: 4, PC: 5,
});

/** BillsHouseBillPokemonText: "I'm not a POKéMON!", he needs the Cell Separator whatever is answered. */
function* billPokemon(ctx) {
  yield print(ctx, 'BillsHouseBillPokemonText.ImNotAPokemonText');
  const yes = yield ctx.yesNo();
  if (!yes) yield print(ctx, 'BillsHouseBillPokemonText.NoYouGottaHelpText');
  yield ctx.showText('BillsHouseBillPokemonText.UseSeparationSystemText');
  lib.setMapScript(ctx, BILLS.POKEMON_WALK_TO_MACHINE);
}

/** BillsHousePokemonWalkToMachineScript + BillsHousePokemonEntersMachineScript. */
function* billWalksToMachine(ctx) {
  // he walks round the player when the player faces down (stands above him)
  const around = ctx.player.facing === 'down';
  lib.setMapScript(ctx, BILLS.POKEMON_ENTERS_MACHINE);
  yield ctx.moveNpc(BILLSHOUSE_BILL_POKEMON, around ? ['right', 'up', 'up', 'left', 'up'] : [['up', 3]]);
  ctx.hideToggle('TOGGLE_BILL_POKEMON');
  ctx.setFlag('EVENT_BILL_SAID_USE_CELL_SEPARATOR');
  lib.setMapScript(ctx, BILLS.BILL_EXITS_MACHINE);
}

/** BillsHouseBillExitsMachineScript + BillsHouseCleanupScript (after the Cell Separator). */
function* billExitsMachine(ctx) {
  ctx.placeObject(BILLSHOUSE_BILL1, 1, 2, 'down'); // SetSpritePosition1 (map coords 5, 6)
  ctx.showToggle('TOGGLE_BILL_1');
  yield ctx.wait(8);
  lib.setMapScript(ctx, BILLS.CLEANUP);
  yield ctx.moveNpc(BILLSHOUSE_BILL1, ['down', 'right', 'right', 'right', 'down']);
  ctx.setFlag('EVENT_MET_BILL_2'); // "this event seems redundant"
  ctx.setFlag('EVENT_MET_BILL');
  lib.setMapScript(ctx, BILLS.DEFAULT);
}

/** BillsHouseBillSSTicketText: the S.S.TICKET. */
function* billSSTicket(ctx) {
  const T = (n) => `BillsHouseBillSSTicketText.${n}`;
  if (!ctx.getFlag('EVENT_GOT_SS_TICKET')) {
    yield print(ctx, T('ThankYouText'));
    if (!(yield* give(ctx, 'S_S_TICKET', 1))) {
      yield ctx.showText(T('SSTicketNoRoomText'));
      return;
    }
    yield print(ctx, T('SSTicketReceivedText'), { subs: { wStringBuffer: lib.itemName('S_S_TICKET') } });
    ctx.setFlag('EVENT_GOT_SS_TICKET');
    ctx.showToggle('TOGGLE_CERULEAN_GUARD_1');
    ctx.hideToggle('TOGGLE_CERULEAN_GUARD_2');
  }
  yield ctx.showText(T('WhyDontYouGoInsteadOfMeText'));
}

/** BillsHousePC (the hidden PC at (1, 4), facing up): the Cell Separator, then BILL's favourite list. */
function* billsHousePC(ctx) {
  if (ctx.getFlag('EVENT_LEFT_BILLS_HOUSE_AFTER_HELPING')) {
    yield* billsPokemonList(ctx);
    return;
  }
  if (ctx.getFlag('EVENT_USED_CELL_SEPARATOR_ON_BILL') || !ctx.getFlag('EVENT_BILL_SAID_USE_CELL_SEPARATOR')) {
    yield ctx.showText('BillsHouseMonitorText');
    return;
  }
  // .doCellSeparator (wDoNotWaitForButtonPressAfterDisplayingText = 1)
  yield ctx.showText([{ cmd: 'text_far', label: '_BillsHouseInitiatedText' }, { cmd: 'text_promptbutton' }, { cmd: 'text_end' }],
    { wait: false, close: false });
  stopMusic(ctx); // BillsHouseInitiatedText's text_asm
  yield ctx.wait(16);
  yield* lib.fanfare(ctx, 'SFX_SWITCH');
  yield ctx.wait(60);
  ctx.closeText();
  yield ctx.wait(32);
  yield* lib.fanfare(ctx, 'SFX_TINK');
  yield ctx.wait(80);
  yield* lib.fanfare(ctx, 'SFX_SHRINK');
  yield ctx.wait(48);
  yield* lib.fanfare(ctx, 'SFX_TINK');
  yield ctx.wait(32);
  yield* lib.fanfare(ctx, 'SFX_GET_ITEM_1');
  yield* lib.playMapMusic(ctx);
  ctx.setFlag('EVENT_USED_CELL_SEPARATOR_ON_BILL');
}

/** BillsHousePokemonList: EEVEE / FLAREON / JOLTEON / VAPOREON pages until CANCEL. */
function* billsPokemonList(ctx) {
  const dexes = [133, 136, 135, 134]; // EEVEE, FLAREON, JOLTEON, VAPOREON (the list order)
  yield print(ctx, 'BillsHousePokemonListText1');
  let choice = 0;
  for (;;) {
    yield print(ctx, 'BillsHousePokemonListText2');
    // BillsMonListText: a 9x10 box at (0, 0), the names two rows apart from (2, 2); the cursor is kept between pages
    choice = yield ctx.menu(['EEVEE', 'FLAREON', 'JOLTEON', 'VAPOREON', 'CANCEL'],
      { x: 0, y: 0, width: 11, height: 12, top: 2, spacing: 2, wrap: false, initial: Math.max(choice, 0) });
    if (choice < 0 || choice >= dexes.length) break;
    yield* lib.pokedexPage(ctx, dexes[choice]);
    ctx.state.pokedex.setSeen(dexes[choice]); // _DisplayPokedex marks it seen
  }
  ctx.closeText(); // wDoNotWaitForButtonPressAfterDisplayingText
}

const BillsHouse = {
  onFrame(ctx) {
    switch (lib.getMapScript(ctx)) {
      case BILLS.POKEMON_WALK_TO_MACHINE:
        return billWalksToMachine(ctx);
      case BILLS.BILL_EXITS_MACHINE:
        // BillsHouseBillExitsMachineScript waits for the Cell Separator
        return ctx.getFlag('EVENT_USED_CELL_SEPARATOR_ON_BILL') ? billExitsMachine(ctx) : undefined;
      case BILLS.POKEMON_ENTERS_MACHINE:
        // only after a reload: Bill's walk is over (BillsHousePokemonEntersMachineScript)
        ctx.hideToggle('TOGGLE_BILL_POKEMON');
        ctx.setFlag('EVENT_BILL_SAID_USE_CELL_SEPARATOR');
        lib.setMapScript(ctx, BILLS.BILL_EXITS_MACHINE);
        return undefined;
      case BILLS.CLEANUP:
        // only after a reload: Bill is back at his desk (BillsHouseCleanupScript)
        ctx.setFlag('EVENT_MET_BILL_2');
        ctx.setFlag('EVENT_MET_BILL');
        lib.setMapScript(ctx, BILLS.DEFAULT);
        return undefined;
      case BILLS.PC: // BillsHousePCScript: nothing sets it, it falls back to the default script
        lib.setMapScript(ctx, BILLS.DEFAULT);
        return undefined;
      default:
        return undefined;
    }
  },
  onInteract(ctx, i) {
    if (i === BILLSHOUSE_BILL_POKEMON) return billPokemon(ctx);
    if (i === BILLSHOUSE_BILL1) return billSSTicket(ctx);
    return undefined;
  },
  onHiddenObject(ctx, routine) {
    if (routine !== 'BillsHousePC') return undefined;
    if (ctx.player.facing !== 'up') return true;
    return billsHousePC(ctx);
  },
};

// =========================================================================== Route5Gate / Route6Gate

const ROUTE5GATE_GUARD = 1;
const ROUTE6GATE_GUARD = 1;
const GATE = Object.freeze({ DEFAULT: 0, PLAYER_MOVING: 1 });
const ROUTE5GATE_COORDS = Object.freeze([[3, 3], [4, 3]]);
const ROUTE6GATE_COORDS = Object.freeze([[3, 2], [4, 2]]);

/** RemoveGuardDrink: the first of FRESH WATER / SODA POP / LEMONADE in the bag is taken. @returns {string|null} */
export function removeGuardDrink(ctx) {
  const list = getGameData().raw.items.guardDrinks;
  for (const item of list) {
    if (lib.hasItem(ctx, item)) {
      lib.takeItem(ctx, item, 1);
      return item;
    }
  }
  return null;
}

/**
 * The guards of the Saffron gates (SaffronGateGuardText, also used by the gates of Routes 6 /
 * 7 / 8): the drink makes him let the player through for good. Without one he is thirsty and
 * Route5GateMovePlayerUpScript pushes the player back (up one step, whatever gate it is: the
 * asm shares the code and sets wRoute5GateCurScript).
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

/** Route5GateMovePlayerUpScript / Route6GateMovePlayerDownScript + the PLAYER_MOVING state. */
function* gatePushPlayer(ctx, dir, map) {
  lib.setMapScript(ctx, GATE.PLAYER_MOVING, map);
  yield ctx.movePlayer([dir]);
  yield ctx.wait(3);
  lib.setMapScript(ctx, GATE.DEFAULT, map);
}

/** Route5GateDefaultScript / Route6GateDefaultScript. */
function gateDefaultScript(ctx, { coords, facing, pushDir, map }) {
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
    yield* gatePushPlayer(ctx, pushDir, map);
  }());
}

const Route5Gate = {
  onFrame(ctx) {
    if (lib.getMapScript(ctx) === GATE.PLAYER_MOVING) { // Route5GatePlayerMovingScript (left over by the shared guard text)
      lib.setMapScript(ctx, GATE.DEFAULT);
      return undefined;
    }
    return gateDefaultScript(ctx, { coords: ROUTE5GATE_COORDS, facing: 'left', pushDir: 'up', map: 'Route5Gate' });
  },
  onInteract(ctx, i) {
    return i === ROUTE5GATE_GUARD ? saffronGateGuard(ctx) : undefined;
  },
};

const Route6Gate = {
  onFrame(ctx) {
    if (lib.getMapScript(ctx) === GATE.PLAYER_MOVING) {
      lib.setMapScript(ctx, GATE.DEFAULT);
      return undefined;
    }
    return gateDefaultScript(ctx, { coords: ROUTE6GATE_COORDS, facing: 'right', pushDir: 'down', map: 'Route6Gate' });
  },
  onInteract(ctx, i) {
    return i === ROUTE6GATE_GUARD ? saffronGateGuard(ctx) : undefined;
  },
};

// =========================================================================== UndergroundPathRoute5

const UNDERGROUNDPATHROUTE5_LITTLE_GIRL = 1;

const UndergroundPathRoute5 = {
  onInteract(ctx, i) {
    if (i !== UNDERGROUNDPATHROUTE5_LITTLE_GIRL) return undefined;
    return (function* trade() { yield* lib.npcTrade(ctx, 'TRADE_FOR_SPOT'); }());
  },
};

// =========================================================================== Daycare

const DAYCARE_GENTLEMAN = 1;

/** DaycareGentlemanText: leave a POKéMON, or pay ¥100 x (levels grown + 1) to take it back. */
function* daycareGentleman(ctx) {
  const st = ctx.state;
  const T = (n) => `DaycareGentlemanText.${n}`;
  if (!st.dayCareMon) {
    yield print(ctx, T('IntroText'));
    const yes = yield ctx.yesNo();
    if (!yes) {
      yield ctx.showText(T('ComeAgainText'));
      return;
    }
    if (lib.partyCount(ctx) <= 1) {
      yield ctx.showText(T('OnlyHaveOneMonText'));
      return;
    }
    yield print(ctx, T('WhichMonText'));
    const which = yield* lib.choosePartyMon(ctx, {});
    if (which < 0) { // B: "All right then, come again."
      yield ctx.showText(T('AllRightThenText'));
      return;
    }
    const r = dayCareDeposit(st, which);
    if (!r.ok) { // KnowsHMMove (the only refusal left)
      yield ctx.showText(T('CantAcceptMonWithHMText'));
      return;
    }
    yield print(ctx, T('WillLookAfterMonText'), { subs: { wNameBuffer: r.mon.nickname } });
    yield* cry(ctx, r.mon.species);
    yield ctx.showText(T('ComeSeeMeInAWhileText'));
    return;
  }
  // .daycareInUse
  const quote = dayCareQuote(st);
  const name = st.dayCareMon.mon.nickname;
  yield print(ctx, quote.levelsGrown === 0 ? T('MonNeedsMoreTimeText') : T('MonHasGrownText'),
    { subs: { wNameBuffer: name, wDayCareNumLevelsGrown: quote.levelsGrown } });
  if (lib.partyCount(ctx) >= 6) {
    yield ctx.showText(T('NoRoomForMonText'));
    return;
  }
  // text_bcd would zero-pad the amount (the engine reads LEADING_ZEROES the wrong way round): a trailing space instead
  yield print(ctx, T('OweMoneyText'), { subs: { wDayCareTotalCost: String(quote.cost).padEnd(4, ' ') } });
  lib.showMoneyBox(ctx);
  const pay = yield ctx.yesNo();
  if (!pay) {
    yield ctx.showText(T('AllRightThenText'));
    lib.hideMoneyBox(ctx);
    return;
  }
  if (lib.money(ctx) < quote.cost) {
    yield ctx.showText(T('NotEnoughMoneyText'));
    lib.hideMoneyBox(ctx);
    return;
  }
  const back = dayCareWithdraw(st);
  if (!back.ok) { // room and money were checked above
    lib.hideMoneyBox(ctx);
    return;
  }
  yield* lib.fanfare(ctx, 'SFX_PURCHASE');
  lib.showMoneyBox(ctx);
  yield print(ctx, T('HeresYourMonText'));
  yield* cry(ctx, back.mon.species);
  yield ctx.showText(T('GotMonBackText'), { subs: { wDayCareMonName: back.mon.nickname } });
  lib.hideMoneyBox(ctx);
}

const Daycare = {
  onInteract(ctx, i) {
    return i === DAYCARE_GENTLEMAN ? daycareGentleman(ctx) : undefined;
  },
};

export default {
  PewterCity,
  Museum1F,
  PewterGym,
  PewterNidoranHouse,
  PewterPokecenter,
  MtMoonB2F,
  MtMoonPokecenter,
  CeruleanCity,
  CeruleanTrashedHouse,
  CeruleanTradeHouse,
  CeruleanGym,
  BikeShop,
  CeruleanBadgeHouse,
  Route24,
  Route25,
  BillsHouse,
  Route5Gate,
  UndergroundPathRoute5,
  Daycare,
  Route6Gate,
};
