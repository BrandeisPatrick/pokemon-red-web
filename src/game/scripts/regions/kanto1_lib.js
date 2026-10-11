// Private helpers of the kanto1 region scripts (src/game/scripts/regions/kanto1.js).

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

/** Stop the music, then start a song (SFX_STOP_ALL_MUSIC + PlayMusic). */
export function stopAndPlay(ctx, music) {
  const audio = ctx.hooks && ctx.hooks.audio;
  if (audio && typeof audio.stopMusic === 'function') audio.stopMusic();
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
