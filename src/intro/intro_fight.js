// The Gengar vs Nidorino fight (PlayIntroScene in engine/movie/intro.asm).
//
// Gengar (seen from behind) is a 7x7 BG tilemap at hlcoord 13,7 of vBGMap1 and moves with
// hSCX; Nidorino is 36 OBJs (6x6, OAM_PRIO = behind the black bars and Gengar) whose
// tiles come from three 6x6 frames. Both slide in for 80 frames (Nidorino +2 px, SCX +2
// every 2 frames), then: hip/hop x2, Gengar raises its arm (SCX +8) and slashes (SCX -16)
// while Nidorino hops back, Gengar returns, Nidorino hops again, crouches and lunges.
// Every CheckForUserInterruption (A/Start, or Up+Select+B held) ends the scene early;
// either way it fades out to white (GBFadeOutToWhite) and the title screen follows.

import { GbScene, checkForUserInterruption, setPal } from './gb.js';
import { OAM_PRIO } from './ppu.js';

/** const_def -1: MOVE_NIDORINO_RIGHT, MOVE_GENGAR_RIGHT, MOVE_GENGAR_LEFT */
export const MOVE = Object.freeze({ NIDORINO_RIGHT: -1, GENGAR_RIGHT: 0, GENGAR_LEFT: 1 });

/** IntroNidorinoAnimation1..7: [dy, dx] per step, 5 frames each (ANIMATION_END stripped). */
export const NIDORINO_ANIMATIONS = Object.freeze({
  1: [[0, 0], [-2, 2], [-1, 2], [1, 2], [2, 2]],
  2: [[0, 0], [-2, -2], [-1, -2], [1, -2], [2, -2]],
  3: [[0, 0], [-12, 6], [-8, 6], [8, 6], [12, 6]],
  4: [[0, 0], [-8, -4], [-4, -4], [4, -4], [8, -4]],
  5: [[0, 0], [-8, 4], [-4, 4], [4, 4], [8, 4]],
  6: [[0, 0], [2, 0], [2, 0], [0, 0]],
  7: [[-8, -16], [-7, -14], [-6, -12], [-4, -10]],
});

export const FIGHT_TIMING = Object.freeze({
  animStepFrames: 5,   // AnimateIntroNidorino: DelayFrames 5 per step
  moveStepFrames: 2,   // IntroMoveMon: CheckForUserInterruption 2 per 2 px
});

/**
 * The script as data: what PlayIntroScene does between interruption checks.
 *   ['move', count, MOVE.*]        IntroMoveMon (count steps of 2 px)
 *   ['sfx', name]                  PlaySound
 *   ['base', tile]                 wIntroNidorinoBaseTile (0, 36 = frame 2, 72 = frame 3)
 *   ['anim', n]                    AnimateIntroNidorino(IntroNidorinoAnimation<n>)
 *   ['wait', frames]               CheckForUserInterruption
 *   ['gengar', pose]               IntroCopyTiles(TILEMAP_GENGAR_INTRO_<pose>)
 */
export const FIGHT_SCRIPT = Object.freeze([
  ['move', 40, MOVE.NIDORINO_RIGHT],
  ['sfx', 'SFX_INTRO_HIP'], ['base', 0], ['anim', 1],
  ['sfx', 'SFX_INTRO_HOP'], ['anim', 2],
  ['wait', 10],
  ['sfx', 'SFX_INTRO_HIP'], ['anim', 1],
  ['sfx', 'SFX_INTRO_HOP'], ['anim', 2],
  ['wait', 30],
  // raise
  ['gengar', 2], ['sfx', 'SFX_INTRO_RAISE'], ['move', 4, MOVE.GENGAR_LEFT],
  ['wait', 30],
  // slash
  ['gengar', 3], ['sfx', 'SFX_INTRO_CRASH'], ['move', 8, MOVE.GENGAR_RIGHT],
  ['sfx', 'SFX_INTRO_HIP'], ['base', 36], ['anim', 3],
  ['wait', 30],
  ['move', 4, MOVE.GENGAR_LEFT], ['gengar', 1],
  ['wait', 60],
  ['sfx', 'SFX_INTRO_HIP'], ['base', 0], ['anim', 4],
  ['sfx', 'SFX_INTRO_HOP'], ['anim', 5],
  ['wait', 20],
  ['base', 36], ['anim', 6],
  ['wait', 30],
  // lunge
  ['sfx', 'SFX_INTRO_LUNGE'], ['base', 72], ['anim', 7],
]);

/** Frames the fight takes when nobody presses anything (excluding the final fade). */
export function fightFrames(script = FIGHT_SCRIPT) {
  let n = 0;
  for (const [op, a] of script) {
    if (op === 'move') n += a * FIGHT_TIMING.moveStepFrames;
    else if (op === 'anim') n += NIDORINO_ANIMATIONS[a].length * FIGHT_TIMING.animStepFrames;
    else if (op === 'wait') n += a;
  }
  return n;
}

export class IntroFightScene extends GbScene {
  get id() { return 'fight'; }

  /** IntroCopyTiles: a Gengar pose at hlcoord 13,7 (CopyTileIDs also re-enables the transfer). */
  copyGengar(pose) {
    const { gb, data } = this.ctx;
    const ids = data.gengarMaps[pose - 1];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) gb.tilemap.set(13 + c, 7 + r, ids[r * 7 + c]);
    gb.autoTransfer = true;
  }

  /** UpdateIntroNidorinoOAM: every OBJ += (baseY, baseX), tiles = base tile + i. */
  updateNidorino(dy, dx) {
    const oam = this.ctx.gb.oam;
    for (let i = 0; i < 36; i++) {
      const o = oam[i];
      o.y = (o.y + dy) & 0xff;
      o.x = (o.x + dx) & 0xff;
      o.tile = (this.baseTile + i) & 0xff;
    }
  }

  /** InitIntroNidorinoOAM with wBaseCoordX = 0, wBaseCoordY = 80. */
  initNidorino() {
    let x = 0, n = 0;
    for (let col = 0; col < 6; col++) {
      let y = 80;
      for (let row = 0; row < 6; row++) {
        y += 8;
        this.ctx.gb.setSprite(n, y, x, n, OAM_PRIO);
        n++;
      }
      x += 8;
    }
  }

  /** IntroMoveMon. @returns {Generator<any, boolean>} interrupted */
  *moveMon(count, kind) {
    const gb = this.ctx.gb;
    for (let d = count; d > 0; d--) {
      if (kind === MOVE.NIDORINO_RIGHT) {
        this.updateNidorino(0, 2);
        gb.hSCX = (gb.hSCX + 2) & 0xff;
      } else if (kind === MOVE.GENGAR_LEFT) {
        gb.hSCX = (gb.hSCX + 2) & 0xff;
      } else {
        gb.hSCX = (gb.hSCX - 2) & 0xff;
      }
      if (yield* checkForUserInterruption(this.ctx.joy, FIGHT_TIMING.moveStepFrames)) return true;
    }
    return false;
  }

  /** AnimateIntroNidorino (no interruption checks inside). */
  *animate(n) {
    for (const [dy, dx] of NIDORINO_ANIMATIONS[n]) {
      this.updateNidorino(dy, dx);
      yield FIGHT_TIMING.animStepFrames;
    }
  }

  *script() {
    const { gb, game, sound, joy } = this.ctx;
    // SET_PAL_NIDORINO_INTRO; rBGP = rOBP0 = rOBP1 = %11100100
    setPal(game.palette, 0xe4, 0xe4, 0xe4);
    gb.hSCX = 0;
    this.baseTile = 0;
    this.copyGengar(1);
    this.initNidorino();
    for (const [op, a, b] of FIGHT_SCRIPT) {
      if (op === 'move') { if (yield* this.moveMon(a, b)) break; }
      else if (op === 'sfx') sound.playSfx(a);
      else if (op === 'base') this.baseTile = a;
      else if (op === 'anim') yield* this.animate(a);
      else if (op === 'wait') { if (yield* checkForUserInterruption(joy, a)) break; }
      else if (op === 'gengar') this.copyGengar(a);
    }
    // PlayIntro: GBFadeOutToWhite, hSCX = 0, transfer off, ClearSprites, DelayFrame
    yield* game.palette.fadeToWhite();
    gb.hSCX = 0;
    gb.autoTransfer = false;
    gb.clearSprites();
    yield 1;
    return { next: this.ctx.make.title({ fromIntro: true }) };
  }
}
