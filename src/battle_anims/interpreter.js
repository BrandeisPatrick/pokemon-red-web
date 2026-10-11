// The animation command interpreter: PlayAnimation, LoadSubanimation, PlaySubanimation,
// DrawFrameBlock, DoSpecialEffectByAnimationId, plus MoveAnimation / TossBallAnimation /
// PlayApplyingAttackAnimation from engine/battle/animations.asm.

import { SUBANIMTYPE } from './runtime.js';
import { SPECIAL_EFFECT_ROUTINES, FRAME_BLOCK_HOOKS, ANIMATION_TYPE_ROUTINES, cleanOam } from './effects.js';
import { ANIM, GROWL, AMNESIA, REST } from './ids.js';
import { MIRROR_X, MIRROR_Y, HFLIP_Y_SHIFT, OAM_XFLIP, OAM_YFLIP } from './layout.js';

/** DrawFrameBlock: write the block's tiles to OAM from run.fbDest, then wait/clean per mode. */
export function* drawFrameBlock(run, blockIndex, baseIndex, mode) {
  const data = run.data;
  const tiles = data.frameBlocks[blockIndex];
  const base = data.baseCoords[baseIndex];
  if (!tiles) throw new Error(`frame block ${blockIndex} does not exist`);
  if (!base) throw new Error(`base coordinate ${baseIndex} does not exist`);
  const oam = run.view.oam;
  const tileBase = data.frameBlockTileBase;
  const dest = run.fbDest;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    let y, x, flags = t.flags;
    switch (run.subAnimTransform) {
      case SUBANIMTYPE.HVFLIP: // .flipHorizontalAndVertical
        y = MIRROR_Y - ((base.y + t.y) & 0xff);
        x = MIRROR_X - ((base.x + t.x) & 0xff);
        if (flags === 0) flags = OAM_XFLIP | OAM_YFLIP;
        else if (flags === OAM_XFLIP) flags = OAM_YFLIP;
        else if (flags === OAM_YFLIP) flags = OAM_XFLIP;
        else flags = 0;
        break;
      case SUBANIMTYPE.HFLIP: // .flipHorizontalTranslateDown
        y = base.y + t.y + HFLIP_Y_SHIFT;
        x = MIRROR_X - ((base.x + t.x) & 0xff);
        flags ^= OAM_XFLIP;
        break;
      case SUBANIMTYPE.COORDFLIP: // .flipBaseCoords
        y = ((MIRROR_Y - base.y) & 0xff) + t.y;
        x = ((MIRROR_X - base.x) & 0xff) + t.x;
        break;
      default: // no transformation (NORMAL, REVERSE)
        y = base.y + t.y;
        x = base.x + t.x;
    }
    oam.set(dest + i, y, x, tileBase + t.tile, flags);
  }
  const end = dest + tiles.length;
  if (mode === 2) { // FRAMEBLOCKMODE_02: no delay, keep OAM, append
    run.fbDest = end;
    return;
  }
  yield* run.wait(run.frameDelay);
  if (mode === 3) { // keep OAM, append
    run.fbDest = end;
    return;
  }
  if (mode === 4) return; // keep OAM, next block overwrites from the same slot
  if (run.animId !== GROWL) yield* cleanOam(run);
  run.fbDest = 0;
}

/** LoadSubanimation: header, transform for this turn, first entry. */
export function loadSubanimation(run, subIndex) {
  const sub = run.data.subanims[subIndex];
  if (!sub) throw new Error(`subanimation ${subIndex} does not exist`);
  run.subanim = sub;
  run.subAnimCounter = sub.entries.length & 0x1f;
  let t;
  if (sub.type === SUBANIMTYPE.ENEMY) t = run.turn === 0 ? SUBANIMTYPE.HFLIP : SUBANIMTYPE.NORMAL; // GetSubanimationTransform2
  else t = run.turn === 0 ? SUBANIMTYPE.NORMAL : sub.type; // GetSubanimationTransform1
  run.subAnimTransform = t;
  run.subEntry = t === SUBANIMTYPE.REVERSE ? sub.entries.length - 1 : 0;
}

/** DoSpecialEffectByAnimationId: the per-animation hook after each frame block. */
export function* doSpecialEffectByAnimationId(run) {
  const routine = run.data.hooks[run.animId];
  if (!routine) return;
  const fn = FRAME_BLOCK_HOOKS[routine];
  if (!fn) throw new Error(`no implementation for frame block hook ${routine}`);
  yield* fn(run);
}

/** PlaySubanimation. */
export function* playSubanimation(run) {
  run.moveSound(run.animSound);
  run.fbDest = 0;
  const entries = run.subanim.entries;
  for (let guard = 0; ; guard++) {
    if (guard > 4096) throw new Error(`${run.subanim.const}: subanimation does not terminate`);
    const e = entries[run.subEntry];
    if (!e) throw new Error(`${run.subanim.const}: entry ${run.subEntry} out of range`);
    yield* drawFrameBlock(run, e.frameBlock, e.baseCoord, e.mode);
    yield* doSpecialEffectByAnimationId(run);
    run.subAnimCounter = (run.subAnimCounter - 1) & 0xff;
    if (run.subAnimCounter === 0) return;
    run.subEntry += run.subAnimTransform === SUBANIMTYPE.REVERSE ? -1 : 1;
  }
}

/** PlayAnimation: run the script of run.animId. */
export function* playAnimationScript(run) {
  run.subAnimTransform = 0;
  const anim = run.data.animations[run.animId - 1];
  if (!anim) throw new Error(`animation ${run.animId} does not exist`);
  for (const cmd of anim.commands) {
    if (cmd.op === 'special') {
      run.moveSound(cmd.sound);
      const fn = SPECIAL_EFFECT_ROUTINES[cmd.routine];
      if (!fn) throw new Error(`no implementation for special effect ${cmd.routine}`);
      yield* fn(run);
    } else {
      run.frameDelay = cmd.delay;
      run.whichTileset = cmd.tileset;
      run.animSound = cmd.sound;
      const savedObp0 = run.regs.obp0;
      run.setOBP0(run.animPalette);
      run.view.loadAnimTiles(cmd.tileset);
      loadSubanimation(run, cmd.subanim);
      yield* playSubanimation(run);
      run.setOBP0(savedObp0);
    }
  }
}

/** Play animation `id` with PlayAnimation (sets wAnimationID first). */
export function* playAnimationId(run, id) {
  run.animId = id;
  yield* playAnimationScript(run);
}

/** SetAnimationPalette. */
export function setAnimationPalette(run, animId) {
  const c = run.data.constants;
  if (run.sgb) {
    run.animPalette = c.animPaletteSgb;
    const trade = animId >= ANIM.TRADE_BALL_DROP_ANIM && animId <= ANIM.TRADE_BALL_POOF_ANIM;
    run.view.setRegs({ obp0: trade ? c.animPaletteSgb : 0xe4, obp1: c.obp1 });
  } else {
    run.animPalette = c.animPaletteDmg;
    run.view.setRegs({ obp0: c.animPaletteDmg, obp1: c.obp1 });
  }
}

/** ShareMoveAnimations: on the enemy's turn Amnesia and Rest borrow the status animations. */
export function shareMoveAnimations(run, animId) {
  if (!run.turn) return animId;
  if (animId === AMNESIA) return ANIM.CONF_ANIM;
  if (animId === REST) return ANIM.SLP_ANIM;
  return animId;
}

/** PlayApplyingAttackAnimation (wAnimationType). */
export function* playApplyingAttackAnimation(run, type = run.ctx.animationType | 0) {
  if (!type) return;
  const fn = ANIMATION_TYPE_ROUTINES[type];
  if (!fn) throw new Error(`unknown animation type ${type}`);
  yield* fn(run);
}

/**
 * TossBallAnimation: toss (+ poof, hide, shakes, poof, show) driven by wPokeBallAnimData, or the
 * trainer block.
 */
export function* tossBallAnimation(run) {
  if (run.isTrainerBattle) {
    yield* playAnimationId(run, ANIM.TOSS_ANIM);
    run.sfx('SFX_FAINT_THUD');
    yield* playAnimationId(run, ANIM.BLOCKBALL_ANIM);
    return;
  }
  const b = run.pokeBallAnimData;
  let count = (b >> 4) & 0xf;
  if (count === 0) count = 1; // (0 would make the GB loop 256 times through memory)
  run.numShakes = b & 0xf;
  const items = run.data.ballItems;
  const list = run.data.tables.PokeBallAnimations.map((n) => run.data.ids[n]);
  let id = run.curItem === items.POKE_BALL ? ANIM.TOSS_ANIM : run.curItem === items.GREAT_BALL ? ANIM.GREATTOSS_ANIM : ANIM.ULTRATOSS_ANIM;
  for (let k = 0; ; k++) {
    yield* playAnimationId(run, id);
    if (--count === 0) break;
    id = list[k];
    if (id == null) break;
  }
}

/**
 * MoveAnimation: WaitForSoundToFinish, SetAnimationPalette, then the toss sequence or
 * ShareMoveAnimations + PlayAnimation (or 30 frames when animations are off) and the
 * applying-attack animation.
 */
export function* moveAnimation(run, animId) {
  yield* run.waitForSound();
  setAnimationPalette(run, animId);
  if (animId === 0) return;
  if (animId === ANIM.TOSS_ANIM) {
    run.animId = animId;
    yield* tossBallAnimation(run);
  } else {
    if (run.ctx.animations === false) {
      yield* run.wait(30);
    } else {
      run.animId = shareMoveAnimations(run, animId);
      yield* playAnimationScript(run);
    }
    yield* playApplyingAttackAnimation(run);
  }
  yield* run.waitForSound();
}
