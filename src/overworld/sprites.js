// Sprite frame selection (SpriteFacingAndAnimationTable, data/sprites/facings.asm) and the
// Gen 1 sprite-vs-sprite collision test (DetectCollisionBetweenSprites,
// engine/overworld/sprite_collisions.asm). Pure.

import { DIR_BIT } from './constants.js';

/**
 * Sheet frame + horizontal flip for a sprite.
 * @param {any} spritesJson data/sprites.json
 * @param {{kind:string}} sprite entry of spritesJson.sprites (or an extra sheet)
 * @param {string} facing
 * @param {number} phase animation phase 0..3 (AnimFrameCounter)
 * @returns {[number, boolean]}
 */
export function spriteFrame(spritesJson, sprite, facing, phase) {
  if (!sprite || sprite.kind === 'still') return [0, false];
  const table = spritesJson.facingAnimation[facing] || spritesJson.facingAnimation.down;
  const [frame, flip] = table[phase & 3];
  // 3-frame "standing" sheets never walk; the GB would read the next sprite's tiles. Keep
  // the standing frame of that facing instead of indexing past the sheet.
  if (sprite.kind === 'standing' && frame > 2) return table[0];
  return [frame, flip];
}

/**
 * Adjusted coordinate used by DetectCollisionBetweenSprites: the cell (multiple of 16) plus
 * 7 when moving towards +, or the cell before minus 7 when moving towards -.
 * `v` is the sprite's pixel position of its 16x16 cell box (the ROM's YPIXELS + 4 / XPIXELS).
 */
export function adjustedCoord(v, d) {
  if (d === 0) return v & ~15;
  if (d > 0) return (v & ~15) | 7;
  return ((v - 1) & ~15) | 9;
}

/**
 * @typedef {Object} CollisionBody
 * @property {number} px   pixel x of the 16x16 cell box (world or screen; same origin for all)
 * @property {number} py   pixel y of the cell box (no -4 draw offset)
 * @property {number} vx   step vector -1/0/1
 * @property {number} vy
 */

/**
 * DetectCollisionBetweenSprites for sprite `i` against `others`: returns the collision
 * direction bits (DIR_BIT right 1, left 2, down 4, up 8) - exactly the ROM's
 * x#SPRITESTATEDATA1_COLLISIONDATA, including its quirks (a still sprite only records
 * up/down collisions; the thresholds are 7 for a still axis and 9 for a moving one).
 * @param {CollisionBody} i
 * @param {Iterable<CollisionBody>} others visible sprites (i excluded by the caller or by identity)
 * @returns {number}
 */
export function spriteCollisionBits(i, others) {
  const ayi = adjustedCoord(i.py, i.vy);
  const axi = adjustedCoord(i.px, i.vx);
  const tYi = (ayi & 15) ? 9 : 7;
  const tXi = (axi & 15) ? 9 : 7;
  let bits = 0;
  for (const j of others) {
    if (j === i) continue;
    const ayj = adjustedCoord(j.py, j.vy);
    const dy = Math.abs(ayj - ayi);
    let d = dy - tYi;
    if (d >= 0) {
      d -= j.vy ? 9 : 7;
      if (d > 0) continue;
    }
    const axj = adjustedCoord(j.px, j.vx);
    const dx = Math.abs(axj - axi);
    d = dx - tXi;
    if (d >= 0) {
      d -= j.vx ? 9 : 7;
      if (d > 0) continue;
    }
    // collision: pick the Y bits unless i moves horizontally only
    if (tYi < tXi) bits |= axi > axj ? DIR_BIT.left : DIR_BIT.right;
    else bits |= ayi > ayj ? DIR_BIT.up : DIR_BIT.down;
  }
  return bits;
}
