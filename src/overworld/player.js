// Player state (the subset of the ROM's player sprite state + wMovementFlags the overworld
// loop uses). Pure data; the logic lives in overworld.js.

import { MODE, WALK_COUNTER_STEPS } from './constants.js';

export class Player {
  constructor() {
    /** logical step position (wXCoord / wYCoord); updated at the END of a step */
    this.x = 0;
    this.y = 0;
    /** sprite facing (SPRITESTATEDATA1_FACINGDIRECTION) */
    this.facing = 'down';
    /** wWalkBikeSurfState */
    this.mode = MODE.WALK;
    /** wWalkCounter: 8 -> 0 during a step (2 px per decrement) */
    this.walkCounter = 0;
    /** step vector (wSpritePlayerStateData1Y/XStepVector) */
    this.vx = 0;
    this.vy = 0;
    /** wPlayerDirection (last direction pressed / talked in) */
    this.direction = 'down';
    /** wPlayerMovingDirection (null = none) */
    this.movingDirection = null;
    /** wPlayerLastStopDirection */
    this.lastStopDirection = null;
    /** wCheckFor180DegreeTurn */
    this.checkFor180 = 1;
    /** BIT_TURNING of wMiscFlags */
    this.turning = false;
    this.intraAnim = 0;
    this.animFrame = 0;
    // wMovementFlags
    this.standingOnDoor = false;
    this.exitingDoor = false;
    this.standingOnWarp = false;
    this.ledge = false;
    this.spinning = false;
    /** wPlayerJumpingYScreenCoordsIndex */
    this.jumpIndex = 0;
    /** sprite screen Y override (ledge hop, warp-pad spin); null = $3c */
    this.screenY = null;
    /** displayed facing while spinning / teleporting (null = facing) */
    this.spinFacing = null;
    /** OAM priority under tall grass */
    this.grass = false;
    /** collision bits from DetectCollisionBetweenSprites */
    this.collisionBits = 0;
    /** hidden (falling through a hole, scripts) */
    this.hidden = false;
    /** only draw the upper half (LeaveMapThroughHoleAnim) */
    this.halfHidden = false;
  }

  /** Pixels moved in the current step (0 when standing). */
  get progress() {
    return this.walkCounter ? (WALK_COUNTER_STEPS - this.walkCounter) * 2 : 0;
  }

  /** Map-pixel position of the 16x16 cell box (moves smoothly during a step). */
  get px() { return this.x * 16 + this.vx * this.progress; }
  get py() { return this.y * 16 + this.vy * this.progress; }

  get modeName() {
    return this.mode === MODE.BIKE ? 'bike' : this.mode === MODE.SURF ? 'surf' : 'walk';
  }
}
