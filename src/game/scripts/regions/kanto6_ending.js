// The ending (called from the Hall of Fame map script, kanto6.js): HallOfFamePC =
// AnimateHallOfFame (engine/movie/hall_of_fame.asm) + Credits (engine/movie/credits.asm) +
// HallOfFameResetEventsAndSaveScript (scripts/HallOfFame.asm), then `jp Init`: the game starts
// over at the title screen.
//
// The pictures are drawn on the intro's Game Boy screen model (src/intro/ppu.js: BG maps 0 / 1,
// the window, SCX / SCY, raster splits, VRAM tile slots), so the asm's own tricks are kept: the Hall
// of Fame's back picture scrolls in from the right through the BG map and the front picture slides
// in from the left (SCX / SCY on the map the text is mirrored to), the credits' font is shifted to
// colour index 2 and faded in through BGP, and the credits' Pokémon slide across as black
// silhouettes through a raster split (SCX is changed at line $20 and put back at line $70) while the
// window slides in behind them.
//
//   * Hall of Fame: every party Pokémon in turn (back picture left, front picture right, the box with
//     its name, LEVEL and TYPE1/TYPE2, its cry, "HALL OF FAME", fade to white), the team is recorded
//     (state.hallOfFame / hallOfFameCount, SaveHallOfFameTeams), then the player (Red's pictures, name,
//     PLAY TIME, MONEY, the Pokédex seen / owned and OAK's rating).
//   * Credits: the staff in the asm's order (text fades in through BGP $C0 / $D0 / $E0 / $F0), a
//     Pokémon silhouette between the screens, the copyright, "THE END".
//   * Afterwards the Elite Four's events and scripts are reset, the Pokémon Center to return to is
//     Pallet Town's, the game is saved (with the position at Pallet Town's door: where the original's
//     CONTINUE after the Hall of Fame sends the player, see engine/menus/main_menu.asm), "THE END"
//     stays 10 seconds, A / B restarts: the scene stack is replaced by the intro.
//
// `playEnding(ctx)` is the entry point (a generator for a map script). Pure helpers
// (recordHallOfFame, resetEliteFour, creditsSchedule, dexRatingLabel ...) are exported for tests.

import * as lib from '../lib.js';
import { getGameData } from '../../../pokemon/data.js';
import { TextBox, textResolver } from '../../../engine/text.js';
import { PAD } from '../../../engine/input.js';
import {
  GbScene, standaloneContext, setPal, gbPalWhiteOut, fillScreen, clearScreen, placeString, textBoxBorder,
  printNumber, copyVideoData, textBoxSfx, waitFor,
} from '../../../intro/gb.js';
import {
  VCHARS1, VCHARS2, BG_MAP0, BG_MAP1, SPACE, picTiles, copyPicToTilemap,
} from '../../../intro/ppu.js';
import { startIntro, loadIntroData } from '../../../intro/index.js';
import { COPYRIGHT_ROWS } from '../../../intro/splash.js';
import { printBCD, LEADING_ZEROES, MONEY_SIGN } from '../../../menus/format.js';
import { PALETTES } from '../../../engine/palette.js';
import { OverworldScene } from '../../../overworld/index.js';
import { newGame } from '../../new_game.js';
import { loadGame, hasSave, deleteSave, saveGame } from '../../save.js';

// =========================================================================== data

/** HOF_TEAM_CAPACITY: older teams are shifted out. */
export const HOF_TEAM_CAPACITY = 50;

/** Timings of the ending in frames (the asm's DelayFrames / fade steps). */
export const ENDING_TIMING = Object.freeze({
  afterFadeOut: 100,        // ClearScreen + DelayFrames 100 (Hall of Fame and again before the credits)
  scrollBackPicStep: 4,     // hSCX += 4 until $A0 (the pic comes in from the right)
  scrollFrontPicStep: 4,    // hSCX -= 4 until 0 (the pic slides in from the left)
  beforeHallOfFameText: 80,
  hallOfFameText: 180,
  statsText: 120,           // HoFPrintTextAndDelay
  creditsMusicDelay: 128,
  fadeInStep: 5,            // FadeInCredits: 5 frames per palette
  fadeTextHold: 120,        // CRED_TEXT_FADE
  fadeMonTextHold: 90,      // CRED_TEXT_FADE_MON
  textHold: 140,            // CRED_TEXT
  monTextHold: 110,         // CRED_TEXT_MON
  theEndDelay: 16,
  endHold: 600,             // 5 x DelayFrames 120 before WaitForTextScrollButtonPress
});

/** HoFGBPalettes: BGP of the four steps of FadeInCredits. */
export const CREDITS_FADE_BGP = Object.freeze([0xc0, 0xd0, 0xe0, 0xf0]);

/** DexRatingsTable: owned count below `limit` -> the text. */
export const DEX_RATING_LABELS = Object.freeze([
  [10, '_DexRatingText_Own0To9'], [20, '_DexRatingText_Own10To19'], [30, '_DexRatingText_Own20To29'],
  [40, '_DexRatingText_Own30To39'], [50, '_DexRatingText_Own40To49'], [60, '_DexRatingText_Own50To59'],
  [70, '_DexRatingText_Own60To69'], [80, '_DexRatingText_Own70To79'], [90, '_DexRatingText_Own80To89'],
  [100, '_DexRatingText_Own90To99'], [110, '_DexRatingText_Own100To109'], [120, '_DexRatingText_Own110To119'],
  [130, '_DexRatingText_Own120To129'], [140, '_DexRatingText_Own130To139'], [150, '_DexRatingText_Own140To149'],
  [152, '_DexRatingText_Own150To151'],
].map((e) => Object.freeze(e)));

/** The text label of OAK's rating for `owned` Pokémon (DisplayDexRating's table walk). */
export function dexRatingLabel(owned) {
  const row = DEX_RATING_LABELS.find(([limit]) => owned < limit);
  return (row || DEX_RATING_LABELS[DEX_RATING_LABELS.length - 1])[1];
}

// data/credits/credits_text.asm, credits_order.asm and credits_mons.asm (Red version): the staff strings
// as [x offset from column 9, text] and the order of every screen's lines and commands.
export const CREDITS_TEXT = Object.freeze({
  VERSION: Object.freeze([-8, 'RED VERSION STAFF']),
  TAJIRI: Object.freeze([-6, 'SATOSHI TAJIRI']),
  TA_OOTA: Object.freeze([-6, 'TAKENORI OOTA']),
  MORIMOTO: Object.freeze([-7, 'SHIGEKI MORIMOTO']),
  WATANABE: Object.freeze([-7, 'TETSUYA WATANABE']),
  MASUDE: Object.freeze([-6, 'JUNICHI MASUDA']),
  NISINO: Object.freeze([-5, 'KOHJI NISINO']),
  SUGIMORI: Object.freeze([-5, 'KEN SUGIMORI']),
  NISHIDA: Object.freeze([-6, 'ATSUKO NISHIDA']),
  MIYAMOTO: Object.freeze([-7, 'SHIGERU MIYAMOTO']),
  KAWAGUCHI: Object.freeze([-8, 'TAKASHI KAWAGUCHI']),
  ISHIHARA: Object.freeze([-8, 'TSUNEKAZU ISHIHARA']),
  YAMAUCHI: Object.freeze([-7, 'HIROSHI YAMAUCHI']),
  ZINNAI: Object.freeze([-7, 'HIROYUKI ZINNAI']),
  HISHIDA: Object.freeze([-7, 'TATSUYA HISHIDA']),
  SAKAI: Object.freeze([-6, 'YASUHIRO SAKAI']),
  YAMAGUCHI: Object.freeze([-7, 'WATARU YAMAGUCHI']),
  YAMAMOTO: Object.freeze([-8, 'KAZUYUKI YAMAMOTO']),
  TANIGUCHI: Object.freeze([-8, 'RYOHSUKE TANIGUCHI']),
  NONOMURA: Object.freeze([-8, 'FUMIHIRO NONOMURA']),
  FUZIWARA: Object.freeze([-7, 'MOTOFUMI FUZIWARA']),
  MATSUSIMA: Object.freeze([-7, 'KENJI MATSUSIMA']),
  TOMISAWA: Object.freeze([-7, 'AKIHITO TOMISAWA']),
  KAWAMOTO: Object.freeze([-7, 'HIROSHI KAWAMOTO']),
  KAKEI: Object.freeze([-6, 'AKIYOSHI KAKEI']),
  TSUCHIYA: Object.freeze([-7, 'KAZUKI TSUCHIYA']),
  TA_NAKAMURA: Object.freeze([-6, 'TAKEO NAKAMURA']),
  YUDA: Object.freeze([-6, 'MASAMITSU YUDA']),
  MON: Object.freeze([-3, '#MON']),
  DIRECTOR: Object.freeze([-3, 'DIRECTOR']),
  PROGRAMMERS: Object.freeze([-5, 'PROGRAMMERS']),
  CHAR_DESIGN: Object.freeze([-7, 'CHARACTER DESIGN']),
  MUSIC: Object.freeze([-2, 'MUSIC']),
  SOUND_EFFECTS: Object.freeze([-6, 'SOUND EFFECTS']),
  GAME_DESIGN: Object.freeze([-5, 'GAME DESIGN']),
  MONSTER_DESIGN: Object.freeze([-6, 'MONSTER DESIGN']),
  GAME_SCENE: Object.freeze([-6, 'GAME SCENARIO']),
  PARAM: Object.freeze([-8, 'PARAMETRIC DESIGN']),
  MAP: Object.freeze([-4, 'MAP DESIGN']),
  TEST: Object.freeze([-7, 'PRODUCT TESTING']),
  SPECIAL: Object.freeze([-6, 'SPECIAL THANKS']),
  PRODUCERS: Object.freeze([-4, 'PRODUCERS']),
  PRODUCER: Object.freeze([-4, 'PRODUCER']),
  EXECUTIVE: Object.freeze([-8, 'EXECUTIVE PRODUCER']),
  TAMADA: Object.freeze([-6, 'SOUSUKE TAMADA']),
  SA_OOTA: Object.freeze([-5, 'SATOSHI OOTA']),
  YOSHIKAWA: Object.freeze([-6, 'RENA YOSHIKAWA']),
  TO_OOTA: Object.freeze([-6, 'TOMOMICHI OOTA']),
  US_STAFF: Object.freeze([-7, 'US VERSION STAFF']),
  US_COORD: Object.freeze([-7, 'US COORDINATION']),
  TILDEN: Object.freeze([-5, 'GAIL TILDEN']),
  KAWAKAMI: Object.freeze([-6, 'NAOKO KAWAKAMI']),
  HI_NAKAMURA: Object.freeze([-6, 'HIRO NAKAMURA']),
  GIESE: Object.freeze([-6, 'WILLIAM GIESE']),
  OSBORNE: Object.freeze([-5, 'SARA OSBORNE']),
  TRANS: Object.freeze([-7, 'TEXT TRANSLATION']),
  OGASAWARA: Object.freeze([-6, 'NOB OGASAWARA']),
  IWATA: Object.freeze([-5, 'SATORU IWATA']),
  IZUSHI: Object.freeze([-7, 'TAKEHIRO IZUSHI']),
  HARADA: Object.freeze([-7, 'TAKAHIRO HARADA']),
  MURAKAWA: Object.freeze([-7, 'TERUKI MURAKAWA']),
  FUKUI: Object.freeze([-5, 'KOHTA FUKUI']),
  CLUB: Object.freeze([-9, 'NCL SUPER MARIO CLUB']),
  PAAD: Object.freeze([-5, 'PAAD TESTING']),
});

/** CreditsOrder, one row of the asm per entry: string ids and a closing command. */
export const CREDITS_ORDER = Object.freeze([
  ['MON', 'VERSION', 'TEXT_FADE_MON'],
  ['DIRECTOR', 'TAJIRI', 'TEXT_FADE_MON'],
  ['PROGRAMMERS', 'TA_OOTA', 'MORIMOTO', 'TEXT_FADE'],
  ['PROGRAMMERS', 'WATANABE', 'MASUDE', 'TAMADA', 'TEXT_MON'],
  ['CHAR_DESIGN', 'SUGIMORI', 'NISHIDA', 'TEXT_FADE_MON'],
  ['MUSIC', 'MASUDE', 'TEXT_FADE'],
  ['SOUND_EFFECTS', 'MASUDE', 'TEXT_MON'],
  ['GAME_DESIGN', 'TAJIRI', 'TEXT_FADE_MON'],
  ['MONSTER_DESIGN', 'SUGIMORI', 'NISHIDA', 'FUZIWARA', 'TEXT_FADE'],
  ['MONSTER_DESIGN', 'MORIMOTO', 'SA_OOTA', 'YOSHIKAWA', 'TEXT_MON'],
  ['GAME_SCENE', 'TAJIRI', 'TEXT_FADE'],
  ['GAME_SCENE', 'TANIGUCHI', 'NONOMURA', 'ZINNAI', 'TEXT_MON'],
  ['PARAM', 'NISINO', 'TA_NAKAMURA', 'TEXT_FADE_MON'],
  ['MAP', 'TAJIRI', 'NISINO', 'TEXT_FADE'],
  ['MAP', 'MATSUSIMA', 'NONOMURA', 'TANIGUCHI', 'TEXT_MON'],
  ['TEST', 'KAKEI', 'TSUCHIYA', 'TEXT_FADE'],
  ['TEST', 'TA_NAKAMURA', 'YUDA', 'TEXT_MON'],
  ['SPECIAL', 'HISHIDA', 'SAKAI', 'TEXT_FADE'],
  ['SPECIAL', 'YAMAGUCHI', 'YAMAMOTO', 'TEXT'],
  ['SPECIAL', 'TOMISAWA', 'KAWAMOTO', 'TO_OOTA', 'TEXT_MON'],
  ['PRODUCERS', 'MIYAMOTO', 'TEXT_FADE'],
  ['PRODUCERS', 'KAWAGUCHI', 'TEXT'],
  ['PRODUCERS', 'ISHIHARA', 'TEXT_MON'],
  ['US_STAFF', 'TEXT_FADE'],
  ['US_COORD', 'TILDEN', 'TEXT_FADE'],
  ['US_COORD', 'KAWAKAMI', 'HI_NAKAMURA', 'TEXT'],
  ['US_COORD', 'GIESE', 'OSBORNE', 'TEXT'],
  ['TRANS', 'OGASAWARA', 'TEXT_FADE'],
  ['PROGRAMMERS', 'MURAKAWA', 'FUKUI', 'TEXT_FADE'],
  ['SPECIAL', 'IWATA', 'TEXT_FADE'],
  ['SPECIAL', 'HARADA', 'TEXT'],
  ['TEST', 'PAAD', 'CLUB', 'TEXT_FADE'],
  ['PRODUCER', 'IZUSHI', 'TEXT_FADE'],
  ['EXECUTIVE', 'YAMAUCHI', 'TEXT_FADE_MON'],
  ['COPYRIGHT', 'TEXT_FADE_MON'],
  ['THE_END'],
].map((r) => Object.freeze(r)));

/** CreditsMons: one per CRED_TEXT_MON / CRED_TEXT_FADE_MON, in order. */
export const CREDITS_MONS = Object.freeze([
  'VENUSAUR', 'ARBOK', 'RHYHORN', 'FEAROW', 'ABRA', 'GRAVELER', 'HITMONLEE', 'TANGELA', 'STARMIE', 'GYARADOS',
  'DITTO', 'OMASTAR', 'VILEPLUME', 'NIDOKING', 'PARASECT',
]);

const CREDITS_COMMANDS = Object.freeze(['TEXT_FADE_MON', 'TEXT_MON', 'TEXT_FADE', 'TEXT', 'COPYRIGHT', 'THE_END']);

/**
 * The credits as screens: `lines` = [{text, x}] placed at (x, 6 + 2 i), `copyright` (the copyright text
 * is drawn first), `end` = the closing command ('TEXT_FADE_MON' | 'TEXT_MON' | 'TEXT_FADE' | 'TEXT' |
 * 'THE_END'), `fade` (the text fades in through BGP), `mon` = the species const shown after the text
 * (or null) and `hold` = the frames the text stays (before the Pokémon).
 */
export function creditsSchedule() {
  const screens = [];
  let monIndex = 0;
  for (const row of CREDITS_ORDER) {
    const lines = [];
    let copyright = false;
    let end = null;
    for (const token of row) {
      if (token === 'COPYRIGHT') { copyright = true; continue; }
      if (CREDITS_COMMANDS.includes(token)) { end = token; continue; }
      const [off, text] = CREDITS_TEXT[token];
      lines.push({ text, x: 9 + off });
    }
    const fade = end === 'TEXT_FADE_MON' || end === 'TEXT_FADE';
    const withMon = end === 'TEXT_FADE_MON' || end === 'TEXT_MON';
    const hold = { TEXT_FADE_MON: ENDING_TIMING.fadeMonTextHold, TEXT_MON: ENDING_TIMING.monTextHold, TEXT_FADE: ENDING_TIMING.fadeTextHold, TEXT: ENDING_TIMING.textHold }[end] ?? 0;
    screens.push({ lines, copyright, end, fade, hold, mon: withMon ? CREDITS_MONS[monIndex++] : null });
  }
  return screens;
}

// =========================================================================== state

/** The team the Hall of Fame records: every party Pokémon (HoFRecordMonInfo: species, level, name). */
export function hallOfFameTeam(state) {
  return (state.party || []).map((m) => ({ species: m.species, level: m.level, nickname: m.nickname }));
}

/**
 * wNumHoFTeams (+1, stops at 255) and SaveHallOfFameTeams: the party joins the recorded teams, the
 * oldest is dropped past HOF_TEAM_CAPACITY. @returns {object[]} the new team
 */
export function recordHallOfFame(state) {
  const team = hallOfFameTeam(state);
  state.hallOfFameCount = Math.min(255, (state.hallOfFameCount | 0) + 1);
  const teams = (state.hallOfFame || []).map((t) => t.map((m) => ({ ...m })));
  teams.push(team);
  state.hallOfFame = teams.slice(-HOF_TEAM_CAPACITY);
  return team;
}

/**
 * The state changes of HallOfFameResetEventsAndSaveScript: BIT_NO_MAP_MUSIC cleared, BIT_UNUSED_BEAT_ELITE_4
 * set, the Elite Four rooms' and the Hall of Fame's scripts back to the default, the Indigo Plateau events
 * (INDIGO_PLATEAU_EVENTS_START..END: the beaten Elite Four, the Champion ...) reset, wLastBlackoutMap = PALLET_TOWN.
 */
export function resetEliteFour(state) {
  if (state.statusFlags) {
    state.statusFlags.set('BIT_NO_MAP_MUSIC', false);
    state.statusFlags.set('BIT_UNUSED_BEAT_ELITE_4', true);
  }
  for (const map of ['LoreleisRoom', 'BrunosRoom', 'AgathasRoom', 'LancesRoom', 'HallOfFame']) state.setMapScript(map, 0);
  state.flags.clearRange('INDIGO_PLATEAU_EVENTS_START', 'INDIGO_PLATEAU_EVENTS_END');
  state.lastBlackoutMap = 'PALLET_TOWN';
}

/**
 * Where a CONTINUE after the Hall of Fame starts (main_menu.asm: wNumHoFTeams != 0 and wCurMap == HALL_OF_FAME
 * -> a special warp to PALLET_TOWN's fly spot, facing down, wLastMap = PALLET_TOWN): the position that is saved.
 */
export function continuePositionAfterHallOfFame(state) {
  const w = lib.flyWarpFor('PALLET_TOWN');
  state.pos = { map: 'PALLET_TOWN', x: w.x, y: w.y, facing: 'down' };
  state.lastOutdoor = { map: 'PALLET_TOWN', x: null, y: null, warpIndex: null };
  state.surfing = false;
  state.bike = false;
}

/** resetEliteFour + the position + SaveGameData. @returns {{ok:boolean}|null} the save result (null: nothing to save to) */
export function finishRun(state, store) {
  resetEliteFour(state);
  continuePositionAfterHallOfFame(state);
  return store ? saveGame(state, store) : null;
}

// =========================================================================== assets

const IMAGES = Object.freeze({
  red: 'assets/trainers/red.png',
  redBack: 'assets/battle/red_back2x.png',
  theEnd: 'assets/credits/the_end_tiles.png',
  copyright: 'assets/intro/splash/copyright.png',
  gamefreakInc: 'assets/title/gamefreak_inc.png',
});

/**
 * Everything the ending draws, loaded before it starts (the scene's script is synchronous):
 * the party's front / back pictures, Red's, the credits' Pokémon, "THE END" and the copyright tiles.
 * @returns {Promise<{img: object, front: Map<number, object>, back: Map<number, object>, texts: Function}>}
 */
export async function loadEndingAssets(game, state) {
  const gd = getGameData();
  const a = game.assets;
  const keys = Object.keys(IMAGES);
  const [common, ...imgs] = await Promise.all([a.json('data/text/common.json'), ...keys.map((k) => a.image(IMAGES[k]))]);
  const img = Object.fromEntries(keys.map((k, i) => [k, imgs[i]]));
  const front = new Map();
  const back = new Map();
  const want = new Set((state.party || []).map((m) => m.species));
  const credits = new Set(CREDITS_MONS.map((c) => gd.species(c).dex));
  await Promise.all([...new Set([...want, ...credits])].map(async (dex) => {
    const sp = gd.species(dex);
    front.set(dex, await a.image(sp.sprites.front));
    if (want.has(dex)) back.set(dex, await a.image(sp.sprites.back2x));
  }));
  return { img, front, back, texts: textResolver(common) };
}

// =========================================================================== the scene

/**
 * One scene for HallOfFamePC: AnimateHallOfFame, the credits and the wait on "THE END" (a GbScene: its
 * script is stepped once per frame, followed by the model's VBlank).
 * params: {state, assets (loadEndingAssets), onTeamRecorded?, onCreditsDone?, onFinish?(game)}.
 */
export class EndingScene extends GbScene {
  get id() { return 'ending'; }

  /** A PrintText box on wTileMap with no letter delay (wLetterPrintingDelayFlags = 0). */
  textBox() {
    const { game, gb, sound } = this.ctx;
    const st = this.params.state;
    return new TextBox({
      font: game.font, map: gb.tilemap, input: game.input, sfx: textBoxSfx(sound), speed: 0,
      subs: { PLAYER: st.playerName, RIVAL: st.rivalName }, resolveFar: this.params.assets.texts,
    });
  }

  /** PrintText of a label (instant) with RAM substitutions, then HoFPrintTextAndDelay's delay. */
  *printTextAndDelay(label, subs = {}) {
    const box = this.textBox();
    yield* box.run([{ cmd: 'text_far', label }, { cmd: 'text_end' }], { subs: { PLAYER: this.params.state.playerName, ...subs } });
    yield ENDING_TIMING.statsText;
  }

  /** LoadFontTilePatterns + LoadTextBoxTilePatterns. */
  loadFontTiles() {
    const { gb, game } = this.ctx;
    gb.vram.load(VCHARS2 + 0x60, game.font.gfx, 0x60, 32);
    gb.vram.load(VCHARS1, game.font.gfx, 0x80, 128);
  }

  /** HoFFadeOutScreenAndMusic. */
  *fadeOutScreenAndMusic() {
    const { sound, game } = this.ctx;
    sound.fadeOutMusic(10);
    yield* game.palette.fadeToWhite();
  }

  /**
   * HoFShowMonOrPlayer: the back picture scrolls left through the BG map (SCX $C0 -> $A0, 4 per frame,
   * SCY $D0), then the front picture slides in from the left (SCX $A0 -> 0, SCY 0).
   * @param {{front: object, back: object}} pics 7x7-tile pictures
   */
  *showPics(pics) {
    const { gb, game } = this.ctx;
    yield* clearScreen(gb);
    gb.hSCY = 0xd0;
    gb.hSCX = 0xc0;
    gb.vram.loadList(VCHARS2, picTiles(pics.front));        // vFrontPic: tiles $00-$30
    gb.vram.loadList(VCHARS2 + 0x31, picTiles(pics.back));  // vBackPic: tiles $31-$61
    setPal(game.palette, 0xe4);
    copyPicToTilemap(gb.tilemap, 12, 5, { startId: 0x31 });
    do {
      yield 1;
      gb.hSCX = (gb.hSCX + ENDING_TIMING.scrollBackPicStep) & 0xff;
    } while (gb.hSCX !== 0xa0);
    gb.hSCY = 0;
    copyPicToTilemap(gb.tilemap, 12, 5, { startId: 0 });
    do {
      yield 1;
      gb.hSCX = (gb.hSCX - ENDING_TIMING.scrollFrontPicStep) & 0xff;
    } while (gb.hSCX !== 0);
  }

  /** HoFDisplayMonInfo: the box with the name, LEVEL/ TYPE1/ TYPE2/, then the cry (waited for). */
  *displayMonInfo(mon) {
    const { gb, game, sound } = this.ctx;
    const font = game.font;
    const map = gb.tilemap;
    const sp = getGameData().species(mon.species);
    textBoxBorder(font, map, 0, 2, 10, 9);
    placeString(font, map, 2, 6, 'LEVEL/\nTYPE1/\nTYPE2/');
    placeString(font, map, 1, 4, mon.nickname || sp.name);
    placeString(font, map, 8, 7, String(mon.level));
    const gd = getGameData();
    placeString(font, map, 3, 9, gd.typeName(sp.types[0]));
    if (sp.types[0] === sp.types[1]) map.fillRect(2, 10, 6, 1, SPACE); // EraseType2Text
    else placeString(font, map, 3, 11, gd.typeName(sp.types[1]));
    yield* waitFor(sound.playCry(sp.dex), 300);
  }

  /** HoFDisplayPlayerStats: name, PLAY TIME, MONEY, the Pokédex counts and OAK's rating. */
  *displayPlayerStats() {
    const { gb, game } = this.ctx;
    const font = game.font;
    const map = gb.tilemap;
    const st = this.params.state;
    textBoxBorder(font, map, 0, 4, 10, 6);
    textBoxBorder(font, map, 5, 0, 9, 2);
    placeString(font, map, 7, 2, st.playerName);
    placeString(font, map, 1, 6, 'PLAY TIME');
    const { hours, minutes } = st.playTimeParts;
    printNumber(map, 5, 7, Math.min(255, hours), 3);
    map.set(8, 7, 0x6d); // <COLON>
    printNumber(map, 9, 7, minutes, 2, { leadingZeroes: true });
    placeString(font, map, 1, 9, 'MONEY');
    placeString(font, map, 4, 10, printBCD(st.money, 3, LEADING_ZEROES | MONEY_SIGN));
    const seen = st.pokedex ? st.pokedex.seenCount : 0;
    const owned = st.pokedex ? st.pokedex.ownedCount : 0;
    // text_decimal ..., 1, 3 right-aligns in 3 cells (the engine's text_decimal does not pad)
    yield* this.printTextAndDelay('_DexSeenOwnedText', {
      wDexRatingNumMonsSeen: String(seen).padStart(3, ' '), wDexRatingNumMonsOwned: String(owned).padStart(3, ' '),
    });
    yield* this.printTextAndDelay('_DexRatingText');
    yield* this.printTextAndDelay(dexRatingLabel(owned));
  }

  /** AnimateHallOfFame. */
  *animateHallOfFame() {
    const { gb, game, sound } = this.ctx;
    const pal = game.palette;
    const font = game.font;
    const map = gb.tilemap;
    const { assets, state } = this.params;
    gbPalWhiteOut(pal);
    yield* clearScreen(gb);
    yield ENDING_TIMING.afterFadeOut;
    this.loadFontTiles();
    gb.bg.fill(SPACE);       // DisableLCD; fill vBGMap0 / 1 with ' '; EnableLCD
    gb.lcdc.bgMap = 1;       // set B_LCDC_BG_MAP: the BG shows the map wTileMap is mirrored to
    gb.autoTransfer = true;  // hAutoBGTransferEnabled
    gb.autoDest = BG_MAP1;
    gb.hSCX = gb.hSCY = 0;
    gb.hWY = 0x90;           // the window stays below the screen
    sound.playMusic('MUSIC_HALL_OF_FAME');
    const team = hallOfFameTeam(state);
    for (const mon of team) {
      const dex = getGameData().species(mon.species).dex;
      yield* this.showPics({ front: assets.front.get(dex), back: assets.back.get(dex) });
      yield* this.displayMonInfo(mon);
      yield ENDING_TIMING.beforeHallOfFameText;
      textBoxBorder(font, map, 2, 13, 14, 3);
      placeString(font, map, 4, 15, 'HALL OF FAME');
      yield ENDING_TIMING.hallOfFameText;
      yield* pal.fadeToWhite();
    }
    if (this.params.onTeamRecorded) this.params.onTeamRecorded(team); // SaveHallOfFameTeams
    yield* this.showPics({ front: assets.img.red, back: assets.img.redBack });
    yield* this.displayPlayerStats();
    yield* this.fadeOutScreenAndMusic();
    gb.hWY = 0;
    gb.lcdc.bgMap = 0;
  }

  /** HallOfFamePC after AnimateHallOfFame: the credits' font and black bars, the music. */
  *creditsSetup() {
    const { gb, game, sound } = this.ctx;
    const map = gb.tilemap;
    yield* clearScreen(gb);
    yield ENDING_TIMING.afterFadeOut;
    // ShiftFontColorIndex: the low bitplane of the font tiles is zeroed: black (3) becomes colour 2
    const v = gb.vram;
    const shift = (slot, n) => { for (let i = slot * 64; i < (slot + n) * 64; i++) v.tiles[i] &= 2; };
    shift(VCHARS1, 128);
    shift(VCHARS2 + 0x60, 32);
    v.fill(VCHARS2 + 0x7e, 1, 3); // solid black
    map.fillRect(0, 0, 20, 4, 0x7e);
    map.fillRect(0, 14, 20, 4, 0x7e);
    setPal(game.palette, 0xc0);
    sound.stopMusic();
    sound.playMusic('MUSIC_CREDITS');
    yield ENDING_TIMING.creditsMusicDelay;
  }

  /** FillMiddleOfScreenWithWhite. */
  fillMiddle() {
    this.ctx.gb.tilemap.fillRect(0, 4, 20, 10, SPACE);
  }

  /** FadeInCredits. */
  *fadeInCredits() {
    const pal = this.ctx.game.palette;
    for (const bgp of CREDITS_FADE_BGP) {
      setPal(pal, bgp);
      yield ENDING_TIMING.fadeInStep;
    }
  }

  /** CreditsCopyTileMapToVRAM: mirror wTileMap to `dest` and let it finish (Delay3). */
  *copyTileMapTo(dest) {
    const gb = this.ctx.gb;
    gb.autoDest = dest;
    gb.autoTransfer = true;
    yield 3;
  }

  /**
   * DisplayCreditsMon: the screen is copied to the BG map (the Pokémon 12 columns to the right of
   * it), the window is hidden, then the band of rows 4-13 scrolls left 8 pixels per frame (SCX is set at
   * line $20 and cleared at line $70) as a black silhouette; for the last 20 frames the window (a blank
   * middle) slides in behind it.
   * @param {object} img the front picture
   */
  *displayCreditsMon(img) {
    const { gb, game } = this.ctx;
    const pal = game.palette;
    gb.autoTransfer = false;
    const buffer1 = Int16Array.from(gb.tilemap.cells); // SaveScreenTilesToBuffer1
    this.fillMiddle();
    gb.vram.loadList(VCHARS2, picTiles(img));           // LoadFrontSpriteByMonIndex
    copyPicToTilemap(gb.tilemap, 8, 6, { startId: 0 });
    yield* this.copyTileMapTo(BG_MAP0 + 0x0c);
    gb.autoTransfer = false;
    gb.tilemap.cells.set(buffer1);                      // LoadScreenTilesFromBuffer1
    yield* this.copyTileMapTo(BG_MAP0);
    gb.wx = 0xa7;
    yield* this.copyTileMapTo(BG_MAP1);                 // the window map stays mirrored
    this.fillMiddle();
    setPal(pal, 0xfc);                                  // the Pokémon is a black silhouette
    let b = 0;
    for (let c = 0; c < 7; c++) {
      gb.split(0x20, { scx: b });
      gb.split(0x70, { scx: 0 });
      yield 1;
      b += 8;
    }
    for (let c = 0; c < 20; c++) {
      gb.split(0x20, { scx: b });
      gb.split(0x70, { scx: 0 });
      yield 1;
      b += 8;
      gb.wx = (gb.wx - 8) & 0xff;
    }
    gb.hWY = 0;
    setPal(pal, 0xc0);
  }

  /** LoadCopyrightTiles: the copyright tiles and CopyrightTextString at (2, 7). */
  *drawCopyright() {
    const { gb } = this.ctx;
    const { copyright, gamefreakInc } = this.params.assets.img;
    yield* copyVideoData(gb, 28, (first, n) => {
      for (let i = first; i < first + n; i++) {
        gb.vram.setTile(VCHARS2 + 0x60 + i, i < 19 ? copyright.tile(i) : gamefreakInc.tile(i - 19));
      }
    });
    COPYRIGHT_ROWS.forEach((row, i) => gb.tilemap.putTiles(2, 7 + 2 * i, row));
  }

  /** `.showTheEnd`: "T H E  E N D" from the 10 tiles of TheEndGfx. */
  *drawTheEnd() {
    const { gb } = this.ctx;
    const tiles = this.params.assets.img.theEnd;
    yield ENDING_TIMING.theEndDelay;
    this.fillMiddle();
    yield* copyVideoData(gb, 10, (first, n) => {
      for (let i = first; i < first + n; i++) gb.vram.setTile(VCHARS2 + 0x60 + i, tiles.tile(i));
    });
    gb.tilemap.putTiles(4, 8, [0x60, 0x7f, 0x62, 0x7f, 0x64, 0x7f, 0x7f, 0x64, 0x7f, 0x66, 0x7f, 0x68]);
    gb.tilemap.putTiles(4, 9, [0x61, 0x7f, 0x63, 0x7f, 0x65, 0x7f, 0x7f, 0x65, 0x7f, 0x67, 0x7f, 0x69]);
    yield* this.fadeInCredits();
  }

  /** Credits. */
  *credits() {
    const { gb, game } = this.ctx;
    const { assets } = this.params;
    const gd = getGameData();
    for (const screen of creditsSchedule()) {
      this.fillMiddle();
      if (screen.end === 'THE_END') {
        yield* this.drawTheEnd();
        return;
      }
      if (screen.copyright) yield* this.drawCopyright();
      screen.lines.forEach((l, i) => placeString(game.font, gb.tilemap, l.x, 6 + 2 * i, l.text));
      if (screen.fade) yield* this.fadeInCredits();
      yield screen.hold;
      if (screen.mon) yield* this.displayCreditsMon(assets.front.get(gd.species(screen.mon).dex));
    }
  }

  /** WaitForTextScrollButtonPress. */
  *waitForButton() {
    const joy = this.ctx.joy;
    for (;;) {
      yield 1;
      if (joy.poll() & (PAD.a | PAD.b)) return;
    }
  }

  *script() {
    yield* this.animateHallOfFame();
    yield* this.creditsSetup();
    yield* this.credits();
    // back in HallOfFameResetEventsAndSaveScript
    if (this.params.onCreditsDone) this.params.onCreditsDone();
    yield ENDING_TIMING.endHold;
    yield* this.waitForButton();
    return { call: () => (this.params.onFinish ? this.params.onFinish(this.game) : returnToTitle(this.game)) };
  }
}

// =========================================================================== Init

/** main.js' startOverworld: the overworld for a game state (new game or continue). */
function startOverworld(game, state) {
  state.options = Object.assign(game.options, state.options || {});
  game.state = state;
  game.playing = true;
  const ov = new OverworldScene({ data: game.data, state, hooks: game.hooks, paletteMode: 'sgb' });
  game.overworld = ov;
  return ov;
}

/**
 * `jp Init`: the game starts over at the copyright screen and the title (the scene stack is replaced by
 * the intro). The title's CONTINUE loads the save written before; NEW GAME starts a new one. Without the
 * pieces of main.js' game object the page is reloaded like START > RESET (game.softReset).
 * @returns {Promise<void>}
 */
export function returnToTitle(game) {
  const soft = () => { if (typeof game.softReset === 'function') game.softReset(); };
  if (!game || !game.scenes || !game.assets) { soft(); return Promise.resolve(); }
  game.playing = false; // the play time counter stops until a game is started
  const store = game.saveStore;
  const hooks = {
    audio: game.audio,
    options: game.options,
    saveInfo: () => {
      if (!store || !hasSave(store)) return null;
      const s = loadGame(store);
      return s ? { playerName: s.playerName, badges: s.badges, dexOwned: s.pokedex.ownedCount, playTimeFrames: s.playTime } : null;
    },
    clearSave: () => { if (store) deleteSave(store); },
    onNewGame: ({ playerName, rivalName }) => startOverworld(game, newGame({ playerName, rivalName, options: game.options })),
    onContinue: () => {
      const state = store ? loadGame(store) : null;
      if (!state) {
        console.error('[kanto6] the save could not be loaded:', store && store.lastError);
        return null;
      }
      return startOverworld(game, state);
    },
  };
  return loadIntroData(game.assets).then((data) => {
    if (game.audio && typeof game.audio.stopMusic === 'function') game.audio.stopMusic();
    game.scenes.clear();
    game.palette.setColors(PALETTES.dmg);
    game.palette.setObjColors(0, null);
    game.palette.setObjColors(1, null);
    return startIntro(game, hooks, { data });
  }).then(() => undefined, (err) => {
    console.error('[kanto6] returning to the title failed:', err);
    soft();
  });
}

// =========================================================================== entry point

/** The game object (window.game) behind a script ctx: the overworld's. */
function gameOf(ctx) {
  return (ctx.ov && ctx.ov.game) || ctx.game || null;
}

/**
 * HallOfFamePC for the Hall of Fame map script: the screen fades to white, the Hall of Fame
 * and the credits play, the run is recorded and saved, then the title screen. Without a game with scenes
 * (tests, headless) only the state changes happen.
 */
export function* playEnding(ctx) {
  const state = ctx.state;
  const game = gameOf(ctx);
  const store = game && game.saveStore;
  if (!game || !game.scenes || !game.font || !game.assets) {
    recordHallOfFame(state);
    finishRun(state, store);
    return;
  }
  const assets = yield loadEndingAssets(game, state);
  const audio = ctx.hooks && ctx.hooks.audio;
  if (audio && typeof audio.fadeOutMusic === 'function') audio.fadeOutMusic(10);
  yield ctx.fadeOut('white'); // HoFFadeOutScreenAndMusic
  const sctx = standaloneContext(game, { audio: game.audio || null, options: game.options });
  const scene = new EndingScene(sctx, {
    state, assets,
    onTeamRecorded: () => recordHallOfFame(state),
    onCreditsDone: () => finishRun(state, store),
  });
  game.scenes.push(scene);
  yield scene.finished; // the scene ends by replacing the whole stack (returnToTitle)
}
