// The Game Freak logo and shooting star (PlayShootingStar in engine/movie/intro.asm,
// AnimateShootingStar in engine/movie/splash.asm).
//
// Black bars on rows 0-3 / 14-17, 64 frames, then a big star (4 OBJs, OBP1) streaks from
// the top-right corner to the bottom-left at 4 px/frame for 40 frames while the
// "GAME FREAK" logo (16 OBJs, OBP0 = $F9) sits in the middle; the logo then flashes three
// times (rOBP0 rotated right twice every 10 frames: $7E, $9F, $E7) and four waves of four
// small stars fall from under it (8 px per 24 frames, the lower star of each tile blinking
// through rOBP1 ^= %10100000 every 3 frames), behind the bottom bar (OAM_PRIO).
// A/Start (or Up+Select+B) skips the rest of the animation and the 40-frame pause; the
// intro battle music starts either way and the fight scene follows.

import { GbScene, checkForUserInterruption, copyVideoData, setPal } from './gb.js';
import { VCHARS0, VCHARS1, VCHARS2, BG_MAP1, OAM_PAL1, OAM_XFLIP, OAM_PRIO, OAM_HIDDEN_Y, columnMajorTiles } from './ppu.js';

export const GAMEFREAK_TIMING = Object.freeze({
  barsFrames: 64,          // DelayFrames 64 before the star
  bigStarStep: 4,          // px per frame (Y += 4, X -= 4)
  bigStarEndY: 160,        // loop until sprite 0 Y == $A0
  flashes: 3,
  flashFrames: 10,
  smallStarWaves: 6,       // 4 waves + 2 empty
  smallStarSteps: 8,       // 1 px each
  smallStarStepFrames: 3,
  afterFrames: 40,         // DelayFrames 40 if not interrupted
});

/** GameFreakLogoOAMData: [x tile, y tile, OBJ tile] (dbsprite, no OAM offsets). */
export const LOGO_OAM = Object.freeze([
  [10, 9, 0x8d], [11, 9, 0x8e], [10, 10, 0x8f], [11, 10, 0x90], [10, 11, 0x91], [11, 11, 0x92],
  [6, 12, 0x80], [7, 12, 0x81], [8, 12, 0x82], [9, 12, 0x83], [10, 12, 0x93],
  [11, 12, 0x84], [12, 12, 0x85], [13, 12, 0x83], [14, 12, 0x81], [15, 12, 0x86],
]);

/** GameFreakShootingStarOAMData: [x tile, y tile, tile, attr]. */
export const STAR_OAM = Object.freeze([
  [20, 0, 0xa0, OAM_PAL1], [21, 0, 0xa0, OAM_PAL1 | OAM_XFLIP],
  [20, 1, 0xa1, OAM_PAL1], [21, 1, 0xa1, OAM_PAL1 | OAM_XFLIP],
]);

/** SmallStarsWave1..4Coords + 2 empty waves: [Y, X] per OAM entry. */
export const SMALL_STAR_WAVES = Object.freeze([
  [[0x68, 0x30], [0x68, 0x40], [0x68, 0x58], [0x68, 0x78]],
  [[0x68, 0x38], [0x68, 0x48], [0x68, 0x60], [0x68, 0x70]],
  [[0x68, 0x34], [0x68, 0x4c], [0x68, 0x54], [0x68, 0x64]],
  [[0x68, 0x3c], [0x68, 0x5c], [0x68, 0x6c], [0x68, 0x74]],
  [],
  [],
]);

/** rrc twice */
export function rotateRight2(v) {
  return ((v >> 2) | (v << 6)) & 0xff;
}

/** IntroDrawBlackBars + LoadIntroGraphics (LCD off: everything is instant). */
export function loadIntroScreen(ctx) {
  const { gb, data } = ctx;
  const { img } = data;
  // IntroClearScreen: vBGMap1, 32 x 18 cells = tile 0
  gb.fillBg(BG_MAP1, 32 * 18, 0);
  // black bars: wTileMap rows 0-3 and 14-17, vBGMap1 rows 0-3 and 14-17 (32 wide)
  gb.tilemap.fillRect(0, 0, 20, 4, 1);
  gb.tilemap.fillRect(0, 14, 20, 4, 1);
  gb.fillBg(BG_MAP1, 32 * 4, 1);
  gb.fillBg(BG_MAP1 + 14 * 32, 32 * 4, 1);
  // LoadIntroGraphics
  const v = gb.vram;
  v.load(VCHARS2, img.gengarTiles, 0, 96);          // FightIntroBackMon
  v.fill(VCHARS2 + 96, 1);                           // + blank tile
  v.load(VCHARS2 + 97, img.presents, 0, 13);         // GameFreakIntro
  v.load(VCHARS2 + 110, img.gfLogo, 0, 6);
  v.fill(VCHARS2 + 116, 1);
  v.load(VCHARS1, img.presents, 0, 13);              // GameFreakIntro again at vChars1 (OBJ $80+)
  v.load(VCHARS1 + 13, img.gfLogo, 0, 6);
  v.fill(VCHARS1 + 19, 1);
  [img.nidorino1, img.nidorino2, img.nidorino3].forEach((im, k) => {
    v.loadList(VCHARS0 + 36 * k, columnMajorTiles(im, 6, 6)); // FightIntroFrontMon(2,3), --columns
  });
}

/**
 * AnimateShootingStar. @returns {Generator<any, boolean>} true if the player interrupted
 * @param {import('./gb.js').IntroContext} ctx
 */
export function* animateShootingStar(ctx) {
  const { gb, data, joy, sound, game } = ctx;
  const pal = game.palette;
  const T = GAMEFREAK_TIMING;
  // LoadShootingStarGraphics
  let obp0 = 0xf9, obp1 = 0xa4;
  setPal(pal, null, obp0, obp1);
  yield* copyVideoData(gb, 1, () => gb.vram.setTile(VCHARS1 + 0x20, data.img.moveAnim1.tile(3)));
  yield* copyVideoData(gb, 1, () => gb.vram.setTile(VCHARS1 + 0x21, data.img.moveAnim1.tile(19)));
  yield* copyVideoData(gb, 1, () => gb.vram.setTile(VCHARS1 + 0x22, data.img.fallingStar.tile(0)));
  LOGO_OAM.forEach(([x, y, t], i) => gb.setSprite(24 + i, y * 8, x * 8, t, 0));
  STAR_OAM.forEach(([x, y, t, a], i) => gb.setSprite(i, y * 8, x * 8, t, a));
  sound.playSfx('SFX_SHOOTING_STAR');
  // move the big star down and left
  for (;;) {
    for (let i = 0; i < 4; i++) {
      const o = gb.oam[i];
      o.y = (o.y + T.bigStarStep) & 0xff;
      o.x = (o.x - T.bigStarStep) & 0xff;
    }
    if (yield* checkForUserInterruption(joy, 1)) return true;
    if (gb.oam[0].y === T.bigStarEndY) break; // (the `cp 80` test in the asm changes nothing)
  }
  for (let i = 0; i < 4; i++) gb.oam[i].y = OAM_HIDDEN_Y;
  // make the logo flash
  for (let b = 0; b < T.flashes; b++) {
    obp0 = rotateRight2(obp0);
    setPal(pal, null, obp0);
    if (yield* checkForUserInterruption(joy, T.flashFrames)) return true;
  }
  // 24 copies of SmallStarsOAM (off-screen)
  for (let i = 0; i < 24; i++) gb.setSprite(i, 0, 0, 0xa2, OAM_PRIO | OAM_PAL1);
  let count = 0;
  for (const wave of SMALL_STAR_WAVES) {
    if (wave.length) {
      wave.forEach(([y, x], k) => { gb.oam[20 + k].y = y; gb.oam[20 + k].x = x; });
      if (count !== 24) count += 6; // "should be 4, but the extra 2 aren't visible on screen"
    }
    // MoveDownSmallStars
    let interrupted = false;
    for (let b = 0; b < T.smallStarSteps; b++) {
      for (let j = 0; j < count; j++) {
        const o = gb.oam[23 - j];
        o.y = (o.y + 1) & 0xff;
      }
      obp1 ^= 0xa0;
      setPal(pal, null, null, obp1);
      if (yield* checkForUserInterruption(joy, T.smallStarStepFrames)) { interrupted = true; break; }
    }
    // shift OAM entries 4..23 down to 0..19 to make room for the next wave
    for (let j = 0; j < 20; j++) Object.assign(gb.oam[j], gb.oam[j + 4]);
    if (interrupted) return true;
  }
  return false;
}

export class GameFreakScene extends GbScene {
  get id() { return 'gamefreak'; }

  *script() {
    const { gb, sound } = this.ctx;
    yield 1; // DisableLCD waits for VBlank
    this.ctx.wram.curOpponent = 0;
    loadIntroScreen(this.ctx);
    // EnableLCD; window off, BG map = vBGMap1
    gb.lcdc.winOn = false;
    gb.lcdc.bgMap = 1;
    yield GAMEFREAK_TIMING.barsFrames;
    const interrupted = yield* animateShootingStar(this.ctx);
    // (LoadPresentsGraphic was removed in the localization)
    if (!interrupted) yield GAMEFREAK_TIMING.afterFrames;
    sound.playMusic('MUSIC_INTRO_BATTLE');
    // IntroClearMiddleOfScreen: wTileMap rows 4-13 = tile 0
    gb.tilemap.fillRect(0, 4, 20, 10, 0);
    gb.clearSprites();
    yield 3;
    return { next: this.ctx.make.fight() };
  }
}
