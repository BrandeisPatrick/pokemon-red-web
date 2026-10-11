// Battle-screen sequences that are not entries of the animation table but draw on the same
// screen (engine/battle/core.asm, scroll_draw_trainer_pic.asm, ghost_marowak_anim.asm and the
// substitute helpers in animations.asm). String ids, see ids.js SEQUENCES.

import { BLANK } from './pics.js';
import { LAYER_BLANK, LAYER_LIVE, LAYER_SNAPSHOT } from './ppu.js';
import { OAM_PAL1, SCREEN_H } from './layout.js';
import { ANIM } from './ids.js';
import { slideMonOff, slideMonOffCore, slideMonDown, changeMonPic, SPECIAL_EFFECT_ROUTINES } from './effects.js';
import { playAnimationId, setAnimationPalette, playApplyingAttackAnimation } from './interpreter.js';

/** Load ctx.mons pics into the view when given (the host can also call view.setPic itself). */
function loadPicFromCtx(run, side) {
  const mons = run.ctx.mons || {};
  const m = mons[side];
  if (!m) return;
  const img = side === 'enemy' ? m.front : m.back;
  if (img) run.view.setPic(side, img, side === 'enemy' ? 'front' : 'back');
}

/**
 * SlidePlayerAndEnemySilhouettesOnScreen (+ LoadPlayerBackPic). Expects the enemy slot to hold
 * the wild mon / trainer pic and the player slot the player's trainer back pic
 * (assets/battle/red_back2x.png) - pass them as ctx.mons.enemy.front / ctx.mons.player.back.
 * The battle transition leaves BGP/OBP at $FF (black); the slide sets $E4.
 */
function* slideSilhouettes(run) {
  const view = run.view, tm = run.tm, ppu = view.ppu, oam = view.oam;
  loadPicFromCtx(run, 'enemy');
  loadPicFromCtx(run, 'player');
  if (run.ctx.fromTransition !== false) view.setRegs({ bgp: 0xff, obp0: 0xff, obp1: 0xff }); // BattleTransition_BlackScreen
  view.silhouette = !!run.ctx.silhouette;
  tm.reset(view.ownRegions);
  tm.copyPic(12, 0, 0x00); // InitWildBattle / InitOpponent: CopyUncompressedPicToTilemap at (12,0)
  // LoadPlayerBackPic: head = 7 columns x 3 rows of OAM, body = BG tiles at (1,5)
  view.loadPicIntoObjTiles('player');
  oam.clear();
  let tile = 0, x = 0xa0, i = 0;
  for (let col = 0; col < 7; col++) {
    let y = 0x38;
    for (let r = 0; r < 3; r++) {
      oam.set(i++, y, x, tile, 0);
      y += 8;
      tile++;
    }
    tile += 4;
    x += 8;
  }
  tm.copyPic(1, 5, 0x31);
  tm.clearArea(1, 5, 7, 3); // the head rows are sprites while sliding
  // copy wTileMap to BG map 0 (LCD off), window off
  ppu.bg = LAYER_SNAPSHOT;
  ppu.bgPixels = run.snapshot();
  ppu.wy = 0x90;
  const lines = new Int16Array(SCREEN_H);
  ppu.lineScx = lines;
  let b = 0x70, c = 0x90, top = 0x90;
  lines.fill(top);
  yield* run.wait(3); // Delay3
  yield* run.wait(1); // DelayFrame (hSCX = $90)
  view.setRegs({ bgp: 0xe4, obp0: 0xe4, obp1: 0xe4 });
  for (;;) {
    for (let y = 0; y < SCREEN_H; y++) lines[y] = y < 0x40 ? top : y < 0x60 ? b : 0;
    yield* run.wait(1);
    b = (b + 2) & 0xff;
    for (let k = 0; k < 21; k++) oam.x[k] = (oam.x[k] - 2) & 0xff; // SlidePlayerHeadLeft
    top = c; // hSCX = c, used from the next frame
    c = (c - 2) & 0xff;
    if (c === 0) break;
  }
  tm.copyPic(1, 5, 0x31); // CopyUncompressedPicToTilemap
  ppu.lineScx = null;
  ppu.wy = 0;
  yield* run.wait(3); // Delay3
  oam.hide(); // HideSprites
  view.silhouette = false;
  ppu.bg = LAYER_BLANK; // _InitBattleCommon clears BG map 0 right after
  ppu.bgPixels = null;
}

/** SlideTrainerPicOffScreen: shift 7 rows one tile per 2 frames, `amount` times. */
function* slideTrainerPicOffScreen(run, x0, y0, amount) {
  const tm = run.tm;
  for (let step = 0; step < amount; step++) {
    for (let r = 0; r < 7; r++) {
      if (amount === 8) { // .slideRight (enemy trainer)
        for (let k = 0; k < amount; k++) tm.set(x0 - k + 1, y0 + r, tm.tileAt(x0 - k, y0 + r));
      } else { // slide left (player trainer)
        for (let k = 0; k < amount; k++) tm.set(x0 + k - 1, y0 + r, tm.tileAt(x0 + k, y0 + r));
      }
    }
    yield* run.wait(2);
  }
}

/** _ScrollTrainerPicAfterBattle: the enemy trainer pic (enemy slot) scrolls in from the right. */
function* scrollTrainerPicIn(run) {
  loadPicFromCtx(run, 'enemy');
  const tm = run.tm;
  let hl = 19;
  for (let c = 1; c < 7; c++) {
    for (let col = 0; col < c; col++) {
      for (let r = 0; r < 7; r++) tm.set(hl + col, r, col * 7 + r); // DrawTrainerPicColumn
    }
    yield* run.wait(4);
    hl--;
  }
}

/** AnimateSendingOutMon: one tile, 3x3, 5x5, then the full pic, growing up and left. */
function* animateSendingOutMon(run, x, y, base) {
  const tm = run.tm;
  tm.set(x, y, (0x4c + run.isInBattle) & 0xff);
  yield* run.wait(3);
  x -= 1; y -= 2;
  tm.copyTileIds(x, y, 3, 3, run.tileList('downscaled_3x3'), base);
  yield* run.wait(4);
  x -= 1; y -= 2;
  tm.copyTileIds(x, y, 5, 5, run.tileList('downscaled_5x5'), base);
  yield* run.wait(5);
  x -= 1; y -= 2;
  tm.copyPic(x, y, (base + 0x31) & 0xff); // CopyUncompressedPicToHL
}

/** EnemySendOut: the enemy mon grows out of its ball at (12,0). */
function* sendOutEnemyMon(run) {
  loadPicFromCtx(run, 'enemy');
  run.view.oam.clear();
  yield* animateSendingOutMon(run, 15, 6, (-0x31) & 0xff);
}

/** SendOutMon: LoadMonBackPic clear, POOF_ANIM on the enemy turn (mirrored), then the grow. */
function* sendOutPlayerMon(run) {
  run.tm.clearArea(1, 5, 8, 7); // LoadMonBackPic
  loadPicFromCtx(run, 'player');
  const turn = run.turn;
  run.turn = 1;
  try {
    yield* run.waitForSound();
    setAnimationPalette(run, ANIM.POOF_ANIM);
    yield* playAnimationId(run, ANIM.POOF_ANIM);
  } finally {
    run.turn = turn;
  }
  yield* animateSendingOutMon(run, 4, 11, 0);
}

/** AnimateRetreatingPlayerMon: 5x5 (4 frames), 3x3 (3 frames), gone. */
function* retreatPlayerMon(run) {
  const tm = run.tm;
  tm.clearArea(1, 5, 7, 7);
  tm.copyTileIds(3, 7, 5, 5, run.tileList('downscaled_5x5'), 0);
  yield* run.wait(4);
  tm.clearArea(1, 5, 7, 7);
  tm.copyTileIds(4, 9, 3, 3, run.tileList('downscaled_3x3'), 0);
  yield* run.wait(3);
  tm.clearArea(1, 5, 7, 7);
  tm.set(5, 11, 0x4c); // ldcoord_a 5, 11 ... immediately cleared again
  tm.clearArea(1, 5, 7, 7);
}

/** SlideDownFaintedMonPic: 7 times, rows move down one tile and the top row blanks (2 frames). */
function* slideDownFaintedMonPic(run, x, yTop) {
  const tm = run.tm;
  for (let step = 0; step < 7; step++) {
    for (let r = 5; r >= 0; r--) tm.copyRow(x, yTop + r, x, yTop + r + 1, 7);
    tm.fill(x, yTop, 7, 1, BLANK); // PlaceString SevenSpacesText
    yield* run.wait(2);
  }
}

/** HideSubstituteShowMonAnim: doll slides off (or down if it broke), the mon comes back. */
function* hideSubstituteShowMon(run) {
  if (run.ctx.substituteUp === false) yield* slideMonDown(run);
  else yield* slideMonOff(run);
  if (run.ctx.minimized) {
    yield* SPECIAL_EFFECT_ROUTINES.AnimationMinimizeMon(run);
  } else {
    changeMonPic(run, false); // AnimationFlashMonPic
    yield* run.showMonPic();
  }
}

/** ReshowSubstituteAnim. */
function* reshowSubstitute(run) {
  yield* slideMonOff(run);
  yield* SPECIAL_EFFECT_ROUTINES.AnimationSubstitute(run);
  yield* run.showMonPic();
}

/** MarowakAnim: the ghost (as sprites) flashes, fades out, and Marowak fades in. */
function* marowakUnveil(run) {
  const view = run.view, ppu = view.ppu, oam = view.oam;
  run.turn = 1;
  view.setRegs({ obp1: 0xe4 });
  const copyPicToSprites = () => { // CopyMonPicFromBGToSpriteVRAM
    view.loadPicIntoObjTiles('enemy');
    oam.clear();
    let i = 0, d = 8, baseX = 0x70;
    for (let b = 0; b < 6; b++) {
      let e = 0x10;
      for (let c = 0; c < 6; c++) {
        e = (e + 8) & 0xff;
        oam.set(i++, e, baseX, d, OAM_PAL1);
        d++;
      }
      d++;
      baseX += 8;
    }
  };
  copyPicToSprites();
  run.tm.clearArea(12, 0, 7, 7);
  yield* run.wait(3);
  ppu.win = LAYER_SNAPSHOT; // hAutoBGTransferEnabled = 0: the window keeps the cleared box
  ppu.winPixels = run.snapshot();
  changeMonPic(run, false); // ChangeMonPic with RESTLESS_SOUL = ctx.mons.enemy.front
  for (let i = 0; i < 8; i++) { // FlashSprite8Times (d = $80)
    view.setRegs({ obp1: view.regs.obp1 ^ 0x80 });
    yield* run.wait(10);
  }
  do { // .fadeOutGhostLoop
    yield* run.wait(10);
    view.setRegs({ obp1: (view.regs.obp1 << 2) & 0xff });
  } while (view.regs.obp1 !== 0);
  oam.clear();
  copyPicToSprites();
  let b = 0xe4;
  do { // .fadeInMarowakLoop
    yield* run.wait(10);
    let a = view.regs.obp1;
    for (let k = 0; k < 2; k++) { const carry = b & 1; b >>= 1; a = (a >> 1) | (carry << 7); }
    view.setRegs({ obp1: a });
  } while (b !== 0);
  ppu.win = LAYER_LIVE;
  ppu.winPixels = null;
  yield* run.wait(3);
  oam.clear();
}

function applyingAttack(type) {
  return function* applying(run) {
    setAnimationPalette(run, 0);
    yield* playApplyingAttackAnimation(run, type);
  };
}

/** Sequence id -> generator(run). */
export const SEQUENCE_ROUTINES = Object.freeze({
  SLIDE_SILHOUETTES: slideSilhouettes,
  SLIDE_TRAINER_OFF_ENEMY: (run) => slideTrainerPicOffScreen(run, 18, 0, 8),
  SLIDE_TRAINER_OFF_PLAYER: (run) => slideTrainerPicOffScreen(run, 1, 5, 9),
  SCROLL_TRAINER_PIC_IN: scrollTrainerPicIn,
  SEND_OUT_ENEMY_MON: sendOutEnemyMon,
  SEND_OUT_PLAYER_MON: sendOutPlayerMon,
  RETREAT_PLAYER_MON: retreatPlayerMon,
  FAINT_ENEMY_MON: (run) => slideDownFaintedMonPic(run, 12, 0),
  FAINT_PLAYER_MON: (run) => slideDownFaintedMonPic(run, 1, 5),
  ENEMY_RAN: function* enemyRan(run) { run.turn = 1; yield* slideMonOffCore(run, 8, 3); },
  HIDE_SUBSTITUTE_SHOW_MON: hideSubstituteShowMon,
  RESHOW_SUBSTITUTE: reshowSubstitute,
  MAROWAK_UNVEIL: marowakUnveil,
  ANIMATIONTYPE_SHAKE_SCREEN_VERTICALLY: applyingAttack(1),
  ANIMATIONTYPE_SHAKE_SCREEN_HORIZONTALLY_HEAVY: applyingAttack(2),
  ANIMATIONTYPE_SHAKE_SCREEN_HORIZONTALLY_SLOW: applyingAttack(3),
  ANIMATIONTYPE_BLINK_ENEMY_MON_SPRITE: applyingAttack(4),
  ANIMATIONTYPE_SHAKE_SCREEN_HORIZONTALLY_LIGHT: applyingAttack(5),
  ANIMATIONTYPE_SHAKE_SCREEN_HORIZONTALLY_SLOW_2: applyingAttack(6),
});

