// Region kanto5 story scripts: Saffron City (+ Pokémon Center, Mart, Gym, Pidgey house, Copycat's
// house, the Fighting Dojo, Mr. Psychic's house), Silph Co. 1F-11F and its elevator, Fuchsia City
// (+ Mart, Bill's grandpa, Pokémon Center, the Warden's house, the Safari Zone gate, Gym, meeting
// room, Good Rod house), the four Safari Zone areas with their rest houses and the secret house,
// Routes 19 / 20 and the Seafoam Islands (docs/scripting.md). Each entry ports
// vendor/pokered/scripts/<Map>.asm: the w<Map>CurScript state machines keep the asm's indices
// (SCRIPT_* in the comments), per-frame map scripts are onFrame, the map-load callbacks
// (BIT_CUR_MAP_LOADED_1 / _2) are onEnter, text_asm NPCs are onInteract / onSign (their box is
// managed here, so PrintText vs DisplayTextID semantics and wDoNotWaitForButtonPressAfterDisplayingText
// can be honoured) and a text_asm inside a text is onTextAsm. Object indices are 1-based
// (object_event order), sign indices 0-based.
//
// No entry (nothing to port): Saffron City (the Rockets are the toggleable objects that
// SilphCo11F sends away), the Saffron / Fuchsia Pokémon Centers and Marts, Bill's grandpa's
// house, the meeting room, the Safari Zone's four areas and rest houses (items, signs and the
// Safari game are the engine's and hooks.js'), Route 19. The Silph Co. card-key doors follow the
// asm's per-floor .GateCoordinates tables (kanto5_lib.js), not data/maps_meta.json's
// cardKeyTables, which the ROM does not use.
//
// Known gaps: the Safari Zone's step / ball counter box in the overworld is hooks.js' business.

import * as lib from '../lib.js';
import { rivalParty } from '../../../pokemon/trainer.js';
import { MODE } from '../../../overworld/constants.js';
import {
  DEX, faceAndDelay, print, waitAndClose, coordIndex, stopAndPlay, playCry, cry, give, scriptVars,
  closeLockedDoors, unlockDoorAt, TEAM_ROCKET_SHOWS, TEAM_ROCKET_HIDES, SILPH_FLOORS, boulderPushedAt,
  resetSeafoamBoulders, bothSet, SEAFOAM_CURRENTS,
} from './kanto5_lib.js';

/** The gym trainers' EVENT_BEAT_<GYM>_TRAINER_n flags (SetEventRange when the leader is beaten). */
const trainerFlags = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

// =========================================================================== SaffronGym

const SAFFRONGYM_SABRINA = 1;
const SAFFRONGYM_GYM_GUIDE = 9;
const SAFFRON_GYM_TRAINER_FLAGS = Object.freeze(trainerFlags('EVENT_BEAT_SAFFRON_GYM_TRAINER_', 7));

/** SaffronGymSabrinaText + SaffronGymSabrinaPostBattle / SaffronGymSabrinaReceiveTM46Script (MARSHBADGE, TM46). */
function saffronSabrina(ctx) {
  return lib.gymLeader(ctx, {
    trainerClass: 'SABRINA', partyIndex: 1, gymLeaderNo: 6, objectIndex: SAFFRONGYM_SABRINA,
    badge: 'MARSHBADGE', badgeFlag: 'EVENT_BEAT_SABRINA', tm: 'TM_PSYWAVE', tmFlag: 'EVENT_GOT_TM46',
    textBefore: 'SaffronGymSabrinaText.Text',
    textWin: 'SaffronGymSabrinaText.ReceivedMarshBadgeText',
    textBadge: 'SaffronGymSabrinaMarshBadgeInfoText',
    textTm: 'SaffronGymSabrinaReceivedTM46Text',
    textNoRoom: 'SaffronGymSabrinaTM46NoRoomText',
    textAfter: 'SaffronGymSabrinaText.PostBattleAdviceText',
    trainerFlags: SAFFRON_GYM_TRAINER_FLAGS,
  });
}

const SaffronGym = {
  trainers: true,
  onInteract(ctx, i) {
    if (i === SAFFRONGYM_SABRINA) return saffronSabrina(ctx);
    if (i === SAFFRONGYM_GYM_GUIDE) {
      return (function* guide() {
        yield ctx.showText(ctx.getFlag('EVENT_BEAT_SABRINA')
          ? 'SaffronGymGymGuideText.BeatSabrinaText' : 'SaffronGymGymGuideText.ChampInMakingText');
      }());
    }
    return undefined;
  },
};

// =========================================================================== SaffronPidgeyHouse

const SaffronPidgeyHouse = {
  onTextAsm(ctx, label) {
    // SaffronPidgeyHousePidgeyText: PlayCry, not waited for (the box waits for a button)
    if (label !== 'SaffronPidgeyHousePidgeyText') return undefined;
    playCry(ctx, DEX.PIDGEY);
    return true;
  },
};

// =========================================================================== Copycat's house

const CopycatsHouse1F = {
  onTextAsm(ctx, label) {
    // CopycatsHouse1FChanseyText: PlayCry, not waited for
    if (label !== 'CopycatsHouse1FChanseyText') return undefined;
    playCry(ctx, DEX.CHANSEY);
    return true;
  },
};

const COPYCATSHOUSE2F_COPYCAT = 1;
const COPYCATSHOUSE2F_PC_SIGN = 1;

/**
 * CopycatsHouse2FCopycatText: the POKé DOLL for TM31 (MIMIC), once. The asm sets
 * wDoNotWaitForButtonPressAfterDisplayingText at the start, so the box closes with the last
 * PrintText (the texts that matter end with their own button wait).
 */
function* copycat(ctx) {
  const T = (n) => `CopycatsHouse2FCopycatText.${n}`;
  if (ctx.getFlag('EVENT_GOT_TM31')) {
    yield ctx.showText(T('TM31Explanation2Text'));
    return;
  }
  yield print(ctx, T('DoYouLikePokemonText'));
  if (!lib.hasItem(ctx, 'POKE_DOLL')) {
    ctx.closeText();
    return;
  }
  yield print(ctx, T('TM31PreReceiveText'));
  if (!(yield* give(ctx, 'TM_MIMIC', 1))) {
    yield print(ctx, T('TM31NoRoomText'));
    ctx.closeText();
    return;
  }
  // the received text goes straight into TM31Explanation1Text (text_waitbutton)
  yield print(ctx, T('ReceivedTM31Text'), { subs: { wStringBuffer: lib.itemName('TM_MIMIC') } });
  lib.takeItem(ctx, 'POKE_DOLL', 1);
  ctx.setFlag('EVENT_GOT_TM31');
  ctx.closeText();
}

const CopycatsHouse2F = {
  onInteract(ctx, i) {
    return i === COPYCATSHOUSE2F_COPYCAT ? copycat(ctx) : undefined;
  },
  onSign(ctx, i) {
    if (i !== COPYCATSHOUSE2F_PC_SIGN) return undefined;
    // CopycatsHouse2FPCText: the secrets only from the front
    return (function* pc() {
      yield ctx.showText(ctx.player.facing === 'up' ? 'CopycatsHouse2FPCText.MySecretsText' : 'CopycatsHouse2FPCText.CantSeeText');
    }());
  },
};

// =========================================================================== FightingDojo

const FIGHTINGDOJO_KARATE_MASTER = 1;
const FIGHTINGDOJO_HITMONLEE_POKE_BALL = 6;
const FIGHTINGDOJO_HITMONCHAN_POKE_BALL = 7;
const FIGHTINGDOJO = Object.freeze({ DEFAULT: 0, START_BATTLE: 1, END_BATTLE: 2, KARATE_MASTER_POST_BATTLE: 3 });
/** FightingDojoDefaultScript: the Karate Master challenges the player at (4, 3), left of him. */
const FIGHTINGDOJO_MASTER_COORDS = Object.freeze([[4, 3]]);
/** SetEventRange EVENT_BEAT_KARATE_MASTER, EVENT_BEAT_FIGHTING_DOJO_TRAINER_3. */
const FIGHTING_DOJO_BEATEN_EVENTS = Object.freeze(['EVENT_BEAT_KARATE_MASTER',
  ...trainerFlags('EVENT_BEAT_FIGHTING_DOJO_TRAINER_', 4)]);

/**
 * FightingDojoKarateMasterText (A button, or the default script when the player stands at (4, 3)):
 * the challenge and the battle (OPP_BLACKBELT 1), then FightingDojoKarateMasterPostBattleScript:
 * the whole dojo counts as beaten and he offers a prize.
 * @param {boolean} fromCoords the player walked up to him (wSavedCoordIndex = 1): both turn to face each other
 */
function* karateMaster(ctx, fromCoords) {
  const T = (n) => `FightingDojoKarateMasterText.${n}`;
  if (ctx.getFlag('EVENT_DEFEATED_FIGHTING_DOJO')) {
    yield ctx.showText(T('StayAndTrainWithUsText'));
    return;
  }
  if (ctx.getFlag('EVENT_BEAT_KARATE_MASTER')) {
    yield ctx.showText(T('IWillGiveYouAPokemonText'));
    return;
  }
  const face = function* faceEachOther() {
    ctx.facePlayer('right');
    yield* faceAndDelay(ctx, FIGHTINGDOJO_KARATE_MASTER, 'left');
  };
  if (fromCoords) yield* face();
  yield ctx.showText(T('Text'));
  lib.setMapScript(ctx, FIGHTINGDOJO.KARATE_MASTER_POST_BATTLE);
  const outcome = yield* lib.scriptedBattle(ctx, {
    kind: 'trainer', trainerClass: 'BLACKBELT', partyIndex: 1, objectIndex: FIGHTINGDOJO_KARATE_MASTER,
    winText: T('DefeatedText'), loseText: T('DefeatedText'),
  });
  if (outcome === 'lose') {
    // FightingDojoResetScripts; the blackout follows this script
    lib.setMapScript(ctx, FIGHTINGDOJO.DEFAULT);
    return;
  }
  // FightingDojoKarateMasterPostBattleScript
  if (fromCoords) yield* face();
  for (const e of FIGHTING_DOJO_BEATEN_EVENTS) ctx.setFlag(e);
  yield ctx.showText(T('IWillGiveYouAPokemonText'));
  lib.setMapScript(ctx, FIGHTINGDOJO.DEFAULT);
}

/**
 * FightingDojoHitmonleePokeBallText / FightingDojoHitmonchanPokeBallText: one of the two, never
 * both (the Pokédex page first, then "You want ...?" YES/NO, Lv. 30).
 */
function* hitmonBall(ctx, { species, text, got, toggle }) {
  if (ctx.getFlag('EVENT_GOT_HITMONLEE') || ctx.getFlag('EVENT_GOT_HITMONCHAN')) {
    yield ctx.showText('FightingDojoBetterNotGetGreedyText');
    return;
  }
  yield* lib.pokedexPage(ctx, species); // DisplayPokedex
  yield print(ctx, text);
  const yes = yield ctx.yesNo();
  if (!yes) {
    yield* waitAndClose(ctx);
    return;
  }
  const party = lib.partyCount(ctx);
  // GivePokemon: "got X!", the nickname question (AddPartyMon / SendNewMonToBox -> AskName); a full box keeps the ball
  if (!(yield* lib.receivePokemon(ctx, { dex: species, level: 30, askNickname: true }))) return;
  // a party mon sets wDoNotWaitForButtonPressAfterDisplayingText: the box (still showing the nickname question) closes without a wait
  if (lib.partyCount(ctx) > party) ctx.closeText();
  // once the Poké Ball is taken, hide the sprite
  ctx.hideToggle(toggle);
  ctx.setFlag(got);
  ctx.setFlag('EVENT_DEFEATED_FIGHTING_DOJO');
}

const FightingDojo = {
  trainers: true,
  onFrame(ctx) {
    // FightingDojoDefaultScript returns before CheckFightingMapTrainers once a prize was taken
    const defeated = ctx.getFlag('EVENT_DEFEATED_FIGHTING_DOJO');
    FightingDojo.trainers = !defeated;
    if (lib.getMapScript(ctx) !== FIGHTINGDOJO.DEFAULT || defeated || ctx.getFlag('EVENT_BEAT_KARATE_MASTER')) return undefined;
    if (!coordIndex(ctx, FIGHTINGDOJO_MASTER_COORDS)) return undefined;
    return karateMaster(ctx, true);
  },
  onInteract(ctx, i) {
    switch (i) {
      case FIGHTINGDOJO_KARATE_MASTER:
        return karateMaster(ctx, false);
      case FIGHTINGDOJO_HITMONLEE_POKE_BALL:
        return hitmonBall(ctx, {
          species: DEX.HITMONLEE, text: 'FightingDojoHitmonleePokeBallText.Text',
          got: 'EVENT_GOT_HITMONLEE', toggle: 'TOGGLE_FIGHTING_DOJO_GIFT_1',
        });
      case FIGHTINGDOJO_HITMONCHAN_POKE_BALL:
        return hitmonBall(ctx, {
          species: DEX.HITMONCHAN, text: 'FightingDojoHitmonchanPokeBallText.Text',
          got: 'EVENT_GOT_HITMONCHAN', toggle: 'TOGGLE_FIGHTING_DOJO_GIFT_2',
        });
      default:
        return undefined;
    }
  },
};

// =========================================================================== MrPsychicsHouse

const MRPSYCHICSHOUSE_MR_PSYCHIC = 1;

const MrPsychicsHouse = {
  onInteract(ctx, i) {
    if (i !== MRPSYCHICSHOUSE_MR_PSYCHIC) return undefined;
    // MrPsychicsHouseMrPsychicText: TM29 (PSYCHIC), once
    return (function* tm29() {
      const T = (n) => `MrPsychicsHouseMrPsychicText.${n}`;
      if (ctx.getFlag('EVENT_GOT_TM29')) {
        yield ctx.showText(T('TM29ExplanationText'));
        return;
      }
      yield print(ctx, T('YouWantedThisText'));
      const ok = yield* lib.receiveItem(ctx, 'TM_PSYCHIC_M', 1, { text: T('ReceivedTM29Text'), noRoomText: T('TM29NoRoomText') });
      if (ok) ctx.setFlag('EVENT_GOT_TM29');
    }());
  },
};

// =========================================================================== Silph Co.

const SILPHCO_BEAT_GIOVANNI = 'EVENT_BEAT_SILPH_CO_GIOVANNI';

/** SilphCo6FBeatGiovanniPrintDEOrPrintHLScript: a worker's line before / after Giovanni was beaten on 11F. */
const worker = (label, before, after) => (ctx) => (function* workerText() {
  yield ctx.showText(`${label}.${ctx.getFlag(SILPHCO_BEAT_GIOVANNI) ? after : before}`);
}());

/** A Silph Co. floor: the map-load callback for its card-key doors and the door the player just opened. */
function silphFloor({ talks = {}, ...rest } = {}) {
  return {
    trainers: true,
    onEnter(ctx) {
      closeLockedDoors(ctx); // BIT_CUR_MAP_LOADED_1: SilphCo<N>FGateCallbackScript
      return undefined;
    },
    onCardKeyDoor(ctx, bx, by) {
      unlockDoorAt(ctx, bx, by); // the same callback, run again by PrintCardKeyText
    },
    onInteract(ctx, i) {
      const talk = talks[i];
      return talk ? talk(ctx) : undefined;
    },
    ...rest,
  };
}

// ----- 1F: the receptionist is back at her desk once Giovanni was beaten

const SilphCo1F = {
  onFrame(ctx) {
    if (!ctx.getFlag(SILPHCO_BEAT_GIOVANNI)) return undefined;
    if (ctx.getFlag('EVENT_SILPH_CO_RECEPTIONIST_AT_DESK')) return undefined; // CheckAndSetEvent
    ctx.setFlag('EVENT_SILPH_CO_RECEPTIONIST_AT_DESK');
    ctx.showToggle('TOGGLE_SILPH_CO_1F_RECEPTIONIST');
    return undefined;
  },
};

// ----- 2F: TM36 for the scared worker

const SILPHCO2F_SILPH_WORKER_F = 1;

const SilphCo2F = silphFloor({
  talks: {
    [SILPHCO2F_SILPH_WORKER_F]: (ctx) => (function* tm36() {
      const T = (n) => `SilphCo2FSilphWorkerFText.${n}`;
      if (ctx.getFlag('EVENT_GOT_TM36')) {
        yield ctx.showText(T('TM36ExplanationText'));
        return;
      }
      yield print(ctx, T('PleaseTakeThisText'));
      const ok = yield* lib.receiveItem(ctx, 'TM_SELFDESTRUCT', 1, { text: T('ReceivedTM36Text'), noRoomText: T('TM36NoRoomText') });
      if (ok) ctx.setFlag('EVENT_GOT_TM36');
    }()),
  },
});

// ----- 3F - 6F: workers who talk about Giovanni

const SilphCo3F = silphFloor({ talks: { 1: worker('SilphCo3FSilphWorkerMText', 'WhatShouldIDoText', 'YouSavedUsText') } });
const SilphCo4F = silphFloor({ talks: { 1: worker('SilphCo4FSilphWorkerMText', 'ImHidingText', 'TeamRocketIsGoneText') } });
const SilphCo5F = silphFloor({ talks: { 1: worker('SilphCo5FSilphWorkerMText', 'ThatsYouRightText', 'YoureOurHeroText') } });
const SilphCo6F = silphFloor({
  talks: {
    1: worker('SilphCo6FSilphWorkerM1Text', 'TookOverTheBuildingText', 'BackToWorkText'),
    2: worker('SilphCo6FSilphWorkerM2Text', 'HelpMePleaseText', 'WeGotEngagedText'),
    3: worker('SilphCo6FSilphWorkerF1Text', 'SuchACowardText', 'HaveToMarryHimText'),
    4: worker('SilphCo6FSilphWorkerF2Text', 'TeamRocketConquerWorldText', 'TeamRocketRanText'),
    5: worker('SilphCo6FSilphWorkerM3Text', 'TargetedSilphText', 'WorkForSilphText'),
  },
});

// ----- 7F: the rival, the Lapras gift

const SILPHCO7F_RIVAL = 9;
const SILPH7 = Object.freeze({
  DEFAULT: 0, START_BATTLE: 1, END_BATTLE: 2, RIVAL_START_BATTLE: 3, RIVAL_AFTER_BATTLE: 4, RIVAL_EXIT: 5,
});
/** SilphCo7FDefaultScript.RivalEncounterCoordinates: index 1 = (3, 2), index 2 = (3, 3). */
const SILPH7_RIVAL_COORDS = Object.freeze([[3, 2], [3, 3]]);

/** The rival's walk up to the player: four steps for the first coordinate, one less for the lower one. */
export function silph7RivalApproach(coordIdx) {
  return coordIdx === 1 ? [['up', 4]] : [['up', 3]];
}

/** His walk away: two steps right when the player stands at (3, 2), else around the player. */
export function silph7RivalExit(coordIdx) {
  return coordIdx === 1 ? [['right', 2]] : ['left', 'up', 'up', 'right', 'right', 'right', 'down'];
}

/** SilphCo7FRivalStartBattleScript: OPP_RIVAL2 party 7 for STARTER2, 8 for STARTER3, any other value falls through to 9. */
function silph7RivalParty(ctx) {
  try {
    return rivalParty('SILPH_CO', ctx.state.rivalStarter);
  } catch {
    return { classConst: 'RIVAL2', partyIndex: 9 };
  }
}

/**
 * SilphCo7FDefaultScript ... SilphCo7FRivalExitScript: the rival waits for the player at the
 * stairs (MUSIC_MEET_RIVAL, OPP_RIVAL2 party 7 / 8 / 9 by his starter).
 */
function* silph7Rival(ctx, coordIdx) {
  const S = SILPH7;
  stopAndPlay(ctx, 'MUSIC_MEET_RIVAL');
  ctx.facePlayer('down');
  yield ctx.showText('SilphCo7FRivalText.Text');
  lib.setMapScript(ctx, S.RIVAL_START_BATTLE);
  yield ctx.moveNpc(SILPHCO7F_RIVAL, silph7RivalApproach(coordIdx));
  // SilphCo7FRivalStartBattleScript
  yield ctx.showText('SilphCo7FRivalWaitedHereText');
  yield ctx.wait(3);
  const { classConst, partyIndex } = silph7RivalParty(ctx);
  lib.setMapScript(ctx, S.RIVAL_AFTER_BATTLE);
  const outcome = yield* lib.scriptedBattle(ctx, {
    kind: 'trainer', trainerClass: classConst, partyIndex, objectIndex: SILPHCO7F_RIVAL,
    winText: 'SilphCo7FRivalDefeatedText', loseText: 'SilphCo7FRivalVictoryText',
  });
  if (outcome === 'lose') {
    // SilphCo7FSetDefaultScript; the blackout follows this script
    lib.setMapScript(ctx, S.DEFAULT);
    return;
  }
  // SilphCo7FRivalAfterBattleScript
  ctx.setFlag('EVENT_BEAT_SILPH_CO_RIVAL');
  ctx.facePlayer('down');
  yield* faceAndDelay(ctx, SILPHCO7F_RIVAL, 'up');
  yield ctx.showText('SilphCo7FRivalGoodLuckToYouText');
  stopAndPlay(ctx, 'MUSIC_MEET_RIVAL_ALT_START'); // Music_RivalAlternateStart
  lib.setMapScript(ctx, S.RIVAL_EXIT);
  yield ctx.moveNpc(SILPHCO7F_RIVAL, silph7RivalExit(coordIdx));
  // SilphCo7FRivalExitScript
  ctx.hideToggle('TOGGLE_SILPH_CO_7F_RIVAL');
  yield* lib.playMapMusic(ctx);
  lib.setMapScript(ctx, S.DEFAULT);
}

/**
 * SilphCo7FSilphWorkerM1Text: LAPRAS (Lv. 15) once, else his worry about the president. GivePokemon
 * asks for a nickname when the mon joins the party and then sets wDoNotWaitForButtonPressAfterDisplayingText:
 * the description replaces the question in the box and the box closes with it; a mon sent to the box
 * waited for a button press first (WaitForTextScrollButtonPress, the box text's own wait here).
 */
function* laprasGuy(ctx) {
  const T = (n) => `SilphCo7FSilphWorkerM1Text.${n}`;
  if (lib.statusFlag(ctx, 'BIT_GOT_LAPRAS')) {
    yield ctx.showText(ctx.getFlag(SILPHCO_BEAT_GIOVANNI) ? T('SavedText') : T('IsOurPresidentOkText'));
    return;
  }
  yield print(ctx, T('HaveThisPokemonText'));
  const party = lib.partyCount(ctx);
  if (!(yield* lib.receivePokemon(ctx, { dex: DEX.LAPRAS, level: 15, askNickname: true }))) return; // box full
  if (lib.partyCount(ctx) > party) {
    yield print(ctx, T('LaprasDescriptionText'));
    ctx.closeText();
  } else {
    yield ctx.showText(T('LaprasDescriptionText'));
  }
  lib.setStatusFlag(ctx, 'BIT_GOT_LAPRAS');
}

const SILPHCO7F_SILPH_WORKER_M1 = 1;

const SilphCo7F = silphFloor({
  talks: {
    [SILPHCO7F_SILPH_WORKER_M1]: laprasGuy,
    2: worker('SilphCo7FSilphWorkerM2Text', 'AfterTheMasterBallText', 'CancelledTheMasterBallText'),
    3: worker('SilphCo7FSilphWorkerM3Text', 'ItWouldBeBadText', 'YouChasedOffTeamRocketText'),
    4: worker('SilphCo7FSilphWorkerM4Text', 'ItsReallyDangerousHereText', 'SafeAtLastText'),
  },
  onFrame(ctx) {
    if (lib.getMapScript(ctx) !== SILPH7.DEFAULT || ctx.getFlag('EVENT_BEAT_SILPH_CO_RIVAL')) return undefined;
    const idx = coordIndex(ctx, SILPH7_RIVAL_COORDS);
    return idx ? silph7Rival(ctx, idx) : undefined;
  },
});

// ----- 8F, 9F, 10F

const SilphCo8F = silphFloor({ talks: { 1: worker('SilphCo8FSilphWorkerMText', 'SilphIsFinishedText', 'ThanksForSavingUsText') } });

/** SilphCo9FNurseText: she heals the party until Giovanni was beaten. */
function* silph9Nurse(ctx) {
  const T = (n) => `SilphCo9FNurseText.${n}`;
  if (ctx.getFlag(SILPHCO_BEAT_GIOVANNI)) {
    yield ctx.showText(T('ThankYouText'));
    return;
  }
  yield print(ctx, T('YouLookTiredText'));
  yield* lib.healParty(ctx); // predef HealParty
  yield ctx.fadeOut('white');
  yield ctx.wait(3);
  yield ctx.fadeIn('white');
  yield ctx.showText(T('DontGiveUpText'));
}

const SilphCo9F = silphFloor({ talks: { 1: silph9Nurse } });
const SilphCo10F = silphFloor({ talks: { 3: worker('SilphCo10FSilphWorkerFText', 'ImScaredText', 'QuietAboutMyCryingText') } });

// ----- 11F: Giovanni, the president's Master Ball

const SILPHCO11F_SILPH_PRESIDENT = 1;
const SILPHCO11F_GIOVANNI = 3;
const SILPH11 = Object.freeze({
  DEFAULT: 0, START_BATTLE: 1, END_BATTLE: 2, GIOVANNI_FACING: 3, GIOVANNI_START_BATTLE: 4, GIOVANNI_AFTER_BATTLE: 5,
});
/** SilphCo11FDefaultScript.PlayerCoordsArray: index 1 = (6, 13) below Giovanni, index 2 = (7, 12) right of his stop. */
const SILPH11_GIOVANNI_COORDS = Object.freeze([[6, 13], [7, 12]]);

/** SilphCo11FTeamRocketLeavesScript: the Rockets leave Silph Co. and Saffron City, the citizens return. */
export function teamRocketLeaves(ctx) {
  for (const t of TEAM_ROCKET_HIDES) ctx.hideToggle(t);
  for (const t of TEAM_ROCKET_SHOWS) ctx.showToggle(t);
}

/** SilphCo11FSetPlayerAndSpriteFacingDirectionScript: below him they face up / down, else left / right. */
function* giovanniFaces(ctx, coordIdx) {
  ctx.facePlayer(coordIdx === 1 ? 'up' : 'left');
  yield* faceAndDelay(ctx, SILPHCO11F_GIOVANNI, coordIdx === 1 ? 'down' : 'right');
}

/**
 * SilphCo11FDefaultScript ... SilphCo11FGiovanniAfterBattleScript: Giovanni walks down three
 * steps to the player and fights (OPP_GIOVANNI 2); once beaten, TEAM ROCKET leaves.
 */
function* giovanniEncounter(ctx, coordIdx) {
  const S = SILPH11;
  yield ctx.showText('SilphCo11FGiovanniText');
  lib.setMapScript(ctx, S.GIOVANNI_FACING);
  yield ctx.moveNpc(SILPHCO11F_GIOVANNI, [['down', 3]]);
  // SilphCo11FGiovanniBattleFacingScript
  yield* giovanniFaces(ctx, coordIdx);
  yield ctx.wait(3);
  // SilphCo11FGiovanniStartBattleScript: both end-battle texts are "I lost again!?"
  lib.setMapScript(ctx, S.GIOVANNI_AFTER_BATTLE);
  const outcome = yield* lib.scriptedBattle(ctx, {
    kind: 'trainer', trainerClass: 'GIOVANNI', partyIndex: 2, objectIndex: SILPHCO11F_GIOVANNI,
    winText: 'SilphCo11FGiovanniILostAgainText', loseText: 'SilphCo11FGiovanniILostAgainText',
  });
  if (outcome === 'lose') {
    // SilphCo11FResetCurScript; the blackout follows this script
    lib.setMapScript(ctx, S.DEFAULT);
    return;
  }
  // SilphCo11FGiovanniAfterBattleScript
  yield* giovanniFaces(ctx, coordIdx);
  yield ctx.showText('SilphCo11FGiovanniYouRuinedOurPlansText');
  yield ctx.fadeOut('black');
  teamRocketLeaves(ctx);
  yield ctx.wait(3);
  yield ctx.fadeIn('black');
  ctx.setFlag(SILPHCO_BEAT_GIOVANNI);
  lib.setMapScript(ctx, S.DEFAULT);
}

/** SilphCo11FSilphPresidentText: the MASTER BALL, once. */
function* silphPresident(ctx) {
  const T = (n) => `SilphCo11FSilphPresidentText.${n}`;
  if (ctx.getFlag('EVENT_GOT_MASTER_BALL')) {
    yield ctx.showText(T('MasterBallDescriptionText'));
    return;
  }
  yield print(ctx, T('Text'));
  const ok = yield* lib.receiveItem(ctx, 'MASTER_BALL', 1, { text: T('ReceivedMasterBallText'), noRoomText: T('NoRoomText') });
  if (ok) ctx.setFlag('EVENT_GOT_MASTER_BALL');
}

const SilphCo11F = silphFloor({
  talks: { [SILPHCO11F_SILPH_PRESIDENT]: silphPresident },
  onFrame(ctx) {
    if (lib.getMapScript(ctx) !== SILPH11.DEFAULT || ctx.getFlag(SILPHCO_BEAT_GIOVANNI)) return undefined;
    const idx = coordIndex(ctx, SILPH11_GIOVANNI_COORDS);
    return idx ? giovanniEncounter(ctx, idx) : undefined;
  },
});

// ----- the elevator

const SILPHCOELEVATOR_PANEL_SIGN = 0;

const SilphCoElevator = {
  onSign(ctx, i) {
    if (i !== SILPHCOELEVATOR_PANEL_SIGN) return undefined;
    // SilphCoElevatorElevatorText: "Which floor do you want?", the exits point at the floor, the shake
    return (function* panel() {
      yield* lib.elevatorMenu(ctx, SILPH_FLOORS, 0);
    }());
  },
};

// =========================================================================== FuchsiaCity

/** bg events 8-12: the animal pens' signs, text and then the Pokémon's Pokédex page. */
const FUCHSIACITY_ANIMAL_SIGNS = Object.freeze({
  8: ['FuchsiaCityChanseySignText.Text', DEX.CHANSEY],
  9: ['FuchsiaCityVoltorbSignText.Text', DEX.VOLTORB],
  10: ['FuchsiaCityKangaskhanSignText.Text', DEX.KANGASKHAN],
  11: ['FuchsiaCitySlowpokeSignText.Text', DEX.SLOWPOKE],
  12: ['FuchsiaCityLaprasSignText.Text', DEX.LAPRAS],
});
const FUCHSIACITY_FOSSIL_SIGN = 13;

/** The text, then DisplayPokedex (the box goes away behind the page). */
function* signWithDexPage(ctx, label, species) {
  yield print(ctx, label);
  ctx.closeText();
  yield* lib.pokedexPage(ctx, species);
}

/** FuchsiaCityFossilSignText: the fossil the player took from MT. MOON, else "undetermined". */
function* fossilSign(ctx) {
  const T = (n) => `FuchsiaCityFossilSignText.${n}`;
  if (ctx.getFlag('EVENT_GOT_DOME_FOSSIL')) {
    yield* signWithDexPage(ctx, T('OmanyteText'), DEX.OMANYTE);
  } else if (ctx.getFlag('EVENT_GOT_HELIX_FOSSIL')) {
    yield* signWithDexPage(ctx, T('KabutoText'), DEX.KABUTO);
  } else {
    yield ctx.showText(T('UndeterminedText'));
  }
}

const FuchsiaCity = {
  onSign(ctx, i) {
    if (i === FUCHSIACITY_FOSSIL_SIGN) return fossilSign(ctx);
    const sign = FUCHSIACITY_ANIMAL_SIGNS[i];
    return sign ? signWithDexPage(ctx, sign[0], sign[1]) : undefined;
  },
};

// =========================================================================== WardensHouse

const WARDENSHOUSE_WARDEN = 1;
const WARDENSHOUSE_DISPLAY_LEFT_SIGN = 0;
const WARDENSHOUSE_DISPLAY_RIGHT_SIGN = 1;

/** WardensHouseWardenText: GOLD TEETH for HM04 (STRENGTH). */
function* warden(ctx) {
  const T = (n) => `WardensHouseWardenText.${n}`;
  if (ctx.getFlag('EVENT_GOT_HM04')) {
    yield ctx.showText(T('HM04ExplanationText'));
    return;
  }
  if (!lib.hasItem(ctx, 'GOLD_TEETH')) {
    if (!ctx.getFlag('EVENT_GAVE_GOLD_TEETH')) {
      // his teeth are missing: gibberish, YES / NO
      yield print(ctx, T('Gibberish1Text'));
      const yes = yield ctx.yesNo();
      yield ctx.showText(yes ? T('Gibberish2Text') : T('Gibberish3Text'));
      return;
    }
    // .gave_gold_teeth: the bag was full last time
  } else {
    // .have_gold_teeth: "gave the GOLD TEETH", the jingle, "popped in his teeth"
    yield print(ctx, T('GaveTheGoldTeethText'));
    lib.takeItem(ctx, 'GOLD_TEETH', 1);
    ctx.setFlag('EVENT_GAVE_GOLD_TEETH');
  }
  yield print(ctx, T('ThanksText'));
  const ok = yield* lib.receiveItem(ctx, 'HM_STRENGTH', 1, { text: T('ReceivedHM04Text'), noRoomText: T('HM04NoRoomText') });
  if (ok) ctx.setFlag('EVENT_GOT_HM04');
}

const WardensHouse = {
  onInteract(ctx, i) {
    return i === WARDENSHOUSE_WARDEN ? warden(ctx) : undefined;
  },
  onSign(ctx, i) {
    // WardensHouseDisplayText: the left display is TEXT_WARDENSHOUSE_DISPLAY_LEFT, the right one the merchandise
    if (i !== WARDENSHOUSE_DISPLAY_LEFT_SIGN && i !== WARDENSHOUSE_DISPLAY_RIGHT_SIGN) return undefined;
    return (function* display() {
      yield ctx.showText(i === WARDENSHOUSE_DISPLAY_LEFT_SIGN
        ? 'WardensHouseDisplayText.PhotosAndFossilsText' : 'WardensHouseDisplayText.MerchandiseText');
    }());
  },
};

// =========================================================================== SafariZoneGate

const SAFARIZONEGATE_WORKER2 = 2;
const SAFARI = Object.freeze({
  DEFAULT: 0, PLAYER_MOVING_RIGHT: 1, WOULD_YOU_LIKE_TO_JOIN: 2, PLAYER_MOVING: 3, PLAYER_MOVING_DOWN: 4,
  LEAVING_SAFARI: 5, SET_SCRIPT_AFTER_MOVE: 6,
});
/** SafariZoneGateDefaultScript.PlayerNextToSafariZoneWorker1CoordsArray: index 1 = (3, 2), index 2 = (4, 2) next to him. */
const SAFARIZONEGATE_WORKER1_COORDS = Object.freeze([[3, 2], [4, 2]]);
const SAFARI_JOIN_TEXT = 'SafariZoneGateSafariZoneWorker1WouldYouLikeToJoinText';
const SAFARI_LEAVING_TEXT = 'SafariZoneGateSafariZoneWorker1LeavingEarlyText';
/**
 * The question texts end in a `text_asm` (the YES / NO and everything after it), which this
 * script does itself: show only the far text, or the engine's default text_asm would print every
 * sub-text of the routine one after the other.
 */
const farText = (label) => [{ cmd: 'text_far', label: `_${label}` }, { cmd: 'text_end' }];

/**
 * SafariZoneGateDefaultScript: walking up to the worker, he welcomes the player (the player faces
 * him, one step to the right when not next to him yet) and asks for ¥500.
 */
function* safariGateWelcome(ctx, coordIdx) {
  yield ctx.showText('SafariZoneGateSafariZoneWorker1Text'); // TEXT_SAFARIZONEGATE_SAFARI_ZONE_WORKER1_1
  ctx.facePlayer('right');
  if (coordIdx === 1) {
    // SafariZoneGatePlayerMovingRightScript
    lib.setMapScript(ctx, SAFARI.PLAYER_MOVING_RIGHT);
    yield ctx.movePlayer(['right']);
  }
  yield* safariGateJoin(ctx);
}

/**
 * SafariZoneGateWouldYouLikeToJoinScript + SafariZoneGateSafariZoneWorker1WouldYouLikeToJoinText's
 * text_asm: the MONEY box, YES / NO, ¥500 for 30 SAFARI BALLs and 502 steps, and the walk into the
 * zone (up three; the warp at the second step takes the player away). NO or no money: one step back down.
 */
function* safariGateJoin(ctx) {
  const T = (n) => `${SAFARI_JOIN_TEXT}.${n}`;
  lib.setMapScript(ctx, SAFARI.WOULD_YOU_LIKE_TO_JOIN);
  yield print(ctx, farText(SAFARI_JOIN_TEXT));
  lib.showMoneyBox(ctx);
  const yes = yield ctx.yesNo();
  if (yes && lib.money(ctx) >= lib.SAFARI_FEE) {
    yield* lib.safariEnter(ctx); // ¥500 off, 30 balls, 502 steps, EVENT_IN_SAFARI_ZONE, EVENT_SAFARI_GAME_OVER reset
    lib.showMoneyBox(ctx);
    yield print(ctx, T('MakePaymentText'));
    yield* waitAndClose(ctx); // TextScriptEnd
    lib.hideMoneyBox(ctx);
    lib.setMapScript(ctx, SAFARI.PLAYER_MOVING);
    yield ctx.movePlayer([['up', 3]]);
    return;
  }
  yield print(ctx, yes ? T('NotEnoughMoneyText') : T('PleaseComeAgainText'));
  yield* waitAndClose(ctx);
  lib.hideMoneyBox(ctx);
  // .CantPayWalkDown
  lib.setMapScript(ctx, SAFARI.PLAYER_MOVING_DOWN);
  yield ctx.movePlayer(['down']);
  lib.setMapScript(ctx, SAFARI.DEFAULT);
}

/**
 * SafariZoneGateLeavingSafariScript: the player came back (the game is over: "Did you get a good
 * haul?", out down three steps; or on purpose: "Leaving early?" YES: balls returned and out,
 * NO: "Good Luck!" and back in).
 */
function* safariGateLeaving(ctx) {
  ctx.facePlayer('down');
  if (ctx.getFlag('EVENT_SAFARI_GAME_OVER')) {
    yield* lib.safariExit(ctx); // ResetEvent EVENT_SAFARI_GAME_OVER / EVENT_IN_SAFARI_ZONE, wNumSafariBalls = 0
    yield ctx.showText('SafariZoneGateSafariZoneWorker1GoodHaulComeAgainText');
    lib.setMapScript(ctx, SAFARI.PLAYER_MOVING_DOWN);
    yield ctx.movePlayer([['down', 3]]);
    lib.setMapScript(ctx, SAFARI.DEFAULT);
    return;
  }
  yield print(ctx, farText(SAFARI_LEAVING_TEXT));
  const yes = yield ctx.yesNo();
  if (yes) {
    yield print(ctx, `${SAFARI_LEAVING_TEXT}.ReturnSafariBallsText`);
    ctx.facePlayer('down');
    yield* lib.safariExit(ctx);
    scriptVars(ctx).safariGateNext = SAFARI.DEFAULT; // wNextSafariZoneGateScript
    lib.setMapScript(ctx, SAFARI.SET_SCRIPT_AFTER_MOVE);
    yield* waitAndClose(ctx);
    yield ctx.movePlayer([['down', 3]]);
    // SafariZoneGateSetScriptAfterMoveScript: Delay3, then the next script
    yield ctx.wait(3);
    lib.setMapScript(ctx, SAFARI.DEFAULT);
    return;
  }
  yield print(ctx, `${SAFARI_LEAVING_TEXT}.GoodLuckText`);
  ctx.facePlayer('up');
  scriptVars(ctx).safariGateNext = SAFARI.LEAVING_SAFARI;
  lib.setMapScript(ctx, SAFARI.SET_SCRIPT_AFTER_MOVE);
  yield* waitAndClose(ctx);
  // back into the zone: the auto-walk is one step up off the gate's top row, onto the warp it came
  // from (the script goes on when the player returns). The engine does not warp on a simulated step
  // off the edge of the map, so the warp is taken directly: (3, 0) leads to the zone's first exit, (4, 0) to the second.
  yield ctx.warp('SafariZoneCenter', ctx.player.x === 3 ? 0 : 1, { facing: 'up' });
}

/** SafariZoneGateSafariZoneWorker2Text: "first time here?" YES: the explanation. */
function* safariWorker2(ctx) {
  const T = (n) => `SafariZoneGateSafariZoneWorker2Text.${n}`;
  yield print(ctx, T('FirstTimeHereText'));
  const yes = yield ctx.yesNo();
  yield ctx.showText(yes ? T('SafariZoneExplanationText') : T('YoureARegularHereText'));
}

const SafariZoneGate = {
  onFrame(ctx) {
    switch (lib.getMapScript(ctx)) {
      case SAFARI.DEFAULT: {
        const idx = coordIndex(ctx, SAFARIZONEGATE_WORKER1_COORDS);
        return idx ? safariGateWelcome(ctx, idx) : undefined;
      }
      case SAFARI.PLAYER_MOVING_RIGHT: // only after a reload: the step is over
      case SAFARI.WOULD_YOU_LIKE_TO_JOIN:
        return safariGateJoin(ctx);
      case SAFARI.PLAYER_MOVING:
        // SafariZoneGatePlayerMovingUpScript: the player is back from the zone
        lib.setMapScript(ctx, SAFARI.LEAVING_SAFARI);
        return undefined;
      case SAFARI.PLAYER_MOVING_DOWN:
        lib.setMapScript(ctx, SAFARI.DEFAULT);
        return undefined;
      case SAFARI.LEAVING_SAFARI:
        return safariGateLeaving(ctx);
      case SAFARI.SET_SCRIPT_AFTER_MOVE:
        lib.setMapScript(ctx, scriptVars(ctx).safariGateNext || SAFARI.DEFAULT);
        return undefined;
      default:
        return undefined;
    }
  },
  onInteract(ctx, i) {
    return i === SAFARIZONEGATE_WORKER2 ? safariWorker2(ctx) : undefined;
  },
};

// =========================================================================== FuchsiaGym

const FUCHSIAGYM_KOGA = 1;
const FUCHSIAGYM_GYM_GUIDE = 8;
const FUCHSIA_GYM_TRAINER_FLAGS = Object.freeze(trainerFlags('EVENT_BEAT_FUCHSIA_GYM_TRAINER_', 6));

/** FuchsiaGymKogaText + FuchsiaGymKogaPostBattleScript / FuchsiaGymReceiveTM06 (SOULBADGE, TM06). */
function fuchsiaKoga(ctx) {
  return lib.gymLeader(ctx, {
    trainerClass: 'KOGA', partyIndex: 1, gymLeaderNo: 5, objectIndex: FUCHSIAGYM_KOGA,
    badge: 'SOULBADGE', badgeFlag: 'EVENT_BEAT_KOGA', tm: 'TM_TOXIC', tmFlag: 'EVENT_GOT_TM06',
    textBefore: 'FuchsiaGymKogaText.BeforeBattleText',
    textWin: 'FuchsiaGymKogaText.ReceivedSoulBadgeText',
    textBadge: 'FuchsiaGymKogaSoulBadgeInfoText',
    textTm: 'FuchsiaGymKogaReceivedTM06Text',
    textNoRoom: 'FuchsiaGymKogaTM06NoRoomText',
    textAfter: 'FuchsiaGymKogaText.PostBattleAdviceText',
    trainerFlags: FUCHSIA_GYM_TRAINER_FLAGS,
  });
}

const FuchsiaGym = {
  trainers: true,
  onInteract(ctx, i) {
    if (i === FUCHSIAGYM_KOGA) return fuchsiaKoga(ctx);
    if (i === FUCHSIAGYM_GYM_GUIDE) {
      return (function* guide() {
        yield ctx.showText(ctx.getFlag('EVENT_BEAT_KOGA')
          ? 'FuchsiaGymGymGuideText.BeatKogaText' : 'FuchsiaGymGymGuideText.ChampInMakingText');
      }());
    }
    return undefined;
  },
};

// =========================================================================== FuchsiaGoodRodHouse / SafariZoneSecretHouse

const FUCHSIAGOODRODHOUSE_FISHING_GURU = 1;

const FuchsiaGoodRodHouse = {
  onInteract(ctx, i) {
    if (i !== FUCHSIAGOODRODHOUSE_FISHING_GURU) return undefined;
    // FuchsiaGoodRodHouseFishingGuruText: the GOOD ROD for a YES, once (BIT_GOT_GOOD_ROD)
    return (function* goodRod() {
      const T = (n) => `FuchsiaGoodRodHouseFishingGuruText.${n}`;
      if (lib.statusFlag(ctx, 'BIT_GOT_GOOD_ROD')) {
        yield ctx.showText(T('HowAreTheFishText'));
        return;
      }
      yield print(ctx, T('Text'));
      const yes = yield ctx.yesNo();
      if (!yes) {
        yield ctx.showText(T('ThatsSoDisappointingText'));
        return;
      }
      const ok = yield* lib.receiveItem(ctx, 'GOOD_ROD', 1, { text: T('ReceivedGoodRodText'), noRoomText: T('NoRoomText') });
      if (ok) lib.setStatusFlag(ctx, 'BIT_GOT_GOOD_ROD');
    }());
  },
};

const SAFARIZONESECRETHOUSE_FISHING_GURU = 1;

const SafariZoneSecretHouse = {
  onInteract(ctx, i) {
    if (i !== SAFARIZONESECRETHOUSE_FISHING_GURU) return undefined;
    // SafariZoneSecretHouseFishingGuruText: HM03 (SURF), once
    return (function* hm03() {
      const T = (n) => `SafariZoneSecretHouseFishingGuruText.${n}`;
      if (ctx.getFlag('EVENT_GOT_HM03')) {
        yield ctx.showText(T('HM03ExplanationText'));
        return;
      }
      yield print(ctx, T('YouHaveWonText'));
      const ok = yield* lib.receiveItem(ctx, 'HM_SURF', 1, { text: T('ReceivedHM03Text'), noRoomText: T('HM03NoRoomText') });
      if (ok) ctx.setFlag('EVENT_GOT_HM03');
    }());
  },
};

// =========================================================================== Route 20 and the Seafoam Islands

const Route20 = {
  trainers: true,
  onEnter(ctx) {
    // CheckAndResetEvent EVENT_IN_SEAFOAM_ISLANDS: the first frame outside the cave
    if (!ctx.getFlag('EVENT_IN_SEAFOAM_ISLANDS')) return undefined;
    ctx.clearFlag('EVENT_IN_SEAFOAM_ISLANDS');
    resetSeafoamBoulders(ctx);
    return undefined;
  },
};

/**
 * Seafoam floors 1F - B2F: a boulder that stopped on a hole plugs it (BIT_PUSHED_BOULDER + CheckBoulderCoords);
 * the holes themselves are the engine's (DEFAULT_HOLES).
 */
const seafoamFloor = (extra = {}) => ({
  onBoulderPushed(ctx, objectIndex, x, y) {
    boulderPushedAt(ctx, x, y);
  },
  ...extra,
});

const SeafoamIslands1F = seafoamFloor({
  onEnter(ctx) {
    ctx.setFlag('EVENT_IN_SEAFOAM_ISLANDS'); // set every frame by the 1F script
    return undefined;
  },
});
const SeafoamIslandsB1F = seafoamFloor();
const SeafoamIslandsB2F = seafoamFloor();

// ----- the strong currents (B3F / B4F)

const SEAFOAMB3F = Object.freeze({ DEFAULT: 0, OBJECT_MOVING1: 1, MOVE_OBJECT: 2, OBJECT_MOVING2: 3 });
const SEAFOAMB4F = Object.freeze({ DEFAULT: 0, OBJECT_MOVING1: 1, MOVE_OBJECT: 2, OBJECT_MOVING2: 3, OBJECT_MOVING3: 4 });
const SEAFOAM_B3F = 'SeafoamIslandsB3F';
const SEAFOAM_B4F = 'SeafoamIslandsB4F';
/** CheckForceBikeOrSurf (ForcedBikeOrSurfMaps): where the holes of B2F / B3F drop the player into the water. */
const B3F_CURRENT_SPOTS = Object.freeze([[18, 7], [19, 7]]);
const B4F_CURRENT_SPOTS = Object.freeze([[4, 14], [5, 14]]);
/** SeafoamIslandsB4FDefaultScript.Coords: the shore below the stairs, where the player is pushed up out of the water. */
const B4F_SHORE_COORDS = Object.freeze([[20, 17], [21, 17], [20, 16], [21, 16]]);
const B3F_CURRENT_START = Object.freeze([[15, 8]]);

/** ForceBikeOrSurf: the player surfs (wWalkBikeSurfState = 2), the sprite and the music follow. */
function forceSurf(ctx, on = true) {
  const ov = ctx.ov;
  if (ov && typeof ov.setMode === 'function') ov.setMode(on ? MODE.SURF : MODE.WALK);
  else ctx.state.surfing = on;
}

/** The single steps of a [direction, count] list. */
const stepsOf = (path) => path.flatMap((s) => (Array.isArray(s) ? Array(s[1]).fill(s[0]) : [s]));

/**
 * The player is carried along `path` by the current (simulated D-pad presses with BIT_FORCED_WARP,
 * so the stairs at the end of it are taken). The walk ends in another map, so the floor's script
 * index is set by name: `during` while the current carries the player, `after` when it is over.
 */
function* carriedBy(ctx, map, path, during, after) {
  lib.setMapScript(ctx, during, map);
  ctx.forceWarp();
  yield* lib.forcedMovement(ctx, path);
  lib.setMapScript(ctx, after, map);
}

const SeafoamIslandsB3F = seafoamFloor({
  onEnter(ctx) {
    // CheckForceBikeOrSurf: dropped into the current at (18, 7) / (19, 7) by a hole of B2F
    if (coordIndex(ctx, B3F_CURRENT_SPOTS)) {
      forceSurf(ctx);
      lib.setMapScript(ctx, SEAFOAMB3F.MOVE_OBJECT);
    }
    return undefined;
  },
  onFrame(ctx) {
    const plugged = bothSet(ctx, 'EVENT_SEAFOAM3_BOULDER1_DOWN_HOLE', 'EVENT_SEAFOAM3_BOULDER2_DOWN_HOLE');
    switch (lib.getMapScript(ctx)) {
      case SEAFOAMB3F.DEFAULT:
        // SeafoamIslandsB3FDefaultScript: without the B2F boulders the current at (15, 8) carries the player to the stairs
        if (plugged || !coordIndex(ctx, B3F_CURRENT_START)) return undefined;
        return carriedBy(ctx, SEAFOAM_B3F, SEAFOAM_CURRENTS.B3F_NEAR_STEPS, SEAFOAMB3F.OBJECT_MOVING1, SEAFOAMB3F.DEFAULT);
      case SEAFOAMB3F.MOVE_OBJECT: {
        // SeafoamIslandsB3FMoveObjectScript
        if (plugged) return undefined;
        const x = ctx.player.x;
        if (x !== 18 && x !== 19) {
          lib.setMapScript(ctx, SEAFOAMB3F.DEFAULT);
          return undefined;
        }
        const path = x === 18 ? SEAFOAM_CURRENTS.B3F_NEAR_LEFT_BOULDER : SEAFOAM_CURRENTS.B3F_NEAR_RIGHT_BOULDER;
        return carriedBy(ctx, SEAFOAM_B3F, path, SEAFOAMB3F.OBJECT_MOVING2, SEAFOAMB3F.DEFAULT);
      }
      case SEAFOAMB3F.OBJECT_MOVING1:
      case SEAFOAMB3F.OBJECT_MOVING2:
        // only after a reload: the walk is over
        lib.setMapScript(ctx, SEAFOAMB3F.DEFAULT);
        return undefined;
      default:
        return undefined;
    }
  },
});

/** SeafoamIslandsB4FDefaultScript: arriving from the stairs of B3F on the shore, pushed up out of the water. */
function* pushedOutOfTheWater(ctx, coordIdx) {
  lib.setMapScript(ctx, SEAFOAMB4F.OBJECT_MOVING1, SEAFOAM_B4F);
  yield* lib.forcedMovement(ctx, coordIdx >= 3 ? ['up'] : ['up', 'up']);
  lib.setMapScript(ctx, SEAFOAMB4F.DEFAULT, SEAFOAM_B4F);
}

/** SeafoamIslandsB4FMoveObjectScript + ObjectMoving2: the current carries the player to the shore, where the surfing stops. */
function* b4fCurrent(ctx, coordIdx) {
  const path = stepsOf(coordIdx === 1 ? SEAFOAM_CURRENTS.B4F_NEAR_LEFT_BOULDER : SEAFOAM_CURRENTS.B4F_NEAR_RIGHT_BOULDER);
  lib.setMapScript(ctx, SEAFOAMB4F.OBJECT_MOVING2, SEAFOAM_B4F);
  yield* lib.forcedMovement(ctx, path.slice(0, -1));
  forceSurf(ctx, false); // .doneForcedSurfMovement: one press left, the player gets off the water
  yield* lib.forcedMovement(ctx, path.slice(-1));
  lib.setMapScript(ctx, SEAFOAMB4F.DEFAULT, SEAFOAM_B4F);
}

const SeafoamIslandsB4F = {
  trainers: true,
  onEnter(ctx) {
    // CheckForceBikeOrSurf: dropped into the current at (4, 14) / (5, 14) by a hole of B3F
    if (coordIndex(ctx, B4F_CURRENT_SPOTS)) {
      forceSurf(ctx);
      lib.setMapScript(ctx, SEAFOAMB4F.MOVE_OBJECT);
    }
    return undefined;
  },
  onFrame(ctx) {
    switch (lib.getMapScript(ctx)) {
      case SEAFOAMB4F.DEFAULT: {
        if (bothSet(ctx, 'EVENT_SEAFOAM3_BOULDER1_DOWN_HOLE', 'EVENT_SEAFOAM3_BOULDER2_DOWN_HOLE')) return undefined;
        const idx = coordIndex(ctx, B4F_SHORE_COORDS);
        return idx ? pushedOutOfTheWater(ctx, idx) : undefined;
      }
      case SEAFOAMB4F.MOVE_OBJECT: {
        if (bothSet(ctx, 'EVENT_SEAFOAM4_BOULDER1_DOWN_HOLE', 'EVENT_SEAFOAM4_BOULDER2_DOWN_HOLE')) {
          lib.setMapScript(ctx, SEAFOAMB4F.DEFAULT);
          return undefined;
        }
        const idx = coordIndex(ctx, B4F_CURRENT_SPOTS);
        if (!idx) {
          lib.setMapScript(ctx, SEAFOAMB4F.DEFAULT);
          return undefined;
        }
        return b4fCurrent(ctx, idx);
      }
      case SEAFOAMB4F.OBJECT_MOVING1:
      case SEAFOAMB4F.OBJECT_MOVING2:
      case SEAFOAMB4F.OBJECT_MOVING3:
        // only after a reload: the walk is over
        lib.setMapScript(ctx, SEAFOAMB4F.DEFAULT);
        return undefined;
      default:
        return undefined;
    }
  },
  onTextAsm(ctx, label) {
    // SeafoamIslandsB4FArticunoBattleText: ARTICUNO's cry, waited for, before the battle
    return label === 'SeafoamIslandsB4FArticunoBattleText' ? cry(ctx, DEX.ARTICUNO) : undefined;
  },
};

export default {
  SaffronGym,
  SaffronPidgeyHouse,
  CopycatsHouse1F,
  CopycatsHouse2F,
  FightingDojo,
  MrPsychicsHouse,
  SilphCo1F,
  SilphCo2F,
  SilphCo3F,
  SilphCo4F,
  SilphCo5F,
  SilphCo6F,
  SilphCo7F,
  SilphCo8F,
  SilphCo9F,
  SilphCo10F,
  SilphCo11F,
  SilphCoElevator,
  FuchsiaCity,
  WardensHouse,
  SafariZoneGate,
  FuchsiaGym,
  FuchsiaGoodRodHouse,
  SafariZoneSecretHouse,
  Route19: { trainers: true },
  Route20,
  SeafoamIslands1F,
  SeafoamIslandsB1F,
  SeafoamIslandsB2F,
  SeafoamIslandsB3F,
  SeafoamIslandsB4F,
};
