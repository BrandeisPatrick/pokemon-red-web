// A mock battle screen (everything except the pics) for anims-test.html and headless renders:
// HUD frames, HP bars, names/levels and the message box, laid out like DrawEnemyHUDAndHPBar /
// DrawPlayerHUDAndHPBar / DrawHPBar / the MESSAGE_BOX text box. The real battle engine draws its
// own screen; this only shows where things go. Pure (draws into a FrameBuffer).

import { ENEMY_HUD, PLAYER_HUD, MESSAGE_BOX, HP_BAR } from './layout.js';

/**
 * @param {import('../engine/framebuffer.js').FrameBuffer} fb
 * @param {object} o
 * @param {import('../engine/gfx.js').IndexedImage} o.battleTiles  assets/battle/battle_tiles_60_7f.png
 * @param {import('../engine/font.js').Font} [o.font]
 * @param {{name?: string, level?: number, hpPx?: number}} [o.enemy]
 * @param {{name?: string, level?: number, hpPx?: number, hp?: number, maxHp?: number}} [o.player]
 * @param {string} [o.message] up to two lines separated by \n
 */
export function drawMockBattleScreen(fb, { battleTiles, font = null, enemy = {}, player = {}, message = '' }) {
  const tile = (id, tx, ty) => fb.drawTile(battleTiles, id - 0x60, tx * 8, ty * 8);
  const hpBar = (tx, ty, px) => {
    tile(HP_BAR.label, tx, ty);
    tile(HP_BAR.left, tx + 1, ty);
    for (let i = 0; i < HP_BAR.segments; i++) {
      const fill = Math.max(0, Math.min(8, px - i * 8));
      tile(HP_BAR.empty + fill, tx + 2 + i, ty);
    }
    tile(HP_BAR.endBattle, tx + 8, ty);
  };
  const text = (str, tx, ty) => { if (font) font.drawText(fb, str, tx * 8, ty * 8); };

  // enemy HUD (PlaceEnemyHUDTiles + DrawHPBar at (2,2))
  const eh = ENEMY_HUD;
  tile(eh.tiles.bar, eh.frame.bar.x, eh.frame.bar.y);
  tile(eh.tiles.corner, eh.frame.corner.x, eh.frame.corner.y);
  for (let i = 0; i < eh.frame.line.len; i++) tile(eh.tiles.line, eh.frame.line.x + i, eh.frame.line.y);
  tile(eh.tiles.end, eh.frame.end.x, eh.frame.end.y);
  hpBar(eh.hpBar.x, eh.hpBar.y, enemy.hpPx ?? 48);
  text(enemy.name ?? 'CHARMANDER', eh.name.x, eh.name.y);
  tile(0x6e, eh.level.x, eh.level.y);
  text(String(enemy.level ?? 5), eh.level.x + 1, eh.level.y);

  // player HUD (PlacePlayerHUDTiles, $73 at (18,9) is overwritten by the bar end)
  const ph = PLAYER_HUD;
  tile(ph.tiles.bar, ph.frame.bar.x, ph.frame.bar.y);
  tile(ph.tiles.corner, ph.frame.corner.x, ph.frame.corner.y);
  for (let i = 0; i < ph.frame.line.len; i++) tile(ph.tiles.line, ph.frame.line.x + i, ph.frame.line.y);
  tile(ph.tiles.end, ph.frame.end.x, ph.frame.end.y);
  hpBar(ph.hpBar.x, ph.hpBar.y, player.hpPx ?? 48);
  text(player.name ?? 'PIKACHU', ph.name.x, ph.name.y);
  tile(0x6e, ph.level.x, ph.level.y);
  text(String(player.level ?? 25), ph.level.x + 1, ph.level.y);
  const hp = String(player.hp ?? 55).padStart(3, ' ');
  const max = String(player.maxHp ?? 55).padStart(3, ' ');
  text(`${hp}/${max}`, ph.hpNumbers.x, ph.hpNumbers.y);

  // message box $79-$7E
  const mb = MESSAGE_BOX;
  tile(0x79, mb.x, mb.y);
  tile(0x7b, mb.x + mb.w - 1, mb.y);
  tile(0x7d, mb.x, mb.y + mb.h - 1);
  tile(0x7e, mb.x + mb.w - 1, mb.y + mb.h - 1);
  for (let x = 1; x < mb.w - 1; x++) { tile(0x7a, mb.x + x, mb.y); tile(0x7a, mb.x + x, mb.y + mb.h - 1); }
  for (let y = 1; y < mb.h - 1; y++) { tile(0x7c, mb.x, mb.y + y); tile(0x7c, mb.x + mb.w - 1, mb.y + y); }
  const lines = String(message).split('\n');
  if (lines[0]) text(lines[0], mb.line1.x, mb.line1.y);
  if (lines[1]) text(lines[1], mb.line2.x, mb.line2.y);
}
