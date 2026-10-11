// Private helpers of the kanto2 region scripts (src/game/scripts/regions/kanto2.js).

import * as lib from '../lib.js';
import { Scene } from '../../../engine/scene.js';
import { TileMap } from '../../../engine/tilemap.js';
import { getGameData } from '../../../pokemon/data.js';

/** SetSpriteFacingDirectionAndDelay (home/map_objects.asm): turn an NPC, then 6 frames. */
export function* faceAndDelay(ctx, objectIndex, dir) {
  ctx.faceNpc(objectIndex, dir);
  yield ctx.wait(6);
}

/**
 * The end of DisplayTextID after a text_asm printed its last text without a button wait:
 * wait for A/B (no new text, the box keeps what it shows) and close the box.
 */
export function* waitAndClose(ctx) {
  yield ctx.showText([{ cmd: 'text_end' }], { open: false, wait: true, close: true });
}

/** PrintText inside a text_asm: print into a fresh box, no wait, keep it open. */
export function print(ctx, label, opts = {}) {
  return ctx.showText(label, { ...opts, wait: false, close: false });
}

/** Is the player at one of the coordinates (ArePlayerCoordsInArray)? @returns {number} 1-based index or 0 */
export function coordIndex(ctx, coords) {
  const p = ctx.player;
  const i = coords.findIndex(([x, y]) => p.x === x && p.y === y);
  return i + 1;
}

/** SFX_STOP_ALL_MUSIC. */
export function stopMusic(ctx) {
  const audio = ctx.hooks && ctx.hooks.audio;
  if (audio && typeof audio.stopMusic === 'function') audio.stopMusic();
}

/** Stop the music, then start a song (SFX_STOP_ALL_MUSIC + PlayMusic). */
export function stopAndPlay(ctx, music) {
  stopMusic(ctx);
  ctx.playMusic(music);
}

/** Play a Pokémon cry and wait for it (PlayCry + WaitForSoundToFinish). */
export function* cry(ctx, dex) {
  const audio = ctx.hooks && ctx.hooks.audio;
  const r = audio && typeof audio.playCry === 'function' ? audio.playCry(dex) : null;
  if (r && typeof r.then === 'function') {
    let done = false;
    r.then(() => { done = true; }, () => { done = true; });
    let n = 0;
    yield () => done || ++n > 300;
  }
}

/**
 * GiveItem: add to the bag (the hook may answer with a promise). @returns {boolean} false when
 * there is no room.
 */
export function* give(ctx, item, qty = 1) {
  let ok = ctx.giveItem(item, qty);
  if (ok && typeof ok.then === 'function') ok = yield ok;
  return !!ok;
}

/**
 * A DisplayListMenuID list (hooks.listMenu: four entries, scrolling, CANCEL at the end). Falls
 * back to a plain menu without the menus layer. @returns {number} the index, -1 on CANCEL / B
 */
export function* listMenu(ctx, entries, initial = 0) {
  const hooks = ctx.hooks || {};
  if (typeof hooks.listMenu === 'function') {
    let r = hooks.listMenu({ entries: [...entries], initial });
    if (r && typeof r.then === 'function') r = yield r;
    else if (r && typeof r.next === 'function') r = yield* r;
    return Number.isInteger(r) ? r : -1;
  }
  const i = yield ctx.menu([...entries, 'CANCEL'], { x: 4, y: 2, width: 16, top: 2, spacing: 2 });
  return i >= 0 && i < entries.length ? i : -1;
}

/** hRandomAdd: a random byte (the game's rng; tests can give the ctx its own `rng`). */
export function randByte(ctx) {
  const rng = ctx.rng || (ctx.ov && ctx.ov.rng) || null;
  if (rng && typeof rng.randByte === 'function') return rng.randByte();
  return Math.floor(Math.random() * 256);
}

/**
 * The engine's wild-battle switch (BIT_NO_BATTLES in wStatusFlags4): the saved status bit, and
 * the overworld's own switch when there is one. `ctx.ov.noBattles` is also the test page's
 * debug toggle, so it is only turned off again when this function turned it on.
 */
const ownNoBattles = new WeakSet();
export function setNoBattles(ctx, on) {
  lib.setStatusFlag(ctx, 'BIT_NO_BATTLES', on);
  const ov = ctx.ov;
  if (!ov) return;
  if (on) {
    if (!ov.noBattles) { ov.noBattles = true; ownNoBattles.add(ov); }
  } else if (ownNoBattles.has(ov)) {
    ov.noBattles = false;
    ownNoBattles.delete(ov);
  }
}

// =========================================================================== the fossil pop-up

/** MON_SPRITE_POPUP (data/text_boxes.asm): the box from (6, 4) to (14, 13). */
const POPUP_BOX = Object.freeze({ x: 6, y: 4, w: 9, h: 10 });

/**
 * DisplayMonFrontSpriteInBox (engine/events/hidden_events/museum_fossils.asm): the box with the
 * Pokémon's front sprite, until A or B is pressed. Out of battle AnimateSendingOutMon just
 * copies the 7x7 tiles to (7, 5); a smaller sprite is centred in them and sits at the bottom
 * (LoadUncompressedSpriteData: (8 - width) / 2 tiles from the left, 7 - height from the top).
 */
class MonPopupScene extends Scene {
  /** @param {{pic: any, font: any}} o pic: the front sprite's IndexedImage */
  constructor({ pic, font }) {
    super();
    this.opaque = false;
    this.pic = pic;
    this.font = font;
    this.ui = new TileMap(20, 18);
    this.frames = 0;
    const tilesW = Math.round(pic.width / 8), tilesH = Math.round(pic.height / 8);
    this.x = (7 + ((8 - tilesW) >> 1)) * 8;
    this.y = (5 + (7 - tilesH)) * 8;
  }

  enter() {
    const b = POPUP_BOX;
    this.font.drawBox(this.ui, b.x, b.y, b.w, b.h);
  }

  update(frame, input) {
    // WaitForTextScrollButtonPress: a press after the box was drawn (Delay3)
    if (++this.frames > 3 && (input.pressed.a || input.pressed.b)) this.stack.pop(true);
  }

  draw(fb) {
    this.ui.draw(fb, this.font.gfx);
    fb.blit(this.pic, 0, 0, this.pic.width, this.pic.height, this.x, this.y);
  }
}

/**
 * Show a Pokémon's front sprite in the pop-up box and wait for A / B. Needs the engine's scene
 * stack and assets (ctx.ov.game); without them (tests, an overworld without a game) it does
 * nothing, so the caller still shows the text.
 * @returns {boolean} the pop-up was shown
 */
export function* monPopup(ctx, species) {
  const ov = ctx.ov;
  const game = ov && ov.game;
  if (!game || !game.scenes || !game.assets || !ov.font) return false;
  let pic;
  try {
    const sp = getGameData().species(species);
    pic = yield game.assets.image(sp.sprites.front);
  } catch (err) {
    console.warn('[kanto2] monPopup: no front sprite', err && err.message ? err.message : err);
    return false;
  }
  const scene = new MonPopupScene({ pic, font: ov.font });
  game.scenes.push(scene);
  yield scene.finished;
  return true;
}
