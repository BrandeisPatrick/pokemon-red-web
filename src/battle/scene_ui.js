// The battle engine's UI on the real screen: HUDs, HP bar animation, text box, the battle /
// move / party / bag menus, YES/NO boxes, the level-up stats box, the evolution movie, the
// transitions and the animations (BattleAnimView owns both pics). Every method the engine
// calls with `yield*` is a generator that yields frame counts (the scene's Coroutine runner
// waits that many frames), promises (other scenes: naming, status screen, Pokédex) or 1.
//
// Screen model (the GB's single wTileMap split in three):
//   base  TileMap drawn inside view.render()'s drawScreen: HUDs, text box, menus that do not
//         cover a pic region - it moves with the screen shakes like the GB window
//   view  BattleAnimView: the two pic regions (its own PicTilemap cells), OAM, PPU effects
//   top   TileMap drawn after view.render(): boxes that cover a pic region (move info box,
//         item list, mimic / forget-move menus, level-up stats, the shift YES/NO)
//   full  TileMap for the full-screen party menu (mode 'party')
// saveScreen/restoreScreen snapshot base + top + the view's pic cells (SaveScreenTilesToBuffer).

import { TileMap, EMPTY } from '../engine/tilemap.js';
import { TextBox } from '../engine/text.js';
import { YesNoMenu } from '../engine/menu.js';
import { byteToMap, BGP_NORMAL, OBP0_NORMAL } from '../engine/palette.js';
import {
  playAnimation, AnimRun, SPECIAL_EFFECT_ROUTINES, PLAYER_PIC_REGION, ENEMY_PIC_REGION, BLANK,
} from '../battle_anims/index.js';
import { shakeScreenHorizontally } from '../battle_anims/effects.js';
import * as hud from './hud.js';
import { TransitionGrid, battleTransition } from './transitions.js';
import { PLAYER, ENEMY, TRAINER_BATTLE } from './constants.js';
import { isKeyItem } from '../pokemon/bag.js';

const TEXT_SPEEDS = Object.freeze({ fast: 1, mid: 3, medium: 3, slow: 5, instant: 0 });
/** PartyMonSpeeds (5, 16, 32) + 1 on DMG: frames per icon frame for green / yellow / red HP. */
const ICON_FRAME_TIME = Object.freeze([6, 17, 33]);
const BOB_ICONS = new Set(['ICON_BALL', 'ICON_HELIX']);
const PIC_REGIONS = [PLAYER_PIC_REGION, ENEMY_PIC_REGION];
const MAX_SOUND_WAIT = 600;

const sideName = (s) => (s === ENEMY || s === 'enemy' ? 'enemy' : 'player');

function overlapsPic(x, y, w, h) {
  return PIC_REGIONS.some((r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y);
}

function inPicRegion(x, y) {
  return PIC_REGIONS.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
}

/** PrintBCDNumber: LEADING_ZEROES (bit 7) = do NOT print leading zeroes, LEFT_ALIGN = no padding. */
export function formatBCD(value, bytes, flags = []) {
  const digits = bytes * 2;
  const v = String(Math.max(0, Math.floor(Number(value) || 0)));
  const money = flags.includes('MONEY_SIGN') ? '¥' : '';
  if (flags.includes('LEADING_ZEROES')) {
    const s = money + v;
    return flags.includes('LEFT_ALIGN') ? s : s.padStart(digits + money.length, ' ');
  }
  return money + v.padStart(digits, '0');
}

/** Image cache for pics and icons (game.assets.image -> IndexedImage). */
export class PicCache {
  constructor(assets) {
    this.assets = assets;
    this.map = new Map();
  }

  get(url) { return (url && this.map.get(url)) || null; }

  async load(urls) {
    const todo = [...new Set(urls.filter((u) => u && !this.map.has(u)))];
    await Promise.all(todo.map(async (u) => {
      try {
        this.map.set(u, await this.assets.image(u));
      } catch (err) {
        console.warn(`[battle] cannot load ${u}: ${err && err.message ? err.message : err}`);
        this.map.set(u, null);
      }
    }));
  }
}

export const RED_BACK = 'assets/battle/red_back2x.png';
export const OLD_MAN_BACK = 'assets/battle/oldman_back2x.png';
export const GHOST_PIC = 'assets/pokemon/front/mon_ghost.png';
export const BALLS = 'assets/battle/balls.png';
export const iconUrl = (icon) => `assets/ui/icons/${String(icon || 'ICON_MON').replace(/^ICON_/, '').toLowerCase()}.png`;

export class SceneUI {
  /**
   * @param {object} o
   * @param {any} o.game        engine services (font, input, palette, assets, scenes, audio?, sfx?)
   * @param {any} o.scene       the BattleScene (opaque flag during the transition)
   * @param {import('../battle_anims/view.js').BattleAnimView} o.view
   * @param {PicCache} o.images
   * @param {import('./text.js').TextLibrary} o.texts
   * @param {any} o.gd
   * @param {any} o.state       GameState
   * @param {any} [o.audio]     src/audio facade (optional)
   */
  constructor({ game, scene, view, images, texts, gd, state, audio }) {
    this.game = game;
    this.scene = scene;
    this.font = game.font;
    this.input = game.input;
    this.palette = game.palette;
    this.view = view;
    this.images = images;
    this.texts = texts;
    this.gd = gd;
    this.state = state;
    this.audio = audio || null;
    this.base = new TileMap(20, 18);
    this.top = new TileMap(20, 18);
    this.full = new TileMap(20, 18);
    /** 'blank' | 'transition' | 'battle' | 'party' | 'evolution' */
    this.mode = 'blank';
    this.blip = { play: () => this.playSfx('SFX_PRESS_AB') };
    this.currentSubs = {};
    this.box = this.makeTextBox(this.base);
    this.fullBox = this.makeTextBox(this.full);
    this.saved = [null, null];
    this.transition = null;
    this.party = null; // party menu state {icons, selected, timer, frame}
    this.evoPic = null; // {img, flipped}
    this.enemyPicSpec = null;
    this.playerTrainer = 'red';
    this.lowHealthAlarm = false;
    this.battle = null;
    this.frame = 0;
  }

  attach(battle) {
    this.battle = battle;
    return this;
  }

  // ===================================================================== text

  makeTextBox(map) {
    const speed = TEXT_SPEEDS[this.state.options && this.state.options.textSpeed] ?? 3;
    return new TextBox({
      font: this.font, map, input: this.input, sfx: this.blip, speed,
      resolveFar: (label) => {
        const cmds = this.texts.get(label);
        return cmds ? this.prepare(cmds, this.currentSubs) : undefined;
      },
      onSound: (name) => this.playSfx(name),
      onCall: (cmd) => (cmd.script === 'battleSoundWait' ? this.sfxPlayAndWait(cmd.sound) : undefined),
    });
  }

  /**
   * Text commands as the TextBox should run them: sound commands wait for the sound
   * (TextCommand_SOUND calls WaitForSoundToFinish) and BCD numbers use PrintBCDNumber's flags.
   */
  prepare(cmds, subs) {
    const out = [];
    for (const c of cmds || []) {
      if (!c || typeof c !== 'object') { out.push(c); continue; }
      if (c.cmd === 'sound') out.push({ cmd: 'script', script: 'battleSoundWait', sound: c.sound || c.name });
      else if (c.cmd === 'text_bcd' || c.cmd === 'bcd') out.push({ cmd: 'text', str: formatBCD(subs[c.ram ?? c.var] ?? 0, c.bytes || 3, c.flags || []) });
      else out.push(c);
    }
    return out;
  }

  /** PrintText: a fresh message box (Delay3) and the text with the option speed. */
  *printText(cmds, subs, opts = {}) {
    const box = this.mode === 'party' ? this.fullBox : this.box;
    this.currentSubs = subs || {};
    if (this.mode === 'blank' || this.mode === 'transition') this.mode = 'battle';
    if (opts.empty) {
      yield* box.run([], { subs: this.currentSubs });
      return;
    }
    const speed = box.speed;
    if (opts.instant) box.speed = 0;
    try {
      yield* box.run(this.prepare(cmds, this.currentSubs), { subs: this.currentSubs, open: opts.open !== false });
    } finally {
      box.speed = speed;
    }
  }

  /** WaitForTextScrollButtonPress (no arrow, no sound). */
  *waitButton() {
    for (;;) {
      yield 1;
      if (this.input.pressed.a || this.input.pressed.b) return;
    }
  }

  drawEmptyMessageBox() {
    this.font.drawBox(this.base, 0, 12, 20, 6);
  }

  // ===================================================================== screen buffers

  snapshotScreen() {
    return { base: this.base.cells.slice(), top: this.top.cells.slice(), pic: this.view.tilemap.save() };
  }

  applyScreen(s) {
    this.base.cells.set(s.base);
    this.top.cells.set(s.top);
    this.view.tilemap.restore(s.pic);
    this.box.isOpen = false;
  }

  leaveFullScreen() {
    if (this.mode === 'party') {
      this.mode = 'battle';
      this.party = null;
      this.palette.setMaps(BGP_NORMAL, OBP0_NORMAL, this.palette.obp1);
    }
  }

  saveScreen() { this.saved[0] = this.snapshotScreen(); }
  restoreScreen() { this.leaveFullScreen(); if (this.saved[0]) this.applyScreen(this.saved[0]); }
  saveScreen2() { this.saved[1] = this.snapshotScreen(); }
  restoreScreen2() { this.leaveFullScreen(); if (this.saved[1]) this.applyScreen(this.saved[1]); }

  /** ClearScreenArea: the tile layers and the view's pic cells inside the rectangle. */
  clearArea(x, y, w, h) {
    this.base.clearRect(x, y, w, h);
    this.top.clearRect(x, y, w, h);
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) if (inPicRegion(xx, yy)) this.view.tilemap.set(xx, yy, BLANK);
    }
  }

  /** ClearScreen */
  clearScreen() {
    if (this.mode === 'blank') this.mode = 'battle';
    this.base.clear();
    this.top.clear();
    this.view.tilemap.reset(true);
    this.box.isOpen = false;
  }

  clearSprites() { this.view.oam.clear(); }

  /** A bordered box on the layer the GB's wTileMap write would be visible in. */
  layerFor(x, y, w, h) {
    if (this.mode === 'party') return this.full;
    return overlapsPic(x, y, w, h) ? this.top : this.base;
  }

  drawBoxOn(map, x, y, w, h) {
    this.font.drawBox(map, x, y, w, h);
  }

  // ===================================================================== HUD

  hudMon(side) {
    const S = this.battle.side[side];
    return { nick: S.nick, level: S.level, status: S.status, hp: S.hp, maxHP: S.maxHP, species: S.species };
  }

  drawHUD(side) {
    const b = this.battle;
    if (!b || !b.side[side].species) return;
    const clear = (x, y, w, h) => this.clearArea(x, y, w, h);
    if (side === PLAYER) {
      hud.drawPlayerHUD(this.base, this.font, this.hudMon(PLAYER), clear);
      b.updateLowHealthAlarm();
    } else {
      hud.drawEnemyHUD(this.base, this.font, this.hudMon(ENEMY), clear);
    }
  }

  drawHUDs() {
    this.drawHUD(PLAYER);
    this.drawHUD(ENEMY);
  }

  /** SetupOwnPartyPokeballs / SetupEnemyPartyPokeballs: HUD frame tiles + ball sprites. */
  drawPartyBalls(side, party) {
    const balls = this.images.get(BALLS);
    if (balls) for (let i = 0; i < 4; i++) this.view.objTiles[0x31 + i] = balls.tile(i);
    const tiles = hud.partyBallTiles(party || []);
    if (side === PLAYER) {
      hud.placePlayerHUDTiles(this.base, this.font);
      for (let i = 0; i < 6; i++) this.view.oam.set(i, 0x60, 0x60 + 8 * i, tiles[i], 0);
    } else {
      hud.placeEnemyHUDTiles(this.base, this.font);
      for (let i = 0; i < 6; i++) this.view.oam.set(6 + i, 0x20, 0x48 - 8 * i, tiles[i], 0);
    }
  }

  /**
   * UpdateHPBar2 for a side: the bar moves 1 HP at a time, 2 frames per pixel, the player's
   * numbers lag one step and cost a frame each; Delay3 at the end.
   */
  *hpBar(side, oldHP, newHP) {
    const b = this.battle;
    const S = b.side[side];
    b.hpBarHPDifference = Math.abs(newHP - oldHP);
    if (oldHP === newHP) return;
    const player = side === PLAYER;
    const draw = (px, shown) => {
      if (player) {
        hud.drawHPBar(this.base, this.font, 10, 9, px, hud.HP_BAR_PLAYER);
        hud.drawHPFraction(this.base, this.font, 11, 10, shown, S.maxHP);
      } else {
        hud.drawHPBar(this.base, this.font, 2, 2, px, hud.HP_BAR_ENEMY);
      }
    };
    yield* this.animateHPBar(oldHP, newHP, S.maxHP, draw, player);
  }

  /** The UpdateHPBar loop shared by the battle HUDs and the party menu. */
  *animateHPBar(oldHP, newHP, maxHP, draw, numbers) {
    const delta = newHP > oldHP ? 1 : -1;
    let hp = oldHP;
    let guard = 0;
    while (hp !== newHP && guard++ < 0x10000) {
      const prev = hp;
      hp += delta;
      const oldPx = hpBarPxForAnim(prev, maxHP);
      const newPx = hpBarPxForAnim(hp, maxHP);
      const diff = delta < 0 ? oldPx - newPx : newPx - oldPx;
      if (numbers) {
        draw(oldPx, prev);
        yield 1;
      }
      let e = oldPx;
      for (let k = 0; k < diff; k++) {
        draw(e, numbers ? prev : hp);
        yield 2;
        const next = e + delta;
        if (next < 0 || next >= 0x31) break;
        e = next;
      }
    }
    const finalPx = newHP ? hud.hpBarLength(newHP, maxHP) : 0;
    draw(finalPx, newHP);
    if (numbers) yield 1;
    yield 2;
    yield 3;
  }

  setLowHealthAlarm(on) {
    this.lowHealthAlarm = !!on;
    if (this.audio && this.audio.setLowHealthAlarm) this.audio.setLowHealthAlarm(!!on);
  }

  // ===================================================================== pics

  speciesPic(species, kind) {
    if (!species) return null;
    const sp = this.gd.findSpecies(species);
    if (!sp) return null;
    return this.images.get(kind === 'front' ? sp.sprites.front : sp.sprites.back2x);
  }

  enemyPicImage(spec = this.enemyPicSpec) {
    if (!spec) return null;
    if (spec.kind === 'trainer') return this.images.get(this.gd.trainerClass(spec.trainerClass).pic);
    if (spec.kind === 'ghost') return this.images.get(GHOST_PIC);
    return this.speciesPic(spec.species, 'front');
  }

  setEnemyPic(spec) {
    this.enemyPicSpec = spec;
    this.view.setPic('enemy', this.enemyPicImage(spec), 'front');
  }

  setPlayerTrainerPic(kind) {
    this.playerTrainer = kind;
    this.view.setPic('player', this.images.get(kind === 'oldman' ? OLD_MAN_BACK : RED_BACK), 'back');
  }

  setPlayerMonPic(species) {
    this.playerTrainer = null;
    this.view.setPic('player', this.speciesPic(species, 'back'), 'back');
  }

  /** ctx.mons for the animation player: own pics and the opponent's for Transform. */
  mons() {
    const b = this.battle;
    const P = b.side[PLAYER];
    const En = b.side[ENEMY];
    const playerBack = this.playerTrainer ? this.images.get(this.playerTrainer === 'oldman' ? OLD_MAN_BACK : RED_BACK) : this.speciesPic(P.species, 'back');
    return {
      player: { front: this.speciesPic(P.species, 'front'), back: playerBack },
      enemy: { front: this.enemyPicImage() || this.speciesPic(En.species, 'front'), back: this.speciesPic(En.species, 'back') },
    };
  }

  // ===================================================================== animations

  animCtx(opts = {}) {
    const b = this.battle;
    return {
      view: this.view,
      attacker: sideName(opts.attacker),
      palette: this.palette,
      sfx: (name, o) => this.animSfx(name, o),
      mons: this.mons(),
      animationType: opts.animationType || 0,
      damageMultiplier: opts.damageMultiplier ?? 10,
      ball: opts.ball,
      battleType: opts.battleType || (b && b.isInBattle === TRAINER_BATTLE ? 'trainer' : 'wild'),
      animations: this.state.options.battleAnimations !== false,
      preDelay: opts.preDelay || 0,
      substituteUp: opts.substituteUp,
      minimized: opts.minimized,
    };
  }

  animSfx(name, o = {}) {
    if (name === 'CRY') {
      const S = this.battle.side[o.side === 'enemy' ? ENEMY : PLAYER];
      this.cry(S.species);
      return;
    }
    this.playSfx(name, { frequencyModifier: o.pitch, tempoModifier: o.tempo });
  }

  *anim(id, opts = {}) {
    this.mode = 'battle';
    yield* playAnimation(id, this.animCtx(opts));
  }

  *sequence(name, opts = {}) {
    this.mode = 'battle';
    if (name === 'SUBSTITUTE_DOLL' || name === 'TRANSFORM_PIC') {
      const run = new AnimRun(this.view, this.animCtx(opts));
      const fn = name === 'SUBSTITUTE_DOLL' ? SPECIAL_EFFECT_ROUTINES.AnimationSubstitute : SPECIAL_EFFECT_ROUTINES.AnimationTransformMon;
      yield* fn(run);
      return;
    }
    yield* playAnimation(name, this.animCtx(opts));
  }

  /** PredefShakeScreenHorizontally (Jump Kick crash). */
  *shakeScreenHorizontally(n) {
    const run = new AnimRun(this.view, this.animCtx({ attacker: PLAYER }));
    yield* shakeScreenHorizontally(run, n);
  }

  *delay(n) {
    if (n > 0) yield n;
  }

  // ===================================================================== transition

  *battleTransition(id) {
    this.mode = 'transition';
    this.scene.opaque = false;
    this.transition = { grid: new TransitionGrid(), snapshot: null };
    const setPalette = (bgp, obp) => {
      if (obp === undefined) this.palette.bgpByte = bgp;
      else this.palette.setMaps(byteToMap(bgp), byteToMap(obp), byteToMap(obp));
    };
    try {
      yield* battleTransition(id, this.transition.grid, { setPalette, spiralDirection: this.battle ? this.battle.spiralDirection ?? 1 : 1 });
    } finally {
      this.mode = 'battle';
      this.scene.opaque = true;
      this.transition = null;
    }
  }

  // ===================================================================== sound

  playSfx(name, opts = {}) {
    if (this.audio && this.audio.playSfx) {
      try {
        const p = this.audio.playSfx(name, opts);
        if (p && typeof p.then === 'function') return p;
      } catch (err) {
        console.warn('[battle] sfx', name, err);
      }
      return null;
    }
    if (name === 'SFX_PRESS_AB' && this.game.sfx && this.game.sfx.play) this.game.sfx.play('press');
    return null;
  }

  sfx(name, opts) { this.playSfx(name, opts); }

  /** Wait (max 600 frames) for a promise to settle. */
  *waitPromise(p) {
    if (!p || typeof p.then !== 'function') return;
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < MAX_SOUND_WAIT && !done; i++) yield 1;
  }

  /** Play a sound effect and wait until it has finished (the text `sound` commands). */
  *sfxPlayAndWait(name, opts) {
    yield* this.waitPromise(this.playSfx(name, opts));
  }

  /** WaitForSoundToFinish, then the sound, waiting for it too. */
  *sfxWait(name, opts) {
    yield* this.waitSound();
    yield* this.waitPromise(this.playSfx(name, opts));
  }

  *waitSound() {
    if (this.audio && this.audio.waitForSfx && this.audio.isReady) yield* this.waitPromise(this.audio.waitForSfx());
  }

  cry(species) {
    if (!species || !this.audio || !this.audio.playCry) return null;
    try { return this.audio.playCry(this.gd.species(species).dex); } catch { return null; }
  }

  *cryWait(species) {
    yield* this.waitPromise(this.cry(species));
  }

  music(name) {
    if (this.audio && this.audio.playMusic) this.audio.playMusic(name);
  }

  stopMusic() {
    if (this.audio && this.audio.stopMusic) this.audio.stopMusic();
  }

  // ===================================================================== input helpers

  pressed(btn) { return !!this.input.pressed[btn]; }

  dir(btn, repeat) {
    if (repeat && typeof this.input.repeat === 'function') return this.input.repeat(btn);
    return !!this.input.pressed[btn];
  }

  // ===================================================================== battle menu

  /**
   * DisplayBattleMenu's input part: FIGHT / PKMN / ITEM / RUN (or BALL / BAIT / THROW ROCK /
   * RUN) in two columns. @returns {Generator<any, number>} position 0..3 (0 top-left, 1
   * bottom-left, 2 top-right, 3 bottom-right)
   */
  *battleMenu({ safari, cursor = 0, balls = 0 }) {
    this.mode = 'battle';
    const map = this.base;
    let cols;
    if (safari) {
      this.font.drawBox(map, 0, 12, 20, 6);
      hud.putStr(map, this.font, 2, 14, 'BALL×       BAIT');
      hud.putStr(map, this.font, 2, 16, 'THROW ROCK  RUN');
      cols = [1, 13];
    } else {
      this.font.drawBox(map, 8, 12, 12, 6);
      hud.putStr(map, this.font, 10, 14, 'FIGHT <PK><MN>');
      hud.putStr(map, this.font, 10, 16, 'ITEM  RUN');
      cols = [9, 15];
    }
    let col = cursor >= 2 ? 1 : 0;
    let row = cursor & 1;
    const space = this.font.space;
    for (;;) {
      // .leftColumn / .rightColumn: clear the other column's cursors (+ the ball count)
      for (const c of cols) { map.set(c, 14, space); map.set(c, 16, space); }
      if (safari) hud.printNumber(map, this.font, 7, 14, balls, 2);
      map.set(cols[col], 14 + 2 * row, this.font.cursor.right);
      yield 3; // PlaceMenuCursor + Delay3
      for (;;) {
        yield 1;
        const p = this.input.pressed;
        if (p.up && row > 0) { row = 0; break; }
        if (p.down && row < 1) { row = 1; break; }
        if (col === 0 && p.right) { col = 1; break; }
        if (col === 1 && p.left) { col = 0; break; }
        if (p.a) {
          this.blip.play();
          map.set(cols[col], 14 + 2 * row, this.font.cursor.rightHollow);
          return col * 2 + row;
        }
      }
    }
  }

  /** The old man's simulated input: ▶ FIGHT 80 frames, ▶ ITEM 50 frames, ▷ ITEM. */
  *oldManBattleMenu() {
    this.mode = 'battle';
    const map = this.base;
    this.font.drawBox(map, 8, 12, 12, 6);
    hud.putStr(map, this.font, 10, 14, 'FIGHT <PK><MN>');
    hud.putStr(map, this.font, 10, 16, 'ITEM  RUN');
    map.set(9, 14, this.font.cursor.right);
    yield 80;
    map.set(9, 14, this.font.space);
    map.set(9, 16, this.font.cursor.right);
    yield 50;
    map.set(9, 16, this.font.cursor.rightHollow);
  }

  // ===================================================================== move menus

  moveName(id) {
    return id ? this.gd.move(id).name : '-';
  }

  /** The move list text (FormatMovesString): names or "-", one per row. */
  writeMoves(map, x, y, moves) {
    for (let i = 0; i < 4; i++) hud.putStr(map, this.font, x, y + i, this.moveName(moves[i]));
  }

  /**
   * MoveSelectionMenu. Regular (in-battle) menu: box (4,12), moves at (6,13), the TYPE/PP box
   * of the hovered move (PrintMenuItem, which also loads the move - battle.moveMenuHover).
   * type 'relearn' (Ether & co): box (4,7), moves at (6,8), no info box.
   * @returns {Generator<any, {action:'select'|'cancel'|'swap', index:number}>}
   */
  *moveMenu({ moves, cursor = 0, swap = -1, battle, type, mon }) {
    this.mode = 'battle';
    const relearn = type === 'relearn';
    const ids = relearn ? moves : moves.slice(0, 4);
    const n = Math.max(1, ids.filter(Boolean).length);
    let cur = Math.min(cursor & 3, n - 1);
    const x0 = relearn ? 4 : 4;
    const y0 = relearn ? 7 : 12;
    const map = relearn ? this.top : this.base;
    this.font.drawBox(map, x0, y0, 16, 6);
    if (!relearn) {
      map.set(4, 12, this.font.frame.top);
      map.set(10, 12, this.font.frame.bottomRight);
    }
    this.writeMoves(map, 6, y0 + 1, ids);
    const cursorX = 5;
    for (;;) {
      if (!relearn && battle) {
        const info = battle.moveMenuHover(cur);
        this.top.clearRect(0, 8, 11, 5);
        hud.drawMoveInfoBox(this.top, this.font, (x, y, w, h) => this.font.drawBox(this.top, x, y, w, h), {
          disabled: info.disabled, typeName: info.type, pp: info.pp, maxPP: info.maxPP,
        });
      }
      for (let i = 0; i < 4; i++) map.set(cursorX, y0 + 1 + i, this.font.space);
      if (swap >= 0 && !relearn) map.set(cursorX, y0 + 1 + swap, this.font.cursor.rightHollow);
      map.set(cursorX, y0 + 1 + cur, this.font.cursor.right);
      yield 3;
      for (;;) {
        yield 1;
        const p = this.input.pressed;
        if (p.up) { cur = cur > 0 ? cur - 1 : n - 1; break; }
        if (p.down) { cur = cur < n - 1 ? cur + 1 : 0; break; }
        if (p.a) { this.blip.play(); return { action: 'select', index: cur }; }
        if (p.b) { this.blip.play(); return { action: 'cancel', index: cur }; }
        if (p.select && !relearn) return { action: 'swap', index: cur };
      }
    }
  }

  /** MimicEffect's menu (wMoveMenuType 1): the foe's moves at (2,8), "WHICH TECHNIQUE?", A only. */
  *mimicMenu(moves) {
    this.mode = 'battle';
    const n = Math.max(1, moves.filter(Boolean).length);
    this.font.drawBox(this.top, 0, 7, 16, 6);
    this.writeMoves(this.top, 2, 8, moves);
    hud.putStr(this.base, this.font, 1, 14, 'WHICH TECHNIQUE?');
    let cur = 0;
    for (;;) {
      for (let i = 0; i < 4; i++) this.top.set(1, 8 + i, this.font.space);
      this.top.set(1, 8 + cur, this.font.cursor.right);
      yield 3;
      for (;;) {
        yield 1;
        const p = this.input.pressed;
        if (p.up) { cur = cur > 0 ? cur - 1 : n - 1; break; }
        if (p.down) { cur = cur < n - 1 ? cur + 1 : 0; break; }
        if (p.a) { this.blip.play(); return cur; }
      }
    }
  }

  /** TryingToLearn's "which move" menu: box (4,7), moves at (6,8), A/B. @returns index or -1 */
  *forgetMoveMenu(moveIds) {
    const n = Math.max(1, moveIds.filter(Boolean).length);
    const map = this.mode === 'evolution' ? this.top : this.top;
    this.font.drawBox(map, 4, 7, 16, 6);
    this.writeMoves(map, 6, 8, moveIds);
    let cur = 0;
    for (;;) {
      for (let i = 0; i < 4; i++) map.set(5, 8 + i, this.font.space);
      map.set(5, 8 + cur, this.font.cursor.right);
      yield 3;
      for (;;) {
        yield 1;
        const p = this.input.pressed;
        if (p.up && cur > 0) { cur--; break; }
        if (p.down && cur < n - 1) { cur++; break; }
        if (p.a) { this.blip.play(); return cur; }
        if (p.b) { this.blip.play(); return -1; }
      }
    }
  }

  // ===================================================================== YES / NO

  *yesNo({ x = 14, y = 7 } = {}) {
    if (this.mode === 'blank' || this.mode === 'transition') this.mode = 'battle';
    const map = this.layerFor(x, y, 6, 5);
    const menu = new YesNoMenu({ font: this.font, map, input: this.input, sfx: this.blip, x, y });
    return yield* menu.run();
  }

  // ===================================================================== level up

  /** PrintStatsBox (d = 1): box (9,2), ATTACK/DEFENSE/SPEED/SPECIAL, then wait for A/B. */
  *levelUpStats(mon) {
    const map = this.mode === 'evolution' ? this.top : this.top;
    this.font.drawBox(map, 9, 2, 11, 10);
    const labels = ['ATTACK', 'DEFENSE', 'SPEED', 'SPECIAL'];
    const values = [mon.stats.atk, mon.stats.def, mon.stats.spd, mon.stats.spc];
    for (let i = 0; i < 4; i++) {
      hud.putStr(map, this.font, 11, 3 + 2 * i, labels[i]);
      hud.printNumber(map, this.font, 15, 4 + 2 * i, values[i], 3);
    }
    yield* this.waitButton();
  }

  // ===================================================================== party menu

  partyHPColor(mon) {
    const px = mon.hp ? hud.hpBarLength(mon.hp, mon.stats ? mon.stats.hp : 1) : 0;
    return px >= 27 ? 0 : px >= 10 ? 1 : 2;
  }

  /** RedrawPartyMenu_: names, levels, status/FNT, HP bars with fractions, the icons. */
  drawPartyList() {
    const map = this.full;
    const font = this.font;
    const party = this.battle.party;
    map.clear();
    for (let i = 0; i < party.length; i++) {
      const m = party[i];
      const y = 2 * i;
      hud.putStr(map, font, 3, y, m.nickname);
      const st = m.hp > 0 ? hud.statusString(m.status) : 'FNT';
      if (st) hud.putStr(map, font, 17, y, st);
      const max = m.stats ? m.stats.hp : m.hp;
      hud.drawHPBar(map, font, 4, y + 1, m.hp ? hud.hpBarLength(m.hp, max) : 0, hud.HP_BAR_PARTY);
      hud.drawHPFraction(map, font, 13, y + 1, m.hp, max);
      hud.printLevel(map, font, 13, y, m.level);
    }
    this.party = this.party || { selected: 0, timer: 0, frame: 0 };
    this.party.icons = party.map((m) => {
      const sp = this.gd.species(m.species);
      return { img: this.images.get(iconUrl(sp.menuIcon)), bob: BOB_ICONS.has(sp.menuIcon), color: this.partyHPColor(m) };
    });
  }

  partyMessage(type) {
    return { normal: '_PartyMenuNormalText', item: '_PartyMenuItemUseText', battle: '_PartyMenuBattleText', swap: '_PartyMenuSwapMonText' }[type] || '_PartyMenuNormalText';
  }

  /**
   * DisplayPartyMenu (GBPalWhiteOutWithDelay3, draw, message) / GoBackToPartyMenu (goBack),
   * then HandlePartyMenuInput: wrapping cursor at (0, 2i+1), the selected icon animates.
   * @returns {Generator<any, number>} party index, -1 for B
   */
  *partyMenu({ type = 'normal', battle, cancelable = true, goBack = false } = {}) {
    const b = battle || this.battle;
    if (!goBack || this.mode !== 'party') {
      this.palette.whiteOut();
      yield 3;
      this.clearSprites();
    }
    this.mode = 'party';
    this.drawPartyList();
    this.fullBox.isOpen = false;
    yield* this.printText([{ cmd: 'text_far', label: this.partyMessage(type) }, { cmd: 'text_end' }], b.subs(), { instant: true });
    this.palette.setMaps(BGP_NORMAL, OBP0_NORMAL, this.palette.obp1);
    const n = b.party.length;
    let cur = Math.min(b.partyMenuCursor | 0, Math.max(0, n - 1));
    for (;;) {
      for (let i = 0; i < 6; i++) this.full.set(0, 2 * i + 1, i < n ? this.font.space : EMPTY);
      this.full.set(0, 2 * cur + 1, this.font.cursor.right);
      this.party.selected = cur;
      this.party.timer = 0;
      this.party.frame = 0;
      yield 3;
      for (;;) {
        yield 1;
        this.tickPartyIcon();
        const p = this.input.pressed;
        if (p.up) { cur = cur > 0 ? cur - 1 : n - 1; break; }
        if (p.down) { cur = cur < n - 1 ? cur + 1 : 0; break; }
        if (p.a || (p.b && cancelable)) {
          this.blip.play();
          this.full.set(0, 2 * cur + 1, this.font.cursor.rightHollow);
          b.partyMenuCursor = cur;
          this.party.frame = 0;
          return p.a ? cur : -1;
        }
      }
    }
  }

  tickPartyIcon() {
    const st = this.party;
    if (!st || !st.icons || !st.icons[st.selected]) return;
    const c = ICON_FRAME_TIME[st.icons[st.selected].color] || 6;
    st.timer = (st.timer + 1) % (2 * c);
    st.frame = st.timer >= c ? 1 : 0;
  }

  drawPartyIcons(fb) {
    const st = this.party;
    if (!st || !st.icons) return;
    st.icons.forEach((ic, i) => {
      if (!ic.img) return;
      const animate = i === st.selected && st.frame === 1;
      const srcY = animate && !ic.bob ? 16 : 0;
      const dy = animate && ic.bob ? 1 : 0;
      fb.blit(ic.img, 0, srcY, 16, 16, 8, 16 * i + dy, { obj: 0 });
    });
  }

  /** The SWITCH / STATS / CANCEL box over the party menu. @returns 0, 1, 2 or -1 (B) */
  *switchStatsCancel() {
    const map = this.full;
    this.font.drawBox(map, 11, 11, 9, 7);
    hud.putStr(map, this.font, 13, 12, 'SWITCH');
    hud.putStr(map, this.font, 13, 14, 'STATS');
    hud.putStr(map, this.font, 13, 16, 'CANCEL');
    let cur = 0;
    for (;;) {
      for (let i = 0; i < 3; i++) map.set(12, 12 + 2 * i, this.font.space);
      map.set(12, 12 + 2 * cur, this.font.cursor.right);
      yield 3;
      for (;;) {
        yield 1;
        this.tickPartyIcon();
        const p = this.input.pressed;
        if (p.up) { cur = cur > 0 ? cur - 1 : 2; break; }
        if (p.down) { cur = cur < 2 ? cur + 1 : 0; break; }
        if (p.a) {
          this.blip.play();
          map.set(12, 12 + 2 * cur, this.font.cursor.rightHollow);
          return cur;
        }
        if (p.b) {
          this.blip.play();
          map.fillRect(11, 11, 9, 7, this.font.space);
          return -1;
        }
      }
    }
  }

  /**
   * Medicine used from the battle bag: the HP bar of the mon fills in the party menu (or the
   * status sound plays), the menu is redrawn with the message, 50 frames, wait for A/B.
   */
  *partyMenuItemResult({ index, sfx, oldHP, newHP, text, subs }) {
    if (this.mode !== 'party') {
      this.mode = 'party';
      this.drawPartyList();
    }
    const mon = this.battle.party[index];
    const max = mon.stats ? mon.stats.hp : newHP;
    if (sfx === 'SFX_HEAL_HP' && oldHP !== undefined && newHP !== undefined) {
      yield* this.waitSound();
      this.playSfx(sfx);
      const y = 2 * index + 1;
      const draw = (px, shown) => {
        hud.drawHPBar(this.full, this.font, 4, y, px, hud.HP_BAR_PARTY);
        hud.printNumber(this.full, this.font, 13, y, shown, 3);
      };
      yield* this.animateHPBar(oldHP, newHP, max, draw, true);
    } else {
      yield* this.sfxWait(sfx || 'SFX_HEAL_AILMENT');
    }
    this.drawPartyList();
    this.fullBox.isOpen = false;
    yield* this.printText(text, subs, { instant: true });
    yield 50;
    yield* this.waitButton();
  }

  *closePartyMenu() {}

  // ===================================================================== status screen / dex / naming

  /** Hooks other modules provide (game.hooks overrides, else the menus / intro modules). */
  async menusModule() {
    return import('../menus/index.js');
  }

  *statusScreen(mon) {
    const hooks = this.game.hooks || {};
    let p;
    if (typeof hooks.statsScreen === 'function') p = hooks.statsScreen(mon);
    else p = this.menusModule().then((m) => m.statsScreen(this.game, mon)).catch((err) => console.warn('[battle] status screen unavailable:', err));
    yield p;
  }

  *pokedexEntry(species) {
    const hooks = this.game.hooks || {};
    let p;
    if (typeof hooks.pokedexEntry === 'function') p = hooks.pokedexEntry(species);
    else p = this.menusModule().then((m) => m.pokedexScene(this.game, { species: this.gd.species(species).dex })).catch((err) => console.warn('[battle] Pokédex entry unavailable:', err));
    yield p;
    this.clearScreen(); // ShowPokedexData ends with ClearScreen
  }

  *namingScreen(species) {
    const hooks = this.game.hooks || {};
    const dex = this.gd.species(species).dex;
    let p;
    if (typeof hooks.namingScreen === 'function') p = Promise.resolve(hooks.namingScreen({ kind: 'nickname', speciesForIcon: dex, audio: this.audio }));
    else p = import('../intro/naming.js').then((m) => m.namingScreen({ kind: 'nickname', speciesForIcon: dex, audio: this.audio }, this.game));
    let name = '';
    p.then((v) => { name = v; }, (err) => { console.warn('[battle] naming screen unavailable:', err); });
    yield p.catch(() => '');
    return typeof name === 'string' ? name : '';
  }

  // ===================================================================== bag

  /**
   * DisplayListMenuID (ITEMLISTMENU) in the box (4,2)-(19,12): 4 rows, the cursor on the first
   * three, scrolling, CANCEL, quantities (×nn) for non-key items, ▼ when more follow, SELECT
   * swaps two entries (Bag.swap). The old man's list picks POKé BALL by itself after 80 frames.
   * @returns {Generator<any, {index:number, cursor:number, scroll:number}>}
   */
  *bagMenu({ items, cursor = 0, scroll = 0, oldMan = false, bag = null }) {
    this.mode = 'battle';
    const map = this.top;
    const font = this.font;
    this.font.drawBox(map, 4, 2, 16, 11);
    yield 10;
    let cur = cursor;
    let off = scroll;
    let swapId = 0; // wMenuItemToSwap (1-based)
    const list = () => (bag ? bag.items : items);
    const count = () => list().length;
    const maxItem = () => (count() < 2 ? 1 : 2);
    if (off > Math.max(0, count() - 2)) off = Math.max(0, count() - 2);
    if (cur > maxItem()) cur = maxItem();
    const printEntries = () => {
      map.fillRect(5, 3, 14, 9, font.space);
      const l = list();
      let printedCancel = false;
      for (let k = 0; k < 4; k++) {
        const idx = off + k;
        const y = 4 + 2 * k;
        if (idx >= l.length) {
          hud.putStr(map, font, 6, y, 'CANCEL');
          printedCancel = true;
          break;
        }
        const it = this.gd.item(l[idx].item);
        hud.putStr(map, font, 6, y, it.name);
        if (!isKeyItem(it.const, this.gd)) {
          hud.putStr(map, font, 14, y + 1, '×');
          hud.printNumber(map, font, 15, y + 1, l[idx].qty, 2);
        }
        if (swapId && swapId - 1 === idx) map.set(5, y, font.cursor.rightHollow);
      }
      if (!printedCancel) map.set(18, 11, font.cursor.down);
    };
    for (;;) {
      printEntries();
      yield 3;
      if (oldMan) {
        map.set(5, 4, font.cursor.right);
        yield 80;
        map.set(5, 4, font.cursor.rightHollow);
        return { index: 0, cursor: 0, scroll: 0 };
      }
      // HandleMenuInput (cursor rows 0..maxItem, out-of-bounds scrolls)
      let action = null;
      for (;;) {
        for (let k = 0; k < 4; k++) if (map.get(5, 4 + 2 * k) === font.cursor.right) map.set(5, 4 + 2 * k, font.space);
        map.set(5, 4 + 2 * cur, font.cursor.right);
        yield 3;
        for (;;) {
          yield 1;
          const p = this.input.pressed;
          if (this.dir('up', true)) {
            if (cur > 0) { cur--; action = 'move'; } else action = 'scrollUp';
            break;
          }
          if (this.dir('down', true)) {
            if (cur < maxItem()) { cur++; action = 'move'; } else action = 'scrollDown';
            break;
          }
          if (p.a) { action = 'a'; break; }
          if (p.b) { action = 'b'; break; }
          if (p.select) { action = 'select'; break; }
        }
        if (action !== 'move') break;
      }
      if (action === 'a') {
        this.blip.play();
        map.set(5, 4 + 2 * cur, font.cursor.rightHollow);
        const idx = off + cur;
        if (!count() || idx > count() - 1) return { index: -1, cursor: cur, scroll: off };
        return { index: idx, cursor: cur, scroll: off };
      }
      if (action === 'b') {
        this.blip.play();
        return { index: -1, cursor: cur, scroll: off };
      }
      if (action === 'scrollDown') {
        if (off + 3 <= count()) off++;
        continue;
      }
      if (action === 'scrollUp') {
        if (off > 0) off--;
        continue;
      }
      if (action === 'select' && bag) {
        // HandleItemListSwapping
        const idx = off + cur;
        if (idx >= count()) continue;
        if (!swapId) {
          swapId = idx + 1;
          yield 20;
          continue;
        }
        if (swapId === idx + 1) continue;
        const first = swapId - 1;
        yield 20;
        const before = count();
        bag.swap(first, idx);
        swapId = 0;
        if (count() !== before) { off = 0; cur = 0; }
      }
    }
  }

  // ===================================================================== evolution

  /**
   * EvolveMon: the old pic (flipped) at (7,2), its cry, the evolution music, then 8 rounds of
   * "wait 16, 14, ... 2 frames (B cancels) + k x (new 3 frames, old 3 frames)", then the new
   * pic and its cry. @returns {Generator<any, boolean>} cancelled
   */
  *evolutionScene({ from, into, canCancel = true }) {
    const fromSp = this.gd.species(from);
    const toSp = this.gd.species(into);
    yield this.images.load([fromSp.sprites.front, toSp.sprites.front]);
    const oldImg = this.images.get(fromSp.sprites.front);
    const newImg = this.images.get(toSp.sprites.front);
    this.mode = 'evolution';
    this.top.clear();
    this.clearSprites();
    this.setLowHealthAlarm(false);
    this.stopMusic();
    this.playSfx('SFX_TINK');
    yield 3;
    this.evoPic = { img: oldImg };
    yield* this.cryWait(from);
    this.music('MUSIC_SAFARI_ZONE');
    yield 80;
    let cancelled = false;
    outer: for (let k = 1, c = 16; c > 0; k++, c -= 2) {
      for (let f = 0; f < c; f++) {
        yield 1;
        if (canCancel && this.input.pressed.b) { cancelled = true; break outer; }
      }
      for (let i = 0; i < k; i++) {
        this.evoPic = { img: newImg };
        yield 3;
        this.evoPic = { img: oldImg };
        yield 3;
      }
    }
    if (!cancelled) {
      this.evoPic = { img: newImg };
      yield 3;
    }
    this.stopMusic();
    yield* this.cryWait(cancelled ? from : into);
    return cancelled;
  }

  /** The pic of the evolution screen: LoadFlippedFrontSpriteByMonIndex at (7,2). */
  drawEvolutionPic(fb) {
    const img = this.evoPic && this.evoPic.img;
    if (!img) return;
    const wt = Math.min(7, img.width >> 3);
    const ht = Math.min(7, img.height >> 3);
    const colOff = (8 - wt) >> 1;
    const rowOff = 7 - ht;
    const x = (7 + (7 - colOff - wt)) * 8;
    const y = (2 + rowOff) * 8;
    fb.blit(img, 0, 0, wt * 8, ht * 8, x, y, { flipX: true });
  }

  // ===================================================================== end

  endOfBattle() {
    this.setLowHealthAlarm(false);
    this.clearSprites();
    this.palette.whiteOut(); // GBPalWhiteOut
  }

  // ===================================================================== draw

  draw(fb) {
    this.frame++;
    const gfx = this.font.gfx;
    // the scene below shows through only before the battle screen exists and during the transition
    this.scene.opaque = this.mode !== 'blank' && this.mode !== 'transition';
    switch (this.mode) {
      case 'transition': {
        const t = this.transition;
        if (!t) return;
        if (!t.snapshot) t.snapshot = fb.pixels.slice();
        t.grid.render(fb, t.snapshot);
        return;
      }
      case 'battle':
        this.view.render(fb, (screen) => this.base.draw(screen, gfx));
        this.top.draw(fb, gfx);
        return;
      case 'party':
        fb.clear(0);
        this.full.draw(fb, gfx);
        this.drawPartyIcons(fb);
        return;
      case 'evolution':
        fb.clear(0);
        this.base.draw(fb, gfx);
        this.drawEvolutionPic(fb);
        this.top.draw(fb, gfx);
        return;
      default:
        // 'blank': nothing yet (the screen below stays visible)
    }
  }
}

/** The bar length UpdateHPBar works with: GetHPBarLength (at least 1, even for 0 HP). */
function hpBarPxForAnim(hp, maxHP) {
  return hud.hpBarLength(hp, maxHP);
}
