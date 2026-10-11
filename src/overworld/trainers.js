// Trainer line of sight (CheckFightingMapTrainers / TrainerEngage / CheckSpriteCanSeePlayer /
// CheckPlayerIsInFrontOfSprite, engine/overworld/trainer_sight.asm + home/trainers.asm). Pure.
//
// The ROM compares *screen pixel* positions: the trainer must be exactly lined up with the
// player (same row or column, not mid-step), facing the player, within sightRange steps,
// with the player in front of it. Distances below are pixel differences of the cell boxes.

/**
 * @param {{px:number,py:number,facing:string,visible:boolean}} trainer
 * @param {{px:number,py:number}} player   cell-box pixel position (aligned when standing)
 * @param {number} sightRange in steps (header byte = range << 4)
 * @param {{bypassFrontCheck?: boolean}} [opts] Power Plant: no in-front check
 * @returns {number} steps between trainer and player when engaging (>= 1), else 0
 */
export function trainerSeesPlayer(trainer, player, sightRange, opts = {}) {
  if (!trainer.visible || sightRange <= 0) return 0;
  const dxp = trainer.px - player.px; // trainer screen X - $40
  const dyp = trainer.py - player.py; // trainer screen Y - $3c
  let dist;
  if (dyp === 0) {
    // lined up on the same row: must face left/right
    dist = Math.abs(dxp);
    if (dist === 0) return 0;
    if (dist > sightRange * 16) return 0;
    if (trainer.facing !== 'left' && trainer.facing !== 'right') return 0;
  } else if (dxp === 0) {
    dist = Math.abs(dyp);
    if (dist > sightRange * 16) return 0;
    if (trainer.facing !== 'up' && trainer.facing !== 'down') return 0;
  } else {
    return 0;
  }
  if (!opts.bypassFrontCheck) {
    switch (trainer.facing) {
      case 'down': if (!(dyp < 0)) return 0; break; // trainer above the player
      case 'up': if (!(dyp >= 0)) return 0; break; // below
      case 'left': if (!(dxp >= 0)) return 0; break; // right of the player
      case 'right': if (!(dxp < 0)) return 0; break; // left of the player
      default: return 0;
    }
  }
  return Math.max(1, Math.round(dist / 16));
}

/**
 * TrainerWalkUpToPlayer: the trainer walks (distance - 1) steps in its facing direction.
 * @returns {string[]} directions
 */
export function trainerApproachPath(facing, steps) {
  const n = Math.max(0, steps - 1);
  return Array.from({ length: n }, () => facing);
}
