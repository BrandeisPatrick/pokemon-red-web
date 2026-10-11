// Battle-screen tile writers: the HUDs (DrawPlayerHUDAndHPBar, DrawEnemyHUDAndHPBar,
// PlacePlayerHUDTiles / PlaceEnemyHUDTiles), DrawHPBar, PrintNumber, PrintLevel, the status
// abbreviations, CenterMonName - writing font tile ids into an engine TileMap at pokered's
// `hlcoord x, y`. Pure (no DOM): `font` only needs encode(), vram.battle and hpBar.

import { PSN, BRN, FRZ, PAR, SLP_MASK } from './constants.js';

/** Raw battle-VRAM byte -> font sheet tile (HUD tiles $62-$7F differ from the text font). */
export function byteTile(font, b) {
  return font.vram.battle[b & 0xff];
}

/** Write a string (charmap encoded) at (x, y). @returns {number} x after it */
export function putStr(map, font, x, y, str) {
  for (const t of font.encode(String(str))) map.set(x++, y, t);
  return x;
}

/** Write raw battle-VRAM bytes. */
export function putBytes(map, font, x, y, bytes) {
  for (const b of bytes) map.set(x++, y, byteTile(font, b));
  return x;
}

/**
 * PrintNumber: `digits` wide, right-aligned with spaces (LEADING_ZEROES pads with 0,
 * LEFT_ALIGN prints at x without padding).
 */
export function numberString(value, digits, { leftAlign = false, leadingZeros = false } = {}) {
  let s = String(Math.max(0, Math.floor(value)));
  if (s.length > digits) s = s.slice(-digits);
  if (leftAlign) return s;
  return s.padStart(digits, leadingZeros ? '0' : ' ');
}

export function printNumber(map, font, x, y, value, digits, opts) {
  return putStr(map, font, x, y, numberString(value, digits, opts));
}

/** PrintLevel: "<LV>nn" (2 digits, left aligned); at level 100 the ":L" is overwritten. */
export function printLevel(map, font, x, y, level) {
  if (level >= 100) return printNumber(map, font, x, y, level, 3, { leftAlign: true });
  map.set(x, y, byteTile(font, 0x6e));
  return printNumber(map, font, x + 1, y, level, 2, { leftAlign: true });
}

/** PrintStatusAilment: "PSN"/"BRN"/"FRZ"/"PAR"/"SLP" or '' (priority as the bit tests). */
export function statusString(status) {
  if (status & PSN) return 'PSN';
  if (status & BRN) return 'BRN';
  if (status & FRZ) return 'FRZ';
  if (status & PAR) return 'PAR';
  if (status & SLP_MASK) return 'SLP';
  return '';
}

/** CenterMonName: x + 2 for 1-2 letters, x + 1 for 3-4, x for longer names. */
export function centerMonNameX(name, x) {
  const n = String(name).length;
  if (n <= 2) return x + 2;
  if (n <= 4) return x + 1;
  return x;
}

/**
 * GetHPBarLength: hp * 48 / maxHP (both / 4 when maxHP > 255), at least 1 - the battle HUD
 * and UpdateHPBar use this; 0 only for 0 HP when the caller asks for it.
 */
export function hpBarLength(hp, maxHP) {
  hp &= 0xffff;
  maxHP &= 0xffff;
  let num = (hp * 48) & 0xffff;
  let den = maxHP;
  if (den > 255) {
    num >>= 2;
    den = (den >> 2) & 0xff;
  }
  if (!den) return 48;
  const px = Math.floor(num / den) & 0xff;
  return px || 1;
}

/** HP bar type: 0 enemy HUD ($6C end), 1 player HUD / status ($6D end), 2 party menu ($6C). */
export const HP_BAR_ENEMY = 0;
export const HP_BAR_PLAYER = 1;
export const HP_BAR_PARTY = 2;

/**
 * DrawHPBar: "HP:" $71, $62, 6 segments ($63 + pixels, $6B full) and the end tile at (x, y);
 * `px` pixels filled (written past the 6th segment when it exceeds 48, like the GB).
 */
export function drawHPBar(map, font, x, y, px, type = HP_BAR_PLAYER) {
  const bar = font.hpBar;
  map.set(x, y, bar.label);
  map.set(x + 1, y, bar.left);
  for (let i = 0; i < 6; i++) map.set(x + 2 + i, y, bar.fill[0]);
  map.set(x + 8, y, type === HP_BAR_PLAYER ? bar.rightBattle : bar.rightMenu);
  let e = px;
  let cx = x + 2;
  while (e >= 8) {
    map.set(cx++, y, bar.fill[8]);
    e -= 8;
  }
  if (e > 0) map.set(cx, y, bar.fill[e]);
}

/** HP fraction "ccc/mmm" (DrawHP). */
export function drawHPFraction(map, font, x, y, hp, maxHP) {
  printNumber(map, font, x, y, hp, 3);
  putStr(map, font, x + 3, y, '/');
  printNumber(map, font, x + 4, y, maxHP, 3);
}

/** PlacePlayerHUDTiles */
export function placePlayerHUDTiles(map, font) {
  map.set(18, 10, byteTile(font, 0x73));
  map.set(18, 11, byteTile(font, 0x77));
  for (let x = 10; x <= 17; x++) map.set(x, 11, byteTile(font, 0x76));
  map.set(9, 11, byteTile(font, 0x6f));
}

/** PlaceEnemyHUDTiles */
export function placeEnemyHUDTiles(map, font) {
  map.set(1, 2, byteTile(font, 0x73));
  map.set(1, 3, byteTile(font, 0x74));
  for (let x = 2; x <= 9; x++) map.set(x, 3, byteTile(font, 0x76));
  map.set(10, 3, byteTile(font, 0x78));
}

/**
 * DrawPlayerHUDAndHPBar's tile part: clear (9,7) 11x5, frame, name, level or status, HP bar
 * (10,9) with the end tile over the $73 at (18,9), HP numbers at (11,10).
 * @param {{nick:string, level:number, status:number, hp:number, maxHP:number}} mon
 * @param {number} [px] HP bar pixels override (UpdateHPBar animation)
 * @param {number} [shownHP] HP number override (UpdateHPBar prints the previous value)
 */
export function drawPlayerHUD(map, font, mon, clear, px = null, shownHP = null) {
  clear(9, 7, 11, 5);
  placePlayerHUDTiles(map, font);
  map.set(18, 9, byteTile(font, 0x73));
  putStr(map, font, centerMonNameX(mon.nick, 10), 7, mon.nick);
  const st = statusString(mon.status);
  if (st) putStr(map, font, 15, 8, st);
  else printLevel(map, font, 14, 8, mon.level);
  const bar = px ?? (mon.hp ? hpBarLength(mon.hp, mon.maxHP) : 0);
  drawHPBar(map, font, 10, 9, bar, HP_BAR_PLAYER);
  drawHPFraction(map, font, 11, 10, shownHP ?? mon.hp, mon.maxHP);
}

/** DrawEnemyHUDAndHPBar's tile part: clear (0,0) 12x4, frame, name, level or status, HP bar (2,2). */
export function drawEnemyHUD(map, font, mon, clear, px = null) {
  clear(0, 0, 12, 4);
  placeEnemyHUDTiles(map, font);
  putStr(map, font, centerMonNameX(mon.nick, 1), 0, mon.nick);
  const st = statusString(mon.status);
  if (st) putStr(map, font, 5, 1, st);
  else printLevel(map, font, 4, 1, mon.level);
  const bar = px ?? (mon.hp ? hpBarLength(mon.hp, mon.maxHP) : 0);
  drawHPBar(map, font, 2, 2, bar, HP_BAR_ENEMY);
}

/** PickPokeball: $31 healthy, $32 statused, $33 fainted, $34 empty slot. */
export function partyBallTiles(party) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const m = party[i];
    if (!m) out.push(0x34);
    else if (!(m.hp > 0)) out.push(0x33);
    else if (m.status) out.push(0x32);
    else out.push(0x31);
  }
  return out;
}

/** "TYPE/" box contents of PrintMenuItem, or "disabled!". */
export function drawMoveInfoBox(map, font, drawBox, info) {
  drawBox(0, 8, 11, 5);
  if (info.disabled) {
    putStr(map, font, 1, 10, 'disabled!');
    return;
  }
  putStr(map, font, 1, 9, 'TYPE');
  putStr(map, font, 5, 9, '/');
  putStr(map, font, 2, 10, info.typeName || '');
  printNumber(map, font, 5, 11, info.pp, 2);
  putStr(map, font, 7, 11, '/');
  printNumber(map, font, 8, 11, info.maxPP, 2);
}
