// AnimRun: the registers and helpers one playAnimation() call works with (the WRAM/HRAM
// variables of engine/battle/animations.asm) and the GB routines that only touch the tile
// map. Every timed wait goes through run.wait(n), which yields exactly n frames.

import { ENEMY_PIC, PLAYER_PIC } from './layout.js';
import { GROWL, ROAR } from './ids.js';

/** SUBANIMTYPE_* */
export const SUBANIMTYPE = Object.freeze({ NORMAL: 0, HVFLIP: 1, HFLIP: 2, COORDFLIP: 3, REVERSE: 4, ENEMY: 5 });

const MAX_SOUND_WAIT = 600;

export class AnimRun {
  /**
   * @param {import('./view.js').BattleAnimView} view
   * @param {import('./player.js').AnimContext} ctx
   */
  constructor(view, ctx) {
    this.view = view;
    this.data = view.data;
    this.ctx = ctx;
    /** hWhoseTurn: 0 = player, 1 = enemy */
    this.turn = ctx.attacker === 'enemy' || ctx.whoseTurn === 1 ? 1 : 0;
    this.sgb = !!ctx.sgb;
    /** frames yielded so far */
    this.frames = 0;
    /** wAnimationID */
    this.animId = 0;
    // subanimation registers
    this.subAnimTransform = 0;
    this.subAnimCounter = 0;
    this.subEntry = 0;
    this.subanim = null;
    this.frameDelay = 0;
    this.fbDest = 0;
    this.whichTileset = 0;
    this.animSound = null;
    this.animPalette = this.sgb ? this.data.constants.animPaletteSgb : this.data.constants.animPaletteDmg;
    // TossBallAnimation inputs (wPokeBallAnimData, wCurItem, wIsInBattle)
    const ball = normalizeBall(ctx.ball, this.data);
    this.pokeBallAnimData = ball.animData;
    this.curItem = ball.item;
    // wNumShakes keeps the last toss's value; seed it so SHAKE_ANIM played on its own shakes
    // the requested number of times (0 would make DoBallShakeSpecialEffects loop 256 times)
    this.numShakes = Math.max(1, ball.animData & 0xf);
    this.isTrainerBattle = ctx.battleType === 'trainer' || ctx.isTrainerBattle === true;
    /** wIsInBattle (1 wild, 2 trainer) */
    this.isInBattle = this.isTrainerBattle ? 2 : 1;
    this.render = !!(ctx.fb && ctx.autoRender !== false);
    this.trace = typeof ctx.onFrame === 'function' ? ctx.onFrame : null;
  }

  /** @returns {'player'|'enemy'} the side whose turn it is (the attacker) */
  side() { return this.turn ? 'enemy' : 'player'; }
  /** @returns {'player'|'enemy'} */
  otherSide() { return this.turn ? 'player' : 'enemy'; }

  /** One frame: render (when asked to) and yield. */
  *frame() {
    this.frames++;
    this.view.frame++;
    if (this.render) this.view.render(this.ctx.fb, this.ctx.redrawBattleScreen);
    if (this.trace) this.trace(this);
    yield 1;
  }

  /** DelayFrames(n). */
  *wait(n) {
    for (let i = 0; i < n; i++) yield* this.frame();
  }

  /** CallWithTurnFlipped. */
  *flipped(gen) {
    this.turn ^= 1;
    try {
      yield* gen();
    } finally {
      this.turn ^= 1;
    }
  }

  /** WaitForSoundToFinish (only if the host tells us whether a sound is playing). */
  *waitForSound() {
    const f = this.ctx.soundPlaying;
    if (typeof f !== 'function') return;
    for (let i = 0; i < MAX_SOUND_WAIT && f(); i++) yield* this.frame();
  }

  // ------------------------------------------------------------------ sound

  /** PlaySound for a sound effect constant (SFX_*) with optional pitch/tempo modifiers. */
  sfx(name, pitch = 0, tempo = 0, extra = {}) {
    const f = this.ctx.sfx;
    if (typeof f === 'function') f(name, { pitch, tempo, ...extra });
  }

  /**
   * GetMoveSound + PlaySound for a script sound ({move, sfx, pitch, tempo}). Growl and Roar
   * (IsCryMove looks at wAnimationID) play the attacker's cry with the modifiers added.
   */
  moveSound(snd) {
    if (!snd) return;
    if (this.animId === GROWL || this.animId === ROAR) {
      this.sfx('CRY', snd.pitch, snd.tempo, { cry: true, side: this.side(), move: snd.move });
    } else {
      this.sfx(snd.sfx, snd.pitch, snd.tempo, { move: snd.move });
    }
  }

  // ------------------------------------------------------------------ palettes

  get regs() { return this.view.regs; }
  setBGP(v) { this.view.setRegs({ bgp: v }); }
  setOBP0(v) { this.view.setRegs({ obp0: v }); }
  setOBP1(v) { this.view.setRegs({ obp1: v }); }

  // ------------------------------------------------------------------ tile map helpers

  get tm() { return this.view.tilemap; }

  /** Home position of the attacker's pic (hlcoord 1,5 / 12,0). */
  picHome() { return this.turn ? ENEMY_PIC : PLAYER_PIC; }

  /** CopyPicTiles base tile id (hBaseTileID): $31 player, 0 enemy. */
  picBase() { return this.turn ? 0x00 : 0x31; }

  /** A row-major tile id list from TileIDListPointerTable / picTilemaps. */
  tileList(name) { return this.data.picTilemaps[name].tiles; }

  /** AnimationHideMonPic. */
  hideMonPic() {
    const h = this.picHome();
    this.tm.clearArea(h.x, h.y, 7, 7);
  }

  /**
   * GetMonSpriteTileMapPointerFromRowCount + CopyPicTiles: the first `rows` rows of a tile
   * list, bottom-aligned in the attacker's box (or at an explicit position).
   */
  copyPicTiles(list = this.tileList('front'), rows = 7, cols = 7, at = null) {
    const h = at || this.picHome();
    const y = at ? at.y : h.y + 7 - rows;
    this.tm.copyTileIds(h.x, y, rows, cols, list, this.picBase());
  }

  /** AnimationShowMonPic (including its Delay3). */
  *showMonPic() {
    this.copyPicTiles();
    yield* this.wait(3);
  }

  /** Snapshot of the live screen (for BG map 0 / window copies); null = taken at the next render. */
  snapshot() {
    return this.view.snapshotLive(this.ctx.redrawBattleScreen);
  }
}

/**
 * Normalize ctx.ball to {item, animData}. Accepts {item, animData} (wCurItem / wPokeBallAnimData)
 * or {item, caught, shakes, ghost}. item may be a number or 'POKE_BALL' etc.
 */
export function normalizeBall(ball = {}, data) {
  const items = data.ballItems || { MASTER_BALL: 1, ULTRA_BALL: 2, GREAT_BALL: 3, POKE_BALL: 4, SAFARI_BALL: 8 };
  let item = ball.item ?? 'POKE_BALL';
  if (typeof item === 'string') item = items[item] ?? items.POKE_BALL;
  let animData = ball.animData;
  if (animData == null) {
    if (ball.ghost) animData = 0x10;
    else if (ball.caught !== false && ball.shakes == null) animData = 0x43;
    else if (ball.caught) animData = 0x43;
    else {
      const s = Math.max(0, Math.min(3, ball.shakes | 0));
      animData = s === 0 ? 0x20 : 0x60 | s;
    }
  }
  return { item, animData: animData & 0xff };
}

