// Region kanto1 story scripts: Pallet Town, Route 1, Viridian City, Routes 2 / 21 / 22 and
// Viridian Forest (docs/scripting.md). Each entry ports vendor/pokered/scripts/<Map>.asm:
// the w<Map>CurScript state machine keeps the asm's indices (SCRIPT_* in the comments),
// per-frame map scripts are onFrame, text_asm NPCs are onInteract / onSign (their text box
// is managed here, so wDoNotWaitForButtonPressAfterDisplayingText can be honoured).
// Object indices are 1-based (object_event order), sign indices 0-based.

import * as lib from '../lib.js';
import { getGameData } from '../../../pokemon/data.js';
import { rivalParty, RIVAL_STARTER_FOR } from '../../../pokemon/trainer.js';
import { faceAndDelay, waitAndClose, print, coordIndex, stopAndPlay, cry } from './kanto1_lib.js';

const DEX = Object.freeze({ BULBASAUR: 1, CHARMANDER: 4, SQUIRTLE: 7, WEEDLE: 13, SPEAROW: 21 });

const speciesConst = (dex) => {
  const sp = getGameData().findSpecies(dex);
  return sp ? sp.const : null;
};

// =========================================================================== PalletTown

const PALLETTOWN_OAK = 1;
const PALLET = Object.freeze({
  DEFAULT: 0, OAK_HEY_WAIT: 1, OAK_WALKS_TO_PLAYER: 2, OAK_NOT_SAFE_COME_WITH_ME: 3,
  PLAYER_FOLLOWS_OAK: 4, DAISY: 5, NOOP: 6,
});

/** SCRIPT_PALLETTOWN_DEFAULT ... PLAYER_FOLLOWS_OAK + PalletMovementScript (auto_movement.asm). */
function* palletOakCutscene(ctx) {
  const p = ctx.player;
  // PalletTownDefaultScript
  ctx.facePlayer('down');
  stopAndPlay(ctx, 'MUSIC_MEET_PROF_OAK');
  ctx.setFlag('EVENT_OAK_APPEARED_IN_PALLET');
  lib.setMapScript(ctx, PALLET.OAK_HEY_WAIT);
  // PalletTownOakHeyWaitScript: PalletTownOakText with wOakWalkedToPlayer = 0
  // (wDoNotWaitForButtonPressAfterDisplayingText: the box closes without a button press)
  yield print(ctx, '_PalletTownOakHeyWaitDontGoOutText');
  yield ctx.wait(10);
  yield ctx.emote(0, 'shock');
  ctx.facePlayer('down');
  ctx.closeText();
  ctx.showToggle('TOGGLE_PALLET_TOWN_OAK');
  lib.setMapScript(ctx, PALLET.OAK_WALKS_TO_PLAYER);
  // PalletTownOakWalksToPlayerScript: Oak faces up, then FindPathToPlayer to the cell below
  yield* faceAndDelay(ctx, PALLETTOWN_OAK, 'up');
  yield ctx.wait(3);
  const oak = ctx.npc(PALLETTOWN_OAK);
  yield ctx.moveNpc(PALLETTOWN_OAK, ctx.pathTo(oak.x, oak.y, p.x, p.y + 1));
  lib.setMapScript(ctx, PALLET.OAK_NOT_SAFE_COME_WITH_ME);
  // PalletTownOakNotSafeComeWithMeScript (wOakWalkedToPlayer = TRUE)
  ctx.facePlayer('down');
  yield ctx.showText('PalletTownOakText.ItsUnsafeText');
  lib.setMapScript(ctx, PALLET.PLAYER_FOLLOWS_OAK);
  // PalletMovementScript_OakMoveLeft: the map music stays off until the lab says so
  lib.setStatusFlag(ctx, 'BIT_NO_MAP_MUSIC');
  if (p.x === 11) {
    // the player is on the right tile of the path: Oak steps left, then the player
    yield ctx.moveNpc(PALLETTOWN_OAK, ['left']);
    yield ctx.movePlayer(['left']);
  }
  // PalletMovementScript_WalkToLab: RLEList_ProfOakWalkToLab (in sync) / RLEList_PlayerWalkToLab
  const oakWalk = ctx.moveNpc(PALLETTOWN_OAK, [['down', 5], ['left', 1], ['down', 5], ['right', 3], ['up', 1]], { sync: true });
  yield ctx.movePlayer([['down', 6], ['left', 1], ['down', 5], ['right', 3], ['up', 2]]);
  yield oakWalk;
  // PalletMovementScript_Done
  ctx.hideToggle('TOGGLE_PALLET_TOWN_OAK');
}

const PalletTown = {
  onFrame(ctx) {
    if (ctx.getFlag('EVENT_GOT_POKEBALLS_FROM_OAK')) ctx.setFlag('EVENT_PALLET_AFTER_GETTING_POKEBALLS');
    switch (lib.getMapScript(ctx)) {
      case PALLET.DEFAULT:
        if (ctx.getFlag('EVENT_FOLLOWED_OAK_INTO_LAB')) return undefined;
        if (ctx.player.y !== 1) return undefined;
        return palletOakCutscene(ctx);
      case PALLET.PLAYER_FOLLOWS_OAK:
        // PalletTownPlayerFollowsOakScript: the movement script is over
        lib.setMapScript(ctx, PALLET.DAISY);
        return undefined;
      case PALLET.DAISY:
        // PalletTownDaisyScript
        if (!ctx.getFlag('EVENT_DAISY_WALKING') && ctx.getFlag('EVENT_GOT_TOWN_MAP') && ctx.getFlag('EVENT_ENTERED_BLUES_HOUSE')) {
          ctx.setFlag('EVENT_DAISY_WALKING');
          ctx.hideToggle('TOGGLE_DAISY_SITTING');
          ctx.showToggle('TOGGLE_DAISY_WALKING');
          return undefined;
        }
        if (ctx.getFlag('EVENT_GOT_POKEBALLS_FROM_OAK')) ctx.setFlag('EVENT_PALLET_AFTER_GETTING_POKEBALLS_2');
        return undefined;
      default:
        return undefined;
    }
  },
};

// =========================================================================== RedsHouse1F

const REDSHOUSE1F_MOM = 1;
const REDSHOUSE1F_TV_SIGN = 0;
/** MUSIC_PKMN_HEALED plays to its end (RedsHouse1FMomHealScript waits for wChannelSoundIDs). */
const PKMN_HEALED_FRAMES = 140;

const RedsHouse1F = {
  onInteract(ctx, i) {
    if (i !== REDSHOUSE1F_MOM) return undefined;
    return (function* momText() {
      if (!lib.statusFlag(ctx, 'BIT_GOT_STARTER')) {
        yield ctx.showText('RedsHouse1FMomText.WakeUpText');
        return;
      }
      // RedsHouse1FMomHealScript
      yield print(ctx, 'RedsHouse1FMomYouShouldRestText');
      yield ctx.fadeOut('white');
      yield* lib.healParty(ctx);
      ctx.playMusic('MUSIC_PKMN_HEALED');
      yield ctx.wait(PKMN_HEALED_FRAMES);
      yield* lib.playMapMusic(ctx);
      yield ctx.fadeIn('white');
      yield ctx.showText('RedsHouse1FMomLookingGreatText');
    }());
  },
  onSign(ctx, i) {
    if (i !== REDSHOUSE1F_TV_SIGN) return undefined;
    // RedsHouse1FTVText: the movie only from the front
    return (function* tv() {
      yield ctx.showText(ctx.player.facing === 'up' ? 'RedsHouse1FTVText.StandByMeMovieText' : 'RedsHouse1FTVText.WrongSideText');
    }());
  },
};

// =========================================================================== RedsHouse2F

const RedsHouse2F = {
  onFrame(ctx) {
    // RedsHouse2FDefaultScript: hJoyHeld = 0, wPlayerMovingDirection = UP, then NOOP
    if (lib.getMapScript(ctx) !== 0) return undefined;
    ctx.facePlayer('up');
    lib.setMapScript(ctx, 1);
    return undefined;
  },
};

// =========================================================================== BluesHouse

const BLUESHOUSE_DAISY1 = 1;

const BluesHouse = {
  onFrame(ctx) {
    // BluesHouseDefaultScript
    if (lib.getMapScript(ctx) !== 0) return undefined;
    ctx.setFlag('EVENT_ENTERED_BLUES_HOUSE');
    lib.setMapScript(ctx, 1);
    return undefined;
  },
  onInteract(ctx, i) {
    if (i !== BLUESHOUSE_DAISY1) return undefined;
    return (function* daisySitting() {
      if (ctx.getFlag('EVENT_GOT_TOWN_MAP')) {
        yield ctx.showText('BluesHouseDaisyUseMapText');
        return;
      }
      if (!ctx.getFlag('EVENT_GOT_POKEDEX')) {
        yield ctx.showText('BluesHouseDaisyRivalAtLabText');
        return;
      }
      yield print(ctx, 'BluesHouseDaisyOfferMapText');
      if (!ctx.giveItem('TOWN_MAP', 1)) {
        yield ctx.showText('BluesHouseDaisyBagFullText');
        return;
      }
      ctx.hideToggle('TOGGLE_TOWN_MAP');
      yield ctx.showText('GotMapText', { subs: { wStringBuffer: lib.itemName('TOWN_MAP') } });
      ctx.setFlag('EVENT_GOT_TOWN_MAP');
    }());
  },
};

// =========================================================================== OaksLab

// object_const_def order of data/maps/objects/OaksLab.asm
const OAKSLAB_RIVAL = 1;
const OAKSLAB_CHARMANDER_POKE_BALL = 2;
const OAKSLAB_SQUIRTLE_POKE_BALL = 3;
const OAKSLAB_BULBASAUR_POKE_BALL = 4;
const OAKSLAB_OAK1 = 5;
const OAKSLAB_OAK2 = 8;

const LAB = Object.freeze({
  DEFAULT: 0, OAK_ENTERS_LAB: 1, TOGGLE_OAKS: 2, PLAYER_ENTERS_LAB: 3, FOLLOWED_OAK: 4,
  OAK_CHOOSE_MON_SPEECH: 5, PLAYER_DONT_GO_AWAY: 6, PLAYER_FORCED_TO_WALK_BACK: 7, CHOSE_STARTER: 8,
  RIVAL_CHOOSES_STARTER: 9, RIVAL_CHALLENGES_PLAYER: 10, RIVAL_START_BATTLE: 11, RIVAL_END_BATTLE: 12,
  RIVAL_STARTS_EXIT: 13, PLAYER_WATCH_RIVAL_EXIT: 14, RIVAL_ARRIVES_AT_OAKS_REQUEST: 15,
  OAK_GIVES_POKEDEX: 16, RIVAL_LEAVES_WITH_POKEDEX: 17, NOOP: 18,
});

/** The three balls: the player's starter, the ball the rival takes, the toggles. */
const LAB_BALLS = Object.freeze({
  [OAKSLAB_CHARMANDER_POKE_BALL]: { starter: DEX.CHARMANDER, toggle: 'TOGGLE_STARTER_BALL_1', youWant: 'OaksLabYouWantCharmanderText.Text' },
  [OAKSLAB_SQUIRTLE_POKE_BALL]: { starter: DEX.SQUIRTLE, toggle: 'TOGGLE_STARTER_BALL_2', youWant: 'OaksLabYouWantSquirtleText.Text' },
  [OAKSLAB_BULBASAUR_POKE_BALL]: { starter: DEX.BULBASAUR, toggle: 'TOGGLE_STARTER_BALL_3', youWant: 'OaksLabYouWantBulbasaurText.Text' },
});
const BALL_TOGGLE_OF_STARTER = Object.freeze({
  [DEX.CHARMANDER]: 'TOGGLE_STARTER_BALL_1', [DEX.SQUIRTLE]: 'TOGGLE_STARTER_BALL_2', [DEX.BULBASAUR]: 'TOGGLE_STARTER_BALL_3',
});

/** The rival's starter (wRivalStarterTemp) for the player's: the one strong against it. */
export function labRivalStarter(playerStarter) {
  const c = speciesConst(playerStarter);
  const r = RIVAL_STARTER_FOR[c];
  return r ? getGameData().species(r).dex : null;
}

/**
 * OaksLabChoseStarterScript: the rival's walk to the ball that is left for him (the
 * player stands below the table at y = 4, or right of it at x = 9 for Bulbasaur).
 * @returns {{path: string[], place: [number, number]|null}}
 */
export function labRivalBallPath(playerStarter, player) {
  const below = player.y === 4;
  if (playerStarter === DEX.CHARMANDER) {
    return { path: below ? ['down', 'down', 'right', 'right', 'right', 'up'] : ['down', 'right', 'right', 'right'], place: null };
  }
  if (playerStarter === DEX.SQUIRTLE) {
    return { path: below ? ['down', 'down', 'right', 'right', 'right', 'right', 'up'] : ['down', 'right', 'right', 'right', 'right'], place: null };
  }
  // Bulbasaur: from the right of the table the rival is off screen and gets moved first
  if (player.x === 9) return { path: ['right'], place: [5, 4] };
  return { path: ['down', 'right', 'right'], place: null };
}

/** OaksLabCalcRivalMovementScript: where the rival enters for the Pokédex scene. */
export function labRivalEntry(player) {
  if (player.y === 3) return { x: 4, y: 7, steps: 4 };
  if (player.y === 1) return { x: 4, y: 5, steps: 2 };
  return { x: 4, y: 6, steps: 3 };
}

/** SCRIPT_OAKSLAB_DEFAULT ... OAK_CHOOSE_MON_SPEECH: Oak and the player enter the lab. */
function* labIntro(ctx) {
  // OaksLabDefaultScript
  ctx.showToggle('TOGGLE_OAKS_LAB_OAK_2');
  lib.setStatusFlag(ctx, 'BIT_NO_BATTLES', false);
  lib.setMapScript(ctx, LAB.OAK_ENTERS_LAB);
  // OaksLabOakEntersLabScript
  yield ctx.moveNpc(OAKSLAB_OAK2, ['up', 'up', 'up']);
  lib.setMapScript(ctx, LAB.TOGGLE_OAKS);
  // OaksLabToggleOaksScript
  ctx.hideToggle('TOGGLE_OAKS_LAB_OAK_2');
  ctx.showToggle('TOGGLE_OAKS_LAB_OAK_1');
  lib.setMapScript(ctx, LAB.PLAYER_ENTERS_LAB);
  // OaksLabPlayerEntersLabScript: PlayerEntryMovementRLE (UP x8) while the two turn down
  yield ctx.wait(3);
  const walk = ctx.movePlayer([['up', 8]]);
  yield* faceAndDelay(ctx, OAKSLAB_RIVAL, 'down');
  yield* faceAndDelay(ctx, OAKSLAB_OAK1, 'down');
  lib.setMapScript(ctx, LAB.FOLLOWED_OAK);
  yield walk;
  // OaksLabFollowedOakScript
  ctx.setFlag('EVENT_FOLLOWED_OAK_INTO_LAB');
  ctx.setFlag('EVENT_FOLLOWED_OAK_INTO_LAB_2');
  yield* faceAndDelay(ctx, OAKSLAB_RIVAL, 'up');
  lib.setStatusFlag(ctx, 'BIT_NO_MAP_MUSIC', false);
  yield* lib.playMapMusic(ctx);
  lib.setMapScript(ctx, LAB.OAK_CHOOSE_MON_SPEECH);
  // OaksLabOakChooseMonSpeechScript
  yield ctx.showText('OaksLabRivalFedUpWithWaitingText.Text');
  yield ctx.wait(3);
  yield ctx.showText('OaksLabOakChooseMonText.Text');
  yield ctx.wait(3);
  yield ctx.showText('OaksLabRivalWhatAboutMeText.Text');
  yield ctx.wait(3);
  yield ctx.showText('OaksLabOakBePatientText.Text');
  ctx.setFlag('EVENT_OAK_ASKED_TO_CHOOSE_MON');
  lib.setMapScript(ctx, LAB.PLAYER_DONT_GO_AWAY);
}

/** OaksLabPlayerDontGoAwayScript + OaksLabPlayerForcedToWalkBackScript. */
function* labDontGoAway(ctx) {
  yield* faceAndDelay(ctx, OAKSLAB_OAK1, 'down');
  yield* faceAndDelay(ctx, OAKSLAB_RIVAL, 'down');
  yield ctx.showText('OaksLabOakDontGoAwayYetText.Text');
  lib.setMapScript(ctx, LAB.PLAYER_FORCED_TO_WALK_BACK);
  yield ctx.movePlayer(['up']);
  ctx.facePlayer('up');
  yield ctx.wait(3);
  lib.setMapScript(ctx, LAB.PLAYER_DONT_GO_AWAY);
}

/** OaksLabChoseStarterScript + OaksLabRivalChoosesStarterScript. */
function* labRivalTakesBall(ctx) {
  const st = ctx.state;
  const rival = labRivalStarter(st.starterChoice);
  const { path, place } = labRivalBallPath(st.starterChoice, ctx.player);
  if (place) ctx.placeObject(OAKSLAB_RIVAL, place[0], place[1]);
  lib.setMapScript(ctx, LAB.RIVAL_CHOOSES_STARTER);
  yield ctx.moveNpc(OAKSLAB_RIVAL, path);
  // OaksLabRivalChoosesStarterScript
  yield* faceAndDelay(ctx, OAKSLAB_RIVAL, 'up');
  yield ctx.showText('OaksLabRivalIllTakeThisOneText.Text');
  ctx.hideToggle(BALL_TOGGLE_OF_STARTER[rival]);
  yield ctx.wait(3);
  st.rivalStarter = rival;
  yield* faceAndDelay(ctx, OAKSLAB_RIVAL, 'up');
  yield ctx.showText('OaksLabRivalReceivedMonText.Text', { subs: { wNameBuffer: lib.speciesName(rival) } });
  ctx.setFlag('EVENT_GOT_STARTER');
  lib.setMapScript(ctx, LAB.RIVAL_CHALLENGES_PLAYER);
}

/** OaksLabRivalChallengesPlayerScript ... OaksLabPlayerWatchRivalExitScript. */
function* labRivalBattle(ctx) {
  const st = ctx.state;
  yield* faceAndDelay(ctx, OAKSLAB_RIVAL, 'down');
  ctx.facePlayer('up');
  ctx.playMusic('MUSIC_MEET_RIVAL');
  yield ctx.showText('OaksLabRivalIllTakeYouOnText.Text');
  // FindPathToPlayer with hNPCPlayerYDistance - 1: the rival stops right above the player
  const r = ctx.npc(OAKSLAB_RIVAL);
  const p = ctx.player;
  lib.setMapScript(ctx, LAB.RIVAL_START_BATTLE);
  yield ctx.moveNpc(OAKSLAB_RIVAL, ctx.pathTo(r.x, r.y, p.x, p.y - 1));
  // OaksLabRivalStartBattleScript: OPP_RIVAL1, party by the rival's starter
  const { classConst, partyIndex } = rivalParty('OAKS_LAB', st.rivalStarter);
  ctx.facePlayer('up');
  lib.setMapScript(ctx, LAB.RIVAL_END_BATTLE);
  yield* lib.scriptedBattle(ctx, {
    kind: 'trainer', trainerClass: classConst, partyIndex, canLose: true,
    winText: 'OaksLabRivalIPickedTheWrongPokemonText', loseText: 'OaksLabRivalAmIGreatOrWhatText',
    objectIndex: OAKSLAB_RIVAL,
  });
  // OaksLabRivalEndBattleScript (won or lost: no blackout in the lab)
  ctx.facePlayer('up');
  yield* faceAndDelay(ctx, OAKSLAB_RIVAL, 'down');
  yield* lib.healParty(ctx);
  ctx.setFlag('EVENT_BATTLED_RIVAL_IN_OAKS_LAB');
  lib.setMapScript(ctx, LAB.RIVAL_STARTS_EXIT);
  // OaksLabRivalStartsExitScript
  yield ctx.wait(20);
  yield ctx.showText('OaksLabRivalSmellYouLaterText.Text');
  ctx.playMusic('MUSIC_MEET_RIVAL_ALT_START');
  const side = ctx.player.x === 4 ? 'right' : 'left';
  lib.setMapScript(ctx, LAB.PLAYER_WATCH_RIVAL_EXIT);
  // OaksLabPlayerWatchRivalExitScript: the player keeps facing the rival as he leaves
  const rival = ctx.npc(OAKSLAB_RIVAL);
  const x0 = rival.x, y0 = rival.y;
  const exit = ctx.moveNpc(OAKSLAB_RIVAL, [side, ['down', 5]]);
  yield () => rival.x !== x0 || exit.done;
  ctx.facePlayer(side);
  yield () => rival.y !== y0 || exit.done;
  ctx.facePlayer('down');
  yield exit;
  ctx.hideToggle('TOGGLE_OAKS_LAB_RIVAL');
  yield* lib.playMapMusic(ctx);
  lib.setMapScript(ctx, LAB.NOOP);
}

/** OaksLabRivalFaceUpOakFaceDownScript (it turns OAKSLAB_OAK2, as the asm does). */
function* labRivalUpOakDown(ctx) {
  yield* faceAndDelay(ctx, OAKSLAB_RIVAL, 'up');
  yield* faceAndDelay(ctx, OAKSLAB_OAK2, 'down');
}

/** OaksLabRivalArrivesAtOaksRequestScript ... OaksLabRivalLeavesWithPokedexScript. */
function* labPokedex(ctx) {
  stopAndPlay(ctx, 'MUSIC_MEET_RIVAL_ALT_START');
  yield ctx.showText('OaksLabRivalGrampsText');
  const entry = labRivalEntry(ctx.player);
  ctx.placeObject(OAKSLAB_RIVAL, entry.x, entry.y, 'up');
  ctx.showToggle('TOGGLE_OAKS_LAB_RIVAL');
  lib.setMapScript(ctx, LAB.OAK_GIVES_POKEDEX);
  yield ctx.moveNpc(OAKSLAB_RIVAL, [['up', entry.steps]]);
  // OaksLabOakGivesPokedexScript
  yield* lib.playMapMusic(ctx);
  yield* labRivalUpOakDown(ctx);
  yield ctx.showText('OaksLabRivalWhatDidYouCallMeForText');
  yield ctx.wait(1);
  yield* labRivalUpOakDown(ctx);
  yield ctx.showText('OaksLabOakIHaveARequestText');
  yield ctx.wait(1);
  yield* labRivalUpOakDown(ctx);
  yield ctx.showText('OaksLabOakMyInventionPokedexText');
  yield ctx.wait(1);
  yield ctx.showText('OaksLabOakGotPokedexText');
  yield ctx.wait(3);
  ctx.hideToggle('TOGGLE_POKEDEX_1');
  ctx.hideToggle('TOGGLE_POKEDEX_2');
  yield* labRivalUpOakDown(ctx);
  yield ctx.showText('OaksLabOakThatWasMyDreamText');
  yield* faceAndDelay(ctx, OAKSLAB_RIVAL, 'right');
  yield ctx.wait(3);
  yield ctx.showText('OaksLabRivalLeaveItAllToMeText');
  ctx.setFlag('EVENT_GOT_POKEDEX');
  ctx.setFlag('EVENT_OAK_GOT_PARCEL');
  ctx.hideToggle('TOGGLE_LYING_OLD_MAN');
  ctx.showToggle('TOGGLE_OLD_MAN');
  stopAndPlay(ctx, 'MUSIC_MEET_RIVAL_ALT_START');
  lib.setMapScript(ctx, LAB.RIVAL_LEAVES_WITH_POKEDEX);
  yield ctx.moveNpc(OAKSLAB_RIVAL, [['down', entry.steps]]);
  // OaksLabRivalLeavesWithPokedexScript
  yield* lib.playMapMusic(ctx);
  ctx.hideToggle('TOGGLE_OAKS_LAB_RIVAL');
  ctx.setFlag('EVENT_1ST_ROUTE22_RIVAL_BATTLE');
  ctx.clearFlag('EVENT_2ND_ROUTE22_RIVAL_BATTLE');
  ctx.setFlag('EVENT_ROUTE22_RIVAL_WANTS_BATTLE');
  ctx.showToggle('TOGGLE_ROUTE_22_RIVAL_1');
  lib.setMapScript(ctx, PALLET.DAISY, 'PalletTown');
  lib.setMapScript(ctx, LAB.NOOP);
}

/** OaksLabSelectedPokeBallScript (+ OaksLabShowPokeBallPokemonScript / OaksLabMonChoiceMenu). */
function* labPokeBall(ctx, ball) {
  const info = LAB_BALLS[ball];
  if (ctx.getFlag('EVENT_GOT_STARTER')) {
    ctx.faceNpc(OAKSLAB_OAK1, 'down');
    yield ctx.showText('OaksLabLastMonText');
    return;
  }
  if (!ctx.getFlag('EVENT_OAK_ASKED_TO_CHOOSE_MON')) {
    yield ctx.showText('OaksLabThoseArePokeBallsText');
    return;
  }
  ctx.faceNpc(OAKSLAB_OAK1, 'down');
  ctx.faceNpc(OAKSLAB_RIVAL, 'right');
  yield* lib.pokedexPage(ctx, info.starter, { forceOwned: true }); // StarterDex
  yield ctx.wait(10);
  yield print(ctx, info.youWant);
  const yes = yield ctx.yesNo();
  if (!yes) { ctx.closeText(); return; }
  const st = ctx.state;
  st.starterChoice = info.starter;
  ctx.hideToggle(info.toggle);
  yield print(ctx, 'OaksLabMonEnergeticText');
  // OaksLabReceivedMonText, then AddPartyMon (level 5) with its AskName
  yield* lib.receivePokemon(ctx, { dex: info.starter, level: 5, askNickname: true, text: 'OaksLabReceivedMonText' });
  lib.setStatusFlag(ctx, 'BIT_GOT_STARTER');
  lib.setMapScript(ctx, LAB.CHOSE_STARTER);
  ctx.closeText(); // wDoNotWaitForButtonPressAfterDisplayingText
}

/** OaksLabOak1Text. */
function* labOak1(ctx) {
  const owned = lib.dexOwnedCount(ctx);
  if (ctx.getFlag('EVENT_PALLET_AFTER_GETTING_POKEBALLS') || (owned >= 2 && ctx.getFlag('EVENT_GOT_POKEDEX'))) {
    yield print(ctx, 'OaksLabOak1Text.HowIsYourPokedexComingText');
    const hooks = ctx.hooks || {};
    if (typeof hooks.dexRating === 'function') yield hooks.dexRating(); // predef DisplayDexRating
    ctx.closeText();
    return;
  }
  if (lib.hasItem(ctx, 'POKE_BALL')) {
    yield ctx.showText('OaksLabOak1Text.ComeSeeMeSometimesText');
    return;
  }
  if (ctx.getFlag('EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE')) {
    // CheckAndSetEvent EVENT_GOT_POKEBALLS_FROM_OAK
    if (ctx.getFlag('EVENT_GOT_POKEBALLS_FROM_OAK')) {
      yield ctx.showText('OaksLabOak1Text.ComeSeeMeSometimesText');
      return;
    }
    ctx.setFlag('EVENT_GOT_POKEBALLS_FROM_OAK');
    ctx.giveItem('POKE_BALL', 5);
    yield ctx.showText('OaksLabOak1Text.GivePokeballsText');
    return;
  }
  if (ctx.getFlag('EVENT_GOT_POKEDEX')) {
    yield ctx.showText('OaksLabOak1Text.PokemonAroundTheWorldText');
    return;
  }
  if (ctx.getFlag('EVENT_BATTLED_RIVAL_IN_OAKS_LAB')) {
    if (!lib.hasItem(ctx, 'OAKS_PARCEL')) {
      yield ctx.showText('OaksLabOak1Text.RaiseYourYoungPokemonText');
      return;
    }
    yield ctx.showText('OaksLabOak1Text.DeliverParcelText');
    lib.takeItem(ctx, 'OAKS_PARCEL', 1);
    lib.setMapScript(ctx, LAB.RIVAL_ARRIVES_AT_OAKS_REQUEST);
    return;
  }
  if (lib.statusFlag(ctx, 'BIT_GOT_STARTER')) {
    yield ctx.showText('OaksLabOak1Text.YourPokemonCanFightText');
    return;
  }
  yield ctx.showText('OaksLabOak1Text.WhichPokemonDoYouWantText');
}

/** OaksLabRivalText. */
function* labRival(ctx) {
  if (!ctx.getFlag('EVENT_FOLLOWED_OAK_INTO_LAB_2')) yield ctx.showText('OaksLabRivalText.GrampsIsntAroundText');
  else if (!ctx.getFlag('EVENT_GOT_STARTER')) yield ctx.showText('OaksLabRivalText.GoAheadAndChooseText');
  else yield ctx.showText('OaksLabRivalText.MyPokemonLooksStrongerText');
}

const OaksLab = {
  onFrame(ctx) {
    // OaksLab_Script prologue
    if (ctx.getFlag('EVENT_PALLET_AFTER_GETTING_POKEBALLS_2')) ctx.setTextTable('OaksLab_TextPointers2');
    switch (lib.getMapScript(ctx)) {
      case LAB.DEFAULT:
        if (!ctx.getFlag('EVENT_OAK_APPEARED_IN_PALLET')) return undefined;
        return labIntro(ctx);
      case LAB.PLAYER_DONT_GO_AWAY:
        return ctx.player.y === 6 ? labDontGoAway(ctx) : undefined;
      case LAB.CHOSE_STARTER:
        return labRivalTakesBall(ctx);
      case LAB.RIVAL_CHALLENGES_PLAYER:
        return ctx.player.y === 6 ? labRivalBattle(ctx) : undefined;
      case LAB.RIVAL_ARRIVES_AT_OAKS_REQUEST:
        return labPokedex(ctx);
      default:
        return undefined;
    }
  },
  onInteract(ctx, i) {
    switch (i) {
      case OAKSLAB_RIVAL: return labRival(ctx);
      case OAKSLAB_CHARMANDER_POKE_BALL:
      case OAKSLAB_SQUIRTLE_POKE_BALL:
      case OAKSLAB_BULBASAUR_POKE_BALL:
        return labPokeBall(ctx, i);
      case OAKSLAB_OAK1: return labOak1(ctx);
      default: return undefined;
    }
  },
};

// =========================================================================== Route1

const ROUTE1_YOUNGSTER1 = 1;

const Route1 = {
  onInteract(ctx, i) {
    if (i !== ROUTE1_YOUNGSTER1) return undefined;
    return (function* martSample() {
      // CheckAndSetEvent EVENT_GOT_POTION_SAMPLE (set even when the bag is full)
      if (ctx.getFlag('EVENT_GOT_POTION_SAMPLE')) {
        yield ctx.showText('Route1Youngster1Text.AlsoGotPokeballsText');
        return;
      }
      ctx.setFlag('EVENT_GOT_POTION_SAMPLE');
      yield print(ctx, 'Route1Youngster1Text.MartSampleText');
      yield* lib.receiveItem(ctx, 'POTION', 1, { text: 'Route1Youngster1Text.GotPotionText', noRoomText: 'Route1Youngster1Text.NoRoomText' });
    }());
  },
};

// =========================================================================== Route21 (trainers only)

/** Route21_Script is the standard trainer script: the engine runs it. */
const Route21 = { trainers: true };

// =========================================================================== ViridianCity

const VIRIDIANCITY_GAMBLER1 = 2;
const VIRIDIANCITY_YOUNGSTER2 = 3;
const VIRIDIANCITY_GIRL = 4;
const VIRIDIANCITY_OLD_MAN_SLEEPY = 5;
const VIRIDIANCITY_FISHER = 6;
const VIRIDIANCITY_OLD_MAN = 7;
const VIRIDIAN = Object.freeze({ DEFAULT: 0, OLD_MAN_START_CATCH_TRAINING: 1, OLD_MAN_END_CATCH_TRAINING: 2, PLAYER_MOVING_DOWN: 3 });
/** wObtainedBadges == ~(1 << BIT_EARTHBADGE): every badge but the EARTHBADGE. */
const ALL_BUT_EARTH = 0x7f;

/** ViridianCityMovePlayerDownScript + ViridianCityPlayerMovingDownScript. */
function* viridianPushBack(ctx) {
  lib.setMapScript(ctx, VIRIDIAN.PLAYER_MOVING_DOWN);
  ctx.facePlayer('down');
  yield ctx.movePlayer(['down']);
  yield ctx.wait(3);
  lib.setMapScript(ctx, VIRIDIAN.DEFAULT);
}

/** The Old Man's catching demo (OLD_MAN_START / END_CATCH_TRAINING). */
function* viridianOldManDemo(ctx) {
  lib.setMapScript(ctx, VIRIDIAN.OLD_MAN_END_CATCH_TRAINING);
  yield* lib.scriptedBattle(ctx, { kind: 'oldman', species: DEX.WEEDLE, level: 5, canLose: true });
  yield ctx.wait(3);
  yield ctx.showText('ViridianCityOldManYouNeedToWeakenTheTargetText');
  lib.setMapScript(ctx, VIRIDIAN.DEFAULT);
}

const ViridianCity = {
  onFrame(ctx) {
    const s = lib.getMapScript(ctx);
    if (s === VIRIDIAN.OLD_MAN_START_CATCH_TRAINING) return viridianOldManDemo(ctx);
    if (s !== VIRIDIAN.DEFAULT) return undefined;
    const p = ctx.player;
    // ViridianCityCheckGymOpenScript
    if (!ctx.getFlag('EVENT_VIRIDIAN_GYM_OPEN')) {
      if (((ctx.state.badges | 0) & 0xff) === ALL_BUT_EARTH) {
        ctx.setFlag('EVENT_VIRIDIAN_GYM_OPEN');
      } else if (p.y === 8 && p.x === 32) {
        return (function* gymLocked() {
          yield ctx.showText('ViridianCityGymLockedText');
          yield* viridianPushBack(ctx);
        }());
      }
    }
    // ViridianCityCheckGotPokedexScript
    if (!ctx.getFlag('EVENT_GOT_POKEDEX') && p.y === 9 && p.x === 19) {
      return (function* privateProperty() {
        yield ctx.showText('ViridianCityOldManSleepyText.PrivatePropertyText');
        yield* viridianPushBack(ctx);
      }());
    }
    return undefined;
  },
  onInteract(ctx, i) {
    switch (i) {
      case VIRIDIANCITY_GAMBLER1:
        return (function* gambler() {
          const back = ((ctx.state.badges | 0) & 0xff) === ALL_BUT_EARTH || ctx.getFlag('EVENT_BEAT_VIRIDIAN_GYM_GIOVANNI');
          yield ctx.showText(back ? 'ViridianCityGambler1Text.GymLeaderReturnedText' : 'ViridianCityGambler1Text.GymAlwaysClosedText');
        }());
      case VIRIDIANCITY_YOUNGSTER2:
        return (function* youngster() {
          yield print(ctx, 'ViridianCityYoungster2Text.YouWantToKnowAboutText');
          const yes = yield ctx.yesNo();
          yield ctx.showText(yes ? 'ViridianCityYoungster2Text.CaterpieAndWeedleDescriptionText' : 'ViridianCityYoungster2Text.OkThenText');
        }());
      case VIRIDIANCITY_GIRL:
        return (function* girl() {
          yield ctx.showText(ctx.getFlag('EVENT_GOT_POKEDEX') ? 'ViridianCityGirlText.WhenIGoShopText' : 'ViridianCityGirlText.HasntHadHisCoffeeYetText');
        }());
      case VIRIDIANCITY_OLD_MAN_SLEEPY:
        return (function* sleepy() {
          yield ctx.showText('ViridianCityOldManSleepyText.PrivatePropertyText');
          yield* viridianPushBack(ctx);
        }());
      case VIRIDIANCITY_FISHER:
        return (function* fisher() {
          if (ctx.getFlag('EVENT_GOT_TM42')) {
            yield ctx.showText('ViridianCityFisherText.TM42ExplanationText');
            return;
          }
          yield print(ctx, 'ViridianCityFisherText.YouCanHaveThisText');
          const ok = yield* lib.receiveItem(ctx, 'TM_DREAM_EATER', 1, {
            text: 'ViridianCityFisherText.ReceivedTM42Text', noRoomText: 'ViridianCityFisherText.TM42NoRoomText',
          });
          if (ok) ctx.setFlag('EVENT_GOT_TM42');
        }());
      case VIRIDIANCITY_OLD_MAN:
        return (function* oldMan() {
          yield print(ctx, 'ViridianCityOldManText.HadMyCoffeeNowText');
          yield ctx.wait(2);
          const yes = yield ctx.yesNo();
          // YES = "in a hurry": time is money; NO = the catching demo after the text
          if (yes) {
            yield ctx.showText('ViridianCityOldManText.TimeIsMoneyText');
            return;
          }
          yield ctx.showText('ViridianCityOldManText.KnowHowToCatchPokemonText');
          lib.setMapScript(ctx, VIRIDIAN.OLD_MAN_START_CATCH_TRAINING);
        }());
      default:
        return undefined;
    }
  },
};

// =========================================================================== ViridianMart

const VIRIDIANMART = Object.freeze({ DEFAULT: 0, OAKS_PARCEL: 1, NOOP: 2 });

const ViridianMart = {
  onFrame(ctx) {
    // ViridianMartCheckParcelDeliveredScript: the clerk only sells once Oak got his parcel
    ctx.setTextTable(ctx.getFlag('EVENT_OAK_GOT_PARCEL') ? 'ViridianMart_TextPointers2' : 'ViridianMart_TextPointers');
    if (lib.getMapScript(ctx) !== VIRIDIANMART.DEFAULT) return undefined;
    return (function* parcel() {
      // ViridianMartDefaultScript
      yield ctx.showText('ViridianMartClerkYouCameFromPalletTownText');
      lib.setMapScript(ctx, VIRIDIANMART.OAKS_PARCEL);
      yield ctx.movePlayer(['left', 'up', 'up']);
      // ViridianMartOaksParcelScript
      yield ctx.wait(3);
      yield ctx.showText('ViridianMartClerkParcelQuestText');
      ctx.giveItem('OAKS_PARCEL', 1);
      ctx.setFlag('EVENT_GOT_OAKS_PARCEL');
      lib.setMapScript(ctx, VIRIDIANMART.NOOP);
    }());
  },
};

// =========================================================================== ViridianNicknameHouse

const VIRIDIANNICKNAMEHOUSE_SPEAROW = 3;

const ViridianNicknameHouse = {
  onInteract(ctx, i) {
    if (i !== VIRIDIANNICKNAMEHOUSE_SPEAROW) return undefined;
    return (function* speary() {
      yield print(ctx, 'ViridianNicknameHouseSpearowText.Text');
      yield* cry(ctx, DEX.SPEAROW);
      yield* waitAndClose(ctx);
    }());
  },
};

// =========================================================================== ViridianGym

const VIRIDIANGYM_GIOVANNI = 1;
const VIRIDIANGYM_GYM_GUIDE = 10;
const VIRIDIAN_GYM_TRAINER_FLAGS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7].map((n) => `EVENT_BEAT_VIRIDIAN_GYM_TRAINER_${n}`));

/** ViridianGymGiovanniText + ViridianGymGiovanniPostBattle / ViridianGymReceiveTM27. */
function* viridianGiovanni(ctx) {
  if (ctx.getFlag('EVENT_BEAT_VIRIDIAN_GYM_GIOVANNI') && ctx.getFlag('EVENT_GOT_TM27')) {
    // .afterBeat: he leaves the gym for good
    yield print(ctx, 'ViridianGymGiovanniText.PostBattleAdviceText');
    yield ctx.fadeOut('black');
    ctx.hideToggle('TOGGLE_VIRIDIAN_GYM_GIOVANNI');
    yield ctx.wait(3);
    ctx.closeText();
    yield ctx.fadeIn('black');
    return 'after';
  }
  return yield* lib.gymLeader(ctx, {
    trainerClass: 'GIOVANNI', partyIndex: 3, gymLeaderNo: 8, objectIndex: VIRIDIANGYM_GIOVANNI,
    badge: 'EARTHBADGE', badgeFlag: 'EVENT_BEAT_VIRIDIAN_GYM_GIOVANNI',
    tm: 'TM_FISSURE', tmFlag: 'EVENT_GOT_TM27',
    textBefore: 'ViridianGymGiovanniText.PreBattleText',
    textWin: 'ViridianGymGiovanniText.ReceivedEarthBadgeText',
    textBadge: 'ViridianGymGiovanniEarthBadgeInfoText',
    textTm: 'ViridianGymGiovanniReceivedTM27Text',
    textNoRoom: 'ViridianGymGiovanniTM27NoRoomText',
    trainerFlags: VIRIDIAN_GYM_TRAINER_FLAGS,
    onVictory(c) {
      c.showToggle('TOGGLE_ROUTE_22_RIVAL_2');
      c.setFlag('EVENT_2ND_ROUTE22_RIVAL_BATTLE');
      c.setFlag('EVENT_ROUTE22_RIVAL_WANTS_BATTLE');
    },
  });
}

const ViridianGym = {
  trainers: true,
  spinners: true,
  onInteract(ctx, i) {
    if (i === VIRIDIANGYM_GIOVANNI) return viridianGiovanni(ctx);
    if (i === VIRIDIANGYM_GYM_GUIDE) {
      return (function* guide() {
        yield ctx.showText(ctx.getFlag('EVENT_BEAT_VIRIDIAN_GYM_GIOVANNI') ? 'ViridianGymGuidePostBattleText' : 'ViridianGymGuidePreBattleText');
      }());
    }
    return undefined;
  },
  onHiddenObject(ctx, routine) {
    if (routine !== 'GymStatues') return undefined;
    // GymStatues: facing up; "VIRIDIAN CITY POKéMON GYM LEADER: GIOVANNI" (+ the winners)
    if (ctx.player.facing !== 'up') return true;
    return (function* statue() {
      yield ctx.showText(lib.hasBadge(ctx, 'EARTHBADGE') ? 'GymStatueText2' : 'GymStatueText1',
        { subs: { wGymCityName: 'VIRIDIAN CITY', wGymLeaderName: 'GIOVANNI' } });
    }());
  },
};

// =========================================================================== Route22

const ROUTE22_RIVAL1 = 1;
const ROUTE22_RIVAL2 = 2;
const ROUTE22 = Object.freeze({
  DEFAULT: 0, RIVAL1_START_BATTLE: 1, RIVAL1_AFTER_BATTLE: 2, RIVAL1_EXIT: 3,
  RIVAL2_START_BATTLE: 4, RIVAL2_AFTER_BATTLE: 5, RIVAL2_EXIT: 6, NOOP: 7,
});
/** Route22DefaultScript.Route22RivalBattleCoords: index 1 = (29,4) above, 2 = (29,5) below. */
const ROUTE22_RIVAL_BATTLE_COORDS = Object.freeze([[29, 4], [29, 5]]);

/** Route22MoveRivalRightScript: four steps when the player is on the upper tile, else three. */
export function route22RivalApproach(coordIdx) {
  return coordIdx === 1 ? ['right', 'right', 'right', 'right'] : ['right', 'right', 'right'];
}

/** Route22Rival1ExitMovementData1 / 2. */
export function route22Rival1Exit(coordIdx) {
  return coordIdx === 1 ? ['right', 'right', ['down', 5]] : ['up', ['right', 3], ['down', 6]];
}

/** Route22Rival2ExitMovementData1 / 2. */
export function route22Rival2Exit(coordIdx) {
  return coordIdx === 1 ? [['left', 4]] : [['left', 3]];
}

/** The rival on Route 22 (first or second battle). */
function* route22Rival(ctx, second, coordIdx) {
  const obj = second ? ROUTE22_RIVAL2 : ROUTE22_RIVAL1;
  const S = ROUTE22;
  // Route22FirstRivalBattleScript / Route22SecondRivalBattleScript
  ctx.facePlayer('left');
  yield ctx.emote(obj, 'shock');
  const audio = ctx.hooks && ctx.hooks.audio;
  if (ctx.player.mode !== 'walk' && audio && audio.stopMusic) audio.stopMusic();
  if (second) stopAndPlay(ctx, 'MUSIC_MEET_RIVAL_ALT_TEMPO');
  else ctx.playMusic('MUSIC_MEET_RIVAL');
  lib.setMapScript(ctx, second ? S.RIVAL2_START_BATTLE : S.RIVAL1_START_BATTLE);
  yield ctx.moveNpc(obj, route22RivalApproach(coordIdx));
  yield* faceAndDelay(ctx, obj, 'right');
  // Route22Rival1StartBattleScript / Route22Rival2StartBattleScript
  if (coordIdx === 1) {
    ctx.facePlayer('down');
    yield* faceAndDelay(ctx, obj, 'up');
  } else {
    if (second) ctx.facePlayer('left');
    yield* faceAndDelay(ctx, obj, 'right');
  }
  yield ctx.showText(second ? 'Route22RivalBeforeBattleText2' : 'Route22RivalBeforeBattleText1');
  const { classConst, partyIndex } = rivalParty(second ? 'ROUTE_22_2' : 'ROUTE_22_1', ctx.state.rivalStarter);
  lib.setMapScript(ctx, second ? S.RIVAL2_AFTER_BATTLE : S.RIVAL1_AFTER_BATTLE);
  const outcome = yield* lib.scriptedBattle(ctx, {
    kind: 'trainer', trainerClass: classConst, partyIndex, objectIndex: obj,
    winText: second ? 'Route22Rival2DefeatedText' : 'Route22Rival1DefeatedText',
    loseText: second ? 'Route22Rival2VictoryText' : 'Route22Rival1VictoryText',
  });
  if (outcome === 'lose') {
    // Route22SetDefaultScript; the blackout follows this script
    lib.setMapScript(ctx, S.DEFAULT);
    return;
  }
  // Route22Rival1AfterBattleScript / Route22Rival2AfterBattleScript
  if (second) {
    if (coordIdx === 1) { ctx.facePlayer('down'); yield* faceAndDelay(ctx, obj, 'up'); } else { ctx.facePlayer('left'); yield* faceAndDelay(ctx, obj, 'right'); }
  } else {
    yield* faceAndDelay(ctx, obj, ctx.player.facing === 'down' ? 'up' : 'right');
  }
  ctx.setFlag(second ? 'EVENT_BEAT_ROUTE22_RIVAL_2ND_BATTLE' : 'EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE');
  yield ctx.showText(second ? 'Route22RivalAfterBattleText2' : 'Route22RivalAfterBattleText1');
  stopAndPlay(ctx, second ? 'MUSIC_MEET_RIVAL_ALT_START_AND_TEMPO' : 'MUSIC_MEET_RIVAL_ALT_START');
  lib.setMapScript(ctx, second ? S.RIVAL2_EXIT : S.RIVAL1_EXIT);
  yield ctx.moveNpc(obj, second ? route22Rival2Exit(coordIdx) : route22Rival1Exit(coordIdx));
  // Route22Rival1ExitScript / Route22Rival2ExitScript
  ctx.hideToggle(second ? 'TOGGLE_ROUTE_22_RIVAL_2' : 'TOGGLE_ROUTE_22_RIVAL_1');
  yield* lib.playMapMusic(ctx);
  ctx.clearFlag(second ? 'EVENT_2ND_ROUTE22_RIVAL_BATTLE' : 'EVENT_1ST_ROUTE22_RIVAL_BATTLE');
  ctx.clearFlag('EVENT_ROUTE22_RIVAL_WANTS_BATTLE');
  lib.setMapScript(ctx, second ? S.NOOP : S.DEFAULT);
}

const Route22 = {
  onFrame(ctx) {
    if (lib.getMapScript(ctx) !== ROUTE22.DEFAULT) return undefined;
    if (!ctx.getFlag('EVENT_ROUTE22_RIVAL_WANTS_BATTLE')) return undefined;
    const idx = coordIndex(ctx, ROUTE22_RIVAL_BATTLE_COORDS);
    if (!idx) return undefined;
    if (ctx.getFlag('EVENT_1ST_ROUTE22_RIVAL_BATTLE')) return route22Rival(ctx, false, idx);
    if (ctx.getFlag('EVENT_2ND_ROUTE22_RIVAL_BATTLE')) return route22Rival(ctx, true, idx);
    return undefined;
  },
  onInteract(ctx, i) {
    if (i === ROUTE22_RIVAL1) {
      return (function* rival1() {
        yield ctx.showText(ctx.getFlag('EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE') ? 'Route22RivalAfterBattleText1' : 'Route22RivalBeforeBattleText1');
      }());
    }
    if (i === ROUTE22_RIVAL2) {
      return (function* rival2() {
        yield ctx.showText(ctx.getFlag('EVENT_BEAT_ROUTE22_RIVAL_2ND_BATTLE') ? 'Route22RivalAfterBattleText2' : 'Route22RivalBeforeBattleText2');
      }());
    }
    return undefined;
  },
};

// =========================================================================== Route22Gate

const ROUTE22GATE_GUARD = 1;
const ROUTE22GATE = Object.freeze({ DEFAULT: 0, PLAYER_MOVING: 1, NOOP: 2 });
const ROUTE22GATE_COORDS = Object.freeze([[4, 2], [5, 2]]);

/** Route22GateGuardText: BOULDERBADGE check. */
function* route22GateGuard(ctx) {
  if (lib.hasBadge(ctx, 'BOULDERBADGE')) {
    yield ctx.showText('Route22GateGuardGoRightAheadText');
    lib.setMapScript(ctx, ROUTE22GATE.NOOP);
    return;
  }
  // Route22GateGuardNoBoulderbadgeText: the text, SFX_DENIED, "I can't let you pass."
  yield print(ctx, '_Route22GateGuardNoBoulderbadgeText');
  yield* lib.fanfare(ctx, 'SFX_DENIED');
  yield ctx.showText('Route22GateGuardICantLetYouPassText', { open: false });
  lib.setMapScript(ctx, ROUTE22GATE.PLAYER_MOVING);
  // Route22GateMovePlayerDownScript + Route22GatePlayerMovingScript
  ctx.facePlayer('down');
  yield ctx.movePlayer(['down']);
  yield ctx.wait(3);
  lib.setMapScript(ctx, ROUTE22GATE.DEFAULT);
}

const Route22Gate = {
  onFrame(ctx) {
    if (lib.getMapScript(ctx) !== ROUTE22GATE.DEFAULT) return undefined;
    if (!coordIndex(ctx, ROUTE22GATE_COORDS)) return undefined;
    return route22GateGuard(ctx);
  },
  onInteract(ctx, i) {
    return i === ROUTE22GATE_GUARD ? route22GateGuard(ctx) : undefined;
  },
};

// =========================================================================== Route2 / DiglettsCaveRoute2 / gates

/** Route2: item balls and signs only (engine). */
const Route2 = {};

/** DiglettsCaveRoute2_Script sets wLastMap = ROUTE_2 every frame: data scriptSetsLastMap (engine). */
const DiglettsCaveRoute2 = {};

const ROUTE2GATE_OAKS_AIDE = 1;

const Route2Gate = {
  onInteract(ctx, i) {
    if (i !== ROUTE2GATE_OAKS_AIDE) return undefined;
    return (function* oaksAide() {
      if (!ctx.getFlag('EVENT_GOT_HM05')) {
        const r = yield* lib.oaksAide(ctx, { requirement: 10, item: 'HM_FLASH' });
        if (r !== lib.OAKS_AIDE.GOT_ITEM) {
          yield* waitAndClose(ctx);
          return;
        }
        ctx.setFlag('EVENT_GOT_HM05');
      }
      yield ctx.showText('Route2GateOaksAideText.FlashExplanationText');
    }());
  },
};

const ROUTE2TRADEHOUSE_GAMEBOY_KID = 2;

const Route2TradeHouse = {
  onInteract(ctx, i) {
    if (i !== ROUTE2TRADEHOUSE_GAMEBOY_KID) return undefined;
    return (function* trade() {
      yield* lib.npcTrade(ctx, 'TRADE_FOR_MARCEL');
    }());
  },
};

/** Trainers and item balls are the engine's (ViridianForest_Script is the trainer script). */
const ViridianForest = { trainers: true };

export default {
  PalletTown,
  RedsHouse1F,
  RedsHouse2F,
  BluesHouse,
  OaksLab,
  Route1,
  Route21,
  ViridianCity,
  ViridianMart,
  ViridianNicknameHouse,
  ViridianGym,
  Route22,
  Route22Gate,
  Route2,
  Route2Gate,
  Route2TradeHouse,
  DiglettsCaveRoute2,
  ViridianForest,
};
