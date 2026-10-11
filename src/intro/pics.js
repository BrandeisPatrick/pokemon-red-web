// Loading 7x7 "pics" (Pokémon front sprites, trainer pics, Red, the shrink frames) the way
// IntroDisplayPicCenteredOrUpperRight / LoadFrontSpriteByMonIndex do: decompress
// (CPU time), CopyVideoData 49 tiles to vFrontPic (8 tiles per frame, so a pic that is
// already on screen is replaced in vertical strips over 7 frames), then write the tile ids
// into wTileMap (CopyUncompressedPicToHL).

import { copyVideoData } from './gb.js';
import { VCHARS2, picTiles, copyPicToTilemap } from './ppu.js';

/**
 * Frames UncompressSpriteData + InterlaceMergeSpriteBuffers spend before the first VRAM
 * chunk. An estimate (the real cost depends on the pic's compressed size); everything
 * else in the pic path is frame-exact.
 */
export const PIC_DECOMPRESS_FRAMES = 2;

/** Frames a whole pic load takes: decompression + CopyVideoData(49). */
export const PIC_LOAD_FRAMES = PIC_DECOMPRESS_FRAMES + 7;

/**
 * Load a pic into vFrontPic (tiles $00-$30) with the GB's timing.
 * @param {import('./gb.js').IntroContext} ctx
 * @param {import('../engine/gfx.js').IndexedImage} img
 * @param {{flip?: boolean}} [opts]
 */
export function* loadPic(ctx, img, { flip = false } = {}) {
  const gb = ctx.gb;
  if (PIC_DECOMPRESS_FRAMES > 0) yield PIC_DECOMPRESS_FRAMES;
  const tiles = picTiles(img, { flip });
  yield* copyVideoData(gb, 49, (f, n) => gb.vram.loadList(VCHARS2 + f, tiles.slice(f, f + n)));
}

/**
 * IntroDisplayPicCenteredOrUpperRight (centred = hlcoord 6,4; upper right = 15,1) or
 * LoadFrontSpriteByMonIndex at (x, y).
 */
export function* displayPic(ctx, img, { flip = false, x = 6, y = 4 } = {}) {
  yield* loadPic(ctx, img, { flip });
  copyPicToTilemap(ctx.gb.tilemap, x, y, { flip });
}
