// Map script hook API for the story-scripting layer (see docs/overworld.md for a worked
// example).
//
//   import { registerMapScript } from './src/overworld/scripts.js';
//   registerMapScript('PalletTown', {
//     onEnter(ctx) {},                       // map loaded and player placed
//     onFrame(ctx) {},                       // every overworld-loop iteration while standing
//     onStep(ctx, x, y) {},                  // a step was completed on this map
//     onInteract(ctx, objectIndex) {},       // A on an NPC (1-based object index)
//     onSign(ctx, bgIndex) {},               // A on a sign (0-based index into map.bgEvents)
//     onHiddenObject(ctx, routine, args) {}, // A on a hidden object (args = the hiddenObjects entry)
//     onTextAsm(ctx, label) {},              // a displayed text reached `text_asm`
//     onWarpAttempt(ctx, warp) {},           // about to warp; return false to cancel
//   });
//
// Every hook may be a plain function or a generator function. A hook that returns a
// generator (or a promise) runs as a *blocking script*: player input is locked until it
// finishes (NPCs keep moving, the player can be moved with ctx.movePlayer). A hook that
// returns `undefined`/`false` - or a generator that returns `ctx.DEFAULT` - lets the engine
// do its default behaviour (show the NPC/sign text, etc.).
//
// ctx actions return engine Coroutines: `yield ctx.showText('Label')` waits for it inside a
// generator, `await ctx.showText(...)` works from async code, and starting two actions before
// waiting runs them in parallel:  const a = ctx.moveNpc(1, ['down']); yield ctx.movePlayer(['up']); yield a;

import { DEFAULT, DIR_DELTA, OPPOSITE } from './constants.js';

/** @type {Map<string, any>} */
const registry = new Map();

/**
 * Register the script object of a map (replaces a previous one).
 * Optional flags on the object turn off engine defaults for that map:
 * `trainers: false` (no automatic line-of-sight battles), `spinners: false`, `holes: false`.
 * @param {string} mapName map label, e.g. 'PalletTown'
 * @param {object} def hooks (see file header)
 * @returns {() => void} unregister function
 */
export function registerMapScript(mapName, def) {
  registry.set(mapName, def);
  return () => { if (registry.get(mapName) === def) registry.delete(mapName); };
}

/** @returns {any|null} the registered script object of a map */
export function getMapScript(mapName) {
  return registry.get(mapName) || null;
}

export function clearMapScripts() {
  registry.clear();
}

export function registeredMapScripts() {
  return [...registry.keys()];
}

/**
 * Normalise a movement path: an array of 'up' | 'down' | 'left' | 'right', ['up', n],
 * {dir: 'up', n}, {face: 'left'} (turn without moving, NPCs only) or null (wait one step,
 * NO_INPUT), or a string such as 'up up left' / 'up*3, left'.
 * @param {any} path
 * @returns {Array<string|null|{face:string}>}
 */
export function normalizePath(path) {
  if (path == null) return [];
  if (typeof path === 'string') {
    return path.split(/[\s,]+/).filter(Boolean).flatMap((tok) => {
      const m = tok.match(/^(up|down|left|right)(?:\*(\d+))?$/i);
      if (!m) throw new Error(`normalizePath: bad step "${tok}"`);
      return Array(m[2] ? +m[2] : 1).fill(m[1].toLowerCase());
    });
  }
  if (!Array.isArray(path)) path = [path];
  const out = [];
  for (const s of path) {
    if (s === null || s === 'wait' || s === 'none') { out.push(null); continue; }
    if (typeof s === 'string') {
      if (!DIR_DELTA[s]) out.push(...normalizePath(s));
      else out.push(s);
      continue;
    }
    if (Array.isArray(s)) { for (let i = 0; i < (s[1] ?? 1); i++) out.push(s[0]); continue; }
    if (s && s.face) { out.push({ face: s.face }); continue; }
    if (s && s.dir) { for (let i = 0; i < (s.n ?? 1); i++) out.push(s.dir); continue; }
    throw new Error(`normalizePath: bad step ${JSON.stringify(s)}`);
  }
  return out;
}

/**
 * FindPathToPlayer (engine/overworld/pathfinding.asm): at each step reduce whichever of the
 * remaining X / Y distances is larger (X when equal).
 * @returns {string[]} directions
 */
export function findPath(x0, y0, x1, y1) {
  const out = [];
  let dx = x1 - x0, dy = y1 - y0;
  while (dx || dy) {
    if (Math.abs(dx) >= Math.abs(dy)) { out.push(dx > 0 ? 'right' : 'left'); dx -= Math.sign(dx); }
    else { out.push(dy > 0 ? 'down' : 'up'); dy -= Math.sign(dy); }
  }
  return out;
}

/**
 * The `ctx` object passed to map-script hooks. One per overworld; it always refers to the
 * current map.
 */
export class ScriptContext {
  /** @param {any} ov the OverworldScene */
  constructor(ov) {
    this.ov = ov;
    /** return this from a generator hook to run the engine's default behaviour afterwards */
    this.DEFAULT = DEFAULT;
  }

  // ------------------------------------------------------------------ info

  /** Current map label ('PalletTown'). */
  get map() { return this.ov.mapName; }
  /** Current map JSON (data/maps/<Map>.json). */
  get mapData() { return this.ov.map ? this.ov.map.json : null; }
  /** The shared game state. */
  get state() { return this.ov.state; }
  /** The global hooks object. */
  get hooks() { return this.ov.hooks; }
  /** Player snapshot: {x, y, facing, mode: 'walk'|'bike'|'surf', moving}. */
  get player() { return this.ov.playerInfo(); }
  /** NPC handle (live object) for a 1-based object index, or null. */
  npc(objectIndex) { return this.ov.npc(objectIndex); }

  // ------------------------------------------------------------------ text & menus

  /**
   * Show a text box. `text` is a text label of the current map or common.json, a command
   * list, {commands}, or a literal string. Options: {wait: true} wait for A/B at the end,
   * {close: true}, {subs: {...}} extra substitutions (e.g. wStringBuffer).
   * @returns {import('../engine/scene.js').Coroutine}
   */
  showText(text, opts = {}) { return this.ov.run(this.ov.textGen(text, opts)); }

  /** Remove a text box left open with {close: false}. */
  closeText() { this.ov.textBox.close(); }

  /** YES/NO box (returns a Coroutine resolving to true/false). Options as YesNoMenu. */
  yesNo(opts = {}) { return this.ov.run(this.ov.yesNoGen(opts)); }

  /** Vertical menu (Coroutine resolving to the index, -1 on B). Options as engine Menu. */
  menu(items, opts = {}) { return this.ov.run(this.ov.menuGen(items, opts)); }

  // ------------------------------------------------------------------ control

  /** Ignore the player's D-pad/A/B/START (wJoyIgnore). Nested calls stack. */
  lockInput() { this.ov.inputLock++; }
  unlockInput() { this.ov.inputLock = Math.max(0, this.ov.inputLock - 1); }

  /**
   * Move the player along a path with simulated D-pad presses (no collision checks except
   * on the last step, no wild battles - like the ROM's simulated joypad). Warps on the way
   * still fire.
   */
  movePlayer(path) { return this.ov.run(this.ov.movePlayerGen(normalizePath(path))); }

  /**
   * Walk an NPC along a path (MoveSprite: collisions ignored; afterwards the NPC STAYs like
   * in the ROM unless {restore: true}). {sync: true} uses DoScriptedNPCMovement: the NPC moves
   * at the player's speed, for walking together with ctx.movePlayer.
   */
  moveNpc(objectIndex, path, opts = {}) {
    return this.ov.run(this.ov.moveNpcGen(objectIndex, normalizePath(path), opts));
  }

  /** Turn an NPC. */
  faceNpc(objectIndex, facing) {
    const n = this.ov.npc(objectIndex);
    if (n) n.face(facing);
  }

  /** Turn the NPC towards the player. */
  npcFacePlayer(objectIndex) {
    const n = this.ov.npc(objectIndex);
    if (!n) return;
    const p = this.ov.player;
    const dx = p.x - n.x, dy = p.y - n.y;
    n.face(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  }

  /** Turn the player (optionally towards an NPC: facePlayer({npc: 1})). */
  facePlayer(facing) {
    const p = this.ov.player;
    if (facing && typeof facing === 'object' && facing.npc != null) {
      const n = this.ov.npc(facing.npc);
      if (!n) return;
      const dx = n.x - p.x, dy = n.y - p.y;
      facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    }
    this.ov.setPlayerFacing(facing);
  }

  /** Wait n frames. */
  wait(frames) { return this.ov.run(function* waitFrames() { yield frames; }); }

  /** Run a generator as a child coroutine (returns the Coroutine). */
  run(gen) { return this.ov.run(gen); }

  /** Palette fades: 'black' (default, 32 frames) or 'white' (24 frames). */
  fadeOut(to = 'black') { return this.ov.run(this.ov.fadeGen('out', to)); }
  fadeIn(from = 'black') { return this.ov.run(this.ov.fadeGen('in', from)); }

  /** Emotion bubble over the player (0) or an NPC: 'shock' | 'question' | 'happy' (60 frames). */
  emote(objectIndex = 0, kind = 'shock') { return this.ov.run(this.ov.emoteGen(objectIndex, kind)); }

  // ------------------------------------------------------------------ map changes

  /** Warp to warp `warpIndex` (0-based) of `mapName`, exactly like stepping on a warp. */
  warp(mapName, warpIndex = 0, opts = {}) { return this.ov.run(this.ov.scriptWarpGen(mapName, warpIndex, opts)); }

  /**
   * Teleport to (x, y) of `mapName` (fly / escape rope / blackout style). Options:
   * {facing, fade: 'black'|'white'|'none', setLastMap: true}.
   */
  teleport(mapName, x, y, opts = {}) { return this.ov.run(this.ov.teleportGen(mapName, x, y, opts)); }

  /** Fall through a hole to dungeon warp `whichWarp` (1-based) of `destMapConst`. */
  dungeonWarp(destMapConst, whichWarp) { return this.ov.run(this.ov.dungeonWarpGen(destMapConst, whichWarp)); }

  /** Make the next step onto a warp of the current map warp even without a direction held. */
  forceWarp() { this.ov.forcedWarp = true; }

  /** Replace a map block (ReplaceTileBlock); coordinates in blocks. */
  setBlock(bx, by, block) { return this.ov.setBlock(bx, by, block); }

  /** Switch the map's text pointer table (e.g. 'OaksLab_TextPointers2'). */
  setTextTable(label) { this.ov.setTextTable(label); }

  // ------------------------------------------------------------------ objects & flags

  /** Hide / show an object (persisted in state.missables when it is toggleable). */
  hideObject(objectIndex) { this.ov.setObjectHidden(objectIndex, true); }
  showObject(objectIndex) { this.ov.setObjectHidden(objectIndex, false); }
  /** Move an object to a step. */
  placeObject(objectIndex, x, y, facing) {
    const n = this.ov.npc(objectIndex);
    if (n) { n.setPosition(x, y); if (facing) n.face(facing); }
  }

  /**
   * Hide / show a toggleable object by its TOGGLE_* const or index, whatever map it is on
   * (ShowObject / HideObject with wToggleableObjectIndex).
   */
  hideToggle(toggle) { this.ov.setToggleHidden(toggle, true); }
  showToggle(toggle) { this.ov.setToggleHidden(toggle, false); }

  /** FindPathToPlayer: greedy path from (x0, y0) to (x1, y1) (larger distance first, X on ties). */
  pathTo(x0, y0, x1, y1) { return findPath(x0, y0, x1, y1); }

  getFlag(name) { return this.ov.state.flags.get(name); }
  setFlag(name, value = true) { this.ov.state.flags.set(name, value); }
  clearFlag(name) { this.ov.state.flags.clear(name); }

  // ------------------------------------------------------------------ audio & game hooks

  playSfx(name) { return this.ov.playSfx(name); }
  playMusic(name) { return this.ov.playMusic(name); }

  /** hooks.giveItem(item, qty) -> true if it fit in the bag (true when no hook). */
  giveItem(item, qty = 1) { return this.ov.callGameHook('giveItem', [item, qty], true); }
  /** hooks.hasItem(item) -> boolean (false when no hook). */
  hasItem(item) { return this.ov.callGameHook('hasItem', [item], false); }
  /** hooks.givePokemon(species, level) -> true if received. */
  givePokemon(species, level) { return this.ov.callGameHook('givePokemon', [species, level], true); }
  /**
   * Start a battle through the hooks: {trainerClass, partyIndex, objectIndex, texts} for a
   * trainer, {species, level} for a wild/static Pokémon. Returns a Coroutine resolving to
   * the battle result.
   */
  startBattle(opts) { return this.ov.run(this.ov.battleGen(opts)); }

  // ------------------------------------------------------------------ helpers

  /** Direction from (x0, y0) to (x1, y1) along the larger axis. */
  static directionTo(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  }

  static opposite(dir) { return OPPOSITE[dir]; }
}
