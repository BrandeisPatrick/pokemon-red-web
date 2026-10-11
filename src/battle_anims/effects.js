// The special-effect routines of engine/battle/animations.asm, one generator per routine,
// keyed by the routine name the data uses (special_effects.json `routine`). Each takes an
// AnimRun and yields one value per frame. Comments name the asm routine being transcribed;
// frame counts follow its DelayFrames/Delay3 calls exactly.

import { BLANK, blankPicTiles } from './pics.js';
import { LAYER_BLANK, LAYER_LIVE, LAYER_SNAPSHOT } from './ppu.js';
import { OAM_XFLIP, SCREEN_H, OAM_Y_OFS } from './layout.js';

// ============================================================================ shared pieces

/** AnimationCleanOAM: DelayFrame, then ClearSprites. */
export function* cleanOam(run) {
  yield* run.wait(1);
  run.view.oam.clear();
}

/** InitMultipleObjectsOAM: c entries of tile d at X 0, Y 8, 16, ...; loads tileset a. */
function initMultipleObjectsOam(run, count, tile, tileset) {
  run.view.loadAnimTiles(tileset);
  let e = 0;
  for (let i = 0; i < count; i++) {
    e = (e + 8) & 0xff;
    run.view.oam.set(i, e, 0, tile, 0);
  }
}

/** AnimationFlashScreen: BGP inverted 2 frames, white 2 frames, restored. */
export function* flashScreen(run) {
  const saved = run.regs.bgp;
  run.setBGP(run.data.constants.flashScreenInverted);
  yield* run.wait(2);
  run.setBGP(0x00);
  yield* run.wait(2);
  run.setBGP(saved);
}

/** AnimationFlashScreenLong: the 12-step table 3 times (2 frames per step, then 1, then 1). */
function* flashScreenLong(run) {
  const t = run.data.tables;
  const table = run.sgb ? t.FlashScreenLongSGB : t.FlashScreenLongMonochrome;
  for (let counter = 3; counter > 0; counter--) {
    for (const v of table) {
      run.setBGP(v);
      yield* run.wait(counter === 3 ? 2 : 1); // FlashScreenLongDelay
    }
  }
}

/** SetAnimationBGPalette callers (b = DMG value, c = SGB value). */
function bgPalette(name) {
  return function* setPalette(run) {
    const p = run.data.bgPalettes[name];
    run.setBGP(run.sgb ? p.sgb : p.dmg);
  };
}

/** PredefShakeScreenHorizontally: WX = 7 + (b, 0), (b-1 ...) with 4(+1)-frame steps. */
export function* shakeScreenHorizontally(run, b) {
  const ppu = run.view.ppu;
  let mutate = 0;
  const step = function* () {
    mutate ^= b;
    const a = mutate & 0x80 ? 0 : mutate;
    ppu.wx = (a + 7) & 0xff;
    yield* run.wait(4);
  };
  for (;;) {
    yield* step();
    yield* run.wait(1);
    yield* step();
    b = (b - 1) & 0xff;
    if (b === 0) break;
    mutate = b;
  }
  ppu.wx = 7;
}

/** PredefShakeScreenVertically: WY = b, 0, ... 3 frames each (hWY restores 0 afterwards). */
export function* shakeScreenVertically(run, b) {
  const ppu = run.view.ppu;
  let mutate = 0;
  const step = function* () {
    mutate ^= b;
    ppu.wy = mutate;
    yield* run.wait(3);
  };
  for (;;) {
    yield* step();
    yield* step();
    b = (b - 1) & 0xff;
    if (b === 0) break;
    mutate = b;
  }
  ppu.wy = 0;
}

/** AnimationShakeScreenHorizontallySlow: WX += 1 b times then -= 1 b times (2 frames each), c times. */
export function* shakeScreenHorizontallySlow(run, b, c) {
  const ppu = run.view.ppu;
  for (; c > 0; c--) {
    for (let i = 0; i < b; i++) { ppu.wx = (ppu.wx + 1) & 0xff; yield* run.wait(2); }
    for (let i = 0; i < b; i++) { ppu.wx = (ppu.wx - 1) & 0xff; yield* run.wait(2); }
  }
}

// ============================================================================ pic routines

/** AnimationBlinkMon: hide 5 frames / show (+3) 5 frames, 6 times. */
export function* blinkMon(run) {
  for (let i = 0; i < 6; i++) {
    run.hideMonPic();
    yield* run.wait(5);
    yield* run.showMonPic();
    yield* run.wait(5);
  }
}

/** AnimationBlinkEnemyMon. */
export function* blinkEnemyMon(run) {
  yield* run.flipped(() => blinkMon(run));
}

/** AnimationSlideMonDown: the pic sinks one row per 3 frames and ends hidden. */
export function* slideMonDown(run) {
  const list = run.tileList('front');
  for (let b = 7; b > 0; b--) {
    run.copyPicTiles(list, b);
    yield* run.wait(3);
    run.hideMonPic();
  }
}

/** _AnimationSlideMonUp: rows move up, the bottom row is refilled with the next pic row (2 frames each). */
function* slideMonUp(run) {
  const tm = run.tm;
  const h = run.picHome();
  let bottom = run.turn ? 0xff : 0x30; // wSlideMonUpBottomRowLeftTile
  for (let c = 0; c < 7; c++) {
    for (let r = 0; r < 6; r++) tm.copyRow(h.x, h.y + r + 1, h.x, h.y + r, 7);
    bottom = (bottom + 1) & 0xff;
    for (let col = 0; col < 7; col++) tm.set(h.x + col, h.y + 6, (bottom + 7 * col) & 0xff);
    yield* run.wait(2);
  }
}

/** _AnimationSlideMonOff: every cell takes the tile one pic column further (e steps). */
export function* slideMonOffCore(run, steps, delay) {
  const tm = run.tm;
  const [x0, y0] = run.turn ? [12, 0] : [0, 5];
  for (let s = 0; s < steps; s++) {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 8; c++) {
        const v = tm.tileAt(x0 + c, y0 + r);
        let a;
        if (run.turn) { // .EnemyNextTile
          a = (v - 7) & 0xff;
          if (a >= 0x30) a = BLANK;
        } else { // .PlayerNextTile (cp $61: the bottom-right pic tile is lost, as on the GB)
          a = (v + 7) & 0xff;
          if (a >= 0x61) a = BLANK;
        }
        tm.set(x0 + c, y0 + r, a);
      }
    }
    yield* run.wait(delay);
  }
}

/** AnimationSlideMonOff: 8 steps of 3 frames. */
export function* slideMonOff(run) {
  yield* slideMonOffCore(run, 8, 3);
}

/** AnimationSlideEnemyMonOff. */
export function* slideEnemyMonOff(run) {
  yield* run.flipped(() => slideMonOff(run));
}

/** AnimationSlideMonHalfOff: 4 steps of 4 frames, then Delay3. */
function* slideMonHalfOff(run) {
  yield* slideMonOffCore(run, 4, 4);
  yield* run.wait(3);
}

/** AnimationMoveMonHorizontally: hide, redraw one tile towards the opponent, 3 frames. */
function* moveMonHorizontally(run) {
  run.hideMonPic();
  const at = run.turn ? { x: 11, y: 0 } : { x: 2, y: 5 };
  run.copyPicTiles(run.tileList('front'), 7, 7, at);
  yield* run.wait(3);
}

/** AnimationResetMonPosition: clear the shifted box, show at home. */
function* resetMonPosition(run) {
  if (run.turn) run.tm.clearArea(11, 0, 7, 7);
  else run.tm.clearArea(2, 5, 7, 7);
  yield* run.showMonPic();
}

/** AnimationShowMonPic. */
function* showMonPic(run) {
  yield* run.showMonPic();
}

/** AnimationShowEnemyMonPic. */
function* showEnemyMonPic(run) {
  yield* run.flipped(() => run.showMonPic());
}

/** AnimationHideMonPic. */
function* hideMonPic(run) {
  run.hideMonPic();
}

/** AnimationHideEnemyMonPic: hide the defender, Delay3. */
function* hideEnemyMonPic(run) {
  yield* run.flipped(function* () { run.hideMonPic(); });
  yield* run.wait(3);
}

/** AnimationShakeBackAndForth: pic one tile left / one tile right, 3 frames each, 16 times; ends hidden. */
function* shakeBackAndForth(run) {
  const [hl, de] = run.turn ? [{ x: 11, y: 0 }, { x: 13, y: 0 }] : [{ x: 0, y: 5 }, { x: 2, y: 5 }];
  const list = run.tileList('front');
  for (let c = 0; c < 0x10; c++) {
    run.copyPicTiles(list, 7, 7, hl);
    yield* run.wait(3);
    run.tm.clearArea(hl.x, hl.y, 9, 7);
    run.copyPicTiles(list, 7, 7, de);
    yield* run.wait(3);
    run.tm.clearArea(hl.x, hl.y, 9, 7);
  }
}

/** _AnimationSquishMonPic: one pass over 7 rows (AnimCopyRowLeft/Right of 3 tiles + a blank). */
function* squishPass(run, x, y, left) {
  const tm = run.tm;
  for (let r = 0; r < 7; r++) {
    if (left) {
      for (let k = 0; k < 3; k++) tm.set(x + k - 1, y + r, tm.tileAt(x + k, y + r));
      tm.set(x + 2, y + r, BLANK);
    } else {
      for (let k = 0; k < 3; k++) tm.set(x - k + 1, y + r, tm.tileAt(x - k, y + r));
      tm.set(x - 2, y + r, BLANK);
    }
  }
  yield* run.wait(3);
}

/** AnimationSquishMonPic: squeeze towards the centre column 4 times, then hide. */
function* squishMonPic(run) {
  for (let i = 0; i < 4; i++) {
    const [hl, de] = run.turn ? [16, 14] : [5, 3];
    const y = run.turn ? 0 : 5;
    yield* squishPass(run, hl, y, true);
    yield* squishPass(run, de, y, false);
  }
  run.hideMonPic();
  yield* run.wait(1); // jp DelayFrame
}

/** AnimationBoundUpAndDown: SlideMonDown 5 times, then ShowMonPic. */
function* boundUpAndDown(run) {
  for (let i = 0; i < 5; i++) yield* slideMonDown(run);
  yield* run.showMonPic();
}

/** AnimationSlideMonDownAndHide: 7x5 then 7x3 squashed pics (8 frames each), hide, blank tile data. */
function* slideMonDownAndHide(run) {
  for (const [name, rows] of [['slide_down_7x5', 5], ['slide_down_7x3', 3]]) {
    run.hideMonPic();
    run.copyPicTiles(run.tileList(name), rows);
    yield* run.wait(8);
  }
  run.hideMonPic();
  run.view.clearPicTiles(run.side()); // FillMemory wTempPic + CopyTempPicToMonPic
}

/** AnimationMinimizeMon: pic data = the 8x5 blob in tile (3,4) rows 2-6; Delay3; ShowMonPic. */
function* minimizeMon(run) {
  const tiles = blankPicTiles();
  const rows = run.data.tables.MinimizedMonSprite;
  const t = 7 * 3 + 4; // (PIC_WIDTH * 3 + 4) tiles = column 3, row 4
  for (let r = 0; r < rows.length; r++) {
    for (let b = 0; b < 8; b++) if (rows[r] & (0x80 >> b)) tiles[t * 64 + (r + 2) * 8 + b] = 3; // + TILE_SIZE / 4 = 2 rows
  }
  run.view.setPicTiles(run.side(), tiles);
  yield* run.wait(3);
  yield* run.showMonPic();
}

/** AnimationSubstitute: pic data = the MonsterSprite doll (front for the enemy, back for the player). */
function* substitute(run) {
  const tiles = blankPicTiles();
  const mon = run.data.gfx.monster;
  const place = run.turn ? [[0, 18], [1, 25], [2, 19], [3, 26]] : [[4, 25], [5, 32], [6, 26], [7, 33]];
  if (mon) for (const [src, dst] of place) tiles.set(mon.tile(src), dst * 64);
  run.view.setPicTiles(run.side(), tiles);
  yield* run.showMonPic();
}

/**
 * ChangeMonPic: reload the pic of the attacker's side. `transform` uses the opponent's species
 * (AnimationTransformMon), otherwise the side's own (AnimationFlashMonPic). Images come from
 * ctx.mons (player.back / enemy.front for the own pic, enemy.back / player.front for
 * Transform), falling back to the pic last given to view.setPic.
 */
export function changeMonPic(run, transform) {
  const mons = run.ctx.mons || {};
  const view = run.view;
  if (run.turn) {
    const img = transform ? mons.player && mons.player.front : mons.enemy && mons.enemy.front;
    loadSlot(run, 'enemy', img, 'front');
    view.tilemap.copyPic(12, 0, 0x00); // LoadFrontSpriteByMonIndex: CopyUncompressedPicToHL at (12,0)
  } else {
    const img = transform ? mons.enemy && mons.enemy.back : mons.player && mons.player.back;
    view.tilemap.clearArea(1, 5, 8, 7); // LoadMonBackPic
    loadSlot(run, 'player', img, 'back');
    run.copyPicTiles();
  }
}

function loadSlot(run, side, img, kind) {
  const view = run.view;
  if (img) {
    // after Transform the side's species is the transformed one (wBattleMonSpecies changes), so
    // the transformed pic also becomes the fallback for later FlashMonPic calls
    view.setPic(side, img, kind);
  } else if (view.pics[side]) {
    view.setPic(side, view.pics[side].img, view.pics[side].kind);
  } else if (!run._warnedPic) {
    run._warnedPic = true;
    if (typeof console !== 'undefined') console.warn(`battle_anims: no ${kind} pic for ${side} (pass ctx.mons)`);
  }
}

function* flashMonPic(run) {
  changeMonPic(run, false);
}

function* flashEnemyMonPic(run) {
  yield* run.flipped(function* () { changeMonPic(run, false); });
}

function* transformMon(run) {
  changeMonPic(run, true);
}

// ============================================================================ sprite routines

/** AnimationWaterDropletsEverywhere: 32 x 2 droplet fields, each shown 1 frame then 1 frame empty. */
function* waterDropletsEverywhere(run) {
  run.view.loadAnimTiles(0);
  const oam = run.view.oam;
  const tile = run.data.constants.dropletTile;
  let x = (-16) & 0xff;
  for (let d = 0; d < 32; d++) {
    for (const baseY of [16, 24]) {
      // _AnimationWaterDroplets
      let i = 0, y = baseY;
      for (;;) {
        do {
          x = (x + 27) & 0xff;
          oam.set(i++, y, x, tile, 0);
        } while (x < 144);
        x = (x - 168) & 0xff;
        y += 16;
        if (y >= 112) break;
      }
      yield* cleanOam(run);
      yield* run.wait(1);
    }
  }
}

/** _AnimationShootBallsUpward: a column of `count` balls rising 4 px per `delay` frames. */
function* shootBallsUpwardCore(run, baseY, baseX, count, delay) {
  run.view.loadAnimTiles(0);
  const oam = run.view.oam;
  const tile = run.data.constants.spiralBallTile;
  let e = baseY;
  for (let i = 0; i < count; i++) {
    e = (e + 8) & 0xff;
    oam.set(i, e, baseX, tile, 0);
  }
  yield* run.wait(1);
  let remaining = count;
  const top = (baseY + 8) & 0xff;
  do {
    for (let i = 0; i < count; i++) {
      if (oam.y[i] === top) {
        oam.y[i] = 0;
        remaining = (remaining - 1) & 0xff;
      } else {
        oam.y[i] = (oam.y[i] - 4) & 0xff;
      }
    }
    yield* run.wait(delay);
  } while (remaining !== 0);
}

/** AnimationShootBallsUpward. */
function* shootBallsUpward(run) {
  const [y, x] = run.turn ? [0, 16 * 8] : [6 * 8, 5 * 8];
  yield* shootBallsUpwardCore(run, y, x, 5, 1);
  yield* cleanOam(run);
}

/** AnimationShootManyBallsUpward: six pillars of 4 balls (only used by the unused ANIM_B6/B7). */
function* shootManyBallsUpward(run) {
  const t = run.data.tables;
  const [xs, y] = run.turn ? [t.UpwardBallsAnimXCoordinatesEnemyTurn, 0x28] : [t.UpwardBallsAnimXCoordinatesPlayerTurn, 0x50];
  for (const x of xs) yield* shootBallsUpwardCore(run, y, x, 4, 1);
  yield* cleanOam(run);
}

/** AnimationSpiralBallsInward: 3 balls follow SpiralBallAnimationCoordinates (5 frames a step), then a flash. */
function* spiralBallsInward(run) {
  const [by, bx] = run.turn ? [(-40) & 0xff, 80] : [0, 0];
  initMultipleObjectsOam(run, 3, run.data.constants.spiralBallTile, 0);
  const path = run.data.tables.SpiralBallAnimationCoordinates;
  const oam = run.view.oam;
  for (let s = 0; ; s++) {
    let done = false;
    for (let i = 0; i < 3; i++) {
      const p = path[s + i];
      if (!p) { done = true; break; }
      oam.y[i] = (by + p[0]) & 0xff;
      oam.x[i] = (bx + p[1]) & 0xff;
    }
    if (done) break;
    yield* run.wait(5);
  }
  yield* cleanOam(run);
  yield* flashScreen(run);
}

/** AnimationFallingObjects (leaves / petals): fall 2 px per 3 frames, swaying, until object 0 reaches Y 104. */
function* fallingObjects(run, tile, count) {
  const t = run.data.tables;
  const oam = run.view.oam;
  initMultipleObjectsOam(run, count, tile, 1);
  for (let i = 0; i < count; i++) oam.x[i] = t.FallingObjects_InitialXCoords[i]; // FallingObjects_InitXCoords
  const move = t.FallingObjects_InitialMovementData.slice(0, count);
  oam.y[0] = 0;
  const deltas = t.FallingObjects_DeltaXs;
  let guard = 0;
  do {
    for (let i = 0; i < count; i++) {
      let b = (move[i] + 1) & 0xff; // FallingObjects_UpdateMovementByte
      if ((b & 0x7f) === 9) b = (b & 0x80) ^ 0x80;
      let y = (oam.y[i] + 2) & 0xff; // FallingObjects_UpdateOAMEntry
      if (y >= 112) y = SCREEN_H + OAM_Y_OFS;
      oam.y[i] = y;
      const dx = deltas[b & 0x7f];
      if (b & 0x80) { oam.x[i] = (oam.x[i] - dx) & 0xff; oam.attr[i] = OAM_XFLIP; }
      else { oam.x[i] = (oam.x[i] + dx) & 0xff; oam.attr[i] = 0; }
      move[i] = b;
    }
    yield* run.wait(3);
    if (++guard > 1000) throw new Error('fallingObjects: runaway loop');
  } while (oam.y[0] !== 104);
}

/** AnimationLeavesFalling: 3 leaves (OBP0 = wAnimPalette while they fall). */
function* leavesFalling(run) {
  const saved = run.regs.obp0;
  run.setOBP0(run.animPalette);
  yield* fallingObjects(run, run.data.constants.leafTile, 3);
  run.setOBP0(saved);
}

/** AnimationPetalsFalling: 20 petals, then ClearSprites. */
function* petalsFalling(run) {
  yield* fallingObjects(run, run.data.constants.petalTile, 20);
  run.view.oam.clear();
}

// ============================================================================ screen routines

/** AnimationShakeScreen: PredefShakeScreenHorizontally b = 8. */
function* shakeScreen(run) {
  yield* shakeScreenHorizontally(run, 8);
}

/** AnimationDelay10. */
function* delay10(run) {
  yield* run.wait(10);
}

/**
 * AnimationWavyScreen: BG map 0 gets a frozen copy of the screen, the window is moved off,
 * and for 255 frames every line gets SCX from WavyScreenLineOffsets (one table step per line,
 * the start advancing one step per frame); then the window comes back and map 0 is cleared.
 */
function* wavyScreen(run) {
  const ppu = run.view.ppu;
  ppu.bg = LAYER_LIVE;
  yield* run.wait(3); // BattleAnimCopyTileMapToVRAM(vBGMap0)
  yield* run.wait(3); // Delay3
  ppu.bg = LAYER_SNAPSHOT; // hAutoBGTransferEnabled = 0
  ppu.bgPixels = run.snapshot();
  ppu.wy = SCREEN_H;
  const table = run.data.tables.WavyScreenLineOffsets;
  const lines = new Int16Array(SCREEN_H);
  ppu.lineScx = lines;
  let start = 0;
  for (let f = 0; f < 255; f++) {
    for (let y = 0; y < SCREEN_H; y++) lines[y] = table[(start + y) % table.length] & 0xff;
    yield* run.wait(1);
    start = (start + 1) % table.length;
  }
  ppu.lineScx = null;
  ppu.wy = 0;
  ppu.bg = LAYER_BLANK; // ClearScreen with the transfer aimed at map 0
  ppu.bgPixels = null;
  yield* run.wait(3); // Delay3
  yield* run.wait(3); // BattleAnimCopyTileMapToVRAM(vBGMap1)
}

/**
 * AnimationShakeEnemyHUD: the top 7 rows (BG map 0, live, with the attacker's pic removed) shake
 * by SCX +-2 while the window (from row 7, a frozen copy) and an OAM copy of the back pic's top
 * five rows stay still.
 */
function* shakeEnemyHUD(run) {
  const view = run.view, ppu = view.ppu;
  view.loadPicIntoObjTiles('player'); // vBackPic -> vSprites
  ppu.scx = 0;
  ppu.bg = LAYER_LIVE;
  yield* run.wait(3); // copy wTileMap to BG map 0
  ppu.wy = SCREEN_H;
  ppu.win = LAYER_SNAPSHOT; // copy wTileMap to map 1 seven rows up
  ppu.winPixels = run.snapshot();
  ppu.winSrcY = 7 * 8;
  yield* run.wait(3);
  ppu.wy = 7 * 8;
  // ShakeEnemyHUD_WritePlayerMonPicOAM: 7 columns x 5 rows of the back pic copy
  const oam = view.oam;
  let i = 0, d = 0, baseX = 0x10;
  for (let c = 0; c < 7; c++) {
    let e = 0x30;
    for (let b = 0; b < 5; b++) {
      e = (e + 8) & 0xff;
      oam.set(i++, e, baseX, d, 0);
      d++;
    }
    d += 2;
    baseX += 8;
  }
  yield* run.wait(3); // BattleAnimCopyTileMapToVRAM(vBGMap0)
  run.hideMonPic();
  yield* run.wait(3);
  for (let e = 0; e < 8; e++) { // ShakeEnemyHUD_ShakeBG d = 2, e = 8
    ppu.scx = 2;
    yield* run.wait(2);
    ppu.scx = (-2) & 0xff;
    yield* run.wait(2);
  }
  ppu.scx = 0;
  yield* run.showMonPic();
  oam.clear();
  ppu.wy = SCREEN_H;
  ppu.win = LAYER_LIVE;
  ppu.winPixels = null;
  ppu.winSrcY = 0;
  yield* run.wait(3); // map 1 <- wTileMap
  ppu.wy = 0;
  yield* run.wait(3); // BattleAnimCopyTileMapToVRAM(vBGMap0)
  ppu.bg = LAYER_BLANK; // ClearScreen + Delay3 with dest map 0
  yield* run.wait(3);
  yield* run.wait(3); // BattleAnimCopyTileMapToVRAM(vBGMap1)
}

// ============================================================================ table

/** SpecialEffectPointers routine name -> generator(run). */
export const SPECIAL_EFFECT_ROUTINES = Object.freeze({
  AnimationFlashScreen: flashScreen,
  AnimationDarkScreenPalette: bgPalette('AnimationDarkScreenPalette'),
  AnimationResetScreenPalette: bgPalette('AnimationResetScreenPalette'),
  AnimationShakeScreen: shakeScreen,
  AnimationWaterDropletsEverywhere: waterDropletsEverywhere,
  AnimationDarkenMonPalette: bgPalette('AnimationDarkenMonPalette'),
  AnimationFlashScreenLong: flashScreenLong,
  AnimationSlideMonUp: slideMonUp,
  AnimationSlideMonDown: slideMonDown,
  AnimationFlashMonPic: flashMonPic,
  AnimationSlideMonOff: slideMonOff,
  AnimationBlinkMon: blinkMon,
  AnimationMoveMonHorizontally: moveMonHorizontally,
  AnimationResetMonPosition: resetMonPosition,
  AnimationLightScreenPalette: bgPalette('AnimationLightScreenPalette'),
  AnimationHideMonPic: hideMonPic,
  AnimationSquishMonPic: squishMonPic,
  AnimationShootBallsUpward: shootBallsUpward,
  AnimationShootManyBallsUpward: shootManyBallsUpward,
  AnimationBoundUpAndDown: boundUpAndDown,
  AnimationMinimizeMon: minimizeMon,
  AnimationSlideMonDownAndHide: slideMonDownAndHide,
  AnimationTransformMon: transformMon,
  AnimationLeavesFalling: leavesFalling,
  AnimationPetalsFalling: petalsFalling,
  AnimationSlideMonHalfOff: slideMonHalfOff,
  AnimationShakeEnemyHUD: shakeEnemyHUD,
  AnimationSpiralBallsInward: spiralBallsInward,
  AnimationDelay10: delay10,
  AnimationFlashEnemyMonPic: flashEnemyMonPic,
  AnimationHideEnemyMonPic: hideEnemyMonPic,
  AnimationBlinkEnemyMon: blinkEnemyMon,
  AnimationShowMonPic: showMonPic,
  AnimationShowEnemyMonPic: showEnemyMonPic,
  AnimationSlideEnemyMonOff: slideEnemyMonOff,
  AnimationShakeBackAndForth: shakeBackAndForth,
  AnimationSubstitute: substitute,
  AnimationWavyScreen: wavyScreen,
});

// ============================================================================ frame-block hooks

/** DoBallTossSpecialEffects. */
function* ballToss(run) {
  if (run.curItem < 3) run.setOBP0(run.regs.obp0 ^ 0x3c); // Master/Ultra Ball: complement colours 1 and 2
  if (run.subAnimCounter === 11) run.sfx('SFX_BALL_TOSS');
  if (run.isTrainerBattle) { // shorten the toss by one frame block
    if (run.subAnimCounter === 3) run.subAnimCounter = 2;
    return;
  }
  if (run.pokeBallAnimData !== 0x10) return; // ghost (Marowak / unidentified): dodge
  const c = run.subAnimCounter;
  if (c === 3 || c === 2 || c === 1) {
    const tm = run.tm;
    for (let r = 0; r < 7; r++) for (let k = 0; k < 7; k++) tm.set(18 - k, r, tm.tileAt(17 - k, r)); // AnimCopyRowRight
  }
}

/** DoBallShakeSpecialEffects. */
function* ballShake(run) {
  if (run.subAnimCounter === 4) {
    run.sfx('SFX_TINK');
    yield* run.wait(40);
  }
  if (run.subAnimCounter !== 1) return;
  run.numShakes = (run.numShakes - 1) & 0xff;
  if (run.numShakes === 0) return;
  run.subEntry -= 4; // -(4 * 3) bytes
  run.subAnimCounter = 5;
}

/** DoPoofSpecialEffects. */
function* poof(run) {
  if (run.subAnimCounter === 5) run.sfx('SFX_BALL_POOF');
}

/** DoRockSlideSpecialEffects. */
function* rockSlide(run) {
  const c = run.subAnimCounter;
  if (c >= 12) return;
  if (c >= 8) {
    yield* shakeScreenHorizontally(run, 1);
    yield* shakeScreenVertically(run, 1);
    return;
  }
  if (c === 1) yield* flashScreen(run);
}

function* flashEvery8(run) {
  if ((run.subAnimCounter & 7) === 0) yield* flashScreen(run);
}

function* flashEvery4(run) {
  if ((run.subAnimCounter & 3) === 0) yield* flashScreen(run);
}

/** DoExplodeSpecialEffects: hide the attacker on the last block, otherwise flash every 4. */
function* explode(run) {
  if (run.subAnimCounter === 1) { run.hideMonPic(); return; }
  yield* flashEvery4(run);
}

/** DoBlizzardSpecialEffects. */
function* blizzard(run) {
  const c = run.subAnimCounter;
  if (c === 13 || c === 9 || c === 5 || c === 1) yield* flashScreen(run);
}

/** DoGrowlSpecialEffects: copy the note (OAM 0-3) to OAM 4-7; clean up after the last block. */
function* growl(run) {
  run.view.oam.copy(0, 4, 4);
  if (run.subAnimCounter === 1) yield* cleanOam(run);
}

/** TailWhipAnimationUnused (never reached: Tail Whip has no subanimation). */
function* tailWhip(run) {
  run.subAnimCounter = 1;
  yield* run.wait(20);
}

/** TradeHidePokemon: clear the traded mon's pic at (7,2). */
function* tradeHidePokemon(run) {
  if (run.subAnimCounter === 6) run.tm.clearArea(7, 2, 7, 7);
}

/** TradeShakePokeball: on the last block the ball jumps up (-12, -12, -8, 3 frames each). */
function* tradeShakePokeball(run) {
  if (run.subAnimCounter !== 1) return;
  const oam = run.view.oam;
  for (const d of run.data.tables.BallMoveDistances1) {
    for (let i = 0; i < 4; i++) oam.y[i] = (oam.y[i] + d) & 0xff;
    yield* run.wait(3);
  }
  yield* cleanOam(run);
  run.sfx('SFX_TRADE_MACHINE');
}

/** TradeJumpPokeball: the ball hops (5 frames a step) while the BG scrolls 8 px; ends with ClearScreen. */
function* tradeJumpPokeball(run) {
  const oam = run.view.oam;
  const dist = run.data.tables.BallMoveDistances2;
  for (let k = 0; k < dist.length; k++) {
    for (let i = 0; i < 4; i++) oam.y[i] = (oam.y[i] + dist[k]) & 0xff;
    const next = dist[k + 1];
    if (next === 12 || next === undefined) run.sfx('SFX_SWAP');
    yield* run.wait(5);
    run.view.ppu.scx = (run.view.ppu.scx - 8) & 0xff;
  }
  run.tm.clearArea(0, 0, 20, 18); // ClearScreen
}

/** AnimationIdSpecialEffects routine name -> generator(run), run after every frame block. */
export const FRAME_BLOCK_HOOKS = Object.freeze({
  AnimationFlashScreen: flashScreen,
  TailWhipAnimationUnused: tailWhip,
  DoGrowlSpecialEffects: growl,
  DoBlizzardSpecialEffects: blizzard,
  FlashScreenEveryFourFrameBlocks: flashEvery4,
  FlashScreenEveryEightFrameBlocks: flashEvery8,
  DoExplodeSpecialEffects: explode,
  DoRockSlideSpecialEffects: rockSlide,
  TradeHidePokemon: tradeHidePokemon,
  TradeShakePokeball: tradeShakePokeball,
  TradeJumpPokeball: tradeJumpPokeball,
  DoBallTossSpecialEffects: ballToss,
  DoBallShakeSpecialEffects: ballShake,
  DoPoofSpecialEffects: poof,
});

// ============================================================================ applying-attack

/** PlayApplyingAttackSound: damage / super effective / not very effective (silent when immune). */
export function* playApplyingAttackSound(run) {
  yield* run.waitForSound();
  const m = (run.ctx.damageMultiplier ?? 10) & 0x7f;
  if (m === 0) return;
  if (m === 10) run.sfx('SFX_DAMAGE', 0x20, 0x30);
  else if (m > 10) run.sfx('SFX_SUPER_EFFECTIVE', 0xe0, 0xff);
  else run.sfx('SFX_NOT_VERY_EFFECTIVE', 0x50, 0x01);
}

/** AnimationTypePointerTable (wAnimationType 1-6). */
export const ANIMATION_TYPE_ROUTINES = Object.freeze({
  1: function* shakeScreenVerticallyType(run) { yield* playApplyingAttackSound(run); yield* shakeScreenVertically(run, 8); },
  2: function* shakeScreenHorizontallyHeavy(run) { yield* playApplyingAttackSound(run); yield* shakeScreenHorizontally(run, 8); },
  3: function* shakeScreenHorizontallySlowType(run) { yield* shakeScreenHorizontallySlow(run, 6, 2); },
  4: function* blinkEnemyMonSprite(run) { yield* playApplyingAttackSound(run); yield* blinkEnemyMon(run); },
  5: function* shakeScreenHorizontallyLight(run) { yield* playApplyingAttackSound(run); yield* shakeScreenHorizontally(run, 2); },
  6: function* shakeScreenHorizontallySlow2(run) { yield* shakeScreenHorizontallySlow(run, 3, 2); },
});

