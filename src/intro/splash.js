// Init (home/init.asm) + the copyright screen of PlayShootingStar
// (engine/movie/intro.asm, LoadCopyrightAndTextBoxTiles in engine/movie/title.asm):
//
//   ©'95.'96.'98 Nintendo
//   ©'95.'96.'98 Creatures inc.
//   ©'95.'96.'98 GAME FREAK inc.
//
// shown for 180 frames on the window layer, then cleared. Not skippable (plain
// DelayFrames). Continues with the Game Freak shooting star (gamefreak.js).

import { GbScene, clearScreen, copyVideoData, setPal, gbPalWhiteOut } from './gb.js';
import { VCHARS2, BG_MAP1 } from './ppu.js';

export const SPLASH_TIMING = Object.freeze({
  /** SoftReset: StopAllSounds, GBPalWhiteOut, DelayFrames 32 (only when restarting) */
  softResetFrames: 32,
  /** DelayFrames 180 with the copyright on screen */
  copyrightFrames: 180,
});

/** CopyrightTextString, placed at hlcoord 2, 7 with <NEXT> = 2 rows. */
export const COPYRIGHT_ROWS = Object.freeze([
  [0x60, 0x61, 0x62, 0x61, 0x63, 0x61, 0x64, 0x7f, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a],
  [0x60, 0x61, 0x62, 0x61, 0x63, 0x61, 0x64, 0x7f, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f, 0x70, 0x71, 0x72],
  [0x60, 0x61, 0x62, 0x61, 0x63, 0x61, 0x64, 0x7f, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b],
]);

/**
 * Init: palettes white, VRAM cleared, both BG maps = ' ', window off-screen, LCDC default,
 * auto BG transfer destination vBGMap1.
 * @param {import('./gb.js').IntroContext} ctx
 */
export function initHardware(ctx) {
  const { gb, game } = ctx;
  gbPalWhiteOut(game.palette);
  gb.reset();
  gb.autoDest = BG_MAP1;
  ctx.joy.reset();
  // WRAM is zeroed by Init
  ctx.wram.letterDelayFlags = 0;
  ctx.wram.alphabetLower = false;
  ctx.wram.titleMon = 0;
}

/** LoadTextBoxTilePatterns (VRAM $60-$7F = font_extra) as a CopyVideoData (5 frames). */
export function* loadTextBoxTilePatterns(ctx) {
  const { gb, game } = ctx;
  yield* copyVideoData(gb, 32, (f, n) => gb.vram.load(VCHARS2 + 0x60 + f, game.font.gfx, 0x60 + f, n));
}

export class SplashScene extends GbScene {
  get id() { return 'splash'; }

  /** params.softReset: coming back through Init after the clear-save dialog */
  *script({ softReset = false } = {}) {
    const { gb, game, sound, data } = this.ctx;
    if (softReset) {
      // SoftReset: StopAllSounds, GBPalWhiteOut, 32 frames
      sound.stopMusic();
      gbPalWhiteOut(game.palette);
      yield SPLASH_TIMING.softResetFrames;
    }
    initHardware(this.ctx);
    sound.stopMusic(); // StopAllSounds
    // PlayIntro
    gb.autoTransfer = true;
    // PlayShootingStar -> LoadCopyrightAndTextBoxTiles
    gb.hWY = 0;
    yield* clearScreen(gb);
    yield* loadTextBoxTilePatterns(this.ctx);
    // LoadCopyrightTiles: copyright.png ($60-$72) + gamefreak_inc.png ($73-$7B), 28 tiles
    const { copyright, gamefreakInc } = data.img;
    yield* copyVideoData(gb, 28, (f, n) => {
      for (let i = f; i < f + n; i++) {
        if (i < 19) gb.vram.setTile(VCHARS2 + 0x60 + i, copyright.tile(i));
        else gb.vram.setTile(VCHARS2 + 0x60 + i, gamefreakInc.tile(i - 19));
      }
    });
    COPYRIGHT_ROWS.forEach((row, i) => gb.tilemap.putTiles(2, 7 + 2 * i, row));
    setPal(game.palette, 0xe4);
    yield SPLASH_TIMING.copyrightFrames;
    yield* clearScreen(gb);
    return { next: this.ctx.make.gamefreak() };
  }
}
