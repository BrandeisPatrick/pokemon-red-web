// The title screen (DisplayTitleScreen in engine/movie/title.asm, TitleScroll and the
// Poké Ball toss in engine/movie/title2.asm).
//
// Layout (tiles): POKéMON logo rows 1-7 (x 2-17), "Red Version" at (7,8), the title mon
// 7x7 at (5,10), "©'95.'96.'98 GAME FREAK inc." at (2,17); Red is 35 OBJs at screen
// (82,80) holding a Poké Ball (OBJ 10, lowered to Y=$74).
// Sequence: the logo drops in through hSCY ($40 -> 0 at 4 px/frame, then bounces 3/2/1 px,
// SFX_INTRO_CRASH on the -3 step) while the window (WY=$40) shows the mon; 36 frames;
// SFX_INTRO_WHOOSH and "Red Version" slides in from the right (SCX of lines 64-79 from
// 144 to 252 in steps of 4); MUSIC_TITLE_SCREEN. Then forever: 200 frames, the mon scrolls
// out to the left (SCX of lines 72-135: TitleScroll_Out), the window covers it; if it was
// a starter Red tosses the ball (10 frames); a random different mon from TitleMons
// (Random & 15) is loaded and scrolls in from the right (TitleScroll_In).
// There is no timeout back to the intro in Red/Blue: the loop runs until A/Start (or
// Up+Select+B held). Then the current mon's cry plays, the screen whites out and the main
// menu (or, with Up+Select+B still held, the clear-save dialog) follows.

import { GbScene, checkForUserInterruption, clearScreen, waitFor, gbPalWhiteOut, gbPalNormal, loadGBPal, setPal, UP_SELECT_B } from './gb.js';
import { VCHARS0, VCHARS1, VCHARS2, BG_MAP0, SPACE } from './ppu.js';
import { displayPic } from './pics.js';
import { DEX } from './data.js';

/** .TitleScreenPokemonLogoYScrolls: [hSCY delta, frames]. */
export const LOGO_BOUNCE = Object.freeze([[-4, 16], [3, 4], [-3, 4], [2, 2], [-2, 2], [1, 2], [-1, 2]]);

/** TitleScroll_In / _Out / _WaitBall: $<speed><frames> bytes. */
export const TITLE_SCROLL_IN = Object.freeze([0xa2, 0x94, 0x84, 0x63, 0x52, 0x31, 0x11]);
export const TITLE_SCROLL_OUT = Object.freeze([0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x83, 0x93]);
export const TITLE_SCROLL_WAIT_BALL = Object.freeze([0x05, 0x05]);

/** TitleBallYTable (index 0 and the trailing 0 terminate). */
export const TITLE_BALL_Y = Object.freeze([0, 0x71, 0x6f, 0x6e, 0x6d, 0x6c, 0x6d, 0x6e, 0x6f, 0x71, 0x74, 0]);

/** .tileScreenCopyrightTiles at hlcoord 2,17. */
export const TITLE_COPYRIGHT = Object.freeze([0x41, 0x42, 0x43, 0x42, 0x44, 0x42, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e]);

/** VersionOnTitleScreenText (Red) at hlcoord 7,8. */
export const VERSION_TEXT = Object.freeze([0x60, 0x61, 0x7f, 0x65, 0x66, 0x67, 0x68, 0x69]);

export const TITLE_TIMING = Object.freeze({
  afterBounce: 36,
  versionScrollStart: 144,
  versionScrollStep: 4,
  monFrames: 200,
  versionLines: [64, 80],
  monLines: [0x48, 0x88],
});

/** STARTER1..3 in dex numbers (TitleScreenAnimateBallIfStarterOut). */
export const STARTERS = Object.freeze([DEX.CHARMANDER, DEX.SQUIRTLE, DEX.BULBASAUR]);

/**
 * The per-frame SCX values one TitleScroll table produces for the scrolled lines.
 * @param {readonly number[]} table
 * @param {number} start initial d ($88 for In, 0 for Out)
 * @returns {number[]}
 */
export function titleScrollValues(table, start) {
  const out = [];
  let d = start;
  for (const byte of table) {
    const speed = byte >> 4, frames = byte & 0xf;
    for (let i = 0; i < frames; i++) { out.push(d); d = (d + speed) & 0xff; }
  }
  return out;
}

/** SCX values of lines 64-79 while "Red Version" slides in (one per frame). */
export function versionScrollValues() {
  const out = [];
  for (let d = TITLE_TIMING.versionScrollStart; d !== 0; d = (d + TITLE_TIMING.versionScrollStep) & 0xff) out.push(d);
  return out;
}

/**
 * TitleScreenPickNewMon's choice: Random & 15 into TitleMons until it differs from the
 * current mon. @param {() => number} randByte @returns {number} dex
 */
export function pickTitleMon(titleMons, current, randByte) {
  for (;;) {
    const dex = titleMons[randByte() & 0xf].species;
    if (dex !== current) return dex;
  }
}

export class TitleScene extends GbScene {
  get id() { return 'title'; }

  /** PrintGameVersionOnTitleScreen */
  printVersion() {
    this.ctx.gb.tilemap.putTiles(7, 8, VERSION_TEXT);
  }

  /** LoadScreenTilesFromBuffer1/2 */
  loadBuffer(buf) {
    this.ctx.gb.tilemap.cells.set(buf);
    this.ctx.gb.autoTransfer = true;
  }

  /** LoadTitleMonSprite: pic of `dex` at hlcoord 5,10. */
  *loadTitleMon(dex) {
    const { data, wram } = this.ctx;
    wram.titleMon = dex;
    yield* displayPic(this.ctx, data.front.get(dex), { x: 5, y: 10 });
  }

  /** TitleScreenCopyTileMapToVRAM: set hAutoBGTransferDest high byte, Delay3. */
  *copyTileMapToVram(dest) {
    this.ctx.gb.autoDest = dest;
    yield 3;
  }

  /** _TitleScroll: one frame per step, SCX = d on lines 72-135; optional ball animation. */
  *titleScroll(table, start, ball = false) {
    const gb = this.ctx.gb;
    const [l0, l1] = TITLE_TIMING.monLines;
    let d = start, e = 1;
    for (const byte of table) {
      const speed = byte >> 4, frames = byte & 0xf;
      for (let i = 0; i < frames; i++) {
        gb.split(l0, { scx: d });
        gb.split(l1, { scx: 0 });
        d = (d + speed) & 0xff;
        if (ball) { // GetTitleBallY
          const y = TITLE_BALL_Y[e];
          if (y) { gb.oam[10].y = y; e++; }
        }
        yield 1;
      }
    }
  }

  *script({ fromIntro = false } = {}) {
    const ctx = this.ctx;
    const { gb, game, joy, sound, data, wram } = ctx;
    const pal = game.palette;
    const v = gb.vram;
    if (fromIntro) {
      // rest of Init after PlayIntro: DisableLCD, ClearVram, GBPalNormal, ClearSprites, LCDC default
      yield 1;
      v.clear();
      gb.bg.fill(0);
      gbPalNormal(pal);
      gb.clearSprites();
      gb.lcdc = { on: true, bgOn: true, objOn: true, bgMap: 0, winOn: true, winMap: 1 };
      // PrepareTitleScreen
      wram.letterDelayFlags = 0;
    }
    // DisplayTitleScreen
    gbPalWhiteOut(pal);
    gb.autoTransfer = true;
    gb.hSCX = 0;
    gb.hSCY = 0x40;
    gb.hWY = 0x90;
    yield* clearScreen(gb);
    yield 1; // DisableLCD (the loads below happen with the LCD off)
    const { img } = data;
    v.load(VCHARS1, game.font.gfx, 0x80, 128);               // LoadFontTilePatterns
    v.load(VCHARS2 + 0x41, img.copyright, 0, 5);             // vTitleLogo2 tile 16
    v.load(VCHARS2 + 0x46, img.gamefreakInc, 0, 9);          // vTitleLogo2 tile 21
    v.load(VCHARS1, img.pokemonLogo, 0, 0x60);               // vTitleLogo
    v.load(VCHARS2 + 0x31, img.pokemonLogo, 0x60, 0x10);     // vTitleLogo2
    v.load(VCHARS2 + 0x60, img.version, 0, 10);              // Version_GFX
    gb.bg.fill(SPACE);                                       // ClearBothBGMaps
    const map = gb.tilemap;
    for (let r = 0; r < 6; r++) for (let c = 0; c < 16; c++) map.set(2 + c, 1 + r, 0x80 + r * 16 + c);
    for (let c = 0; c < 16; c++) map.set(2 + c, 7, 0x31 + c);
    // DrawPlayerCharacter
    v.load(VCHARS0, img.titlePlayer, 0, 35);
    gb.clearSprites();
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) gb.setSprite(r * 5 + c, 0x60 + 8 * r, 0x5a + 8 * c, r * 5 + c, 0);
    gb.oam[10].y = 0x74; // put a Poké Ball in the player's hand
    map.putTiles(2, 17, TITLE_COPYRIGHT);
    const buffer2 = map.cells.slice();                      // SaveScreenTilesToBuffer2
    this.loadBuffer(buffer2);
    // EnableLCD
    yield* this.loadTitleMon(DEX.CHARMANDER);               // STARTER1 is shown first (Red)
    yield* this.copyTileMapToVram(BG_MAP0 + 0x300);
    const buffer1 = map.cells.slice();                      // SaveScreenTilesToBuffer1
    gb.hWY = 0x40;
    this.loadBuffer(buffer2);
    yield* this.copyTileMapToVram(BG_MAP0);
    gbPalNormal(pal);                                        // (SET_PAL_TITLE_SCREEN on SGB)
    setPal(pal, null, 0xe4);                                 // rOBP0 = %11100100
    // make the POKéMON logo bounce
    for (const [d, frames] of LOGO_BOUNCE) {
      if (d === -3) sound.playSfx('SFX_INTRO_CRASH');
      for (let i = 0; i < frames; i++) {
        yield 1;
        gb.hSCY = (gb.hSCY + d) & 0xff;
      }
    }
    this.loadBuffer(buffer1);
    yield TITLE_TIMING.afterBounce;
    sound.playSfx('SFX_INTRO_WHOOSH');
    // scroll the game version in from the right
    this.printVersion();
    gb.hWY = 144;
    const [v0, v1] = TITLE_TIMING.versionLines;
    for (const d of versionScrollValues()) {
      gb.split(v0, { scx: d });
      gb.split(v1, { scx: 0 });
      yield 1;
    }
    yield* this.copyTileMapToVram(BG_MAP0 + 0x400);
    this.loadBuffer(buffer2);
    this.printVersion();
    yield 3;
    yield* waitFor(sound.waitForSfx(), 120);                 // WaitForSoundToFinish
    sound.playMusic('MUSIC_TITLE_SCREEN');
    // keep scrolling in new mons until the player presses something
    for (;;) {
      if (yield* checkForUserInterruption(joy, TITLE_TIMING.monFrames)) break;
      // TitleScreenScrollInMon (despite its name it scrolls the mon out, to the left)
      yield* this.titleScroll(TITLE_SCROLL_OUT, 0);
      gb.hWY = 0;
      if (yield* checkForUserInterruption(joy, 1)) break;
      if (STARTERS.includes(wram.titleMon)) yield* this.titleScroll(TITLE_SCROLL_WAIT_BALL, 0, true);
      // TitleScreenPickNewMon
      yield* this.copyTileMapToVram(BG_MAP0);
      const next = pickTitleMon(data.titleMons, wram.titleMon, () => game.rng.randByte());
      yield* this.loadTitleMon(next);
      gb.hWY = 0x90;
      yield* this.titleScroll(TITLE_SCROLL_IN, 0x88);
    }
    // .finishedWaiting
    yield* waitFor(sound.playCry(wram.titleMon), 300);      // PlayCry (waits for the cry)
    yield* waitFor(sound.waitForSfx(), 300);
    gbPalWhiteOut(pal);
    yield 3;
    gb.clearSprites();
    gb.hWY = 0;
    gb.autoTransfer = true;
    yield* clearScreen(gb);
    yield* this.copyTileMapToVram(BG_MAP0);
    yield* this.copyTileMapToVram(BG_MAP0 + 0x400);
    yield 3;
    loadGBPal(pal);
    if ((joy.held & UP_SELECT_B) === UP_SELECT_B) return { next: ctx.make.clearSave() };
    return { next: ctx.make.mainMenu() };
  }
}
