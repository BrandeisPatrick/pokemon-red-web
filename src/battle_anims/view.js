// BattleAnimView: the persistent battle-screen state the animations work on, one per battle.
//
//   const view = new BattleAnimView(data);          // data = await loadBattleAnimData(assets)
//   view.setPic('enemy', frontImg);                  // LoadMonFrontSprite (pic tile data only)
//   view.setPic('player', back2xImg);                // LoadMonBackPic
//   view.showPic('enemy'); view.showPic('player');   // CopyUncompressedPicToTilemap
//   // every frame, in the battle scene's draw(fb):
//   view.render(fb, (screen) => drawHudAndTextBox(screen));
//
// It holds what the Game Boy keeps in VRAM/OAM/registers during a battle:
//   vram.enemy / vram.player  the two 7x7 pic tile slots ($00-$30 / $31-$61)
//   tilemap                   wTileMap cells for the pic areas (see pics.js)
//   oam, objTiles             shadow OAM and the sprite tile patterns (animation tileset at $31)
//   ppu                       WX/WY/SCX/SCY, per-line SCX, BG map 0 / window sources
//   regs                      rBGP / rOBP0 / rOBP1 as last written by an animation
// The host draws everything else (HUDs, text box, menus) into the screen buffer it is handed
// in render(); the view draws the pic cells over it, applies the PPU state (shakes, waves,
// window split) and draws the sprites. Pure: no DOM.

import { FrameBuffer } from '../engine/framebuffer.js';
import { byteToMap, mapToByte } from '../engine/palette.js';
import { Oam, PpuState, composeFrame, LAYER_SNAPSHOT } from './ppu.js';
import { PicTilemap, blankPicTiles, picTilesFromImage, picTile, BLANK } from './pics.js';
import { ENEMY_PIC, PLAYER_PIC, ANIM_TILE_BASE, SCREEN_W, SCREEN_H, PIC_TILE_COUNT } from './layout.js';

/** @typedef {'player'|'enemy'} Side */
/** @typedef {import('../engine/gfx.js').IndexedImage} IndexedImage */
/** @typedef {(screen: FrameBuffer, view: BattleAnimView) => void} DrawScreen */

export const SIDES = Object.freeze(['player', 'enemy']);

export class BattleAnimView {
  /**
   * @param {import('./data.js').BattleAnimData} data
   * @param {{ownRegions?: boolean}} [opts] ownRegions (default true): the two pic regions
   *   (layout PLAYER_PIC_REGION / ENEMY_PIC_REGION) start blank and are always drawn by the view
   */
  constructor(data, { ownRegions = true } = {}) {
    if (!data) throw new Error('BattleAnimView: missing data (loadBattleAnimData)');
    this.data = data;
    this.ownRegions = ownRegions;
    this.tilemap = new PicTilemap();
    this.tilemap.reset(ownRegions);
    /** @type {{enemy: Uint8Array, player: Uint8Array}} pic tile slots (VRAM) */
    this.vram = { enemy: blankPicTiles(), player: blankPicTiles() };
    /** @type {{enemy: {img: IndexedImage, kind: string}|null, player: {img: IndexedImage, kind: string}|null}} */
    this.pics = { enemy: null, player: null };
    this.oam = new Oam();
    /** @type {Array<Uint8Array|null>} OBJ tile patterns by OAM tile id */
    this.objTiles = new Array(256).fill(null);
    this.ppu = new PpuState();
    /** rBGP / rOBP0 / rOBP1 bytes */
    this.regs = { bgp: 0xe4, obp0: 0xe4, obp1: 0x6c };
    /** optional engine Palette kept in sync with regs (set by playAnimation from ctx.palette) */
    this.palette = null;
    /** SGB silhouette mode (battle intro): pic colours 1-3 drawn as 3 */
    this.silhouette = false;
    this.live = new FrameBuffer(SCREEN_W, SCREEN_H);
    /** @type {DrawScreen|null} */
    this.lastDrawScreen = null;
    /** frames rendered / stepped (debug) */
    this.frame = 0;
  }

  // ------------------------------------------------------------------ pics

  /**
   * Load a pic into a side's tile slot (no tile-map change), like LoadMonFrontSprite /
   * LoadMonBackPic. Front pics are centred/bottom-aligned, back pics are 56x56 (back2x).
   * @param {Side} side
   * @param {IndexedImage|null} img
   * @param {'front'|'back'} [kind] default: enemy 'front', player 'back'
   */
  setPic(side, img, kind) {
    checkSide(side);
    kind = kind || (side === 'enemy' ? 'front' : 'back');
    this.vram[side] = picTilesFromImage(img, kind);
    this.pics[side] = img ? { img, kind } : null;
  }

  /** Replace a slot's raw tile data (49 x 64 indices, VRAM column-major order). */
  setPicTiles(side, tiles) {
    checkSide(side);
    if (!(tiles instanceof Uint8Array) || tiles.length !== PIC_TILE_COUNT * 64) throw new Error('setPicTiles: need 49*64 indices');
    this.vram[side] = tiles;
  }

  /** Blank a slot's tile data. */
  clearPicTiles(side) { checkSide(side); this.vram[side] = blankPicTiles(); }

  /** Home box of a side's pic. */
  picBox(side) { checkSide(side); return side === 'enemy' ? ENEMY_PIC : PLAYER_PIC; }

  /** Put the side's pic tile ids in its box (CopyUncompressedPicToTilemap). */
  showPic(side) {
    const b = this.picBox(side);
    this.tilemap.copyPic(b.x, b.y, b.tileBase);
  }

  /** Clear the side's box (ClearMonPicFromTileMap). */
  hidePic(side) {
    const b = this.picBox(side);
    this.tilemap.clearArea(b.x, b.y, 7, 7);
  }

  /** True when every cell of the side's box shows its own pic at the home position. */
  isPicShown(side) {
    const b = this.picBox(side);
    for (let c = 0; c < 7; c++) for (let r = 0; r < 7; r++) if (this.tilemap.get(b.x + c, b.y + r) !== b.tileBase + c * 7 + r) return false;
    return true;
  }

  // ------------------------------------------------------------------ sprites

  /** LoadMoveAnimationTiles: animation tileset `set` (0, 1, 2) at OBJ tiles $31+. */
  loadAnimTiles(set) {
    const ts = this.data.tilesets[set];
    const sheet = this.data.gfx.anim[set];
    if (!ts) throw new Error(`loadAnimTiles: no tileset ${set}`);
    for (let i = 0; i < ts.tiles; i++) this.objTiles[ANIM_TILE_BASE + i] = sheet ? sheet.tile(i) : null;
  }

  /** Copy a pic slot's tiles to OBJ tiles 0..48 (CopyVideoData vBackPic/vFrontPic -> vSprites). */
  loadPicIntoObjTiles(side) {
    const slot = this.vram[side];
    for (let i = 0; i < PIC_TILE_COUNT; i++) this.objTiles[i] = picTile(slot, i).slice();
  }

  // ------------------------------------------------------------------ palette registers

  /** Current registers from an engine Palette (or the view's own). */
  readRegs(palette = this.palette) {
    if (palette) return { bgp: mapToByte(palette.bgp), obp0: mapToByte(palette.obp0), obp1: mapToByte(palette.obp1) };
    return { ...this.regs };
  }

  /** Write rBGP/rOBP0/rOBP1 (any subset) and push them to the engine palette. */
  setRegs({ bgp = this.regs.bgp, obp0 = this.regs.obp0, obp1 = this.regs.obp1 } = {}) {
    this.regs = { bgp: bgp & 0xff, obp0: obp0 & 0xff, obp1: obp1 & 0xff };
    if (this.palette) this.palette.setMaps(byteToMap(this.regs.bgp), byteToMap(this.regs.obp0), byteToMap(this.regs.obp1));
  }

  // ------------------------------------------------------------------ state

  /** Back to the normal battle configuration: no sprites, no scroll/shake, live window. */
  resetEffects() {
    this.oam.clear();
    this.ppu.reset();
    this.silhouette = false;
  }

  /** Clear everything (tile map, sprites, PPU); pics stay loaded. */
  reset() {
    this.tilemap.reset(this.ownRegions);
    this.resetEffects();
  }

  // ------------------------------------------------------------------ drawing

  /**
   * Compose the live screen (host drawing + pic cells) into this.live and return its pixels.
   * @param {DrawScreen|null} [drawScreen]
   */
  composeLive(drawScreen = this.lastDrawScreen) {
    const fb = this.live;
    fb.clear(0);
    if (drawScreen) drawScreen(fb, this);
    this.tilemap.draw(fb, this.silhouette ? silhouetteVram(this.vram) : this.vram, this.data.gfx.battleTiles);
    return fb.pixels;
  }

  /**
   * A copy of the live screen right now (BG map / window snapshots), or null when no host
   * drawing function is known yet: render() then fills the pending snapshot from the next frame.
   */
  snapshotLive(drawScreen) {
    const draw = drawScreen || this.lastDrawScreen;
    if (!draw) return null;
    return this.composeLive(draw).slice();
  }

  /**
   * Draw the current frame into `fb` (a FrameBuffer): the host's screen via `drawScreen`, the pic
   * cells, the PPU effects and the sprites. Call it from the battle scene's draw().
   * @param {{pixels: Uint8Array}} fb
   * @param {DrawScreen} [drawScreen] remembered for later calls / snapshots
   */
  render(fb, drawScreen) {
    if (drawScreen) this.lastDrawScreen = drawScreen;
    const live = this.composeLive(this.lastDrawScreen);
    if (this.ppu.bg === LAYER_SNAPSHOT && !this.ppu.bgPixels) this.ppu.bgPixels = live.slice();
    if (this.ppu.win === LAYER_SNAPSHOT && !this.ppu.winPixels) this.ppu.winPixels = live.slice();
    const tiles = this.silhouette ? silhouetteTiles(this.objTiles) : this.objTiles;
    composeFrame(fb.pixels, live, this.ppu, this.oam, tiles);
  }
}

function checkSide(side) {
  if (side !== 'player' && side !== 'enemy') throw new Error(`BattleAnimView: side must be 'player' or 'enemy', got ${side}`);
}

function blacken(arr) {
  const out = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] ? 3 : 0;
  return out;
}

function silhouetteVram(vram) {
  return { enemy: blacken(vram.enemy), player: blacken(vram.player) };
}

function silhouetteTiles(tiles) {
  return tiles.map((t) => (t ? blacken(t) : t));
}

export { BLANK };
