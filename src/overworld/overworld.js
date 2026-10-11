// OverworldScene: the generic overworld engine for every map of the game.
//
// It reproduces home/overworld.asm's OverworldLoop: one loop *iteration* every 2 frames
// (OverworldLoop calls DelayFrame twice; OverworldLoopLessDelay once, after a connection).
// Per iteration: ledge hop / walk continuation, map scripts, joypad (real or simulated),
// START / A handling, the 180-degree-turn delay, sprite updates, collisions, the step
// (2 px per iteration -> 16 frames per step walking, 8 on the bike), and at the end of a
// step: step counting, wild encounters, warps and connections. Everything runs from data/.
//
// Pure enough for node: it only needs `game.{input, palette, rng, font, sfx}` from the
// engine; drawing is in render.js. See docs/overworld.md for the public API.

import { Scene } from '../engine/scene.js';
import { TileMap, EMPTY } from '../engine/tilemap.js';
import { TextBox } from '../engine/text.js';
import { Menu, YesNoMenu } from '../engine/menu.js';
import { PAD } from '../engine/input.js';
import {
  DIR_DELTA, DIR_BIT, OPPOSITE, ITERATION_FRAMES, WALK_COUNTER_STEPS, IGNORE_INPUT_FRAMES,
  EMOTE_FRAMES, COLLISION_SFX_FRAMES, NO_BATTLE_STEPS_AFTER_BATTLE, LCD_OFF_FRAMES, LEDGE_JUMP_Y,
  TILE, MODE, DEFAULT, DARK_FADE_STEP, TEXT_SPEED_FRAMES, SPIN_NEXT, SPIN_ORDER, RIVAL_CLASSES,
} from './constants.js';
import { MapGrid } from './mapgrid.js';
import {
  isWalkable, isPairBlocked, findLedge, waterMove, canStartSurf, isDoorTile, isWarpTile,
  warpPadOrHole, extraWarpCheck, isJustOutsideMap,
} from './collision.js';
import { crossConnection } from './connections.js';
import { resolveWarp, scriptLastMapOverride } from './warps.js';
import { overworldPaletteName, paletteColors } from './palettes.js';
import { spriteCollisionBits } from './sprites.js';
import { Npc, updateNpc, MOVE_STAY, STATUS } from './npc.js';
import { encounterTable, rollEncounter } from './wild.js';
import { trainerSeesPlayer, trainerApproachPath } from './trainers.js';
import { TileAnimator, cloneTilesetImage, loadSpinnerArrowTiles } from './tileanim.js';
import { SPINNER_ARROWS, DEFAULT_HOLES, arrowPath } from './special_data.js';
import { ScriptContext, getMapScript } from './scripts.js';
import { Player } from './player.js';
import * as interact from './interact.js';
import { drawOverworld } from './render.js';

const DPAD = PAD.up | PAD.down | PAD.left | PAD.right;

/** Is `v` a generator / iterator? */
function isIter(v) { return v && typeof v.next === 'function'; }
/** Is `v` a thenable? */
function isThen(v) { return v && typeof v.then === 'function'; }

export class OverworldScene extends Scene {
  /**
   * @param {object} o
   * @param {import('./data.js').OverworldData} o.data   initialised data tables
   * @param {any} o.state   shared game state (see world_state.js for the contract)
   * @param {object} [o.hooks] game hooks (docs/overworld.md): audio, onWildEncounter,
   *   onTrainerBattle, onItemBall, onHiddenObject, onTextAsm, onStartMenu, onBuiltinScript,
   *   giveItem, hasItem, givePokemon, getLeadLevel, onStep, onMapChange, onBlackout ...
   * @param {'sgb'|'dmg'|'gray'|'pocket'|'dmgClassic'} [o.paletteMode]
   * @param {{map:string,x:number,y:number,facing?:string}} [o.start] start position
   *   (default: state.pos)
   */
  constructor({ data, state, hooks = {}, paletteMode = 'sgb', start = null } = {}) {
    super();
    this.data = data;
    this.state = state;
    this.hooks = hooks;
    this.paletteMode = paletteMode;
    this.start = start;
    this.ctx = new ScriptContext(this);
    this.player = new Player();
    /** current map runtime: {name, json, entry, tileset, grid, image, original, text, textTable, wild, indoor, script} */
    this.map = null;
    this.mapName = null;
    /** @type {Npc[]} objects of the current map (index = objectIndex - 1) */
    this.npcs = [];
    /** simulated joypad queue (directions or null), in walking order */
    this.sim = [];
    /** BIT_SCRIPTED_MOVEMENT_STATE */
    this.simulating = false;
    /** wJoyIgnore (scripts) - nested lock count */
    this.inputLock = 0;
    /** IgnoreInputForHalfSecond countdown (frames) */
    this.ignoreInputFrames = 0;
    /** while > 0 the overworld loop does not iterate (text boxes, fades, warps, emotes) */
    this.freeze = 0;
    /** blocking scripts running */
    this.scriptCount = 0;
    /** nested text boxes running */
    this.textDepth = 0;
    /** wMapPalOffset: 0, or 6 for a dark map (FadePal2) */
    this.mapPalOffset = 0;
    /** a script faded the screen out: don't restore the palette every iteration */
    this.paletteHeld = false;
    this.noclip = false;
    /** BIT_STRENGTH_ACTIVE */
    this.strengthActive = false;
    /** wNumberOfNoRandomBattleStepsLeft */
    this.noRandomBattleSteps = 0;
    /** BIT_NO_BATTLES (scripts) */
    this.noBattles = false;
    /** BIT_FORCED_WARP */
    this.forcedWarp = false;
    /** a warp / map change is in progress */
    this.mapChanging = false;
    /** frames until the collision SFX may restart */
    this.bumpSfxFrames = 0;
    /** emotion bubbles on screen: [{target, kind}] */
    this.emotes = [];
    /** extra sprites drawn by animations (boulder dust, cut): [{img, x, y, opts}] (screen px) */
    this.effects = [];
    this.anim = new TileAnimator();
    this.iterDelay = ITERATION_FRAMES;
    this.pressedAcc = 0;
    this.lastJoy = { held: 0, pressed: 0 };
    this.ready = false;
    /** an NPC movement script is running (wNPCMovementScriptPointerTableNum) */
    this.npcMovementScript = 0;
    /** boulder pushing (BIT_TRIED_PUSH_BOULDER / BIT_BOULDER_DUST) */
    this.boulder = { tried: false, pushing: null };
    /** BIT_ON_DUNGEON_WARP */
    this.onDungeonWarp = false;
    this.currentMusic = null;
    /** text labels currently being shown (for text_asm dispatch) */
    this.textLabels = [];
    /** debug counters (tests / test page) */
    this.stats = { bumps: 0, steps: 0, encounters: 0, warps: 0, connections: 0, iterations: 0 };
    /** event log for the test page: [{frame, kind, ...}] */
    this.log = [];
    this.frameCount = 0;
    /** called with (kind, detail) for every logged event */
    this.onEvent = null;
  }

  // ===================================================================== lifecycle

  enter() {
    const g = this.game;
    this.input = g.input;
    this.palette = g.palette;
    this.rng = g.rng;
    this.font = g.font;
    this.ui = new TileMap(20, 18);
    this.textBox = new TextBox({
      font: g.font,
      map: this.ui,
      input: g.input,
      sfx: g.sfx,
      speed: this.textSpeedFrames(),
      subs: this.textSubs(),
      resolveFar: (label) => this.textCommands(label, true),
      onCall: (cmd) => this.onTextCall(cmd),
      onSound: (name) => this.playSfx(soundName(name)),
    });
    this.run(this.bootGen());
  }

  exit() {
    this.ready = false;
  }

  /** @private load the start map and enter it */
  *bootGen() {
    // state.pos.map / state.lastOutdoor.map may be map names (WorldState) or map constants
    // (src/game GameState); the overworld writes them back in the same style
    const sp = this.state.pos && this.state.pos.map;
    this.idStyle = sp && !this.data.mapEntry(sp) && this.data.mapNameForConst(sp) ? 'const' : 'name';
    const pos0 = this.start || this.state.pos;
    const pos = { ...pos0, map: this.mapNameOf(pos0.map) };
    if (!pos.map) throw new Error(`OverworldScene: unknown start map ${pos0.map}`);
    this.freeze++;
    try {
      yield this.data.loadMapBundle(pos.map);
      this.player.mode = this.state.surfing ? MODE.SURF : this.state.bike ? MODE.BIKE : MODE.WALK;
      this.enterMapNow(pos.map, pos.x, pos.y, pos.facing || 'down', { kind: 'boot' });
      this.loadGBPal();
      this.ready = true;
    } finally {
      this.freeze--;
    }
    this.iterDelay = 1;
    this.emit('boot', { map: pos.map, x: pos.x, y: pos.y });
    yield* this.enterHookGen();
  }

  /** Promise resolving once the first map is on screen. */
  whenReady() {
    return new Promise((resolve) => {
      const check = () => (this.ready ? resolve(this) : setTimeout(check, 10));
      check();
    });
  }

  // ===================================================================== per frame

  update(frame, input) {
    this.frameCount++;
    // V-blank work: tile animations, input-ignore countdown, SFX timers
    if (this.map) this.anim.tick();
    if (this.ignoreInputFrames > 0) this.ignoreInputFrames--;
    if (this.bumpSfxFrames > 0) this.bumpSfxFrames--;
    if (!this.ready || this.freeze > 0 || this.mapChanging) {
      // frozen (text box, fade, warp ...): the loop resumes 2 frames after it ends and no
      // button press made while frozen leaks into the overworld
      this.iterDelay = ITERATION_FRAMES;
      this.pressedAcc = 0;
      return;
    }
    this.pressedAcc |= input.pressedMask;
    if (--this.iterDelay > 0) return;
    this.iterDelay = ITERATION_FRAMES;
    this.stats.iterations++;
    this.iteration();
    this.pressedAcc = 0;
  }

  draw(fb) {
    if (!this.map) { fb.clear(0); return; }
    drawOverworld(this, fb);
  }

  // ===================================================================== the loop iteration

  /** One OverworldLoop iteration. */
  iteration() {
    const p = this.player;
    if (!this.paletteHeld && !this.mapChanging) this.loadGBPal();
    if (p.ledge) this.handleMidJump();
    if (p.walkCounter > 0) { this.moveAhead(); return; }

    // ---- JoypadOverworld
    p.vx = 0;
    p.vy = 0;
    this.runMapScripts();
    if (this.freeze > 0 || this.mapChanging || !this.ready) return;
    const joy = this.joypad();
    this.lastJoy = joy;
    const buttons = this.simulating ? joy.held : joy.pressed;
    if (buttons & PAD.start) {
      this.openStartMenu();
      return;
    }
    if (buttons & PAD.a) {
      if (!this.controlledByGame()) interact.aButton(this);
      return;
    }
    const held = joy.held;
    const dir = held & PAD.down ? 'down' : held & PAD.up ? 'up' : held & PAD.left ? 'left' : held & PAD.right ? 'right' : null;
    if (!dir) { this.noDirection(); return; }
    const [dx, dy] = DIR_DELTA[dir];
    p.vx = dx;
    p.vy = dy;
    p.direction = dir;
    if (!this.simulating && p.checkFor180 && dir !== p.lastStopDirection) {
      // the "180 degree turn" code: new direction after stopping -> one iteration without
      // moving (the sprite turns on the next update). NewBattle is called here too.
      p.movingDirection = dir;
      p.turning = true;
      p.checkFor180 = 0;
      this.newBattle();
      return;
    }
    p.movingDirection = dir;
    this.updateSprites();
    if (p.mode === MODE.SURF) {
      if (this.collisionCheckOnWater()) return;
    } else if (this.collisionCheckOnLand()) {
      if (p.standingOnWarp && this.extraWarpCheck()) this.checkWarpsCollision();
      return;
    }
    p.walkCounter = WALK_COUNTER_STEPS;
    this.moveAhead2();
  }

  /** .noDirectionButtonsPressed */
  noDirection() {
    const p = this.player;
    p.turning = false;
    this.updateSprites();
    p.checkFor180 = 1;
    if (p.movingDirection) {
      p.lastStopDirection = p.movingDirection;
      p.movingDirection = null;
    }
  }

  /** .moveAhead: continue a step. */
  moveAhead() {
    if (this.player.spinning) this.loadSpinnerArrows();
    this.updateSprites();
    this.moveAhead2();
  }

  /** .moveAhead2 */
  moveAhead2() {
    const p = this.player;
    p.turning = false;
    if (p.mode === MODE.BIKE && !p.ledge) this.doBikeSpeedup();
    this.advancePlayer();
    if (p.walkCounter !== 0) return;
    this.stepFinished();
  }

  /** DoBikeSpeedup: a second AdvancePlayerSprite per iteration. */
  doBikeSpeedup() {
    if (this.npcMovementScript) return;
    if (this.map.json.const === 'ROUTE_17' && (this.lastJoy.held & (PAD.up | PAD.left | PAD.right))) return;
    this.advancePlayer();
  }

  /** AdvancePlayerSprite: 2 px; coordinates change when the counter reaches 0. */
  advancePlayer() {
    const p = this.player;
    if (p.walkCounter <= 0) return;
    p.walkCounter--;
    if (p.walkCounter === 0) {
      p.x += p.vx;
      p.y += p.vy;
      this.syncPos();
    }
  }

  /**
   * End of a step (OverworldLoop "walking animation finished"): step counting, the game's
   * per-step hook (Safari Zone steps, ApplyOutOfBattlePoisonDamage), wild battles, warps,
   * connections.
   */
  stepFinished() {
    const p = this.player;
    this.stats.steps++;
    const scripted = this.simulating;
    if (!scripted) {
      // wStepCounter - 1 (8 bit; poison hurts when it is a multiple of 4), encounter cooldown
      this.state.stepCounter = ((this.state.stepCounter | 0) - 1) & 0xff;
      if (this.noRandomBattleSteps > 0) this.noRandomBattleSteps--;
    }
    if (this.hooks.onStep) {
      let r;
      try {
        r = this.hooks.onStep(this.ctx, { x: p.x, y: p.y, map: this.mapName, scripted, stepCounter: this.state.stepCounter });
      } catch (err) {
        console.error('[overworld] hooks.onStep threw', err);
      }
      if (isIter(r) || isThen(r)) {
        // a blocking script (fainted text, blackout, Safari game over): the encounter and
        // warp checks of this step run after it, unless it moved the player elsewhere
        const ov = this, map = this.mapName;
        this.runScript(function* stepHook() {
          if (isIter(r)) yield* r; else yield r;
          if (ov.mapName === map && !ov.mapChanging) ov.stepChecks();
        }());
        return;
      }
    }
    this.stepChecks();
  }

  /** NewBattle, then CheckWarpsNoCollision (-> CheckMapConnections -> map script onStep). */
  stepChecks() {
    const battle = this.newBattle();
    this.player.standingOnWarp = false;
    if (battle) return;
    this.checkWarpsNoCollision();
  }

  // ===================================================================== joypad

  /** Real input for this iteration (held now + anything pressed since the last one). */
  realInput() {
    const inp = this.input;
    return { held: (inp ? inp.heldMask : 0) | this.pressedAcc, pressed: this.pressedAcc };
  }

  /** JoypadOverworld: real joypad (masked) or the next simulated state. */
  joypad() {
    let held = 0, pressed = 0;
    if (this.ignoreInputFrames === 0 && this.inputLock === 0) {
      const r = this.realInput();
      held = r.held;
      pressed = r.pressed;
    }
    // Cycling Road: DOWN is forced when nothing is pressed (except during trainer battles)
    if (this.map && this.map.json.const === 'ROUTE_17' && !this.trainerEngaged && !this.simulating
        && this.inputLock === 0 && !(held & (DPAD | PAD.a | PAD.b))) {
      held = PAD.down;
    }
    if (this.simulating) {
      if (this.sim.length === 0) {
        // .doneSimulating
        this.simulating = false;
        const p = this.player;
        p.standingOnDoor = false;
        p.exitingDoor = false;
        p.standingOnWarp = false;
        return { held: 0, pressed };
      }
      const s = this.sim.shift();
      held = s ? PAD[s] : 0;
      if (!held) pressed = 0;
    }
    return { held, pressed };
  }

  /** IsPlayerCharacterBeingControlledByGame */
  controlledByGame() {
    return !!this.npcMovementScript || this.player.exitingDoor || this.simulating;
  }

  /** Is a direction held on the real joypad right now (CheckWarpsNoCollision's test)? */
  directionHeldForWarp() {
    if (this.simulating || this.inputLock > 0 || this.ignoreInputFrames > 0) return false;
    return ((this.input ? this.input.heldMask : 0) & DPAD) !== 0;
  }

  /** Start simulating D-pad presses (directions in walking order). */
  startSimulating(steps) {
    this.sim = steps.slice();
    this.simulating = true;
  }

  // ===================================================================== sprites

  /** UpdateSprites: the player, then every NPC slot. */
  updateSprites() {
    this.updatePlayerSprite();
    const w = this.npcWorld;
    for (const n of this.npcs) updateNpc(n, w);
  }

  /** UpdatePlayerSprite */
  updatePlayerSprite() {
    const p = this.player;
    p.collisionBits = spriteCollisionBits(this.playerBody(), this.visibleNpcs());
    if (p.walkCounter === 0) {
      if (p.movingDirection) {
        if (p.facing !== p.movingDirection) {
          p.facing = p.movingDirection;
          this.syncPos();
        }
        this.tickPlayerAnim();
      } else {
        p.intraAnim = 0;
        p.animFrame = 0;
      }
    } else {
      this.tickPlayerAnim();
    }
    // grass priority from the tile at screen (8,9): the destination once a step has begun
    const g = this.map.grid;
    const t = p.walkCounter === 0 ? g.cellTile(p.x, p.y) : g.cellTile(p.x + p.vx, p.y + p.vy);
    p.grass = this.map.tileset.grassTile != null && t === this.map.tileset.grassTile;
  }

  /** @private */
  tickPlayerAnim() {
    const p = this.player;
    if (p.spinning) return;
    p.intraAnim++;
    if (p.intraAnim >= 4) {
      p.intraAnim = 0;
      p.animFrame = (p.animFrame + 1) & 3;
    }
  }

  /** Collision body of the player (pixel cell box + step vector). */
  playerBody() {
    const p = this.player;
    return { px: p.px, py: p.py, vx: p.vx, vy: p.vy, isPlayer: true };
  }

  /** Visible NPCs (image index != $ff). */
  visibleNpcs() {
    return this.npcs.filter((n) => n.visible);
  }

  /** The world interface NPC logic needs (rebuilt per map). */
  makeNpcWorld() {
    const ov = this;
    return {
      rng: this.rng,
      get player() {
        const p = ov.player;
        return { x: p.x, y: p.y, px: p.px, py: p.py, vx: p.vx, vy: p.vy, walkCounter: p.walkCounter, direction: p.direction };
      },
      cellTile: (x, y) => this.map.grid.cellTile(x, y),
      cellTileTR: (x, y) => this.map.grid.cellTileTR(x, y),
      isWalkable: (t) => isWalkable(this.map.tileset, t),
      grassTile: this.map.tileset.grassTile,
      isHidden: (n) => this.isObjectHidden(n),
      bodies: (n) => {
        const list = [this.playerBody()];
        for (const o of this.npcs) if (o !== n && o.visible) list.push(o);
        return list;
      },
      onScriptDone: () => {},
    };
  }

  /** Is an object hidden through state.missables (toggleable objects)? */
  isObjectHidden(npc) {
    if (npc.forceHidden) return true;
    const t = npc.def.toggleIndex;
    return t != null && this.state.missables.isHidden(t);
  }

  /** NPC by 1-based object index. */
  npc(objectIndex) {
    return this.npcs.find((n) => n.index === objectIndex) || null;
  }

  /** Hide/show a toggleable object by TOGGLE_* const or index (any map). */
  setToggleHidden(toggle, hidden) {
    let idx = toggle;
    if (typeof toggle === 'string') {
      const o = this.data.toggleables.objects.find((t) => t.const === toggle);
      if (!o) throw new Error(`unknown toggleable object ${toggle}`);
      idx = o.index;
    }
    if (hidden) this.state.missables.hide(idx); else this.state.missables.show(idx);
    const n = this.npcs.find((x) => x.def.toggleIndex === idx);
    if (n && hidden) n.visible = false;
  }

  /** Hide/show an object; toggleable objects persist in state.missables. */
  setObjectHidden(objectIndex, hidden) {
    const n = this.npc(objectIndex);
    if (!n) return;
    const t = n.def.toggleIndex;
    if (t != null) {
      if (hidden) this.state.missables.hide(t); else this.state.missables.show(t);
    } else {
      n.forceHidden = hidden;
    }
    if (hidden) n.visible = false;
  }

  // ===================================================================== collisions

  /** The step in front of the player (by facing). */
  frontCell(dist = 1) {
    const p = this.player;
    const [dx, dy] = DIR_DELTA[p.facing];
    return { x: p.x + dx * dist, y: p.y + dy * dist };
  }

  /** Tile in front of the player (bottom-left of the front step). */
  frontTile() {
    const f = this.frontCell();
    return this.map.grid.cellTile(f.x, f.y);
  }

  /** CollisionCheckOnLand: true = blocked (the bump SFX plays). */
  collisionCheckOnLand() {
    const p = this.player;
    if (p.ledge) return false;
    if (this.simulating && this.sim.length > 0) return false; // wSimulatedJoypadStatesIndex != 0
    if (this.noclip) return false;
    let blocked = false;
    if (p.collisionBits & DIR_BIT[p.direction]) blocked = true;
    else if (interact.spriteInFront(this, 16, true)) blocked = true;
    else {
      const g = this.map.grid, ts = this.map.tileset;
      const f = this.frontCell();
      const front = g.cellTile(f.x, f.y), under = g.cellTile(p.x, p.y);
      if (ts.const === 'OVERWORLD') {
        const l = findLedge(ts, p.facing, under, front);
        if (l && (this.lastJoy.held & l.inputMask)) {
          this.startLedgeJump(p.facing);
          return true; // CheckTilePassable fails on the ledge tile; SFX_LEDGE has priority
        }
      }
      if (isPairBlocked(ts, under, front, false)) blocked = true;
      else if (!isWalkable(ts, front)) blocked = true;
    }
    if (blocked) this.bump();
    return blocked;
  }

  /** CollisionCheckOnWater: true = blocked. May end surfing. */
  collisionCheckOnWater() {
    const p = this.player;
    if (this.simulating) return false;
    if (this.noclip) return false;
    const g = this.map.grid, ts = this.map.tileset;
    const f = this.frontCell();
    const front = g.cellTile(f.x, f.y), under = g.cellTile(p.x, p.y);
    // a sprite in the way: the ROM falls into the passable check with a garbage tile ($F0)
    if (p.collisionBits & DIR_BIT[p.direction]) { this.bump(); return true; }
    if (isPairBlocked(ts, under, front, true)) { this.bump(); return true; }
    const m = waterMove(ts, front);
    if (m === 'surf') return false;
    if (m === 'land') {
      this.setMode(MODE.WALK);
      return false;
    }
    this.bump();
    return true;
  }

  /** Play SFX_COLLISION unless it is still playing. */
  bump() {
    this.stats.bumps++;
    if (this.bumpSfxFrames > 0) return;
    this.bumpSfxFrames = COLLISION_SFX_FRAMES;
    this.playSfx('SFX_COLLISION');
  }

  // ===================================================================== ledges

  /** HandleLedges: two simulated steps, the shadow, SFX_LEDGE. */
  startLedgeJump(dir) {
    const p = this.player;
    p.ledge = true;
    p.jumpIndex = 0;
    this.startSimulating([dir, dir]);
    this.playSfx('SFX_LEDGE');
    this.emit('ledge', { x: p.x, y: p.y, dir });
  }

  /** _HandleMidJump: sprite Y from PlayerJumpingYScreenCoords, one entry per iteration. */
  handleMidJump() {
    const p = this.player;
    const c = p.jumpIndex;
    if (c + 1 < 16) {
      p.jumpIndex = c + 1;
      p.screenY = LEDGE_JUMP_Y[c];
      return;
    }
    if (p.walkCounter !== 0) return;
    // finished: UpdateSprites, Delay3, reset
    this.updateSprites();
    this.iterDelay += 3;
    p.jumpIndex = 0;
    p.ledge = false;
    p.screenY = null;
    this.simulating = false;
    this.sim = [];
    this.pressedAcc = 0;
  }

  // ===================================================================== warps

  /** ExtraWarpCheck for the current map. */
  extraWarpCheck() {
    const p = this.player, j = this.map.json;
    return extraWarpCheck(j.extraWarpCheck, {
      x: p.x, y: p.y, facing: p.facing, frontTile: this.frontTile(), W: j.width, H: j.height,
      carpets: this.data.tilesetIndex.warpCarpetTiles,
    });
  }

  /** CheckWarpsNoCollision (after a completed step). */
  checkWarpsNoCollision() {
    const p = this.player, j = this.map.json, ts = this.map.tileset, g = this.map.grid;
    const warps = j.warps || [];
    for (let i = 0; i < warps.length; i++) {
      const w = warps[i];
      if (w.x !== p.x || w.y !== p.y) continue;
      p.standingOnWarp = true;
      const under = g.cellTile(p.x, p.y);
      if (isDoorTile(ts, under)) { this.beginWarp(i); return; }
      if (isWarpTile(ts, under)) { p.standingOnWarp = false; this.beginWarp(i); return; }
      if (this.extraWarpCheck() && (this.forcedWarp || this.directionHeldForWarp())) {
        this.beginWarp(i);
        return;
      }
    }
    this.checkMapConnections();
  }

  /** CheckWarpsCollision: blocked while standing on a warp whose extra check passes. */
  checkWarpsCollision() {
    const p = this.player;
    const warps = this.map.json.warps || [];
    for (let i = 0; i < warps.length; i++) {
      if (warps[i].x === p.x && warps[i].y === p.y) { this.beginWarp(i); return; }
    }
  }

  /** Start warping through warp `index` of the current map. */
  beginWarp(index) {
    this.forcedWarp = false;
    this.mapChanging = true;
    this.run(this.warpGen(index));
  }

  /** @private WarpFound2 + EnterMap */
  *warpGen(index) {
    const p = this.player;
    const fromJson = this.map.json;
    const warp = fromJson.warps[index];
    this.freeze++;
    let entered = false;
    try {
      const veto = yield* this.callMapHookGen('onWarpAttempt', [warp]);
      if (veto === false) return;
      const dest = resolveWarp(warp, this.lastOutdoorNamed());
      if (!dest || !this.data.mapEntry(dest.map)) {
        console.warn(`[overworld] warp ${index} of ${this.mapName} leads nowhere`, warp);
        return;
      }
      const destEntry = this.data.mapEntry(dest.map);
      const isLastMap = warp.destMapId === -1;
      let spinIn = false;
      this.stats.warps++;
      this.emit('warp', { from: this.mapName, index, to: dest.map, warpIndex: dest.warpIndex });
      const loading = this.data.loadMapBundle(dest.map);
      if (fromJson.isOutside) {
        this.setLastOutdoor(fromJson.name, p.x, p.y, index);
        if (destEntry.const === 'ROCK_TUNNEL_1F') {
          this.mapPalOffset = 6;
          yield* this.palette.fadeToBlack();
        }
        yield* this.mapChangeSoundGen();
      } else if (isLastMap) {
        yield* this.mapChangeSoundGen();
        this.mapPalOffset = 0;
      } else {
        const ph = warpPadOrHole(this.map.tileset, this.map.grid.cellTile(p.x, p.y));
        if (ph === 1) {
          yield* this.leaveMapAnimGen();
          spinIn = true;
        } else {
          yield* this.mapChangeSoundGen();
        }
        p.standingOnDoor = false;
        p.exitingDoor = false;
      }
      p.standingOnDoor = true;
      this.ignoreInputFrames = IGNORE_INPUT_FRAMES;
      yield loading;
      const dj = this.data.getMapJson(dest.map);
      const dw = dj.warps[dest.warpIndex] || dj.warps[0];
      yield* this.lcdOffGen();
      this.enterMapNow(dest.map, dw.x, dw.y, p.facing, { kind: 'warp' });
      entered = true;
      if (spinIn) yield* this.enterMapAnimGen('teleport');
      else yield* this.lcdOnGen();
    } finally {
      this.freeze--;
      this.mapChanging = false;
      this.iterDelay = 1;
    }
    if (entered) yield* this.enterHookGen();
  }

  /** PlayMapChangeSound: SFX_GO_INSIDE / SFX_GO_OUTSIDE, then GBFadeOutToBlack (not dark). */
  *mapChangeSoundGen() {
    const p = this.player;
    const tl = this.map.grid.cellTileTL(p.x, p.y);
    this.playSfx(tl === TILE.DOOR_TOP ? 'SFX_GO_INSIDE' : 'SFX_GO_OUTSIDE');
    if (this.mapPalOffset !== 0) return;
    yield* this.palette.fadeToBlack();
  }

  /** LoadMapData turns the LCD off: blank (white) screen for ~2 frames. */
  *lcdOffGen() {
    this.palette.setFadeStep(8);
    yield LCD_OFF_FRAMES;
  }

  /** LCD back on with the faded (black) palette until LoadGBPal at the first iteration. */
  *lcdOnGen() {
    this.palette.setFadeStep(1);
    yield ITERATION_FRAMES;
    this.loadGBPal();
  }

  /** LoadGBPal: normal palette, or FadePal2 on a dark map. */
  loadGBPal() {
    if (!this.palette) return;
    this.palette.setFadeStep(this.mapPalOffset ? DARK_FADE_STEP : 4);
  }

  /** CheckMapConnections (after a step without warp). */
  checkMapConnections() {
    const p = this.player;
    const hit = crossConnection(this.map.json, p.x, p.y);
    if (!hit) { this.afterStep(); return; }
    if (!this.data.mapEntry(hit.map)) { this.afterStep(); return; }
    this.stats.connections++;
    this.emit('connection', { from: this.mapName, dir: hit.dir, to: hit.map, x: hit.x, y: hit.y });
    if (this.data.isBundleLoaded(hit.map)) {
      this.enterMapNow(hit.map, hit.x, hit.y, p.facing, { kind: 'connection' });
      this.iterDelay = 1; // OverworldLoopLessDelay
      this.run(this.enterHookGen());
    } else {
      // not preloaded yet (rare): hold the loop until it is
      this.mapChanging = true;
      this.run(function* loadConnected(ov) {
        try {
          yield ov.data.loadMapBundle(hit.map);
          ov.enterMapNow(hit.map, hit.x, hit.y, p.facing, { kind: 'connection' });
        } finally {
          ov.mapChanging = false;
          ov.iterDelay = 1;
        }
        yield* ov.enterHookGen();
      }(this));
    }
  }

  /** After a completed step that did not change the map: map script onStep. */
  afterStep() {
    const p = this.player;
    const ms = this.mapScript();
    if (ms && ms.onStep) {
      this.startHook('onStep', [p.x, p.y]);
    }
  }

  // ===================================================================== entering maps

  /**
   * Enter a map whose bundle is loaded (LoadMapData / LoadMapHeader + InitMapSprites).
   * @param {string} name
   * @param {number} x
   * @param {number} y
   * @param {string} facing
   * @param {{kind?: 'boot'|'warp'|'connection'|'teleport'}} [opts]
   */
  enterMapNow(name, x, y, facing, opts = {}) {
    const d = this.data;
    const json = d.getMapJson(name);
    if (!json) throw new Error(`OverworldScene: map ${name} not loaded`);
    const entry = d.mapEntry(name);
    const tileset = d.get(json.tilesetFile);
    const original = d.get(tileset.gfx);
    const keepImage = opts.kind === 'connection' && this.map && this.map.tileset === tileset;
    const image = keepImage ? this.map.image : cloneTilesetImage(original);
    const grid = new MapGrid(json, tileset, (n) => d.getMapJson(n));
    if (grid.missing.length) console.warn(`[overworld] ${name}: connection strips missing for ${grid.missing.join(', ')}`);
    const text = d.get(json.textFile);
    const tables = (text && text.textPointerTables) || [];
    this.map = {
      name, json, entry, tileset, grid, image, original, text,
      textTable: tables.find((t) => t.primary) || tables[0] || { entries: [] },
      wild: (d.wild.maps && d.wild.maps[json.const]) || null,
      indoor: json.id >= d.mapIndex.firstIndoorMap,
    };
    this.mapName = name;
    this.npcs = json.objectEvents.map((def) => new Npc(def, d.spritesByConst.get(def.sprite) || null));
    this.npcWorld = this.makeNpcWorld();
    const p = this.player;
    p.x = x;
    p.y = y;
    if (facing) p.facing = facing;
    p.walkCounter = 0;
    p.vx = 0;
    p.vy = 0;
    p.screenY = null;
    p.spinFacing = null;
    p.hidden = false;
    p.halfHidden = false;
    if (opts.kind !== 'connection') {
      // LoadPlayerSpriteGraphics: no bike where it is not allowed, no surfing on maps
      // without animated (water) tiles
      if (p.mode === MODE.BIKE && !this.bikeAllowed()) p.mode = MODE.WALK;
      if (p.mode === MODE.SURF && !tileset.animationId) p.mode = MODE.WALK;
      this.sim = [];
      this.simulating = false;
      p.ledge = false;
      p.spinning = false;
      this.onDungeonWarp = false;
      if (opts.kind !== 'warp') this.strengthActive = false;
      this.state.stepCounter = 0; // ClearVariablesOnEnterMap
    }
    this.anim.reset(tileset.animationId, keepImage ? null : image, d.flowers);
    this.state.surfing = p.mode === MODE.SURF;
    this.state.bike = p.mode === MODE.BIKE;
    this.boulder = { tried: false, pushing: null };
    this.applyPalette();
    this.updateMusic();
    this.syncPos();
    // EnterMap: one UpdateSprites (initialises every NPC, invisible until the next one)
    this.updateSprites();
    d.preloadNeighbours(json);
    if (this.hooks.onMapChange) this.hooks.onMapChange(name, this.ctx, { kind: opts.kind || 'warp', x, y });
    this.emit('enter', { map: name, x, y, via: opts.kind || 'warp' });
  }

  /** The registered script object of the current map (looked up live). */
  mapScript() {
    return this.mapName ? getMapScript(this.mapName) : null;
  }

  /** Run the map script's onEnter hook. */
  *enterHookGen() {
    const handled = this.startHook('onEnter', []);
    if (handled && handled.then) yield handled;
  }

  /**
   * Warping into an indoor map by script / debug teleport: if wLastMap cannot be one of the
   * outdoor maps this map is reachable from (map.lastMapCandidates), use the first candidate
   * so LAST_MAP exits and the palette stay consistent.
   */
  fixLastOutdoorFor(mapName) {
    const j = this.data.getMapJson(mapName);
    if (!j || j.isOutside || !j.lastMapCandidates || !j.lastMapCandidates.length) return;
    const lo = this.lastOutdoorNamed();
    const cur = lo && this.data.mapEntry(lo.map);
    if (cur && j.lastMapCandidates.includes(cur.const)) return;
    const name = this.data.mapNameForConst(j.lastMapCandidates[0]);
    if (name) this.setLastOutdoor(name);
  }

  /** IsBikeRidingAllowed */
  bikeAllowed() {
    const j = this.map.json;
    if (this.data.meta.bikeAlsoAllowedMaps.includes(j.const)) return true;
    return !!this.map.tileset.bikeAllowed;
  }

  // ===================================================================== map scripts

  /** RunMapScript: boulders, door step-out, wLastMap overrides, the map's own script. */
  runMapScripts() {
    const p = this.player;
    // Strength: TryPushingBoulder
    if (this.strengthActive) interact.tryPushingBoulder(this);
    // RunNPCMovementScript: step out of a door after a warp
    if (p.standingOnDoor) {
      p.standingOnDoor = false;
      this.playerStepOutFromDoor();
    }
    const over = scriptLastMapOverride(this.map.json, p.x, p.y);
    if (over) {
      const name = this.data.mapNameForConst(over);
      const lo = this.lastOutdoorNamed();
      if (name && (!lo || lo.map !== name)) this.setLastOutdoor(name);
    }
    if (this.scriptCount > 0 || this.freeze > 0) return;
    // the registered map script
    const script = this.mapScript();
    if (script && script.onFrame) {
      this.startHook('onFrame', []);
      if (this.scriptCount > 0 || this.freeze > 0 || this.mapChanging) return;
    }
    if (this.simulating || p.walkCounter !== 0) {
      if (p.spinning) this.spinningScript();
      return;
    }
    if (p.spinning) { this.spinningScript(); return; }
    // engine defaults of the map's script: spinner arrows, holes, trainer sight
    if (!(script && script.spinners === false) && this.checkSpinnerArrows()) return;
    if (!(script && script.holes === false) && this.checkHoles()) return;
    if (!(script && script.trainers === false)) this.checkFightingMapTrainers();
  }

  /** PlayerStepOutFromDoor */
  playerStepOutFromDoor() {
    const p = this.player;
    const under = this.map.grid.cellTile(p.x, p.y);
    if (isDoorTile(this.map.tileset, under)) {
      p.exitingDoor = true;
      p.facing = 'down';
      p.animFrame = 0;
      this.startSimulating(['down']);
    } else {
      this.sim = [];
      this.simulating = false;
      p.exitingDoor = false;
    }
  }

  /** Spinner arrow tiles (ViridianGym / RocketHideoutB2F / B3F default scripts). */
  checkSpinnerArrows() {
    const table = SPINNER_ARROWS[this.mapName];
    if (!table) return false;
    const p = this.player;
    const hit = table.find((e) => e.x === p.x && e.y === p.y);
    if (!hit) return false;
    this.startSimulating(arrowPath(hit.rle));
    p.spinning = true;
    p.spinFacing = p.facing;
    this.inputLock++;
    this.spinLock = true;
    this.playSfx('SFX_ARROW_TILES');
    this.emit('spinner', { x: p.x, y: p.y, steps: this.sim.length });
    return true;
  }

  /** *PlayerSpinningScript: stop when no simulated step is left. */
  spinningScript() {
    if (this.sim.length > 0 || this.player.walkCounter !== 0) { this.loadSpinnerArrows(); return; }
    const p = this.player;
    p.spinning = false;
    p.spinFacing = null; // the facing field already holds the last moved direction
    if (this.spinLock) { this.spinLock = false; this.inputLock = Math.max(0, this.inputLock - 1); }
    // restore the tileset's own arrow tiles
    loadSpinnerArrowTiles(this.map.image, this.map.original, this.data.gfx.spinners, this.map.tileset.spinnerArrows, 0);
  }

  /** LoadSpinnerArrowTiles: rotate the shown facing, swap the arrow tiles. */
  loadSpinnerArrows() {
    const p = this.player;
    p.spinFacing = SPIN_NEXT[p.spinFacing || p.facing];
    loadSpinnerArrowTiles(this.map.image, this.map.original, this.data.gfx.spinners, this.map.tileset.spinnerArrows, this.sim.length);
  }

  /** IsPlayerOnDungeonWarp for the maps with holes. */
  checkHoles() {
    const h = DEFAULT_HOLES[this.mapName];
    if (!h || this.onDungeonWarp) return false;
    const p = this.player;
    const idx = h.coords.findIndex((c) => c && c[0] === p.x && c[1] === p.y);
    if (idx < 0) return false;
    const dest = Array.isArray(h.dest) ? h.dest[idx] : h.dest;
    this.onDungeonWarp = true;
    this.mapChanging = true;
    this.run(this.dungeonWarpGen(dest, idx + 1));
    return true;
  }

  /** CheckFightingMapTrainers */
  checkFightingMapTrainers() {
    const headers = this.map.json.trainerHeaders || [];
    if (!headers.length || this.trainerEngaged) return false;
    const p = this.player;
    for (const h of headers) {
      if (this.state.flags.get(h.eventFlag)) continue;
      const n = this.npc(h.objectIndex);
      if (!n || !n.visible || n.moving) continue;
      const dist = trainerSeesPlayer(n, { px: p.px, py: p.py }, h.sightRange,
        { bypassFrontCheck: this.map.json.const === 'POWER_PLANT' });
      if (!dist) continue;
      this.emit('trainerSpotted', { objectIndex: n.index, header: h.header, dist });
      this.trainerEngaged = true;
      // BIT_TRAINER_BATTLE + wJoyIgnore: locked right now, before the joypad is read
      this.scriptCount++;
      this.inputLock++;
      this.run(this.trainerEngageGen(n, h, dist));
      return true;
    }
    return false;
  }

  // ===================================================================== hooks

  /**
   * Call a map-script hook. A generator/promise result runs as a blocking script (input
   * locked). Returns: false if not handled (no hook, or it returned undefined/false/DEFAULT),
   * the Coroutine of the blocking script, or true for a synchronous truthy result.
   */
  startHook(name, args) {
    const s = this.mapScript();
    const fn = s && s[name];
    if (typeof fn !== 'function') return false;
    let r;
    try {
      r = fn.call(s, this.ctx, ...args);
    } catch (err) {
      console.error(`[overworld] ${this.mapName}.${name} threw`, err);
      return false;
    }
    if (r === undefined || r === false || r === null || r === DEFAULT) return false;
    if (isThen(r)) return this.runScript(r);
    if (isIter(r)) {
      // step it once now: a generator that returns right away (e.g. an onFrame/onStep whose
      // condition is not met) must not lock the input for a frame
      let first;
      try {
        first = r.next();
      } catch (err) {
        console.error(`[overworld] ${this.mapName}.${name} threw`, err);
        return false;
      }
      if (first.done) return first.value !== DEFAULT;
      return this.runScript(resumeGenerator(r, first));
    }
    return true;
  }

  /**
   * Generator variant used inside other coroutines: runs the hook inline and returns its
   * value ('handled' semantics: undefined/false/DEFAULT -> false). For onWarpAttempt the
   * raw value is returned so `false` can veto.
   */
  *callMapHookGen(name, args) {
    const s = this.mapScript();
    const fn = s && s[name];
    if (typeof fn !== 'function') return name === 'onWarpAttempt' ? undefined : false;
    let r = fn.call(s, this.ctx, ...args);
    if (isIter(r) || isThen(r)) {
      // a script ran: handled, unless it finished with ctx.DEFAULT
      this.scriptCount++;
      try { r = isIter(r) ? yield* r : yield r; } finally { this.scriptCount--; }
      if (name === 'onWarpAttempt') return r;
      return r !== DEFAULT;
    }
    if (name === 'onWarpAttempt') return r;
    return !(r === undefined || r === false || r === null || r === DEFAULT);
  }

  /** Run a generator/promise as a blocking script (input locked while it runs). */
  runScript(genOrPromise) {
    const ov = this;
    this.scriptCount++;
    this.inputLock++;
    return this.run(function* blockingScript() {
      try {
        if (isIter(genOrPromise)) return yield* genOrPromise;
        return yield genOrPromise;
      } finally {
        ov.scriptCount--;
        ov.inputLock = Math.max(0, ov.inputLock - 1);
      }
    }());
  }

  /** Call a game hook with a default when it is missing. */
  callGameHook(name, args, fallback) {
    const fn = this.hooks[name];
    if (typeof fn !== 'function') return fallback;
    return fn(...args, this.ctx);
  }

  // ===================================================================== text

  textSpeedFrames() {
    const s = this.state.options && this.state.options.textSpeed;
    return TEXT_SPEED_FRAMES[s] ?? 3;
  }

  /** {PLAYER}/{RIVAL} and RAM substitutions for texts. */
  textSubs() {
    return {
      PLAYER: this.state.playerName, RIVAL: this.state.rivalName,
      wPlayerName: this.state.playerName, wRivalName: this.state.rivalName,
      ...(this.textVars || {}),
    };
  }

  /**
   * Commands of a text label: the current map's texts first, then common.json. Sound
   * commands become calls so the text waits for the jingle like TextCommand_SOUND.
   * @param {string} label
   * @param {boolean} [far] called through text_far (the engine resolver)
   */
  textCommands(label, far = false) {
    const own = this.map && this.map.text && this.map.text.texts[label];
    const common = this.data.commonText.texts[label];
    const t = own || common;
    if (!t) return far ? undefined : null;
    return prepareCommands(t.commands || []);
  }

  /** Accept a label, a command list, {commands} or a literal string. */
  resolveTextInput(text) {
    if (Array.isArray(text)) return { cmds: prepareCommands(text), label: null };
    if (text && Array.isArray(text.commands)) return { cmds: prepareCommands(text.commands), label: text.label || null };
    if (typeof text === 'string') {
      const cmds = this.textCommands(text);
      if (cmds) return { cmds, label: text };
      return { cmds: [{ cmd: 'text', str: text }, { cmd: 'done' }], label: null };
    }
    return { cmds: [], label: null };
  }

  /**
   * Show a text (DisplayTextID semantics at top level: wait for A/B at the end and close;
   * nested inside another text's text_asm: print into the same box without waiting, like
   * PrintText). Options: {wait, close, holdOnly, subs, open}.
   */
  *textGen(text, opts = {}) {
    const { cmds, label } = this.resolveTextInput(text);
    const nested = this.textDepth > 0;
    const wait = opts.wait ?? !nested;
    const close = opts.close ?? !nested;
    this.freeze++;
    this.textDepth++;
    if (label) this.textLabels.push(label);
    try {
      this.textBox.speed = this.textSpeedFrames();
      yield* this.textBox.run(cmds, {
        open: opts.open !== false,
        waitAtEnd: wait && !opts.holdOnly,
        subs: { ...this.textSubs(), ...(opts.subs || {}) },
      });
      if (opts.holdOnly) while (this.input.held.a) yield 1; // HoldTextDisplayOpen
    } finally {
      if (label) this.textLabels.pop();
      this.textDepth--;
      this.freeze--;
      if (close) this.textBox.close();
    }
  }

  /** text_asm / script commands inside a displayed text. */
  onTextCall(cmd) {
    if (cmd.__sound) return this.soundGen(cmd.__sound);
    if (cmd.cmd === 'script') return interact.builtinScriptGen(this, cmd.script, { cmd });
    const label = this.textLabels[this.textLabels.length - 1] || null;
    return interact.textAsmGen(this, label);
  }

  /** TextCommand_SOUND: play and wait until it finished (when the audio hook says so). */
  *soundGen(name) {
    const r = this.playSfx(name);
    if (!isThen(r)) return;
    let done = false, frames = 0;
    r.then(() => { done = true; }, () => { done = true; });
    yield () => done || ++frames > 600; // never hang a text on a lost promise
  }

  /** YES/NO box. */
  *yesNoGen(opts = {}) {
    this.freeze++;
    try {
      return yield* new YesNoMenu({ font: this.font, map: this.ui, input: this.input, sfx: this.game.sfx, ...opts }).run();
    } finally {
      this.freeze--;
    }
  }

  /** A vertical menu; returns the index or -1. */
  *menuGen(items, opts = {}) {
    this.freeze++;
    const menu = new Menu({ font: this.font, map: this.ui, input: this.input, sfx: this.game.sfx, items, ...opts });
    try {
      return yield* menu.run();
    } finally {
      menu.close();
      this.freeze--;
    }
  }

  // ===================================================================== START menu

  openStartMenu() {
    if (!this.hooks.onStartMenu) return;
    this.playSfx('SFX_START_MENU');
    const r = this.hooks.onStartMenu(this.ctx);
    if (isIter(r) || isThen(r)) {
      const ov = this;
      this.freeze++;
      this.run(function* startMenu() {
        try { if (isIter(r)) yield* r; else yield r; } finally { ov.freeze--; }
      }());
    }
  }

  // ===================================================================== fades, emotes

  *fadeGen(dir, color) {
    this.freeze++;
    try {
      if (dir === 'out') {
        this.paletteHeld = true;
        yield* (color === 'white' ? this.palette.fadeToWhite() : this.palette.fadeToBlack());
      } else {
        yield* this.palette.fadeIn(color === 'white' ? 'white' : 'black');
        this.paletteHeld = false;
        this.loadGBPal();
      }
    } finally {
      this.freeze--;
    }
  }

  /** EmotionBubble: 60 frames, everything frozen. target 0 = player. */
  *emoteGen(target, kind = 'shock') {
    const e = { target, kind };
    this.freeze++;
    this.emotes.push(e);
    try {
      yield EMOTE_FRAMES;
    } finally {
      this.emotes = this.emotes.filter((x) => x !== e);
      this.freeze--;
    }
  }

  // ===================================================================== scripted movement

  *movePlayerGen(path) {
    yield () => this.player.walkCounter === 0 && !this.simulating && !this.mapChanging;
    if (!path.length) return;
    this.startSimulating(path);
    const startMap = this.mapName;
    yield () => (!this.simulating && this.player.walkCounter === 0) || this.mapName !== startMap;
    yield () => !this.mapChanging;
  }

  *moveNpcGen(objectIndex, path, opts = {}) {
    const n = this.npc(objectIndex);
    if (!n || !path.length) return;
    if (this.isObjectHidden(n)) return;
    if (opts.sync) {
      n.startSyncScript(path);
      this.npcMovementScript++;
      try {
        yield () => !n.syncScript || !n.syncScript.active || !this.npcs.includes(n);
      } finally {
        this.npcMovementScript = Math.max(0, this.npcMovementScript - 1);
      }
      return;
    }
    n.startScript(path, { restore: !!opts.restore });
    yield () => !n.scripted || !this.npcs.includes(n);
  }

  // ===================================================================== map changes from scripts

  /** ctx.warp(map, warpIndex): WarpFound2 with a script-chosen destination. */
  *scriptWarpGen(mapName, warpIndex, opts = {}) {
    yield () => this.player.walkCounter === 0 && !this.mapChanging;
    const p = this.player;
    this.mapChanging = true;
    this.freeze++;
    let entered = false;
    try {
      if (!this.data.mapEntry(mapName)) throw new Error(`ctx.warp: unknown map ${mapName}`);
      const loading = this.data.loadMapBundle(mapName);
      if (this.map.json.isOutside) {
        this.setLastOutdoor(this.mapName, p.x, p.y, null);
      }
      if (opts.sound !== false) yield* this.mapChangeSoundGen();
      else if (!this.mapPalOffset) yield* this.palette.fadeToBlack();
      p.standingOnDoor = true;
      this.ignoreInputFrames = IGNORE_INPUT_FRAMES;
      yield loading;
      this.fixLastOutdoorFor(mapName);
      const dj = this.data.getMapJson(mapName);
      const dw = dj.warps[warpIndex] || dj.warps[0] || { x: 0, y: 0 };
      yield* this.lcdOffGen();
      this.enterMapNow(mapName, dw.x, dw.y, opts.facing || p.facing, { kind: 'warp' });
      entered = true;
      yield* this.lcdOnGen();
    } finally {
      this.freeze--;
      this.mapChanging = false;
      this.iterDelay = 1;
    }
    if (entered) yield* this.enterHookGen();
  }

  /**
   * Teleport (fly / escape rope / blackout / debug). opts: {facing, fade: 'black'|'white'|
   * 'none', setLastMap: true (special warps set wLastMap to the destination), keepMode:
   * false (like HandleFlyWarpOrDungeonWarp the player gets off the bike / out of the water)}.
   */
  *teleportGen(mapName, x, y, opts = {}) {
    yield () => this.player.walkCounter === 0 && !this.mapChanging;
    const fade = opts.fade || 'black';
    this.mapChanging = true;
    this.freeze++;
    let entered = false;
    try {
      if (!this.data.mapEntry(mapName)) throw new Error(`ctx.teleport: unknown map ${mapName}`);
      const loading = this.data.loadMapBundle(mapName);
      if (fade === 'black') yield* this.palette.fadeToBlack();
      else if (fade === 'white') yield* this.palette.fadeToWhite();
      yield loading;
      const entry = this.data.mapEntry(mapName);
      if (opts.setLastMap !== false && entry.isOutside) {
        this.setLastOutdoor(mapName);
      } else {
        this.fixLastOutdoorFor(mapName);
      }
      this.mapPalOffset = 0;
      this.player.standingOnDoor = false;
      this.player.standingOnWarp = false;
      // HandleFlyWarpOrDungeonWarp: wWalkBikeSurfState = walking (opts.keepMode opts out)
      if (!opts.keepMode) this.player.mode = MODE.WALK;
      this.enterMapNow(mapName, x, y, opts.facing || this.player.facing, { kind: 'teleport' });
      entered = true;
      if (fade === 'white') yield* this.palette.fadeInFromWhite();
      else if (fade === 'black') yield* this.palette.fadeInFromBlack();
      this.loadGBPal();
    } finally {
      this.freeze--;
      this.mapChanging = false;
      this.iterDelay = 1;
    }
    if (entered) yield* this.enterHookGen();
  }

  /** Fall through a hole (LeaveMapThroughHoleAnim) to a dungeon warp (DungeonWarpData). */
  *dungeonWarpGen(destConst, whichWarp) {
    yield () => this.player.walkCounter === 0;
    const meta = this.data.meta.dungeonWarps.find((w) => w.map === destConst && w.whichWarp === whichWarp);
    const mapName = this.data.mapNameForConst(destConst);
    this.mapChanging = true;
    this.freeze++;
    let entered = false;
    const p = this.player;
    try {
      if (!meta || !mapName) throw new Error(`dungeonWarp: no dungeon warp ${destConst} #${whichWarp}`);
      this.emit('hole', { from: this.mapName, to: mapName, whichWarp });
      const loading = this.data.loadMapBundle(mapName);
      // LeaveMapThroughHoleAnim: upper half shifted down 8 px, lower half hidden; 2 frames; gone
      p.halfHidden = true;
      yield 2;
      p.hidden = true;
      yield* this.palette.fadeToWhite();
      yield loading;
      this.mapPalOffset = 0;
      p.standingOnDoor = false;
      p.mode = MODE.WALK; // HandleFlyWarpOrDungeonWarp
      this.enterMapNow(mapName, meta.x, meta.y, p.facing, { kind: 'teleport' });
      entered = true;
      p.hidden = true;
      // EnterMapAnim (dungeon warp): fade in from white, 50 frames, spin while moving down
      yield* this.palette.fadeInFromWhite();
      this.loadGBPal();
      yield 50;
      p.hidden = false;
      yield* this.spinMoveGen(-20, 60, 16, 3);
    } finally {
      p.hidden = false;
      p.halfHidden = false;
      p.screenY = null;
      p.spinFacing = null;
      this.onDungeonWarp = false;
      this.freeze--;
      this.mapChanging = false;
      this.iterDelay = 1;
    }
    if (entered) yield* this.enterHookGen();
  }

  /** PlayerSpinWhileMovingUpOrDown: rotate the facing while the sprite moves vertically. */
  *spinMoveGen(fromY, toY, step, delay) {
    const p = this.player;
    let i = Math.max(0, SPIN_ORDER.indexOf(p.facing));
    p.screenY = fromY;
    for (;;) {
      p.spinFacing = SPIN_ORDER[i++ & 3];
      p.screenY += Math.sign(toY - fromY) * step;
      if (p.screenY === toY) break;
      yield delay;
    }
    p.screenY = null;
    p.spinFacing = null;
  }

  /** _LeaveMapAnim on a warp pad: spin up, fade to white. */
  *leaveMapAnimGen() {
    this.playSfx('SFX_TELEPORT_EXIT_1');
    yield* this.spinMoveGen(0x3c, -20, 16, 3);
    this.player.hidden = true;
    yield* this.palette.fadeToWhite();
  }

  /** EnterMapAnim (teleport / warp pad arrival). */
  *enterMapAnimGen() {
    const p = this.player;
    p.hidden = true;
    yield 3;
    yield* this.palette.fadeInFromWhite();
    this.loadGBPal();
    this.playSfx('SFX_TELEPORT_ENTER_1');
    p.hidden = false;
    yield* this.spinMoveGen(-20, 0x3c, 16, 3);
    this.playSfx('SFX_TELEPORT_ENTER_2');
  }

  // ===================================================================== battles

  /**
   * Wild encounter test at the end of a step (NewBattle -> TryDoWildEncounter).
   * @returns {boolean} a battle started
   */
  newBattle() {
    if (this.onDungeonWarp) return false;
    if (this.controlledByGame()) return false;
    if (this.noBattles) return false;
    if (this.noRandomBattleSteps > 0) return false;
    return this.tryWildEncounter();
  }

  /** TryDoWildEncounter */
  tryWildEncounter() {
    if (this.npcMovementScript) return false;
    const p = this.player, g = this.map.grid, ts = this.map.tileset, j = this.map.json;
    if (p.standingOnDoor || p.exitingDoor || p.standingOnWarp || p.ledge || p.spinning) return false;
    const under = g.cellTile(p.x, p.y);
    if (isDoorTile(ts, under)) return false;
    if (isWarpTile(ts, under)) { p.standingOnWarp = false; return false; }
    if (isJustOutsideMap(p.x, p.y, j.width, j.height)) return false;
    if (this.state.repelSteps > 0) {
      this.state.repelSteps--;
      if (this.state.repelSteps === 0) {
        this.runScript(this.textGen('RepelWoreOffText'));
        return false;
      }
    }
    const table = encounterTable(this.map.wild, under, g.cellTileBR(p.x, p.y), ts.grassTile, this.map.indoor, ts.const);
    if (!table) return false;
    const roll = rollEncounter(table, this.rng);
    if (!roll) return false;
    if (this.state.repelSteps > 0) {
      const lead = this.callGameHook('getLeadLevel', [], null);
      if (lead != null && roll.mon.level < lead) return false;
    }
    this.stats.encounters++;
    this.emit('wild', { species: roll.mon.species, const: roll.mon.const, level: roll.mon.level, slot: roll.slot, table: table.kind });
    this.mapChanging = true;
    this.run(this.battleGen({ species: roll.mon.species, level: roll.mon.level, wild: true, slot: roll.slot, kind: table.kind }));
    return true;
  }

  /**
   * Run a battle through the hooks and return to the overworld afterwards (EnterMap after
   * battle: 3 steps without random battles, fade in from white).
   * opts: {species, level} (wild / static) or {trainerClass, partyIndex, objectIndex, texts}.
   */
  *battleGen(opts) {
    this.freeze++;
    this.mapChanging = true;
    let result;
    try {
      let r;
      if (opts.trainerClass) {
        r = this.hooks.onTrainerBattle
          ? this.hooks.onTrainerBattle(this.mapName, opts.objectIndex, opts.trainerClass, opts.partyIndex, opts.texts || {}, this.ctx)
          : interact.defaultTrainerBattleGen(this, opts);
      } else {
        r = this.hooks.onWildEncounter
          ? this.hooks.onWildEncounter(opts.species, opts.level, { ...opts, map: this.mapName }, this.ctx)
          : interact.defaultWildBattleGen(this, opts);
      }
      const real = !!(opts.trainerClass ? this.hooks.onTrainerBattle : this.hooks.onWildEncounter);
      if (isIter(r)) result = yield* r;
      else if (isThen(r)) result = yield r;
      else result = r;
      this.noRandomBattleSteps = NO_BATTLE_STEPS_AFTER_BATTLE;
      this.state.stepCounter = 0; // the battle returns through EnterMap
      // MapEntryAfterBattle: standing-on-warp flag, fade in from white
      const p = this.player;
      p.standingOnWarp = (this.map.json.warps || []).some((w) => w.x === p.x && w.y === p.y);
      if (real && !this.mapPalOffset && result !== 'blackout') {
        this.palette.whiteOut();
        yield* this.palette.fadeInFromWhite();
      }
      this.loadGBPal();
      // OverworldLoop .battleOccurred: losing in OAKS_LAB skips the faint check (no blackout)
      if ((result === 'lose' || result === 'blackout') && this.hooks.onBlackout && this.map.json.const !== 'OAKS_LAB') {
        const b = this.hooks.onBlackout(this.ctx, opts);
        if (isIter(b)) yield* b; else if (isThen(b)) yield b;
      }
    } finally {
      this.freeze--;
      this.mapChanging = false;
      this.iterDelay = ITERATION_FRAMES;
    }
    return result;
  }

  /**
   * A trainer saw the player: "!" (60 frames), walk up, textBefore, battle, flag
   * (CheckFightingMapTrainers -> DisplayEnemyTrainerTextAndStartBattle -> EndTrainerBattle).
   */
  *trainerEngageGen(npc, header, dist) {
    // scriptCount / inputLock were taken by checkFightingMapTrainers
    try {
      const cls = npc.def.trainer && npc.def.trainer.trainerClass;
      const tc = cls && this.data.trainerClassByConst.get(cls);
      if (tc && tc.encounterMusic && !RIVAL_CLASSES.includes(cls)) this.playMusic(tc.encounterMusic);
      yield* this.emoteGen(npc.index, 'shock');
      const path = trainerApproachPath(npc.facing, dist);
      if (path.length) yield* this.moveNpcGen(npc.index, path);
      yield () => !npc.moving;
      yield* interact.talkToTrainerGen(this, npc, header, { seen: true });
    } finally {
      this.trainerEngaged = false;
      this.scriptCount--;
      this.inputLock = Math.max(0, this.inputLock - 1);
    }
  }

  // ===================================================================== surf / bike

  /** Change walk/bike/surf state (sprite + music). */
  setMode(mode) {
    const p = this.player;
    if (p.mode === mode) return;
    p.mode = mode;
    this.state.surfing = mode === MODE.SURF;
    this.state.bike = mode === MODE.BIKE;
    this.updateMusic();
    this.emit('mode', { mode: p.modeName });
  }

  /**
   * ItemUseSurfboard (Surf from the party menu): start surfing onto the water in front, or
   * get off onto walkable land. Returns 'started' | 'stopped' | 'cant'.
   */
  useSurf() {
    const p = this.player;
    if (!this.ready || p.walkCounter !== 0 || this.simulating) return 'cant';
    const g = this.map.grid, ts = this.map.tileset;
    const f = this.frontCell();
    const front = g.cellTile(f.x, f.y), under = g.cellTile(p.x, p.y);
    if (p.mode === MODE.SURF) {
      if (interact.spriteInFront(this, 16, false)) return 'cant';
      if (isPairBlocked(ts, under, front, true)) return 'cant';
      if (!isWalkable(ts, front)) return 'cant';
      this.startSimulating([p.facing]);
      this.setMode(MODE.WALK);
      return 'stopped';
    }
    if (!canStartSurf(ts, front)) return 'cant';
    if (isPairBlocked(ts, under, front, true)) return 'cant';
    this.startSimulating([p.facing]);
    this.setMode(MODE.SURF);
    return 'started';
  }

  /** ItemUseBicycle: toggle the bike. Returns 'on' | 'off' | 'cant'. */
  useBike() {
    const p = this.player;
    if (!this.ready || p.mode === MODE.SURF) return 'cant';
    if (p.mode === MODE.BIKE) { this.setMode(MODE.WALK); return 'off'; }
    if (!this.bikeAllowed()) return 'cant';
    this.setMode(MODE.BIKE);
    return 'on';
  }

  // ===================================================================== palette & music & audio

  /** Current SGB palette name for this map (SetPal_Overworld with lastOutdoor). */
  sgbPaletteName() {
    const lo = this.lastOutdoorNamed();
    const last = lo && this.data.mapEntry(lo.map);
    return overworldPaletteName(this.map.entry, last, this.data.sgb, this.data.paletteIdx);
  }

  /** Apply the colour set for the current palette mode. */
  applyPalette() {
    if (!this.palette || !this.map) return;
    const name = this.sgbPaletteName();
    this.palette.setColors(paletteColors(this.paletteMode, name, this.data.sgb));
    this.palette.setObjColors(0, null);
    this.palette.setObjColors(1, null);
    this.currentPaletteName = name;
  }

  /** 'sgb' | 'dmg' | 'gray' | 'pocket' | 'dmgClassic' */
  setPaletteMode(mode) {
    this.paletteMode = mode;
    this.applyPalette();
  }

  /** PlayDefaultMusic: bike / surf music override the map's. */
  updateMusic() {
    if (!this.map) return;
    const p = this.player;
    const music = p.mode === MODE.SURF ? 'MUSIC_SURFING' : p.mode === MODE.BIKE ? 'MUSIC_BIKE_RIDING' : this.map.json.music;
    if (music && music !== this.currentMusic) this.playMusic(music);
  }

  playSfx(name) {
    const a = this.hooks.audio;
    if (a && typeof a.playSfx === 'function') {
      try { return a.playSfx(name); } catch (err) { console.warn('[overworld] playSfx', name, err); }
    }
    return undefined;
  }

  playMusic(name) {
    this.currentMusic = name;
    const a = this.hooks.audio;
    if (a && typeof a.playMusic === 'function') {
      try { return a.playMusic(name); } catch (err) { console.warn('[overworld] playMusic', name, err); }
    }
    return undefined;
  }

  // ===================================================================== misc API

  /** Map name for a map name or a map constant ('PalletTown' / 'PALLET_TOWN'); null if unknown. */
  mapNameOf(id) {
    if (!id) return null;
    if (this.data.mapEntry(id)) return id;
    return this.data.mapNameForConst(id);
  }

  /** The id stored in state.pos.map / state.lastOutdoor.map, in the state's own style. */
  stateMapId(name) {
    if (this.idStyle !== 'const') return name;
    const e = this.data.mapEntry(name);
    return (e && e.const) || name;
  }

  /** state.lastOutdoor with its map as a map name (wLastMap). */
  lastOutdoorNamed() {
    const lo = this.state.lastOutdoor;
    return lo ? { ...lo, map: this.mapNameOf(lo.map) } : null;
  }

  /** Set state.lastOutdoor (wLastMap) from a map name. */
  setLastOutdoor(name, x = null, y = null, warpIndex = null) {
    this.state.lastOutdoor = { map: this.stateMapId(name), x, y, warpIndex };
  }

  /** Keep state.pos in sync with the player. */
  syncPos() {
    const p = this.player;
    const pos = this.state.pos;
    pos.map = this.stateMapId(this.mapName);
    pos.x = p.x;
    pos.y = p.y;
    pos.facing = p.facing;
  }

  /**
   * Turn the player. Like the scripts' `ld [wPlayerMovingDirection], a` the direction is
   * also stored as the moving direction, so the next UpdatePlayerSprite keeps it.
   */
  setPlayerFacing(facing) {
    if (!DIR_DELTA[facing]) return;
    const p = this.player;
    p.facing = facing;
    p.direction = facing;
    if (p.walkCounter === 0) p.movingDirection = facing;
    this.syncPos();
  }

  playerInfo() {
    const p = this.player;
    return { x: p.x, y: p.y, facing: p.facing, mode: p.modeName, moving: p.walkCounter !== 0 };
  }

  /** ReplaceTileBlock */
  setBlock(bx, by, block) {
    return this.map ? this.map.grid.setBlock(bx, by, block) : false;
  }

  setTextTable(label) {
    const t = this.map && this.map.text.textPointerTables.find((tb) => tb.label === label);
    if (t) this.map.textTable = t;
  }

  /** Debug: warp straight to warp `warpIndex` of `mapName` (test page). */
  debugWarp(mapName, warpIndex = 0) {
    return this.run(this.scriptWarpGen(mapName, warpIndex, { sound: true }));
  }

  /** Debug: teleport to a map position (test page). */
  debugTeleport(mapName, x, y, facing) {
    return this.run(this.teleportGen(mapName, x, y, { facing, fade: 'black' }));
  }

  /** Record an event (test page log / tests). */
  emit(kind, detail = {}) {
    const e = { frame: this.frameCount, map: this.mapName, ...detail, kind };
    this.log.push(e);
    if (this.log.length > 500) this.log.shift();
    if (this.onEvent) this.onEvent(e);
  }

  /** Camera: map pixel at the screen's top-left (the player's cell is at screen (64, 64)). */
  camera() {
    const p = this.player;
    return { x: p.px - 64, y: p.py - 64 };
  }

  /** Is a UI tile drawn over screen tile (tx, ty)? (sprites under text boxes are hidden) */
  uiCovers(tx, ty) {
    return this.ui && this.ui.get(tx, ty) !== EMPTY;
  }
}

/**
 * Continue a generator whose first next() was already called (its first yielded value is
 * yielded again so the coroutine runner handles it), forwarding sent values and errors.
 */
export function* resumeGenerator(it, first) {
  let res = first;
  while (!res.done) {
    let sent;
    try {
      sent = yield res.value;
    } catch (err) {
      res = it.throw(err);
      continue;
    }
    res = it.next(sent);
  }
  return res.value;
}

/**
 * Prepare a command list for the TextBox: `sound` commands become calls that wait for the
 * jingle (TextCommand_SOUND waits with WaitForSoundToFinish).
 */
export function prepareCommands(cmds) {
  let changed = false;
  const out = cmds.map((c) => {
    if (c && c.cmd === 'sound') {
      changed = true;
      return { cmd: 'text_asm', __sound: soundName(c.sound || c.name) };
    }
    return c;
  });
  return changed ? out : cmds;
}

/** 'sound_get_item_1' -> 'SFX_GET_ITEM_1' (cries keep their name). */
export function soundName(s) {
  if (!s) return s;
  if (/^SFX_|^MUSIC_/.test(s)) return s;
  if (/^sound_cry_/.test(s)) return s.replace(/^sound_cry_/, 'CRY_').toUpperCase();
  return s.replace(/^sound_/, 'SFX_').toUpperCase();
}

export { OPPOSITE, STATUS, MOVE_STAY };
