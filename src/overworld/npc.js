// NPCs / object events: state + the Gen 1 movement state machine, transcribed from
// engine/overworld/movement.asm (UpdateNPCSprite, TryWalking, CanWalkOntoTile,
// UpdateSpriteInWalkingAnimation, UpdateSpriteMovementDelay, CheckSpriteAvailability,
// MakeNPCFacePlayer, DoScriptedNPCMovement). Pure: the caller passes a `world` object.
//
// One NPC update = one overworld-loop iteration (UpdateSprites), i.e. every 2 frames.
// NPCs walk 1 px per update (16 updates = 32 frames per step: half the player's speed).

import { DIR_DELTA, DIR_BIT, OPPOSITE, NPC_WALK_UPDATES } from './constants.js';
import { spriteCollisionBits } from './sprites.js';

/** Movement byte 1 values. */
export const MOVE_WALK = 'WALK';
export const MOVE_STAY = 'STAY';
export const MOVE_SCRIPTED = 'SCRIPTED';

/** Movement status (x#SPRITESTATEDATA1_MOVEMENTSTATUS). */
export const STATUS = Object.freeze({ UNINIT: 0, READY: 1, DELAYED: 2, WALKING: 3 });

const BYTE2_DIRECTION = { 0xd0: 'down', 0xd1: 'up', 0xd2: 'left', 0xd3: 'right' };
const UP_DOWN = 1, LEFT_RIGHT = 2;

/**
 * @typedef {Object} NpcWorld
 * @property {{randByte:()=>number}} rng
 * @property {{x:number,y:number,px:number,py:number,vx:number,vy:number,walkCounter:number,direction:string}} player
 *   player logical step position (wXCoord/wYCoord), cell-box pixel position, step vector,
 *   wWalkCounter and wPlayerDirection
 * @property {(x:number,y:number)=>number} cellTile     bottom-left tile of a step
 * @property {(x:number,y:number)=>number} cellTileTR   top-right tile of a step
 * @property {(tile:number)=>boolean} isWalkable
 * @property {number|null} grassTile
 * @property {(npc:Npc)=>boolean} isHidden            toggleable object hidden (state.missables)
 * @property {(npc:Npc)=>boolean} [coveredByUi]       text box over the sprite's cell
 * @property {(npc:Npc)=>Iterable<any>} bodies        visible sprites (player + NPCs) for collisions
 * @property {(npc:Npc)=>void} [onScriptDone]         scripted movement finished
 */

export class Npc {
  /**
   * @param {any} def      objectEvents[i] of the map JSON
   * @param {any} sprite   data/sprites.json entry (null if unknown)
   */
  constructor(def, sprite) {
    this.def = def;
    this.index = def.index; // 1-based sprite slot
    this.sprite = sprite;
    /** logical step position (MAPX/MAPY minus 4); the destination while walking */
    this.x = def.x;
    this.y = def.y;
    /** pixel position of the 16x16 cell box in map pixels (no -4 draw offset) */
    this.px = def.x * 16;
    this.py = def.y * 16;
    this.facing = 'down'; // LoadMapHeader zeroes the sprite data (facing 0 = down)
    this.movement = def.movement === 'WALK' ? MOVE_WALK : MOVE_STAY;
    /** movement byte 2 (rangeOrDirectionValue) */
    this.byte2 = def.rangeOrDirectionValue ?? 0xff;
    this.status = STATUS.UNINIT;
    this.delay = 0;
    this.walkCounter = 0;
    this.vx = 0;
    this.vy = 0;
    this.intraAnim = 0;
    this.animFrame = 0;
    this.dispX = 8;
    this.dispY = 8;
    /** visible on screen (image index != $ff) */
    this.visible = false;
    /** OAM priority under grass (lower half behind BG colours 1-3) */
    this.grass = false;
    this.facePlayerPending = false;
    /** displayed image: facing + animation phase (UpdateSpriteImage snapshot) */
    this.imageFacing = 'down';
    this.imageAnim = 0;
    /** scripted movement queue (wNPCMovementDirections): 'down'|'up'|'left'|'right'|{face} */
    this.script = null;
    /** DoScriptedNPCMovement: walk in sync with the player (2 px per update) */
    this.syncScript = null;
    /** original movement restored after a scripted move (when requested) */
    this._restoreMovement = null;
  }

  get scripted() { return this.movement === MOVE_SCRIPTED; }
  get moving() { return this.status === STATUS.WALKING || !!(this.syncScript && this.syncScript.active); }

  /** Collision body (DetectCollisionBetweenSprites inputs). */
  get body() { return this; }

  /** Place the NPC on a step (scripts / teleports). */
  setPosition(x, y) {
    this.x = x; this.y = y;
    this.px = x * 16; this.py = y * 16;
    this.walkCounter = 0;
    this.vx = 0; this.vy = 0;
    if (this.status === STATUS.WALKING) this.status = STATUS.READY;
  }

  /** Turn to a direction now (scripts: faceNpc). */
  face(dir) {
    this.facing = dir;
    this.imageFacing = dir;
    this.imageAnim = 0;
  }

  /**
   * Start a scripted walk (MoveSprite): directions are walked one after another, ignoring
   * collisions, even off screen. When the list ends the NPC becomes STAY (movement byte 1 =
   * $FF, like the ROM) unless `restore` is set.
   * @param {Array<string|{face:string}>} steps
   * @param {{restore?: boolean}} [opts]
   */
  startScript(steps, opts = {}) {
    this._restoreMovement = opts.restore ? this.movement : null;
    this.movement = MOVE_SCRIPTED;
    this.script = steps.slice();
    if (this.status !== STATUS.WALKING) this.status = STATUS.READY;
  }

  /** DoScriptedNPCMovement: walk `steps` in lock-step with the player (2 px per update). */
  startSyncScript(steps) {
    this.syncScript = { steps: steps.slice(), index: 0, counter: 8, active: true, started: false };
  }
}

/**
 * UpdateNPCSprite for one NPC (one overworld-loop iteration).
 * @param {Npc} npc
 * @param {NpcWorld} world
 */
export function updateNpc(npc, world) {
  if (npc.syncScript && npc.syncScript.active) {
    if (!checkAvailability(npc, world)) return;
    doScriptedNpcMovement(npc, world);
    return;
  }
  if (npc.status === STATUS.UNINIT) {
    // InitializeSpriteStatus: ready, invisible, displacement window centred
    npc.status = STATUS.READY;
    npc.visible = false;
    npc.dispX = 8;
    npc.dispY = 8;
    return;
  }
  if (!checkAvailability(npc, world)) return;
  if (npc.facePlayerPending) {
    makeNpcFacePlayer(npc, world);
    return;
  }
  if (npc.status === STATUS.DELAYED) { updateMovementDelay(npc); return; }
  if (npc.status === STATUS.WALKING) { updateWalking(npc, world); return; }
  // ready
  if (world.player.walkCounter !== 0) return; // don't start while the player is mid-step
  // InitializeSpriteScreenPosition: re-snap to the logical cell
  npc.px = npc.x * 16;
  npc.py = npc.y * 16;
  if (npc.scripted) {
    const next = npc.script && npc.script.length ? npc.script.shift() : undefined;
    if (next === undefined) {
      // end of wNPCMovementDirections: movement byte 1 = STAY
      npc.movement = npc._restoreMovement || MOVE_STAY;
      npc._restoreMovement = null;
      npc.script = null;
      if (world.onScriptDone) world.onScriptDone(npc);
      return;
    }
    if (typeof next === 'object' && next.face) {
      // NPC_CHANGE_FACING
      npc.facing = next.face;
      npc.imageFacing = next.face;
      return;
    }
    tryWalking(npc, next, world);
    return;
  }
  const r = world.rng.randByte();
  tryWalking(npc, randomDirection(npc.byte2, r), world);
}

/**
 * Direction chosen by UpdateNPCSprite.determineDirection from movement byte 2 and a random
 * byte (hRandomAdd).
 */
export function randomDirection(byte2, r) {
  const fixed = BYTE2_DIRECTION[byte2];
  if (fixed) return fixed;
  if (r < 0x40) return byte2 === LEFT_RIGHT ? 'left' : 'down';
  if (r < 0x80) return byte2 === LEFT_RIGHT ? 'right' : 'up';
  if (r < 0xc0) return byte2 === UP_DOWN ? 'up' : 'left';
  return byte2 === UP_DOWN ? 'down' : 'right';
}

/** TryWalking: face `dir`, then start a step if CanWalkOntoTile allows it. */
export function tryWalking(npc, dir, world) {
  const [dx, dy] = DIR_DELTA[dir];
  npc.facing = dir;
  npc.vx = dx;
  npc.vy = dy;
  if (!canWalkOntoTile(npc, dir, world)) return false;
  npc.x += dx;
  npc.y += dy;
  npc.walkCounter = NPC_WALK_UPDATES;
  npc.status = STATUS.WALKING;
  updateImage(npc);
  return true;
}

/**
 * CanWalkOntoTile. On failure the NPC is put in the delayed state with a random delay.
 * Scripted NPCs always may walk.
 */
export function canWalkOntoTile(npc, dir, world) {
  if (npc.scripted) return true;
  const [dx, dy] = DIR_DELTA[dir];
  const ok = (() => {
    if (!world.isWalkable(world.cellTile(npc.x + dx, npc.y + dy))) return false;
    if (npc.movement === MOVE_STAY) return false; // only turning is allowed
    // stay on screen: (YPIXELS+4)+d < $80 and XPIXELS+e < $90 with the sprite's screen cell
    const p = world.player;
    const rowPx = (npc.y - p.y + 4) * 16 + dy;
    const colPx = (npc.x - p.x + 4) * 16 + dx;
    if (rowPx < 0 || rowPx >= 0x80 || colPx < 0 || colPx >= 0x90) return false;
    // sprite collisions (with the step vector already set)
    const bits = spriteCollisionBits(npc, world.bodies(npc));
    if (bits & DIR_BIT[dir]) return false;
    // displacement window (with the ROM's quirks: walking up 5+ steps blocks sideways/down
    // moves, nothing limits walking right/down)
    let ny;
    if (dy < 0) {
      if (npc.dispY === 0) return false;
      ny = npc.dispY - 1;
    } else {
      ny = (npc.dispY + dy) & 0xff;
      if (ny < 5) return false;
    }
    let nx;
    if (dx < 0) {
      if (npc.dispX === 0) return false;
      nx = npc.dispX - 1;
    } else {
      nx = (npc.dispX + dx) & 0xff;
    }
    npc.dispX = nx;
    npc.dispY = ny;
    return true;
  })();
  if (!ok) {
    npc.status = STATUS.DELAYED;
    npc.vx = 0;
    npc.vy = 0;
    npc.delay = world.rng.randByte() & 0x7f;
  }
  return ok;
}

/** UpdateSpriteInWalkingAnimation: 1 px per update, anim frame every 4 updates. */
function updateWalking(npc, world) {
  npc.intraAnim++;
  if (npc.intraAnim === 4) {
    npc.intraAnim = 0;
    npc.animFrame = (npc.animFrame + 1) & 3;
  }
  npc.py += npc.vy;
  npc.px += npc.vx;
  npc.walkCounter--;
  if (npc.walkCounter !== 0) return;
  if (npc.scripted) {
    npc.status = STATUS.READY; // scripted: next step right away (vectors kept)
    return;
  }
  npc.delay = world.rng.randByte() & 0x7f; // 0 means 256 updates
  npc.status = STATUS.DELAYED;
  npc.vx = 0;
  npc.vy = 0;
}

/** UpdateSpriteMovementDelay (+ NotYetMoving). */
function updateMovementDelay(npc) {
  if (npc.scripted) {
    npc.delay = 0;
    npc.status = STATUS.READY;
  } else {
    npc.delay = (npc.delay - 1) & 0xff;
    if (npc.delay === 0) npc.status = STATUS.READY;
  }
  notYetMoving(npc);
}

/** NotYetMoving: standing frame. */
function notYetMoving(npc) {
  npc.animFrame = 0;
  updateImage(npc);
}

/** MakeNPCFacePlayer: turn towards the player (who faces wPlayerDirection). */
export function makeNpcFacePlayer(npc, world) {
  npc.facePlayerPending = false;
  npc.facing = OPPOSITE[world.player.direction] || 'down';
  notYetMoving(npc);
}

/** UpdateSpriteImage: snapshot what is displayed. */
export function updateImage(npc) {
  npc.imageFacing = npc.facing;
  npc.imageAnim = npc.animFrame;
}

/**
 * CheckSpriteAvailability: hidden (toggleable object), outside the screen area (non-scripted
 * NPCs only) or standing under text-box tiles -> invisible and not updated. A visible NPC
 * refreshes its image and grass priority, but only while the player is not walking.
 * @returns {boolean} visible
 */
export function checkAvailability(npc, world) {
  if (world.isHidden(npc)) { npc.visible = false; return false; }
  if (!npc.scripted && !(npc.syncScript && npc.syncScript.active)) {
    const p = world.player;
    if (npc.y < p.y - 4 || npc.y > p.y + 4 || npc.x < p.x - 4 || npc.x > p.x + 5) {
      npc.visible = false;
      return false;
    }
  }
  if (world.coveredByUi && world.coveredByUi(npc)) { npc.visible = false; return false; }
  npc.visible = true;
  if (world.player.walkCounter === 0) {
    updateImage(npc);
    // the ROM compares the grass tile with the top-right tile of the sprite's (pixel) cell
    const cx = Math.floor(npc.px / 16), cy = Math.floor(npc.py / 16);
    npc.grass = world.grassTile != null && world.cellTileTR(cx, cy) === world.grassTile;
  }
  return true;
}

/**
 * DoScriptedNPCMovement: 2 px per update in the listed directions, 8 updates per step,
 * walk animation like the player's (frame every 4 updates). Used when an NPC must walk in
 * sync with the player (Oak leading the player to the lab, the Pewter guides).
 */
function doScriptedNpcMovement(npc, world) {
  const s = npc.syncScript;
  if (!s.started) {
    // InitScriptedNPCMovement
    s.started = true;
    s.index = 0;
    s.counter = 8;
    advanceSyncAnim(npc);
    return;
  }
  const dir = s.steps[s.index];
  if (dir === undefined) {
    s.active = false;
    npc.vx = 0; npc.vy = 0;
    npc.animFrame = 0;
    updateImage(npc);
    if (world.onScriptDone) world.onScriptDone(npc);
    return;
  }
  if (typeof dir === 'object' && dir.face) {
    npc.face(dir.face);
    s.index++;
    return;
  }
  const [dx, dy] = DIR_DELTA[dir];
  npc.px += dx * 2;
  npc.py += dy * 2;
  npc.vx = dx; npc.vy = dy;
  npc.facing = dir;
  advanceSyncAnim(npc);
  s.counter--;
  if (s.counter === 0) {
    s.counter = 8;
    s.index++;
    npc.x = Math.round(npc.px / 16);
    npc.y = Math.round(npc.py / 16);
  }
}

function advanceSyncAnim(npc) {
  npc.intraAnim++;
  if (npc.intraAnim >= 4) {
    npc.intraAnim = 0;
    npc.animFrame = (npc.animFrame + 1) & 3;
  }
  updateImage(npc);
}
