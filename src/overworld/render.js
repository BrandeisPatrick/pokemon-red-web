// Drawing the overworld into the index framebuffer (docs/data-format-maps.md §12):
// BG tiles from the padded tile grid through the map's (animated) tileset copy, then sprites
// in OAM priority order (lower OAM index on top: emotes, player, NPC 1 .. NPC 15, ledge
// shadow), sprites with OBJ palette 0 ({obj: 0}) drawn 4 px above their cell, the lower half
// of sprites standing in tall grass behind BG colours 1-3, and finally the UI tile layer.

import { MAP_BORDER } from './mapgrid.js';
import { spriteFrame } from './sprites.js';
import { PLAYER_SCREEN_X, PLAYER_SCREEN_Y, SHADOW_SCREEN_X, SHADOW_SCREEN_Y, SPRITE_Y_OFFSET } from './constants.js';

/**
 * Draw the BG: 21x19 tiles around the camera (map pixel cx, cy at the screen's top-left).
 * @param {import('../engine/framebuffer.js').FrameBuffer} fb
 * @param {import('./mapgrid.js').MapGrid} grid
 * @param {any} image IndexedImage of the tileset (animated copy)
 */
export function drawBackground(fb, grid, image, cx, cy) {
  const tx0 = Math.floor(cx / 8), ty0 = Math.floor(cy / 8);
  const ox = cx - tx0 * 8, oy = cy - ty0 * 8;
  const cols = ox ? 21 : 20, rows = oy ? 19 : 18;
  const off = MAP_BORDER * 4;
  const { tiles, TW, TH } = grid;
  for (let r = 0; r < rows; r++) {
    const ty = ty0 + r;
    const gy = ty + off;
    const sy = r * 8 - oy;
    for (let c = 0; c < cols; c++) {
      const tx = tx0 + c;
      const gx = tx + off;
      const t = gx >= 0 && gy >= 0 && gx < TW && gy < TH ? tiles[gy * TW + gx] : grid.tileAt(tx, ty);
      fb.drawTile(image, t, c * 8 - ox, sy);
    }
  }
}

/**
 * Draw one 16x16 sprite frame: OBP0, optional flip; with `grass` the lower 8 rows only
 * where the BG has colour 0 (OAM priority).
 */
export function drawSpriteFrame(fb, sheet, frame, flip, sx, sy, grass, upperOnly = false) {
  const opts = { obj: 0, flipX: flip };
  if (upperOnly) {
    fb.blit(sheet, 0, frame * 16, 16, 8, sx, sy + 8, opts);
    return;
  }
  if (!grass) {
    fb.blit(sheet, 0, frame * 16, 16, 16, sx, sy, opts);
    return;
  }
  fb.blit(sheet, 0, frame * 16, 16, 8, sx, sy, opts);
  fb.blit(sheet, 0, frame * 16 + 8, 16, 8, sx, sy + 8, { obj: 0, flipX: flip, behind: true });
}

/** An 8x8 tile drawn 4 times (TL, TR x-flipped, BL y-flipped, BR both) as a 16x16 block. */
export function drawQuad(fb, img, x, y, obj = 0) {
  fb.drawTile(img, 0, x, y, { obj });
  fb.drawTile(img, 0, x + 8, y, { obj: 0, flipX: true });
  fb.drawTile(img, 0, x, y + 8, { obj: 0, flipY: true });
  fb.drawTile(img, 0, x + 8, y + 8, { obj: 0, flipX: true, flipY: true });
}

/** Is the NPC's 16x16 screen cell under a UI tile (text box): CheckSpriteAvailability. */
function underUi(ov, sx, cellTop) {
  const tx = Math.floor(sx / 8), ty = Math.floor(cellTop / 16) * 2;
  return ov.uiCovers(tx, ty) || ov.uiCovers(tx + 1, ty) || ov.uiCovers(tx, ty + 1) || ov.uiCovers(tx + 1, ty + 1);
}

/** Draw the whole overworld frame. */
export function drawOverworld(ov, fb) {
  const map = ov.map;
  const cam = ov.camera();
  drawBackground(fb, map.grid, map.image, cam.x, cam.y);
  const data = ov.data;
  const sj = data.sprites;
  const still = ov.textDepth > 0; // DisplayTextIDInit: sprites shown standing during text
  const p = ov.player;

  // ledge shadow (OAM 36-39: lowest priority)
  if (p.ledge && data.gfx.shadow) drawQuad(fb, data.gfx.shadow, SHADOW_SCREEN_X, SHADOW_SCREEN_Y, 1);

  // NPCs, highest slot first so slot 1 ends up on top
  for (let i = ov.npcs.length - 1; i >= 0; i--) {
    const n = ov.npcs[i];
    if (!n.visible || !n.sprite) continue;
    const sheet = data.get(n.sprite.sheet);
    if (!sheet) continue;
    const cellTop = n.py - cam.y;
    const sx = n.px - cam.x, sy = cellTop + SPRITE_Y_OFFSET;
    if (sx <= -16 || sx >= 160 || sy <= -16 || sy >= 144) continue;
    if (underUi(ov, sx, cellTop)) continue;
    const [frame, flip] = spriteFrame(sj, n.sprite, n.imageFacing, still ? 0 : n.imageAnim);
    drawSpriteFrame(fb, sheet, frame, flip, sx, sy, n.grass);
  }

  // player (OAM 0-3)
  if (!p.hidden || p.halfHidden) {
    const sheet = data.playerSheets[p.modeName] || data.playerSheets.walk;
    const facing = p.spinFacing || p.facing;
    const anim = still || p.spinFacing ? 0 : p.animFrame;
    const [frame, flip] = spriteFrame(sj, { kind: 'walking' }, facing, anim);
    const sy = p.screenY != null ? p.screenY : PLAYER_SCREEN_Y;
    if (p.halfHidden) {
      if (!p.hidden) drawSpriteFrame(fb, sheet, frame, flip, PLAYER_SCREEN_X, sy, false, true);
    } else {
      drawSpriteFrame(fb, sheet, frame, flip, PLAYER_SCREEN_X, sy, p.grass);
    }
  }

  // effects (boulder dust ...) in map pixels
  for (const e of ov.effects) {
    if (e.img) drawQuad(fb, e.img, e.worldX - cam.x, e.worldY - cam.y + SPRITE_Y_OFFSET);
  }

  // emotion bubbles (written at the start of OAM: on top), 16 px above the sprite
  for (const e of ov.emotes) {
    const img = data.gfx[`emote_${e.kind}`];
    if (!img) continue;
    let x = PLAYER_SCREEN_X, y = (p.screenY != null ? p.screenY : PLAYER_SCREEN_Y) - 16;
    if (e.target) {
      const n = ov.npc(e.target);
      if (!n) continue;
      x = n.px - cam.x;
      y = n.py - cam.y + SPRITE_Y_OFFSET - 16;
    }
    fb.blit(img, 0, 0, 16, 16, x, y, { obj: 0 });
  }

  ov.ui.draw(fb, ov.font.gfx);
}
