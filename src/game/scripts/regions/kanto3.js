// Region kanto3 story scripts: Vermilion City (+ Pokémon Center, Fan Club, Mart, Gym, Pidgey /
// Old Rod / Trade houses, Dock), the S.S. Anne, Routes 9-15 with Rock Tunnel, the Power Plant
// and the route gates (docs/scripting.md). Each entry ports vendor/pokered/scripts/<Map>.asm:
// the w<Map>CurScript state machines keep the asm's indices (SCRIPT_* in the comments),
// per-frame map scripts are onFrame, the map-load callbacks (BIT_CUR_MAP_LOADED_1 / _2) are
// onEnter, text_asm NPCs are onInteract / onSign (their box is managed here, so PrintText vs
// DisplayTextID semantics and wDoNotWaitForButtonPressAfterDisplayingText can be honoured) and
// a text_asm inside a text is onTextAsm. Object indices are 1-based (object_event order), sign
// indices 0-based.
//
// No entry (nothing to port): the Pokémon Centers, VermilionMart, the gates' 1F, S.S. Anne 1F /
// 3F / B1F, Diglett's Cave (DiglettsCaveRoute11's wLastMap = ROUTE_11 is the engine's
// scriptSetsLastMap) and Rock Tunnel's darkness (wMapPalOffset: the engine; FLASH lights it).
// Maps whose asm script is only the trainer table get `{ trainers: true }`; Route 9, Route 15,
// Rock Tunnel 1F and the Power Plant also get markTrainerTexts (kanto3_lib.js: their trainer
// talks are `asm` entries in data/text, so without it A on a trainer or on a Power Plant
// Voltorb / Electrode / Zapdos would do nothing).
//
// Known gaps: the S.S. Anne's smoke puffs at the dock are not drawn, its band slides in whole
// tiles; the Route 15 binoculars' Articuno picture (DisplayMonFrontSpriteInBox) is not shown.

import * as lib from '../lib.js';
import { rivalParty } from '../../../pokemon/trainer.js';
import {
  DEX, PKMN_HEALED_FRAMES, faceAndDelay, print, waitAndClose, coordIndex, stopAndPlay,
  playCry, cry, waitForSound, randByte, secondLockTrashCan, slideBand, markTrainerTexts,
  syncDarkCave, leaveDarkCave,
} from './kanto3_lib.js';

// =========================================================================== VermilionCity

const VERMILIONCITY_GAMBLER1 = 2;
const VERMILIONCITY_SAILOR1 = 3;
const VERMILIONCITY = Object.freeze({
  DEFAULT: 0, PLAYER_MOVING_UP1: 1, PLAYER_EXIT_SHIP: 2, PLAYER_MOVING_UP2: 3, PLAYER_ALLOWED_TO_PASS: 4,
});
/** SSAnneTicketCheckCoords: the tile left of the guard, facing down. */
const SS_ANNE_TICKET_CHECK_COORDS = Object.freeze([[18, 30]]);
/** .inFrontOfOrBehindGuardCoords: above / below the guard (19, 30). */
const GUARD_FRONT_OR_BEHIND_COORDS = Object.freeze([[19, 29], [19, 31]]);

/** VermilionCitySailor1Text: the guard of the S.S. Anne (A button, and the ticket check below). */
function* vermilionSailor1(ctx) {
  if (ctx.getFlag('EVENT_SS_ANNE_LEFT')) {
    yield ctx.showText('VermilionCitySailor1Text.ShipSetSailText');
    return;
  }
  // from his side (facing right) or from in front of / behind him: only the greeting
  if (ctx.player.facing === 'right' || coordIndex(ctx, GUARD_FRONT_OR_BEHIND_COORDS)) {
    yield ctx.showText('VermilionCitySailor1Text.WelcomeToSSAnneText');
    return;
  }
  yield print(ctx, 'VermilionCitySailor1Text.DoYouHaveATicketText');
  if (!lib.hasItem(ctx, 'S_S_TICKET')) {
    yield ctx.showText('VermilionCitySailor1Text.YouNeedATicketText');
    return;
  }
  yield ctx.showText('VermilionCitySailor1Text.FlashedTicketText');
  lib.setMapScript(ctx, VERMILIONCITY.PLAYER_ALLOWED_TO_PASS);
}

/** VermilionCityDefaultScript: the guard speaks to the player standing on the check tile. */
function* vermilionTicketCheck(ctx) {
  yield* vermilionSailor1(ctx); // DisplayTextID TEXT_VERMILIONCITY_SAILOR1
  // a ticket and the ship still here: through; else one step back up (MOVING_UP1)
  if (!ctx.getFlag('EVENT_SS_ANNE_LEFT') && lib.hasItem(ctx, 'S_S_TICKET')) return;
  lib.setMapScript(ctx, VERMILIONCITY.PLAYER_MOVING_UP1);
  yield ctx.movePlayer(['up']);
  yield ctx.wait(10);
  lib.setMapScript(ctx, VERMILIONCITY.DEFAULT);
}

/** VermilionCityPlayerExitShipScript + VermilionCityPlayerMovingUp2Script. */
function* vermilionExitShip(ctx) {
  lib.setMapScript(ctx, VERMILIONCITY.PLAYER_MOVING_UP2);
  yield ctx.movePlayer(['up', 'up']);
  lib.setMapScript(ctx, VERMILIONCITY.DEFAULT);
}

const VermilionCity = {
  onEnter(ctx) {
    // BIT_CUR_MAP_LOADED_2: VermilionCityLeftSSAnneCallbackScript (the first visit after the
    // ship left: walk up out of the dock's way)
    if (ctx.getFlag('EVENT_SS_ANNE_LEFT') && !ctx.getFlag('EVENT_WALKED_PAST_GUARD_AFTER_SS_ANNE_LEFT')) {
      ctx.setFlag('EVENT_WALKED_PAST_GUARD_AFTER_SS_ANNE_LEFT');
      lib.setMapScript(ctx, VERMILIONCITY.PLAYER_EXIT_SHIP);
    }
    // BIT_CUR_MAP_LOADED_1: .setFirstLockTrashCanIndex (the Gym's first lock: an even can).
    // The asm only runs it when the map is loaded through a warp, after a battle or at Continue,
    // not on a connection (Route 6 / 11): onEnter also runs there, which only re-rolls it earlier.
    ctx.state.trashCans.first = randByte(ctx) & 0x0e;
    return undefined;
  },
  onFrame(ctx) {
    switch (lib.getMapScript(ctx)) {
      case VERMILIONCITY.DEFAULT:
        if (ctx.player.facing !== 'down' || !coordIndex(ctx, SS_ANNE_TICKET_CHECK_COORDS)) return undefined;
        return vermilionTicketCheck(ctx);
      case VERMILIONCITY.PLAYER_ALLOWED_TO_PASS:
        // VermilionCityPlayerAllowedToPassScript: the check re-arms once the player left the tile
        if (!coordIndex(ctx, SS_ANNE_TICKET_CHECK_COORDS)) lib.setMapScript(ctx, VERMILIONCITY.DEFAULT);
        return undefined;
      case VERMILIONCITY.PLAYER_EXIT_SHIP:
        return vermilionExitShip(ctx);
      default:
        return undefined;
    }
  },
  onInteract(ctx, i) {
    switch (i) {
      case VERMILIONCITY_GAMBLER1:
        return (function* gambler1() {
          yield ctx.showText(ctx.getFlag('EVENT_SS_ANNE_LEFT')
            ? 'VermilionCityGambler1Text.SSAnneDepartedText' : 'VermilionCityGambler1Text.DidYouSeeText');
        }());
      case VERMILIONCITY_SAILOR1:
        return vermilionSailor1(ctx);
      default:
        return undefined;
    }
  },
  onTextAsm(ctx, label) {
    if (label !== 'VermilionCityMachopText') return undefined;
    // VermilionCityMachopText: the cry, then the text goes on in the same box
    return (function* machop() {
      yield* cry(ctx, DEX.MACHOP);
      yield ctx.showText('VermilionCityMachopText.StompingTheLandFlatText', { open: false });
    }());
  },
};

// =========================================================================== PokemonFanClub

const POKEMONFANCLUB_PIKACHU_FAN = 1;
const POKEMONFANCLUB_SEEL_FAN = 2;
const POKEMONFANCLUB_PIKACHU = 3;
const POKEMONFANCLUB_SEEL = 4;
const POKEMONFANCLUB_CHAIRMAN = 5;

/** PokemonFanClubPikachuFanText / SeelFanText: each boasts after the other one did. */
function* fanClubFan(ctx, { label, ownBoast, otherBoast }) {
  if (ctx.getFlag(ownBoast)) {
    yield print(ctx, `${label}.BetterText`);
    ctx.clearFlag(ownBoast);
  } else {
    yield print(ctx, `${label}.NormalText`);
    ctx.setFlag(otherBoast);
  }
  yield* waitAndClose(ctx);
}

/** PokemonFanClubPikachuText / SeelText: the text, then the cry. */
function* fanClubPokemon(ctx, label, dex) {
  yield print(ctx, label);
  yield* cry(ctx, dex);
  yield* waitAndClose(ctx);
}

/** PokemonFanClubChairmanText: the story, then the BIKE VOUCHER (once). */
function* fanClubChairman(ctx) {
  // PokemonFanClub_CheckBikeInBag: the voucher was given, or a BICYCLE / voucher is in the bag
  if (ctx.getFlag('EVENT_GOT_BIKE_VOUCHER') || lib.hasItem(ctx, 'BICYCLE') || lib.hasItem(ctx, 'BIKE_VOUCHER')) {
    yield ctx.showText('PokemonFanClubChairmanText.FinalText');
    return;
  }
  yield print(ctx, 'PokemonFanClubChairmanText.IntroText');
  const yes = yield ctx.yesNo();
  if (!yes) {
    yield ctx.showText('PokemonFanClubChairmanText.NoStoryText');
    return;
  }
  yield print(ctx, 'PokemonFanClubChairmanText.StoryText');
  const ok = yield* lib.receiveKeyItem(ctx, 'BIKE_VOUCHER', {
    text: 'PokemonFanClubChairmanText.BikeVoucherText', noRoomText: 'PokemonFanClubChairmanText.BagFullText',
  });
  if (ok) ctx.setFlag('EVENT_GOT_BIKE_VOUCHER');
}

const PokemonFanClub = {
  onInteract(ctx, i) {
    switch (i) {
      case POKEMONFANCLUB_PIKACHU_FAN:
        return fanClubFan(ctx, { label: 'PokemonFanClubPikachuFanText', ownBoast: 'EVENT_PIKACHU_FAN_BOAST', otherBoast: 'EVENT_SEEL_FAN_BOAST' });
      case POKEMONFANCLUB_SEEL_FAN:
        return fanClubFan(ctx, { label: 'PokemonFanClubSeelFanText', ownBoast: 'EVENT_SEEL_FAN_BOAST', otherBoast: 'EVENT_PIKACHU_FAN_BOAST' });
      case POKEMONFANCLUB_PIKACHU:
        return fanClubPokemon(ctx, 'PokemonFanClubPikachuText.Text', DEX.PIKACHU);
      case POKEMONFANCLUB_SEEL:
        return fanClubPokemon(ctx, 'PokemonFanClubSeelText.Text', DEX.SEEL);
      case POKEMONFANCLUB_CHAIRMAN:
        return fanClubChairman(ctx);
      default:
        return undefined;
    }
  },
};

// =========================================================================== VermilionGym

const VERMILIONGYM_LT_SURGE = 1;
const VERMILIONGYM_GYM_GUIDE = 5;
const VERMILION_GYM_TRAINER_FLAGS = Object.freeze([0, 1, 2].map((n) => `EVENT_BEAT_VERMILION_GYM_TRAINER_${n}`));
/** VermilionGymSetDoorTile: block (2, 2) is the motorized door: $24 closed, $05 clear floor. */
const GYM_DOOR = Object.freeze({ bx: 2, by: 2, closed: 0x24, open: 0x05 });

/** VermilionGymSetDoorTile (BIT_CUR_MAP_LOADED_2, and the next frame after the 2nd lock opened). */
function vermilionGymSetDoorTile(ctx) {
  if (ctx.getFlag('EVENT_2ND_LOCK_OPENED')) {
    ctx.playSfx('SFX_GO_INSIDE');
    ctx.setBlock(GYM_DOOR.bx, GYM_DOOR.by, GYM_DOOR.open);
  } else {
    ctx.setBlock(GYM_DOOR.bx, GYM_DOOR.by, GYM_DOOR.closed);
  }
}

/**
 * VermilionGymLTSurgeText + VermilionGymLTSurgeAfterBattleScript / ReceiveTM24Script: THUNDERBADGE,
 * TM24, EVENT_BEAT_LT_SURGE / EVENT_GOT_TM24 and the three gym trainers' flags (lib.gymLeader).
 */
function* vermilionSurge(ctx) {
  return yield* lib.gymLeader(ctx, {
    trainerClass: 'LT_SURGE', partyIndex: 1, gymLeaderNo: 3, objectIndex: VERMILIONGYM_LT_SURGE,
    badge: 'THUNDERBADGE', badgeFlag: 'EVENT_BEAT_LT_SURGE',
    tm: 'TM_THUNDERBOLT', tmFlag: 'EVENT_GOT_TM24',
    textBefore: 'VermilionGymLTSurgeText.PreBattleText',
    textWin: 'VermilionGymLTSurgeReceivedThunderBadgeText',
    textBadge: 'VermilionGymLTSurgeThunderBadgeInfoText',
    textTm: 'VermilionGymLTSurgeReceivedTM24Text',
    textNoRoom: 'VermilionGymLTSurgeTM24NoRoomText',
    textAfter: 'VermilionGymLTSurgeText.PostBattleAdviceText',
    trainerFlags: VERMILION_GYM_TRAINER_FLAGS,
  });
}

/**
 * GymTrashScript: the first lock is under a random even can (set when Vermilion City loads),
 * finding it picks the second one (secondLockTrashCan); a wrong can in between resets the first
 * lock to a new random even can. Both locks open the motorized door.
 */
function* vermilionTrashCan(ctx, can) {
  const cans = ctx.state.trashCans;
  if (ctx.getFlag('EVENT_2ND_LOCK_OPENED')) {
    yield ctx.showText('VermilionGymTrashText');
    return;
  }
  if (!ctx.getFlag('EVENT_1ST_LOCK_OPENED')) {
    if (can !== cans.first) {
      yield ctx.showText('VermilionGymTrashText');
      return;
    }
    // .openFirstLock: the next can is the one trying for the second switch
    ctx.setFlag('EVENT_1ST_LOCK_OPENED');
    cans.second = secondLockTrashCan(can, randByte(ctx));
    yield ctx.showText('VermilionGymTrashSuccessText1');
    return;
  }
  // .trySecondLock
  if (can === cans.second) {
    ctx.setFlag('EVENT_2ND_LOCK_OPENED');
    yield ctx.showText('VermilionGymTrashSuccessText3');
    vermilionGymSetDoorTile(ctx); // the map script's BIT_CUR_MAP_LOADED_2 on the next frame
    return;
  }
  // reset the cans
  ctx.clearFlag('EVENT_1ST_LOCK_OPENED');
  cans.first = randByte(ctx) & 0x0e;
  yield ctx.showText('VermilionGymTrashFailText');
}

/** The sound the trash can texts end with (text_asm: WaitForSoundToFinish, PlaySound, wait). */
function* trashCanSound(ctx, sfx) {
  yield* waitForSound(ctx);
  yield* lib.fanfare(ctx, sfx);
}

const VermilionGym = {
  trainers: true,
  onEnter(ctx) {
    vermilionGymSetDoorTile(ctx);
    return undefined;
  },
  onInteract(ctx, i) {
    switch (i) {
      case VERMILIONGYM_LT_SURGE:
        return vermilionSurge(ctx);
      case VERMILIONGYM_GYM_GUIDE:
        // wBeatGymFlags has BIT_THUNDERBADGE exactly when the badge was given
        return (function* guide() {
          yield ctx.showText(lib.hasBadge(ctx, 'THUNDERBADGE')
            ? 'VermilionGymGymGuideText.BeatLTSurgeText' : 'VermilionGymGymGuideText.ChampInMakingText');
        }());
      default:
        return undefined;
    }
  },
  onHiddenObject(ctx, routine, entry) {
    if (routine !== 'GymTrashScript') return undefined;
    return vermilionTrashCan(ctx, Number(entry && (entry.argValue ?? entry.arg)));
  },
  onTextAsm(ctx, label) {
    switch (label) {
      case 'VermilionGymTrashSuccessText1': return trashCanSound(ctx, 'SFX_SWITCH');
      case 'VermilionGymTrashSuccessText3': return trashCanSound(ctx, 'SFX_GO_INSIDE');
      case 'VermilionGymTrashFailText': return trashCanSound(ctx, 'SFX_DENIED');
      default: return undefined;
    }
  },
};

// =========================================================================== Vermilion houses

const VermilionPidgeyHouse = {
  onTextAsm(ctx, label) {
    // VermilionPidgeyHousePidgeyText: the cry, waited for, while the box stays up
    if (label !== 'VermilionPidgeyHousePidgeyText') return undefined;
    return cry(ctx, DEX.PIDGEY);
  },
};

/**
 * The fishing gurus (VermilionOldRodHouse / Route12SuperRodHouse): offer the rod once (YES / NO),
 * the bit of wStatusFlags1 remembers it.
 */
function* fishingGuru(ctx, o) {
  if (lib.statusFlag(ctx, o.bit)) {
    yield ctx.showText(`${o.label}.${o.again}`);
    return;
  }
  yield print(ctx, `${o.label}.DoYouLikeToFishText`);
  const yes = yield ctx.yesNo();
  if (!yes) {
    yield ctx.showText(`${o.label}.${o.refused}`);
    return;
  }
  const ok = yield* lib.receiveItem(ctx, o.rod, 1, { text: `${o.label}.${o.take}`, noRoomText: `${o.label}.NoRoomText` });
  if (ok) lib.setStatusFlag(ctx, o.bit);
}

const VERMILIONOLDRODHOUSE_FISHING_GURU = 1;

const VermilionOldRodHouse = {
  onInteract(ctx, i) {
    if (i !== VERMILIONOLDRODHOUSE_FISHING_GURU) return undefined;
    return fishingGuru(ctx, {
      label: 'VermilionOldRodHouseFishingGuruText', bit: 'BIT_GOT_OLD_ROD', rod: 'OLD_ROD',
      take: 'TakeThisText', refused: 'ThatsSoDisappointingText', again: 'HowAreTheFishBitingText',
    });
  },
};

const VERMILIONTRADEHOUSE_LITTLE_GIRL = 1;

const VermilionTradeHouse = {
  onInteract(ctx, i) {
    if (i !== VERMILIONTRADEHOUSE_LITTLE_GIRL) return undefined;
    return (function* trade() { yield* lib.npcTrade(ctx, 'TRADE_FOR_DUX'); }());
  },
};

// =========================================================================== VermilionDock

/** The warp to the S.S. Anne's 1F (wNumberOfWarps is decremented once the ship left). */
const SS_ANNE_DOCK_WARP = Object.freeze({ x: 14, y: 2 });

/**
 * VermilionDockSSAnneLeavesScript: the music stops, the surfing song plays, the horn blows, the
 * ship's band slides away (8 x 128 frames in the original; whole-tile steps here, see
 * kanto3_lib.js slideBand), the lower hull blocks become water and the horn blows again.
 * The smoke puffs drifting from the funnel are not drawn.
 */
function* shipLeaves(ctx) {
  ctx.setFlag('EVENT_SS_ANNE_LEFT');
  stopAndPlay(ctx, 'MUSIC_SURFING'); // wJoyIgnore = $ff: the engine's script lock does the same
  yield ctx.wait(120);
  ctx.playSfx('SFX_SS_ANNE_HORN'); // PlaySoundWaitForCurrent: waits for the previous sound only
  yield* slideBand(ctx);
  // VermilionDock_EraseSSAnne: the four hull blocks (5..8, 2) turn into water blocks ($0d)
  for (let bx = 5; bx <= 8; bx++) ctx.setBlock(bx, 2, 0x0d);
  ctx.playSfx('SFX_SS_ANNE_HORN');
  yield ctx.wait(120);
}

/** VermilionDock_Script: arriving from the ship with HM01 in the bag. */
function* dockDeparture(ctx) {
  if (!ctx.getFlag('EVENT_SS_ANNE_LEFT')) yield* shipLeaves(ctx);
  // the next frame: walk out of the dock (three steps up, into the exit warp)
  ctx.setFlag('EVENT_STARTED_WALKING_OUT_OF_DOCK');
  yield ctx.wait(3);
  yield ctx.movePlayer([['up', 3]]);
  if (ctx.map === 'VermilionDock') ctx.setFlag('EVENT_WALKED_OUT_OF_DOCK');
}

const VermilionDock = {
  onEnter(ctx) {
    if (ctx.getFlag('EVENT_STARTED_WALKING_OUT_OF_DOCK')) return undefined; // .walking_out_of_dock: done
    if (!ctx.getFlag('EVENT_GOT_HM01')) return undefined;
    // wDestinationWarpID == 1: the player came from the ship (the arrival tile of its warp)
    const p = ctx.player;
    if (p.x !== SS_ANNE_DOCK_WARP.x || p.y !== SS_ANNE_DOCK_WARP.y) return undefined;
    return dockDeparture(ctx);
  },
  onWarpAttempt(ctx, warp) {
    // the ship's warp is gone once it sailed
    if (warp && warp.destMap === 'SS_ANNE_1F' && ctx.getFlag('EVENT_SS_ANNE_LEFT')) return false;
    return undefined;
  },
};

// =========================================================================== SSAnne2F

const SSANNE2F_RIVAL = 2;
const SSANNE2F = Object.freeze({ DEFAULT: 0, RIVAL_START_BATTLE: 1, RIVAL_AFTER_BATTLE: 2, RIVAL_EXIT: 3, NOOP: 4 });
/** SSAnne2FDefaultScript.PlayerCoordinatesArray: the two tiles in front of the captain's corridor. */
const SSANNE2F_RIVAL_COORDS = Object.freeze([[36, 8], [37, 8]]);

/** The rival's walk down to the player: four steps for the second coordinate (x = 37), else three. */
export function ssAnne2FRivalApproach(coordIdx) {
  return coordIdx === 2 ? ['down', 'down', 'down', 'down'] : ['down', 'down', 'down'];
}

/** His walk away: straight down four when the player is at x = 37, else around the player. */
export function ssAnne2FRivalExit(playerX) {
  return playerX === 37 ? ['down', 'down', 'down', 'down'] : ['right', 'down', 'down', 'down', 'down', 'down'];
}

/** The rival's team by his starter (Squirtle 1, Bulbasaur 2); any other value falls through to the Charmander team 3, as in the asm. */
function ssAnne2FRivalParty(ctx) {
  try {
    return rivalParty('SS_ANNE', ctx.state.rivalStarter);
  } catch {
    return { classConst: 'RIVAL2', partyIndex: 3 };
  }
}

/** SSAnne2FSetFacingDirectionScript: face each other (x = 37: the player left, the rival right). */
function* ssAnne2FFace(ctx) {
  if (ctx.player.x === 37) {
    ctx.facePlayer('left');
    yield* faceAndDelay(ctx, SSANNE2F_RIVAL, 'right');
  } else {
    yield* faceAndDelay(ctx, SSANNE2F_RIVAL, 'down');
  }
}

/** The rival on the 2F (SSAnne2FDefaultScript ... SSAnne2FRivalExitScript). */
function* ssAnne2FRivalEncounter(ctx, coordIdx) {
  const S = SSANNE2F;
  // SSAnne2FDefaultScript
  stopAndPlay(ctx, 'MUSIC_MEET_RIVAL');
  ctx.showToggle('TOGGLE_SS_ANNE_2F_RIVAL');
  yield ctx.wait(3);
  lib.setMapScript(ctx, S.RIVAL_START_BATTLE);
  yield ctx.moveNpc(SSANNE2F_RIVAL, ssAnne2FRivalApproach(coordIdx));
  // SSAnne2FRivalStartBattleScript: his text (it sets the end-battle texts), then OPP_RIVAL2
  yield* ssAnne2FFace(ctx);
  yield ctx.showText('SSAnne2FRivalText.Text');
  yield ctx.wait(3);
  const { classConst, partyIndex } = ssAnne2FRivalParty(ctx);
  yield* ssAnne2FFace(ctx);
  lib.setMapScript(ctx, S.RIVAL_AFTER_BATTLE);
  const outcome = yield* lib.scriptedBattle(ctx, {
    kind: 'trainer', trainerClass: classConst, partyIndex, objectIndex: SSANNE2F_RIVAL,
    winText: 'SSAnne2FRivalDefeatedText', loseText: 'SSAnne2FRivalVictoryText',
  });
  if (outcome === 'lose') {
    // SSAnne2FResetScripts; the blackout follows this script
    lib.setMapScript(ctx, S.DEFAULT);
    return;
  }
  // SSAnne2FRivalAfterBattleScript
  yield* ssAnne2FFace(ctx);
  yield ctx.showText('SSAnne2FRivalCutMasterText');
  const exit = ctx.moveNpc(SSANNE2F_RIVAL, ssAnne2FRivalExit(ctx.player.x));
  stopAndPlay(ctx, 'MUSIC_MEET_RIVAL_ALT_START'); // Music_RivalAlternateStart
  lib.setMapScript(ctx, S.RIVAL_EXIT);
  yield exit;
  // SSAnne2FRivalExitScript
  ctx.hideToggle('TOGGLE_SS_ANNE_2F_RIVAL');
  yield* lib.playMapMusic(ctx);
  lib.setMapScript(ctx, S.NOOP);
}

const SSAnne2F = {
  onFrame(ctx) {
    if (lib.getMapScript(ctx) !== SSANNE2F.DEFAULT) return undefined;
    const idx = coordIndex(ctx, SSANNE2F_RIVAL_COORDS);
    return idx ? ssAnne2FRivalEncounter(ctx, idx) : undefined;
  },
};

// =========================================================================== SSAnneKitchen

const SSANNEKITCHEN_COOK7 = 7;

const SSAnneKitchen = {
  onInteract(ctx, i) {
    if (i !== SSANNEKITCHEN_COOK7) return undefined;
    return (function* cook7() {
      yield print(ctx, 'SSAnneKitchenCook7Text.MainCourseIsText');
      // hRandomAdd: bit 7 salmon, else bit 4 eels, else the steak
      const r = randByte(ctx);
      yield ctx.showText(r & 0x80 ? 'SSAnneKitchenCook7Text.SalmonDuSaladText'
        : r & 0x10 ? 'SSAnneKitchenCook7Text.EelsAuBarbecueText' : 'SSAnneKitchenCook7Text.PrimeBeefSteakText');
    }());
  },
};

// =========================================================================== SSAnneCaptainsRoom

const SSANNECAPTAINSROOM_CAPTAIN = 1;
/** GameState.scriptVars: free-form persistent script variables (here: how the captain faces). */
const scriptVars = (ctx) => ctx.state.scriptVars || (ctx.state.scriptVars = {});

/** SSAnneCaptainsRoomCaptainText: rub his back (the jingle), HM01 CUT, later he is well again. */
function* ssAnneCaptain(ctx) {
  // BIT_NO_NPC_FACE_PLAYER: the seasick captain keeps facing the wall until his back was rubbed
  // (and after a full bag): the engine turned him towards the player on this A press already
  const keepFacing = !ctx.getFlag('EVENT_RUBBED_CAPTAINS_BACK') || lib.statusFlag(ctx, 'BIT_NO_NPC_FACE_PLAYER');
  if (keepFacing) ctx.faceNpc(SSANNECAPTAINSROOM_CAPTAIN, scriptVars(ctx).captainFacing || 'up');
  if (ctx.getFlag('EVENT_GOT_HM01')) {
    yield ctx.showText('SSAnneCaptainsRoomCaptainNotSickAnymoreText');
    return;
  }
  yield print(ctx, 'SSAnneCaptainsRoomRubCaptainsBackText'); // its text_asm: onTextAsm below
  yield print(ctx, 'SSAnneCaptainsRoomCaptainIFeelMuchBetterText');
  const ok = yield* lib.receiveItem(ctx, 'HM_CUT', 1, {
    text: 'SSAnneCaptainsRoomCaptainReceivedHM01Text', noRoomText: 'SSAnneCaptainsRoomCaptainHM01NoRoomText',
  });
  if (ok) {
    ctx.setFlag('EVENT_GOT_HM01');
    return;
  }
  // .bag_full: he stops turning to the player again
  scriptVars(ctx).captainFacing = ctx.npc(SSANNECAPTAINSROOM_CAPTAIN).facing;
  lib.setStatusFlag(ctx, 'BIT_NO_NPC_FACE_PLAYER');
}

/** SSAnneCaptainsRoomRubCaptainsBackText's text_asm: the PKMN HEALED jingle, then the map song. */
function* rubCaptainsBack(ctx) {
  ctx.playMusic('MUSIC_PKMN_HEALED');
  yield ctx.wait(PKMN_HEALED_FRAMES);
  yield* lib.playMapMusic(ctx);
  ctx.setFlag('EVENT_RUBBED_CAPTAINS_BACK');
  lib.setStatusFlag(ctx, 'BIT_NO_NPC_FACE_PLAYER', false);
  ctx.npcFacePlayer(SSANNECAPTAINSROOM_CAPTAIN); // the next PrintText's UpdateSprites turns him
}

const SSAnneCaptainsRoom = {
  onEnter(ctx) {
    // EnterMap: res BIT_NO_NPC_FACE_PLAYER
    lib.setStatusFlag(ctx, 'BIT_NO_NPC_FACE_PLAYER', false);
    delete scriptVars(ctx).captainFacing;
    return undefined;
  },
  onInteract(ctx, i) {
    return i === SSANNECAPTAINSROOM_CAPTAIN ? ssAnneCaptain(ctx) : undefined;
  },
  onTextAsm(ctx, label) {
    return label === 'SSAnneCaptainsRoomRubCaptainsBackText' ? rubCaptainsBack(ctx) : undefined;
  },
};

// =========================================================================== SSAnne 1F / 2F / B1F rooms

const SSAnne1FRooms = {
  trainers: true,
  onTextAsm(ctx, label) {
    // SSAnne1FRoomsWigglytuffText: PlayCry, not waited for
    if (label !== 'SSAnne1FRoomsWigglytuffText') return undefined;
    playCry(ctx, DEX.WIGGLYTUFF);
    return true;
  },
};

const SSANNE2FROOMS_GENTLEMAN3 = 5;

const SSAnne2FRooms = {
  trainers: true,
  onInteract(ctx, i) {
    if (i !== SSANNE2FROOMS_GENTLEMAN3) return undefined;
    // SSAnne2FRoomsGentleman3Text: the text, the box goes away, SNORLAX's Pokédex page
    return (function* snorlaxGentleman() {
      yield print(ctx, 'SSAnne2FRoomsGentleman3Text.Text');
      ctx.closeText();
      yield* lib.pokedexPage(ctx, 'SNORLAX');
    }());
  },
};

const SSAnneB1FRooms = {
  trainers: true,
  onTextAsm(ctx, label) {
    // SSAnneB1FRoomsMachokeText: PlayCry, not waited for
    if (label !== 'SSAnneB1FRoomsMachokeText') return undefined;
    playCry(ctx, DEX.MACHOKE);
    return true;
  },
};

// =========================================================================== Route 11 and its gate

const ROUTE11GATE2F_YOUNGSTER = 1;
const ROUTE11GATE2F_OAKS_AIDE = 2;
const ROUTE11GATE2F_LEFT_BINOCULARS = 0;
const ROUTE11GATE2F_RIGHT_BINOCULARS = 1;

/**
 * OaksAideScript in a gate (Route 11 / Route 15): a missing item asks YES / NO and the Pokédex
 * count; the item once, then the explanation every time.
 */
function* oaksAideGate(ctx, { event, requirement, item, explanation }) {
  if (!ctx.getFlag(event)) {
    const r = yield* lib.oaksAide(ctx, { requirement, item });
    if (r !== lib.OAKS_AIDE.GOT_ITEM) {
      yield* waitAndClose(ctx); // the aide's last text stays up until A / B
      return;
    }
    ctx.setFlag(event);
  }
  yield ctx.showText(explanation);
}

/** GateUpstairsScript_PrintIfFacingUp: a binocular only answers when the player faces up. */
const binocularsNeedFacingUp = (ctx) => (ctx.player.facing === 'up' ? undefined : true);

const Route11Gate2F = {
  onInteract(ctx, i) {
    switch (i) {
      case ROUTE11GATE2F_YOUNGSTER:
        return (function* trade() { yield* lib.npcTrade(ctx, 'TRADE_FOR_TERRY'); }());
      case ROUTE11GATE2F_OAKS_AIDE:
        return oaksAideGate(ctx, {
          event: 'EVENT_GOT_ITEMFINDER', requirement: 30, item: 'ITEMFINDER',
          explanation: 'Route11Gate2FOaksAideText.ItemfinderDescriptionText',
        });
      default:
        return undefined;
    }
  },
  onSign(ctx, i) {
    if (i === ROUTE11GATE2F_LEFT_BINOCULARS) {
      if (ctx.player.facing !== 'up') return true;
      return (function* leftBinoculars() {
        yield ctx.showText(ctx.getFlag('EVENT_BEAT_ROUTE12_SNORLAX')
          ? 'Route11Gate2FLeftBinocularsText.NoSnorlaxText' : 'Route11Gate2FLeftBinocularsText.SnorlaxText');
      }());
    }
    return i === ROUTE11GATE2F_RIGHT_BINOCULARS ? binocularsNeedFacingUp(ctx) : undefined;
  },
};

// =========================================================================== Route 12

const ROUTE12 = Object.freeze({ DEFAULT: 0, START_BATTLE: 1, END_BATTLE: 2, SNORLAX_POST_BATTLE: 3 });

/**
 * Route12DefaultScript + Route12SnorlaxPostBattleScript: the POKé FLUTE woke SNORLAX (the
 * flute's request set EVENT_FIGHT_ROUTE12_SNORLAX, see hooks.lastPokeFlute): its text, it
 * disappears from the map, the wild battle (level 30, the usual wild battle music). A loss
 * resets the script and the blackout follows; HideObject already ran, so as in the asm the road
 * stays open although EVENT_BEAT_ROUTE12_SNORLAX is not set. A win, a catch or running away set
 * EVENT_BEAT_ROUTE12_SNORLAX, with "calmed down" unless it was caught / escaped from
 * (wBattleResult == 2).
 */
function* route12Snorlax(ctx) {
  yield ctx.showText('Route12SnorlaxWokeUpText');
  ctx.hideToggle('TOGGLE_ROUTE_12_SNORLAX');
  lib.setMapScript(ctx, ROUTE12.SNORLAX_POST_BATTLE);
  const outcome = yield* lib.scriptedBattle(ctx, { kind: 'wild', species: DEX.SNORLAX, level: 30 });
  if (outcome === 'lose') {
    lib.setMapScript(ctx, ROUTE12.DEFAULT); // Route12ResetScripts
    return;
  }
  if (outcome !== 'caught' && outcome !== 'ran') yield ctx.showText('Route12SnorlaxCalmedDownText');
  ctx.setFlag('EVENT_BEAT_ROUTE12_SNORLAX');
  yield ctx.wait(3);
  lib.setMapScript(ctx, ROUTE12.DEFAULT);
}

const Route12 = {
  trainers: true,
  onFrame(ctx) {
    if (lib.getMapScript(ctx) !== ROUTE12.DEFAULT) return undefined;
    if (ctx.getFlag('EVENT_BEAT_ROUTE12_SNORLAX') || !ctx.getFlag('EVENT_FIGHT_ROUTE12_SNORLAX')) return undefined;
    ctx.clearFlag('EVENT_FIGHT_ROUTE12_SNORLAX');
    return route12Snorlax(ctx);
  },
};

const ROUTE12GATE2F_BRUNETTE_GIRL = 1;

const Route12Gate2F = {
  onInteract(ctx, i) {
    if (i !== ROUTE12GATE2F_BRUNETTE_GIRL) return undefined;
    // Route12Gate2FBrunetteGirlText: TM39 (SWIFT), once
    return (function* tm39() {
      if (ctx.getFlag('EVENT_GOT_TM39')) {
        yield ctx.showText('Route12Gate2FBrunetteGirlText.TM39ExplanationText');
        return;
      }
      yield print(ctx, 'Route12Gate2FBrunetteGirlText.YouCanHaveThisText');
      const ok = yield* lib.receiveItem(ctx, 'TM_SWIFT', 1, {
        text: 'Route12Gate2FBrunetteGirlText.ReceivedTM39Text', noRoomText: 'Route12Gate2FBrunetteGirlText.TM39NoRoomText',
      });
      if (ok) ctx.setFlag('EVENT_GOT_TM39');
    }());
  },
  onSign(ctx) {
    return binocularsNeedFacingUp(ctx); // both binoculars
  },
};

const ROUTE12SUPERRODHOUSE_FISHING_GURU = 1;

const Route12SuperRodHouse = {
  onInteract(ctx, i) {
    if (i !== ROUTE12SUPERRODHOUSE_FISHING_GURU) return undefined;
    return fishingGuru(ctx, {
      label: 'Route12SuperRodHouseFishingGuruText', bit: 'BIT_GOT_SUPER_ROD', rod: 'SUPER_ROD',
      take: 'ReceivedSuperRodText', refused: 'ThatsDisappointingText', again: 'TryFishingText',
    });
  },
};

// =========================================================================== Route 15 gate

const ROUTE15GATE2F_OAKS_AIDE = 1;

const Route15Gate2F = {
  onInteract(ctx, i) {
    if (i !== ROUTE15GATE2F_OAKS_AIDE) return undefined;
    return oaksAideGate(ctx, {
      event: 'EVENT_GOT_EXP_ALL', requirement: 50, item: 'EXP_ALL',
      explanation: 'Route15Gate2FOaksAideText.ExpAllText',
    });
  },
  onSign(ctx) {
    return binocularsNeedFacingUp(ctx); // the right binoculars
  },
  onHiddenObject(ctx, routine) {
    if (routine !== 'Route15GateLeftBinoculars') return undefined;
    if (ctx.player.facing !== 'up') return true;
    // the text, then ARTICUNO's cry; DisplayMonFrontSpriteInBox (the pop-up picture) is not drawn
    return (function* leftBinoculars() {
      yield ctx.showText('Route15UpstairsBinocularsText');
      yield* cry(ctx, DEX.ARTICUNO);
    }());
  },
};

// =========================================================================== trainer-only maps

const PowerPlant = {
  trainers: true,
  onEnter(ctx) {
    markTrainerTexts(ctx); // the Voltorb / Electrode / Zapdos battles are talks (sight range 0)
    return undefined;
  },
  onTextAsm(ctx, label) {
    // PowerPlantZapdosBattleText: ZAPDOS' cry, waited for, before the battle
    return label === 'PowerPlantZapdosBattleText' ? cry(ctx, DEX.ZAPDOS) : undefined;
  },
};

/** Route9 / Route15 / RockTunnel1F: the trainer table, with the talks the extractor missed. */
const trainersWithTalks = {
  trainers: true,
  onEnter(ctx) {
    markTrainerTexts(ctx);
    return undefined;
  },
};

/**
 * Rock Tunnel: the darkness is the engine's (wMapPalOffset = 6 when the cave is entered from
 * outside, FLASH sets it back to 0); the scripts only keep the saved copy in the state in step
 * (kanto3_lib.js syncDarkCave) so a Continue inside the cave is dark again.
 */
const rockTunnelFloor = (talks) => ({
  trainers: true,
  onEnter(ctx) {
    if (talks) markTrainerTexts(ctx);
    syncDarkCave(ctx);
    return undefined;
  },
  onWarpAttempt(ctx, warp) {
    leaveDarkCave(ctx, warp);
    return undefined;
  },
});

export default {
  VermilionCity,
  PokemonFanClub,
  VermilionGym,
  VermilionPidgeyHouse,
  VermilionDock,
  VermilionOldRodHouse,
  VermilionTradeHouse,
  SSAnne2F,
  SSAnneBow: { trainers: true },
  SSAnneKitchen,
  SSAnneCaptainsRoom,
  SSAnne1FRooms,
  SSAnne2FRooms,
  SSAnneB1FRooms,
  Route9: { ...trainersWithTalks },
  Route10: { trainers: true },
  Route11: { trainers: true },
  Route11Gate2F,
  Route12,
  Route12Gate2F,
  Route12SuperRodHouse,
  Route13: { trainers: true },
  Route14: { trainers: true },
  Route15: { ...trainersWithTalks },
  Route15Gate2F,
  RockTunnel1F: rockTunnelFloor(true),
  RockTunnelB1F: rockTunnelFloor(false),
  PowerPlant,
};
