// playAnimation(animId, ctx): play one battle animation as a coroutine.
//
//   yield* playAnimation('THUNDERBOLT', { view, attacker: 'player', palette: game.palette,
//                                         sfx: (name, o) => audio.playSfx(name, o), animationType: 4 });
//
// Every value the generator yields is the number 1 = exactly one 60 Hz frame (so it runs
// unchanged inside the engine's Coroutine/Scene runner, and a test can count frames with a
// plain for..of). The animation state lives in a BattleAnimView, which the battle scene
// renders every frame (view.render(fb, drawScreen)); with ctx.fb + ctx.redrawBattleScreen
// the player also renders each frame itself (test page, headless tests).

import { AnimRun } from './runtime.js';
import { moveAnimation } from './interpreter.js';
import { SEQUENCE_ROUTINES } from './sequences.js';
import { resolveAnimId } from './ids.js';
import { BattleAnimView } from './view.js';

/**
 * @typedef {Object} AnimContext
 * @property {BattleAnimView} [view]   persistent battle-screen state (created from `data` if missing and stored back)
 * @property {import('./data.js').BattleAnimData} [data]  needed when no view is given
 * @property {'player'|'enemy'} [attacker]  whose turn it is (hWhoseTurn), default 'player'
 * @property {{pixels: Uint8Array}} [fb]   if given (with autoRender !== false) every frame is rendered into it
 * @property {(screen: import('../engine/framebuffer.js').FrameBuffer, view: BattleAnimView) => void} [redrawBattleScreen]
 *   draws the battle screen without the pics (HUDs, text box, menus) into the buffer it gets
 * @property {import('../engine/palette.js').Palette} [palette]  rBGP/rOBP0/rOBP1 effects are applied to it
 * @property {(name: string, opts: {pitch:number, tempo:number, move?:string, cry?:boolean, side?:string}) => void} [sfx]
 *   sound hook: SFX_* constant (or 'CRY' for Growl/Roar with the attacker side) + pitch/tempo modifiers
 * @property {() => boolean} [soundPlaying]  WaitForSoundToFinish polls it (optional)
 * @property {{player?: {front?: object, back?: object}, enemy?: {front?: object, back?: object}}} [mons]
 *   IndexedImages for pic reloads: own pic (FlashMonPic, substitute end), opponent's (Transform),
 *   send-out / intro pics
 * @property {object} [gfx]  overrides data.gfx (anim sheets, monster sprite, battle tiles)
 * @property {object} [rng]  accepted for API symmetry (no Gen 1 animation is random)
 * @property {number} [animationType]  wAnimationType 0-6 (applying-attack effect after the animation)
 * @property {number} [damageMultiplier]  wDamageMultipliers & $7f (10 neutral, 20 super, 5 not very, 0 immune)
 * @property {{item?: string|number, animData?: number, caught?: boolean, shakes?: number, ghost?: boolean}} [ball]
 * @property {'wild'|'trainer'} [battleType]
 * @property {boolean} [animations]  false = battle animations off in the options (30-frame pause)
 * @property {boolean} [sgb]  use the SGB register values (wOnSGB)
 * @property {boolean} [substituteUp] @property {boolean} [minimized]  HIDE_SUBSTITUTE_SHOW_MON inputs
 * @property {number} [preDelay]  frames to wait first (core.asm's PlayMoveAnimation does Delay3)
 * @property {boolean} [restorePalette]  restore BGP/OBP0/OBP1 afterwards (default: true for table
 *   animations, false for sequences, which set the palette on purpose, e.g. the intro)
 * @property {boolean} [clearSprites]  clear leftover OAM afterwards (default false: the GB keeps
 *   e.g. the caught ball of TOSS_ANIM on screen until the battle engine clears the sprites)
 * @property {(run: AnimRun) => void} [onFrame]  called once per frame (tests / tracing)
 */

/**
 * Play animation `animId` (1-203, a constant name like 'TACKLE' / 'TOSS_ANIM', or a sequence id
 * from ids.js SEQUENCES). Returns {frames} when done.
 * @param {number|string} animId
 * @param {AnimContext} ctx
 */
export function* playAnimation(animId, ctx = {}) {
  let view = ctx.view;
  if (!view) {
    if (!ctx.data) throw new Error('playAnimation: ctx.view or ctx.data is required');
    view = ctx.view = new BattleAnimView(ctx.data);
  }
  if (ctx.gfx) view.data = { ...view.data, gfx: { ...view.data.gfx, ...ctx.gfx } };
  if (ctx.palette) view.palette = ctx.palette;
  const id = resolveAnimId(view.data, animId);
  if (id == null) throw new Error(`playAnimation: unknown animation ${animId}`);
  if (typeof id === 'number' && (id < 0 || id > view.data.animations.length)) throw new Error(`playAnimation: animation id ${id} out of range`);
  const run = new AnimRun(view, ctx);
  const saved = view.readRegs(ctx.palette);
  view.regs = { ...saved };
  try {
    if (ctx.preDelay) yield* run.wait(ctx.preDelay | 0);
    if (typeof id === 'string') {
      const fn = SEQUENCE_ROUTINES[id];
      if (!fn) throw new Error(`playAnimation: no sequence ${id}`);
      yield* fn(run);
    } else {
      yield* moveAnimation(run, id);
    }
  } finally {
    if (ctx.clearSprites === true) view.oam.clear();
    const restore = ctx.restorePalette ?? typeof id === 'number';
    if (restore) view.setRegs(saved);
  }
  return { frames: run.frames };
}

/**
 * Run an animation to completion synchronously (headless): returns the frame count. `onFrame`
 * (optional) is called after each frame.
 */
export function runAnimation(animId, ctx, onFrame) {
  const gen = playAnimation(animId, ctx);
  let frames = 0;
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value ? r.value.frames : frames;
    frames++;
    if (onFrame) onFrame(frames);
    if (frames > 100000) throw new Error(`runAnimation: ${animId} does not terminate`);
  }
}
