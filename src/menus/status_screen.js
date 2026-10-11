// The Pokémon summary (engine/pokemon/status_screen.asm StatusScreen + StatusScreen2).
//
// Page 1: flipped front pic at (1,0), nickname (9,1), level (14,2), HP bar (11,3) with the
// numbers below, STATUS/ (9,6) + status or OK (16,6), №.### (1,7), the line boxes, TYPE1/TYPE2/
// <ID>№/OT/ (10,9...), types (11,10/12), ID (12,14), OT (12,16), the stats box (0,8) 10×10.
// Page 2: species name, EXP POINTS / LEVEL UP (exp at (12,4), to-next at (7,6), <to> + next
// level at (14,6)), the moves box (0,8) 20×10 with bold PP and cur/max PP.
// The cry plays when page 1 appears; music is ducked (rAUDVOL $33) while it is shown.

import { MenuScene } from './base.js';
import { LEADING_ZEROES, printNumber } from './format.js';
import { HP_BAR_STATUS } from './screen.js';
import { boxMonStats, maxPP } from '../pokemon/mon.js';
import { expForLevel, MAX_LEVEL } from '../pokemon/exp.js';

/** Stats, level and max HP the status screen shows for a mon (party or box form). */
export function statusScreenData(mon, gd) {
  const sp = gd.species(mon.species);
  const stats = mon.stats || boxMonStats(mon, gd);
  const level = mon.level;
  const nextLevel = level >= MAX_LEVEL ? MAX_LEVEL : level + 1;
  // CalcExpToLevelUp: exp(level + 1) - exp, or 0 at level 100 (24-bit arithmetic)
  const toNext = level >= MAX_LEVEL ? 0 : (expForLevel(sp.growthRate, level + 1, gd) - mon.exp) & 0xffffff;
  return {
    species: sp, stats, level, nextLevel, toNext, maxHp: stats.hp,
    types: [gd.typeName(sp.types[0]), gd.typeName(sp.types[1])],
    sameType: sp.types[0] === sp.types[1],
  };
}

export class StatusScreenScene extends MenuScene {
  /**
   * @param {object} params
   * @param {any} params.mon party or box mon
   * @param {boolean} [params.box] the mon is in box form (BOX_DATA)
   */
  constructor(params = {}) {
    super({ ...params, opaque: true, vramMode: 'status' });
    this.pic = null;
  }

  *main() {
    const mon = this.params.mon;
    const gd = this.gd;
    const d = statusScreenData(mon, gd);
    this.snd.duck(true);
    yield* this.whiteOutDelay3();
    const s = this.scr;
    s.clear();
    // line boxes
    this.lineBox(19, 1, 6, 10);
    s.put(2, 7, 0xf2); // <DOT>
    s.put(1, 7, 0x74); // №
    this.lineBox(19, 9, 8, 6);
    s.text(10, 9, 'TYPE1/\nTYPE2/\n<ID>№/\nOT/');
    s.hp(11, 3, mon.hp, d.maxHp, HP_BAR_STATUS);
    if (!s.status(16, 6, mon.hp, mon.status)) s.text(16, 6, 'OK');
    s.text(9, 6, 'STATUS/');
    s.level(14, 2, d.level);
    s.num(3, 7, d.species.dex, 3, LEADING_ZEROES);
    s.text(11, 10, d.types[0]);
    if (d.sameType) s.clearArea(10, 11, 6, 1);
    else s.text(11, 12, d.types[1]);
    s.text(9, 1, mon.nickname || d.species.name);
    s.text(12, 16, mon.otName || '');
    s.num(12, 14, mon.otId, 5, LEADING_ZEROES);
    this.statsBox(d.stats);
    yield 3;
    this.palNormal();
    // LoadFlippedFrontSpriteByMonIndex at (1,0)
    this.pic = yield this.ctx.frontPic(mon.species);
    this.picAt = { x: 1, y: 0 };
    // PlayCry plays and waits for the cry, then WaitForTextScrollButtonPress
    yield* this.cryWait(d.species.dex);
    yield* this.waitButton();

    // ---- page 2
    s.clearArea(9, 2, 10, 5);
    s.put(19, 3, 0x78);
    s.box(0, 8, 20, 10);
    const names = [];
    for (let i = 0; i < 4; i++) names.push(mon.moves[i] ? gd.move(mon.moves[i].move).name : '-');
    s.text(2, 9, names.join('\n'));
    const known = Math.min(4, mon.moves.length);
    for (let i = 0; i < 4; i++) {
      const y = 10 + 2 * i;
      const b = i < known ? 0x72 : 0xe3; // <BOLD_P> / '-'
      s.put(11, y, b);
      s.put(12, y, b);
      if (i < known) {
        const slot = mon.moves[i];
        s.text(14, y, printNumber(slot.pp, 2));
        s.put(16, y, 0xf3);
        s.text(17, y, printNumber(maxPP(slot, gd), 2));
      }
    }
    s.text(9, 3, 'EXP POINTS\nLEVEL UP');
    s.put(14, 6, 0x70); // <to>
    s.level(16, 6, d.nextLevel);
    s.num(12, 4, mon.exp, 7);
    s.num(7, 6, d.toNext, 7);
    s.clearArea(9, 0, 10, 1);
    s.clearArea(9, 1, 10, 1);
    s.text(9, 1, d.species.name);
    yield 3;
    yield* this.waitButton();
    this.snd.duck(false);
    this.palWhiteOut();
    this.pic = null;
    return null;
  }

  /** DrawLineBox: │ down from (x, y) for b rows, ┘, ─ c tiles to the left, the half-arrow end. */
  lineBox(x, y, b, c) {
    const s = this.scr;
    for (let i = 0; i < b; i++) s.put(x, y + i, 0x78);
    s.put(x, y + b, 0x77);
    for (let i = 1; i <= c; i++) s.put(x - i, y + b, 0x76);
    s.put(x - c - 1, y + b, 0x6f);
  }

  /** PrintStatsBox (STATUS_SCREEN_STATS_BOX): box (0,8) 10×10, labels (1,9), values (6,10..16). */
  statsBox(stats) {
    const s = this.scr;
    s.box(0, 8, 10, 10);
    s.text(1, 9, 'ATTACK\nDEFENSE\nSPEED\nSPECIAL');
    [stats.atk, stats.def, stats.spd, stats.spc].forEach((v, i) => s.num(6, 10 + 2 * i, v, 3));
  }

  drawExtra(fb) {
    if (this.pic) drawFlippedPic(fb, this.pic, this.picAt.x, this.picAt.y);
  }
}

/**
 * LoadFlippedFrontSpriteByMonIndex: the pic bottom-aligned and centred in a 7×7 tile box at
 * tile (tx, ty) (LoadUncompressedSpriteData), the whole box mirrored horizontally.
 */
export function drawFlippedPic(fb, img, tx, ty, opts = {}) {
  const w = img.width >> 3, h = img.height >> 3;
  const col = (8 - w) >> 1; // (8 - w) / 2, rounded down
  const row = 7 - h;
  const mirroredCol = 7 - col - w;
  fb.blit(img, 0, 0, img.width, img.height, (tx + mirroredCol) * 8, (ty + row) * 8, { flipX: true, ...opts });
}

/** LoadFrontSpriteByMonIndex (not flipped). */
export function drawPic(fb, img, tx, ty, opts = {}) {
  const w = img.width >> 3, h = img.height >> 3;
  const col = (8 - w) >> 1;
  const row = 7 - h;
  fb.blit(img, 0, 0, img.width, img.height, (tx + col) * 8, (ty + row) * 8, opts);
}
