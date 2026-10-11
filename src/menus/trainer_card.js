// The trainer card ({PLAYER} in the START menu; engine/menus/start_sub_menus.asm
// StartMenu_TrainerInfo / DrawTrainerInfo, engine/menus/draw_badges.asm DrawBadges).
//
// Top box (0,0) 20×8 with NAME/ MONEY/ TIME/ at (2,2..6), the name (7,2), money left-aligned
// with ¥ (8,4), time h:mm (9,6), Red's pic in the upper right (pic columns 1-4, rows 0-5 at
// tiles (15..18, 1..6) — the rest of the 7×7 pic is covered by the frame / cleared);
// "○BADGES○" at (6,9); the badge box (1,10) 18×8 between two patterned columns; each gym i:
// number tile (2+4i, 11 / 14), the leader's face or, once earned, the badge (2×2 tiles).

import { MenuScene } from './base.js';
import { LEFT_ALIGN, LEADING_ZEROES, MONEY_SIGN } from './format.js';

/** DrawBadges tile layout (pure): [{x, y, number, tiles:[tl,tr,bl,br]}] for 8 gyms. */
export function badgeCells(badges) {
  const cells = [];
  for (let i = 0; i < 8; i++) {
    const owned = !!(badges & (1 << i));
    const base = 0x20 + 8 * i + (owned ? 4 : 0);
    const x = 2 + 4 * (i % 4);
    const y = i < 4 ? 11 : 14;
    cells.push({ x, y, owned, number: 0xd8 + i, name: owned ? null : [0x60 + 2 * i, 0x61 + 2 * i], tiles: [base, base + 1, base + 2, base + 3] });
  }
  return cells;
}

export class TrainerCardScene extends MenuScene {
  constructor(params = {}) {
    super({ ...params, opaque: true, vramMode: 'trainerCard' });
  }

  *main() {
    const st = this.state;
    const s = this.scr;
    this.palWhiteOut();
    s.clear();
    this.drawInfo();
    this.drawBadges(st.badges | 0);
    this.palNormal();
    yield* this.waitButton();
    this.palWhiteOut();
    yield 1;
    return null;
  }

  /** DrawTrainerInfo (everything except the faces / badges). */
  drawInfo() {
    const s = this.scr;
    const st = this.state;
    const redBase = this.ctx.sheet.base.redPic;
    // the 7×7 pic at (15,1) with its tiles shifted one column (only cols 15-18, rows 1-6 survive)
    if (redBase !== undefined) {
      for (let c = 0; c < 4; c++) for (let r = 0; r < 6; r++) s.putTile(15 + c, 1 + r, redBase + r * 7 + (c + 1));
    }
    // TrainerInfo_DrawTextBox (0,0) width 18+1, height 6 inside
    this.infoBox(0, 0, 18, 1);
    this.infoBox(1, 10, 16, 3);
    for (let y = 10; y < 18; y++) { s.put(0, y, 0xd7); s.put(19, y, 0xd7); }
    s.bytesAt(6, 9, [0x76, ...s.bytesOf('BADGES'), 0x76]);
    s.text(2, 2, 'NAME/\nMONEY/\nTIME/');
    s.text(7, 2, st.playerName);
    s.bcd(8, 4, st.money, 3, LEADING_ZEROES | LEFT_ALIGN | MONEY_SIGN);
    const t = st.playTimeParts || { hours: 0, minutes: 0 };
    let x = s.num(9, 6, t.hours, 3, LEFT_ALIGN);
    s.put(x++, 6, 0xd6);
    s.num(x, 6, t.minutes, 2, LEADING_ZEROES);
  }

  /** The trainer-info frame: $79 ┌, $7A top, $7B ┐, $7C left, $78 right, $7D └, $77 bottom, $7E ┘. */
  infoBox(x, y, width, gap) {
    const s = this.scr;
    s.put(x, y, 0x79);
    for (let i = 1; i <= width; i++) s.put(x + i, y, 0x7a);
    s.put(x + width + 1, y, 0x7b);
    for (let r = 1; r <= 6; r++) { s.put(x, y + r, 0x7c); s.put(x + width + 1, y + r, 0x78); }
    s.put(x, y + 7, 0x7d);
    for (let i = 1; i <= width; i++) s.put(x + i, y + 7, 0x77);
    s.put(x + width + 1, y + 7, 0x7e);
    return gap;
  }

  drawBadges(badges) {
    const s = this.scr;
    for (const c of badgeCells(badges)) {
      s.put(c.x, c.y, c.number);
      if (c.name) { s.put(c.x + 1, c.y, c.name[0]); s.put(c.x + 2, c.y, c.name[1]); }
      s.put(c.x + 1, c.y + 1, c.tiles[0]); s.put(c.x + 2, c.y + 1, c.tiles[1]);
      s.put(c.x + 1, c.y + 2, c.tiles[2]); s.put(c.x + 2, c.y + 2, c.tiles[3]);
    }
  }
}
