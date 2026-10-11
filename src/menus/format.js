// Pure number / HP-bar / level formatting exactly like the Game Boy routines the menus use.
// No DOM, no engine state: every function returns plain strings or numbers, so the layout
// rules can be unit tested (tests/menus/format.test.js).
//
//   PrintNumber      (home/print_num.asm)   -> printNumber(value, digits, flags)
//   PrintBCDNumber   (home/print_bcd.asm)   -> printBCD(value, bytes, flags)
//   GetHPBarLength   (engine/gfx/hp_bar.asm) -> hpBarPixels(hp, maxHp)
//   DrawHPBar        (home/pokemon.asm)      -> hpBarBytes(pixels, type)
//   GetHealthBarColor(home/palettes.asm)     -> hpBarColor(pixels)
//   PrintLevel / PrintLevelFull (home/pokemon.asm)
//
// Strings returned here use the charmap spelling the Font understands ("<LV>", "¥", ...);
// a space ' ' stands for "PrintNumber advanced the cursor without writing" (right alignment),
// which on a cleared screen is a blank tile — callers that must not overwrite use
// `{ skip: true }` cells via printNumberCells().

/** Flags shared by PrintNumber / PrintBCDNumber (pret constants/text_constants.asm). */
export const LEADING_ZEROES = 0x80;
export const LEFT_ALIGN = 0x40;
export const MONEY_SIGN = 0x20;

/**
 * PrintNumber: print a `digits`-digit number. LEADING_ZEROES prints the zeros, LEFT_ALIGN
 * drops the padding; otherwise the number is right-aligned in `digits` cells (padding =
 * cursor advanced without writing, returned as spaces). Values wider than `digits` keep
 * their low digits (the asm only ever prints values that fit).
 * @param {number} value
 * @param {number} digits 1-7
 * @param {number} [flags] LEADING_ZEROES | LEFT_ALIGN
 * @returns {string}
 */
export function printNumber(value, digits, flags = 0) {
  const v = Math.max(0, Math.floor(Number(value) || 0));
  let s = String(v);
  if (s.length > digits) s = s.slice(-digits);
  if (flags & LEADING_ZEROES) return s.padStart(digits, '0');
  if (flags & LEFT_ALIGN) return String(Number(s));
  return String(Number(s)).padStart(digits, ' ');
}

/**
 * PrintBCDNumber: `bytes` BCD bytes (2 digits each). In this routine the LEADING_ZEROES bit
 * means "do NOT print leading zeros" (pret's comment: "bit 7: if set, do not print leading
 * zeroes"); right-aligned unless LEFT_ALIGN; MONEY_SIGN puts ¥ right before the first digit
 * printed (taking one extra cell), or first when zeros are printed. An all-zero value prints
 * a single 0 (with ¥ when requested) in the last cell(s).
 * @param {number} value
 * @param {number} bytes 1-3
 * @param {number} [flags]
 * @returns {string}
 */
export function printBCD(value, bytes, flags = 0) {
  const digits = bytes * 2;
  const s = String(Math.max(0, Math.floor(Number(value) || 0)) % 10 ** digits).padStart(digits, '0');
  const money = !!(flags & MONEY_SIGN);
  const noZeros = !!(flags & LEADING_ZEROES);
  const left = !!(flags & LEFT_ALIGN);
  if (!noZeros) return (money ? '¥' : '') + s;
  let out = '';
  let started = false;
  for (const d of s) {
    if (!started && d === '0') {
      if (!left) out += ' ';
      continue;
    }
    if (!started) {
      started = true;
      if (money) out += '¥';
    }
    out += d;
  }
  if (!started) {
    // every digit was zero: step back one cell when right-aligned, then (¥)0
    if (!left) out = out.slice(0, -1);
    out += (money ? '¥' : '') + '0';
  }
  return out;
}

/**
 * GetHPBarLength: hp * 48 / maxHp, both divided by 4 first when maxHp > 255, at least 1.
 * (DrawHP_ skips the call for 0 HP and draws an empty bar.)
 * @returns {number} 0-48 pixels
 */
export function hpBarPixels(hp, maxHp) {
  hp = Math.max(0, hp | 0);
  maxHp = Math.max(1, maxHp | 0);
  if (hp === 0) return 0;
  let num = (hp * 48) & 0xffffff;
  let den = maxHp;
  if (den > 0xff) {
    den = (den >> 2) & 0xff;
    num = (num & 0xff0000) | ((num & 0xffff) >> 2);
  }
  if (den === 0) den = 1;
  const px = Math.floor(num / den) & 0xff;
  return px === 0 ? 1 : Math.min(px, 255);
}

/** HP bar types (wHPBarType): 1 status screen / battle (right end $6D), 2 party menu ($6C). */
export const HP_BAR_STATUS = 1;
export const HP_BAR_PARTY = 2;

/**
 * DrawHPBar: the raw tile bytes of a 6-tile bar: "HP:" ($71), left end ($62), six segments
 * ($63 + filled pixels, $6B = full), right end ($6C party menu / $6D status screen).
 * @param {number} pixels 0-48
 * @param {number} [type] HP_BAR_STATUS | HP_BAR_PARTY
 * @returns {number[]} 9 bytes
 */
export function hpBarBytes(pixels, type = HP_BAR_PARTY) {
  const out = [0x71, 0x62];
  let e = Math.max(0, pixels | 0);
  for (let i = 0; i < 6; i++) {
    const fill = Math.min(8, e);
    out.push(0x63 + fill);
    e -= fill;
  }
  out.push(type === HP_BAR_STATUS ? 0x6d : 0x6c);
  return out;
}

/** GetHealthBarColor: 0 green (>= 27 px), 1 yellow (>= 10 px), 2 red. */
export function hpBarColor(pixels) {
  if (pixels >= 27) return 0;
  if (pixels >= 10) return 1;
  return 2;
}

/** PrintLevel: "<LV>" + level left-aligned (2 digits); at 100+ the <LV> tile is overwritten. */
export function levelString(level) {
  const l = Math.max(0, level | 0);
  if (l >= 100) return printNumber(l, 3, LEFT_ALIGN);
  return '<LV>' + printNumber(l, 2, LEFT_ALIGN);
}

/** PrintLevelFull: always "<LV>" + up to 3 digits. */
export function levelFullString(level) {
  return '<LV>' + printNumber(level, 3, LEFT_ALIGN);
}

/** PrintStatusCondition / PrintStatusAilment: "FNT" at 0 HP, else PSN/BRN/FRZ/PAR/SLP or "". */
export function statusText(hp, status) {
  if (!hp) return 'FNT';
  const s = status & 0xff;
  if (s & 0x08) return 'PSN';
  if (s & 0x10) return 'BRN';
  if (s & 0x20) return 'FRZ';
  if (s & 0x40) return 'PAR';
  if (s & 0x07) return 'SLP';
  return '';
}

/**
 * The HP number pair under / beside the bar (DrawHP_): current and max, 3 digits each,
 * right-aligned, separated by '/'.
 */
export function hpFraction(hp, maxHp) {
  return printNumber(hp, 3) + '/' + printNumber(maxHp, 3);
}

/**
 * Play time "hhh:mm" as the save screen prints it (PrintPlayTime): hours 3 digits right
 * aligned, the <COLON> tile, minutes 2 digits with leading zeros.
 */
export function playTimeString(hours, minutes) {
  return printNumber(hours, 3) + '<COLON>' + printNumber(minutes, 2, LEADING_ZEROES);
}

/** Money as the money box prints it: 7 cells, ¥ right before the digits (right-aligned). */
export function moneyString(money) {
  return printBCD(money, 3, LEADING_ZEROES | MONEY_SIGN);
}

/** Coins as the Game Corner prints them: 4 cells, right-aligned, no leading zeros. */
export function coinString(coins) {
  return printBCD(coins, 2, LEADING_ZEROES);
}
