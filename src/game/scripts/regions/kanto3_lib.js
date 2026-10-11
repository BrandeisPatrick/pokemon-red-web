// Private helpers of the kanto3 region scripts (src/game/scripts/regions/kanto3.js): the
// small text / sound / movement helpers every region needs (copies of the kanto1 ones, so
// the regions stay independent), the Vermilion Gym trash can tables, the S.S. Anne's slide
// at the Vermilion Dock, and the fix-up for trainer texts the data extractor left as `asm`.

import * as lib from '../lib.js';

/** Pokédex numbers of the Pokémon whose cries the scripts play (PlayCry takes the species). */
export const DEX = Object.freeze({
  PIDGEY: 16, PIKACHU: 25, WIGGLYTUFF: 40, MACHOP: 66, MACHOKE: 67, SEEL: 86,
  SNORLAX: 143, ARTICUNO: 144, ZAPDOS: 145,
});

/** MUSIC_PKMN_HEALED plays to its end (the captain's back rub waits for wChannelSoundIDs). */
export const PKMN_HEALED_FRAMES = 140;

// =========================================================================== text, sound

/** SetSpriteFacingDirectionAndDelay (home/map_objects.asm): turn an NPC, then 6 frames. */
export function* faceAndDelay(ctx, objectIndex, dir) {
  ctx.faceNpc(objectIndex, dir);
  yield ctx.wait(6);
}

/** PrintText inside a text_asm: print into a fresh box, no wait, keep it open. */
export function print(ctx, label, opts = {}) {
  return ctx.showText(label, { ...opts, wait: false, close: false });
}

/**
 * The end of DisplayTextID after a text_asm printed its last text without a button wait:
 * wait for A/B on what the box shows and close it.
 */
export function* waitAndClose(ctx) {
  yield ctx.showText([{ cmd: 'text_end' }], { open: false, wait: true, close: true });
}

/** Is the player at one of the coordinates (ArePlayerCoordsInArray)? @returns {number} 1-based index or 0 */
export function coordIndex(ctx, coords) {
  const p = ctx.player;
  const i = coords.findIndex(([x, y]) => p.x === x && p.y === y);
  return i + 1;
}

/** Stop the music, then start a song (SFX_STOP_ALL_MUSIC + PlayMusic). */
export function stopAndPlay(ctx, music) {
  const audio = ctx.hooks && ctx.hooks.audio;
  if (audio && typeof audio.stopMusic === 'function') audio.stopMusic();
  ctx.playMusic(music);
}

/** PlayCry without waiting (the cry runs while the box waits for a button). */
export function playCry(ctx, dex) {
  const audio = ctx.hooks && ctx.hooks.audio;
  return audio && typeof audio.playCry === 'function' ? audio.playCry(dex) : undefined;
}

/** PlayCry + WaitForSoundToFinish. */
export function* cry(ctx, dex) {
  const r = playCry(ctx, dex);
  if (r && typeof r.then === 'function') yield* lib.waitFor(r, 300);
}

/** WaitForSoundToFinish (the last sound effect). */
export function* waitForSound(ctx) {
  const audio = ctx.hooks && ctx.hooks.audio;
  const r = audio && typeof audio.waitForSfx === 'function' ? audio.waitForSfx() : null;
  if (r && typeof r.then === 'function') yield* lib.waitFor(r, 300);
}

/** A byte from the game's RNG (hRandomAdd / hRandomSub); tests may set ctx.rng. */
export function randByte(ctx) {
  const rng = ctx.rng || (ctx.hooks && ctx.hooks.rng) || (ctx.ov && ctx.ov.game && ctx.ov.game.rng);
  if (rng && typeof rng.randByte === 'function') return rng.randByte() & 0xff;
  return Math.floor(Math.random() * 256);
}

// =========================================================================== Vermilion Gym

/**
 * GymTrashCans (engine/events/hidden_events/vermilion_gym_trash.asm): byte 0 = the mask
 * ANDed with the random number, bytes 1-4 = the cans that can hold the second lock.
 */
export const GYM_TRASH_CANS = Object.freeze([
  [2, 1, 3, 0, 0], [3, 0, 2, 4, 0], [2, 1, 5, 0, 0], [3, 0, 4, 6, 0], [4, 1, 3, 5, 7],
  [3, 2, 4, 8, 0], [3, 3, 7, 9, 0], [4, 4, 6, 8, 10], [3, 5, 7, 11, 0], [3, 6, 10, 12, 0],
  [4, 7, 9, 11, 13], [3, 8, 10, 14, 0], [2, 9, 13, 0, 0], [3, 10, 12, 14, 0], [2, 11, 13, 0, 0],
].map((row) => Object.freeze(row)));

/**
 * The can of the second lock after the first one was found under `can`, with the original's
 * arithmetic and its bug: the offset is `((mask & swap(random)) - 1)` and a zero result wraps
 * to $ff, which reads a zero byte of the ROM bank's padding, so the second lock can then be
 * can 0 whatever the first can was. The mask is the count of valid cans (2, 3 or 4), so the
 * offset only ever reaches the last entry or the padding for a mask of 2 or 4.
 * @param {number} can 0-14, the can that held the first lock
 * @param {number} rand a random byte
 * @returns {number} 0-14
 */
export function secondLockTrashCan(can, rand) {
  const row = GYM_TRASH_CANS[can];
  const swapped = ((rand << 4) | (rand >> 4)) & 0xff;
  const offset = ((row[0] & swapped) - 1) & 0xff;
  const byte = 1 + offset < row.length ? row[1 + offset] : 0;
  return byte & 0x0f;
}

// =========================================================================== Vermilion Dock

/**
 * The S.S. Anne sails away (VermilionDockSSAnneLeavesScript): on the real screen the six tile
 * rows below the player (screen rows 10-15) scroll sideways one pixel every 8 frames while the
 * rest stays still. The overworld cannot scroll a band, so the band's tiles are shifted by
 * whole tiles, `framesPerStep` apart (16 steps of 64 frames = the original 8 x 128 frames).
 * What comes in from the east is the screen's own east edge again (the original redraws the
 * columns at the east edge of the unchanged view: water), not the map beyond it. Without an
 * overworld (tests) it only waits.
 * @param {any} ctx
 * @param {{row0?: number, rows?: number, steps?: number, framesPerStep?: number}} [o] first
 *   map tile row of the band, its height, the number of 1-tile steps and the delay per step
 */
export function* slideBand(ctx, { row0 = 6, rows = 6, steps = 16, framesPerStep = 64 } = {}) {
  const ov = ctx.ov;
  const grid = ov && ov.map && ov.map.grid;
  if (!grid || !grid.tiles || !grid.TW) {
    yield ctx.wait(steps * framesPerStep);
    return;
  }
  const { tiles, TW } = grid;
  const pad = ((grid.PW - grid.W) / 2) * 4; // MAP_BORDER blocks of padding, in tiles
  const cam = typeof ov.camera === 'function' ? ov.camera() : { x: 0 };
  const east = Math.floor(cam.x / 8) + 19; // the last map tile column on screen
  const original = [];
  for (let r = 0; r < rows; r++) {
    const start = (row0 + r + pad) * TW;
    original.push(tiles.slice(start, start + TW));
  }
  for (let k = 1; k <= steps; k++) {
    yield ctx.wait(framesPerStep);
    for (let r = 0; r < rows; r++) {
      const start = (row0 + r + pad) * TW;
      // padded column of the map tile column c, and the tile that slides into it
      for (let c = pad; c <= pad + east; c++) {
        let src = c + k;
        if (src > pad + east) src = pad + east - 1 + ((src - pad - east - 1) & 1);
        tiles[start + c] = original[r][src];
      }
    }
    grid.version++;
  }
}

// =========================================================================== Rock Tunnel

/**
 * wMapPalOffset (6 = a dark cave that FLASH has not lit yet) is part of the saved wMainData, but
 * the overworld keeps it in ov.mapPalOffset only (set when the cave is entered from outside,
 * cleared by FLASH together with state.mapPalOffset) and never writes state.mapPalOffset: mirror
 * the entered cave's darkness into the state, and bring the darkness back at Continue (the
 * overworld starts lit, the state says 6). Called from onEnter of the two Rock Tunnel maps.
 */
export function syncDarkCave(ctx) {
  const ov = ctx.ov;
  if (!ov || typeof ov.mapPalOffset !== 'number') return;
  const st = ctx.state;
  if (ov.mapPalOffset !== 0) {
    st.mapPalOffset = ov.mapPalOffset;
  } else if ((st.mapPalOffset | 0) !== 0) {
    ov.mapPalOffset = st.mapPalOffset | 0;
    if (typeof ov.loadGBPal === 'function') ov.loadGBPal();
  }
}

/** Leaving the cave outside (LAST_MAP) lights the palette again: wMapPalOffset = 0. */
export function leaveDarkCave(ctx, warp) {
  if (warp && warp.destMap === 'LAST_MAP' && ctx.state) ctx.state.mapPalOffset = 0;
}

// =========================================================================== data fix-up

/**
 * data/text marks a text entry as a trainer only for the direct `ld hl, <Header> /
 * call TalkToTrainer` shape. Route 9, Route 15, Rock Tunnel 1F and the Power Plant reach
 * TalkToTrainer through a shared `jr <Map>TalkToTrainer` / PowerPlantInitBattleScript, so
 * their entries are plain `asm` ones and pressing A on a trainer (or on a Voltorb /
 * Electrode / Zapdos of the Power Plant, which never "see" the player) would print nothing.
 * The map's trainerHeaders know which object belongs to which header: mark those entries as
 * the trainer talks they are (the engine then runs TalkToTrainer / EndTrainerBattle).
 * @returns {number} how many entries were fixed
 */
export function markTrainerTexts(ctx) {
  const table = ctx.ov && ctx.ov.map && ctx.ov.map.textTable;
  const json = ctx.mapData;
  if (!table || !table.entries || !json) return 0;
  let fixed = 0;
  for (const h of json.trainerHeaders || []) {
    const obj = (json.objectEvents || []).find((o) => o.index === h.objectIndex);
    const entry = obj && table.entries.find((e) => e.id === obj.textIndex);
    if (entry && entry.handler !== 'trainer') {
      entry.handler = 'trainer';
      entry.trainerHeader = h.header;
      fixed++;
    }
  }
  return fixed;
}
