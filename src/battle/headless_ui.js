// A UI for the battle engine without a screen: every message is flattened to a string and
// logged, waits only advance a frame counter, and a controller answers the menus. Used by the
// node tests, the soak runner and `runBattleHeadless`.
//
//   const ui = new HeadlessUI({ controller: new RandomController(rng), text: library });
//   const battle = new Battle({ state, params, rng, ui, text: library });
//   const result = runToEnd(battle.run());

import { flattenText, oneLine } from './text.js';
import { PLAYER, ENEMY, PP_MASK } from './constants.js';
import { Rng } from '../engine/rng.js';

/** Run a generator to completion synchronously (yields are ignored). */
export function runToEnd(gen, maxSteps = 5e7) {
  let r = gen.next();
  let n = 0;
  while (!r.done) {
    if (++n > maxSteps) throw new Error('runToEnd: too many steps');
    r = gen.next();
  }
  return r.value;
}

export class HeadlessUI {
  /**
   * @param {object} [o]
   * @param {object} [o.controller] menu decisions (see RandomController / ScriptController)
   * @param {import('./text.js').TextLibrary} [o.text] resolver for the logged text
   * @param {boolean} [o.verbose] echo every message to the console
   * @param {boolean} [o.yieldFrames] yield once per waited frame (default: no yields)
   */
  constructor({ controller, text, verbose = false, yieldFrames = false } = {}) {
    this.controller = controller || new RandomController(new Rng(1));
    this.library = text || null;
    this.verbose = verbose;
    this.yieldFrames = yieldFrames;
    /** @type {string[]} every printed message, flattened */
    this.messages = [];
    /** @type {Array<{type:string, [k:string]:any}>} everything visible/audible, in order */
    this.events = [];
    this.frames = 0;
    this.lowHealthAlarm = false;
    this.currentMusic = null;
    this.battle = null;
  }

  attach(battle) { this.battle = battle; return this; }

  ev(type, o = {}) { this.events.push({ type, ...o }); }

  *wait(n) {
    this.frames += n;
    if (this.yieldFrames) for (let i = 0; i < n; i++) yield 1;
  }

  // ------------------------------------------------------------------ text

  *printText(cmds, subs, opts = {}) {
    if (opts.empty) {
      this.ev('emptyText');
      return;
    }
    const resolve = this.library ? this.library.resolver() : null;
    const s = flattenText(cmds, subs || {}, resolve);
    this.messages.push(s);
    this.ev('text', { text: s });
    if (this.verbose) console.log(`  | ${oneLine(s)}`);
    yield* this.wait(Math.max(1, s.length));
    if (!this.yieldFrames) yield 1; // lets runners stop a battle that never ends (Rage vs a Ghost...)
    for (const c of cmds || []) if (c && c.cmd === 'sound') this.ev('sfx', { name: c.sound });
  }

  *waitButton() { yield* this.wait(1); }
  drawEmptyMessageBox() {}

  // ------------------------------------------------------------------ screen

  saveScreen() {}
  restoreScreen() {}
  saveScreen2() {}
  restoreScreen2() {}
  clearScreen() { this.ev('clearScreen'); }
  clearArea() {}
  clearSprites() {}
  drawHUDs() { this.checkHUD(PLAYER); this.checkHUD(ENEMY); }
  drawHUD(side) { this.checkHUD(side); }
  drawPartyBalls() {}
  setEnemyPic(pic) { this.ev('enemyPic', { pic }); }
  setPlayerTrainerPic(kind) { this.ev('playerTrainerPic', { kind }); }
  setPlayerMonPic(species) { this.ev('playerMonPic', { species }); }
  endOfBattle() { this.ev('endOfBattle'); }

  /** Sanity checks of what a HUD would show (catches state corruption in the soak). */
  checkHUD(side) {
    const b = this.battle;
    if (!b) return;
    const S = b.side[side];
    if (!S.species) return;
    if (!(S.hp >= 0 && S.hp <= 0xffff)) throw new Error(`HUD ${side}: bad HP ${S.hp}`);
  }

  *hpBar(side, oldHP, newHP) {
    this.ev('hpBar', { side, oldHP, newHP });
    yield* this.wait(Math.min(48, Math.abs(oldHP - newHP)) + 1);
  }

  setLowHealthAlarm(on) {
    if (on !== this.lowHealthAlarm) this.ev('lowHealthAlarm', { on });
    this.lowHealthAlarm = on;
  }

  *battleTransition(id) { this.ev('transition', { id }); yield* this.wait(1); }
  *sequence(name, opts = {}) { this.ev('sequence', { name, attacker: opts.attacker }); yield* this.wait(1); }
  *anim(id, opts = {}) { this.ev('anim', { id, attacker: opts.attacker, ball: opts.ball }); yield* this.wait(1); }
  *shakeScreenHorizontally(n) { this.ev('shake', { n }); yield* this.wait(1); }
  *delay(n) { yield* this.wait(n | 0); }

  // ------------------------------------------------------------------ sound

  stopMusic() { this.currentMusic = null; this.ev('stopMusic'); }
  music(name) { this.currentMusic = name; this.ev('music', { name }); }
  sfx(name) { this.ev('sfx', { name }); }
  *sfxWait(name) { this.ev('sfx', { name }); yield* this.wait(1); }
  *waitSound() { yield* this.wait(0); }
  cry(species) { this.ev('cry', { species }); }
  *cryWait(species) { this.ev('cry', { species }); yield* this.wait(1); }

  // ------------------------------------------------------------------ menus

  *battleMenu(o) {
    const pos = this.controller.battleMenu({ ...o, battle: this.battle });
    this.ev('battleMenu', { pos });
    yield* this.wait(1);
    if (!this.yieldFrames) yield 1; // one yield per menu so runners can stop a stalled battle
    return pos;
  }

  *oldManBattleMenu() { yield* this.wait(1); }

  *moveMenu(o) {
    const b = this.battle;
    if (!o.type && b) b.moveMenuHover(o.cursor | 0);
    const r = this.controller.moveMenu({ ...o, battle: b });
    if (!o.type && b && r && r.index >= 0 && r.index < 4) b.moveMenuHover(r.index);
    this.ev('moveMenu', { action: r && r.action, index: r && r.index, menu: o.type || 'battle' });
    yield* this.wait(1);
    return r;
  }

  *partyMenu(o) {
    const i = this.controller.partyMenu({ ...o, battle: this.battle });
    this.ev('partyMenu', { menu: o.type, index: i });
    yield* this.wait(1);
    return i;
  }

  *closePartyMenu() {}

  *partyMenuItemResult(o) {
    const resolve = this.library ? this.library.resolver() : null;
    const s = flattenText(o.text, o.subs || {}, resolve);
    this.messages.push(s);
    this.ev('text', { text: s, partyMenu: true });
    if (this.verbose) console.log(`  | ${oneLine(s)}`);
    yield* this.wait(1);
  }

  *switchStatsCancel() {
    const r = this.controller.switchStatsCancel({ battle: this.battle });
    yield* this.wait(1);
    return r;
  }

  *statusScreen(mon) { this.ev('statusScreen', { species: mon && mon.species }); yield* this.wait(1); }

  *bagMenu(o) {
    if (o.oldMan) { // the old man picks POKé BALL by himself after 80 frames
      yield* this.wait(80);
      return { index: 0, cursor: 0, scroll: 0 };
    }
    const r = this.controller.bagMenu({ ...o, battle: this.battle });
    this.ev('bagMenu', { index: r.index });
    yield* this.wait(1);
    return { cursor: r.index >= 0 ? r.index : o.cursor, scroll: 0, ...r };
  }

  *yesNo(o) {
    const yes = this.controller.yesNo({ ...o, battle: this.battle });
    this.ev('yesNo', { kind: o.kind, yes });
    yield* this.wait(1);
    return yes;
  }

  *mimicMenu(moves) {
    const i = this.controller.mimicMenu({ moves, battle: this.battle });
    yield* this.wait(1);
    return i;
  }

  *forgetMoveMenu(moves, mon) {
    const i = this.controller.forgetMoveMenu({ moves, mon, battle: this.battle });
    yield* this.wait(1);
    return i;
  }

  *levelUpStats(mon) { this.ev('levelUpStats', { species: mon.species, level: mon.level }); yield* this.wait(1); }
  *pokedexEntry(species) { this.ev('pokedexEntry', { species }); yield* this.wait(1); }

  *namingScreen(species) {
    const name = this.controller.namingScreen({ species, battle: this.battle });
    this.ev('naming', { species, name });
    yield* this.wait(1);
    return name;
  }

  *evolutionScene(o) {
    const cancel = !!(o.canCancel && this.controller.evolutionCancel({ ...o, battle: this.battle }));
    this.ev('evolution', { from: o.from, into: o.into, cancelled: cancel });
    yield* this.wait(1);
    return cancel;
  }
}

// ======================================================================== controllers

const pick = (rng, arr) => arr[rng.randInt(arr.length)];

/**
 * Plays a battle with random but mostly sensible choices (soak tests). All decisions come
 * from its own seeded Rng, so a battle is reproducible from (battle seed, controller seed).
 */
export class RandomController {
  /**
   * @param {{randInt:(n:number)=>number, randByte:()=>number}} rng
   * @param {{fight?:number, items?:boolean, switches?:boolean, run?:boolean, nickname?:boolean}} [o]
   */
  constructor(rng, { fight = 70, items = true, switches = true, run = true, cancelEvolution = 25 } = {}) {
    this.rng = rng;
    this.fight = fight;
    this.items = items;
    this.switches = switches;
    this.run = run;
    this.cancelEvolution = cancelEvolution;
    this.menusWithoutTurn = 0;
  }

  chance(pct) { return this.rng.randInt(100) < pct; }

  battleMenu({ safari, battle }) {
    if (safari) return this.chance(60) ? 0 : this.chance(70) ? pick(this.rng, [1, 2]) : 3;
    this.menusWithoutTurn++;
    // a battle nobody can win (a ghost, two walls without damaging moves): try to leave
    if (battle && battle.turnCount > 150) {
      if (this.run && this.chance(30)) return 3;
      if (this.switches && this.chance(30)) return 2;
    }
    if (this.menusWithoutTurn > 6) return 0;
    const r = this.rng.randInt(100);
    if (r < this.fight) return 0;
    if (r < this.fight + 10 && this.switches) return 2; // PKMN
    if (r < this.fight + 22 && this.items) return 1; // ITEM
    if (this.run) return 3;
    return 0;
  }

  moveMenu({ moves, battle, type }) {
    if (type === 'relearn') return { action: 'select', index: this.rng.randInt(Math.max(1, moves.filter(Boolean).length)) };
    this.menusWithoutTurn++;
    const P = battle.side[PLAYER];
    const n = moves.filter(Boolean).length || 1;
    if (this.menusWithoutTurn < 4) {
      if (this.chance(3)) return { action: 'cancel', index: P.moveListIndex & 3 };
      if (this.chance(3)) return { action: 'swap', index: this.rng.randInt(n) };
    }
    const dis = (P.disabledMove >> 4) & 0xf;
    const usable = [];
    for (let i = 0; i < n; i++) if ((P.pp[i] & PP_MASK) && dis - 1 !== i) usable.push(i);
    this.menusWithoutTurn = 0;
    if (!usable.length || this.chance(2)) return { action: 'select', index: this.rng.randInt(n) };
    return { action: 'select', index: pick(this.rng, usable) };
  }

  partyMenu({ type, battle, cancelable }) {
    const party = battle.party;
    const alive = party.map((m, i) => (m.hp > 0 ? i : -1)).filter((i) => i >= 0);
    if (type === 'battle') {
      const others = alive.filter((i) => i !== battle.playerMonNumber);
      if (cancelable !== false && this.chance(5)) return -1;
      if (this.chance(5)) return this.rng.randInt(party.length);
      return others.length ? pick(this.rng, others) : alive.length ? alive[0] : 0;
    }
    if (type === 'item') {
      if (this.chance(10)) return -1;
      return this.rng.randInt(party.length);
    }
    // 'normal' (PKMN from the battle menu)
    if (this.chance(15)) return -1;
    if (this.chance(10)) return this.rng.randInt(party.length);
    const others = alive.filter((i) => i !== battle.playerMonNumber);
    return others.length ? pick(this.rng, others) : -1;
  }

  switchStatsCancel() {
    const r = this.rng.randInt(100);
    if (r < 75) return 0;
    if (r < 85) return 1;
    if (r < 93) return 2;
    return -1;
  }

  bagMenu({ items }) {
    if (!items.length || this.chance(10)) return { index: -1 };
    return { index: this.rng.randInt(items.length) };
  }

  yesNo({ kind }) {
    if (kind === 'useNextMon') return this.chance(80);
    if (kind === 'shift') return this.chance(30);
    if (kind === 'nickname') return this.chance(30);
    if (kind === 'tryingToLearn') return this.chance(70);
    if (kind === 'abandon') return this.chance(60);
    return this.chance(50);
  }

  mimicMenu({ moves }) {
    const n = moves.filter(Boolean).length || 1;
    return this.rng.randInt(n);
  }

  forgetMoveMenu({ moves }) {
    if (this.chance(15)) return -1;
    return this.rng.randInt(moves.filter(Boolean).length || 1);
  }

  namingScreen({ species }) {
    return this.chance(50) ? '' : pick(this.rng, ['SPARKY', 'BUD', 'X', 'ABCDEFGHIJ']);
  }

  evolutionCancel() { return this.chance(this.cancelEvolution); }
}

/**
 * Scripted choices for deterministic tests: each menu kind takes the next value of its
 * queue; an empty queue falls back to `fallback` (default: a RandomController with seed 1).
 *   new ScriptController({ battleMenu: [0, 0], moveMenu: [0, 1], yesNo: [true] })
 * Queue values may be functions (ctx) => value.
 */
export class ScriptController {
  constructor(queues = {}, fallback = null) {
    this.queues = {};
    for (const [k, v] of Object.entries(queues)) this.queues[k] = Array.isArray(v) ? v.slice() : [v];
    this.fallback = fallback || new RandomController(new Rng(1), { run: false, items: false, switches: false });
    this.calls = [];
  }

  take(kind, ctx, dflt) {
    this.calls.push(kind);
    const q = this.queues[kind];
    if (q && q.length) {
      const v = q.shift();
      return typeof v === 'function' ? v(ctx) : v;
    }
    return dflt();
  }

  battleMenu(ctx) { return this.take('battleMenu', ctx, () => this.fallback.battleMenu(ctx)); }
  moveMenu(ctx) { return moveChoice(this.take('moveMenu', ctx, () => this.fallback.moveMenu(ctx))); }
  partyMenu(ctx) { return this.take('partyMenu', ctx, () => this.fallback.partyMenu(ctx)); }
  switchStatsCancel(ctx) { return this.take('switchStatsCancel', ctx, () => 0); }
  bagMenu(ctx) {
    const v = this.take('bagMenu', ctx, () => ({ index: -1 }));
    if (typeof v === 'number') return { index: v };
    if (typeof v === 'string') return { index: ctx.items.findIndex((s) => s.item === v) };
    return v;
  }
  yesNo(ctx) { return this.take('yesNo', ctx, () => ctx.kind === 'useNextMon'); }
  mimicMenu(ctx) { return this.take('mimicMenu', ctx, () => 0); }
  forgetMoveMenu(ctx) { return this.take('forgetMoveMenu', ctx, () => 0); }
  namingScreen(ctx) { return this.take('namingScreen', ctx, () => ''); }
  evolutionCancel(ctx) { return this.take('evolutionCancel', ctx, () => false); }
}

/**
 * Normalise a scripted move choice: a number = select that slot.
 * @param {number|{action:string, index:number}} v
 */
export function moveChoice(v) {
  return typeof v === 'number' ? { action: 'select', index: v } : v;
}
