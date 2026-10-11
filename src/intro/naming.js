// The naming screen (DisplayNamingScreen in engine/menus/naming_screen.asm), reusable for
// the player, the rival, Pokémon nicknames and (not in Gen 1) box names.
//
//   YOUR NAME?   RED___‾       title at (0,1) ("RIVAL's NAME?"; nickname: the species name
//                 ‾‾‾‾‾‾‾      at (4,1), "NICKNAME?" at (1,3), party icon at screen (8,0))
//   ┌──────────────────┐       name at (10,2), dashes at (10,3): 7 for player/rival, 10
//   │ A B C D E F G H I│       for nicknames, the next slot raised.
//   │                  │       Letters at x = 2,4,..,18 on rows 5,7,9,11,13; the cursor
//   │ J K L M N O P Q R│       sits one column left of the letter; the case switch row
//   │ ...              │       ("lower case"/"UPPER CASE") is at (2,15).
//   │▶lower case       │
//   └──────────────────┘
// Controls (one button handled per frame, priority Down > Up > Left > Right > Start >
// Select > B > A): D-pad moves (Left/Right wrap within a row and do nothing on the case
// row; Up from the top row and Down into the case row go to the case switch, Down from it
// wraps to the top-left), A adds the letter (SFX_PRESS_AB) unless the name is full, A on
// ED or Start submits, A on the case switch or Select toggles the case, B deletes. When
// the name is full the cursor jumps to ED after every A/B/Start/Select.
// No blinking cursor: the GB's ▶ is static (the raised dash marks the next letter).
//
// API:
//   namingScreen({kind, initial, speciesForIcon, maxLength, allowEmpty, fallback, audio},
//                game = window.game) -> Promise<string>   (pushes a NamingScene)
//   runNamingScreen(ctx, opts)  generator for use inside an intro scene script
//   createNamingState / namingInput / namingLetter: the pure state machine (tests)

import { GbScene, PAD, MenuState, placeMenuCursor, eraseMenuCursor, clearScreen, copyVideoData, textBoxBorder, placeString, clearScreenArea, gbPalWhiteOut, gbPalNormal, CH, standaloneContext } from './gb.js';
import { VCHARS0, VCHARS1, VCHARS2 } from './ppu.js';

/** PLAYER_NAME_LENGTH - 1 / NAME_LENGTH - 1 (box: Gen 2's BOX_NAME_LENGTH - 1). */
export const NAME_MAX = Object.freeze({ player: 7, rival: 7, nickname: 10, box: 8 });

/** data/text/alphabets.asm (9 entries per row). */
export const ALPHABET = Object.freeze({
  upper: Object.freeze([
    ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'],
    ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R'],
    ['S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', ' '],
    ['×', '(', ')', ':', ';', '[', ']', '<PK>', '<MN>'],
    ['-', '?', '!', '♂', '♀', '/', '<DOT>', ',', '<ED>'],
  ]),
  lower: Object.freeze([
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
    ['j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r'],
    ['s', 't', 'u', 'v', 'w', 'x', 'y', 'z', ' '],
    ['×', '(', ')', ':', ';', '[', ']', '<PK>', '<MN>'],
    ['-', '?', '!', '♂', '♀', '/', '<DOT>', ',', '<ED>'],
  ]),
});

/** The case-switch text printed under each page (it names the *other* case). */
export const CASE_TEXT = Object.freeze({ upper: 'lower case', lower: 'UPPER CASE' });

/** wTopMenuItemX of the last column (ED) and its row. */
export const ED_X = 0x11;
export const ED_ITEM = 5;
export const CASE_ITEM = 6;

export const NAMING_TIMING = Object.freeze({
  hpBarTiles: 30,          // LoadHpBarAndStatusTilePatterns (CopyVideoData)
  edTiles: 1,              // LoadEDTile (CopyVideoDataDouble)
  partySpriteFrames: 30,   // LoadMonPartySpriteGfx: 28 CopyVideoData calls (two of 8 tiles)
  iconFrames: 17,          // AnimatePartyMon_ForceSpeed1: PartyMonSpeeds[1] = 16, +1 off SGB
});

/** Split a name into charmap keys (<PK>, <MN>, <DOT> are single characters). */
export function nameTokens(str) {
  return String(str || '').match(/<[A-Z]+>|./gu) || [];
}

/**
 * @typedef {Object} NamingState
 * @property {'player'|'rival'|'nickname'|'box'} kind
 * @property {number} max
 * @property {boolean} lower   wAlphabetCase
 * @property {string[]} name   charmap keys
 * @property {number} x        wTopMenuItemX (1, 3, .. 17)
 * @property {number} item     wCurrentMenuItem (1-5 letter rows, 6 = case switch)
 * @property {boolean} submit  wNamingScreenSubmitName
 */

/** @returns {NamingState} */
export function createNamingState({ kind = 'player', initial = '', maxLength, lower = false } = {}) {
  const max = maxLength || NAME_MAX[kind] || NAME_MAX.player;
  return { kind, max, lower: !!lower, name: nameTokens(initial).slice(0, max), x: 1, item: 1, submit: false };
}

/** The letter right of the cursor (rows 1-5), or null on the case-switch row. */
export function namingLetter(s) {
  if (s.item < 1 || s.item > 5) return null;
  return ALPHABET[s.lower ? 'lower' : 'upper'][s.item - 1][(s.x - 1) >> 1];
}

/** True when the name has all its letters (PrintNicknameAndUnderscores' test). */
export function namingFull(s) {
  return s.name.length >= s.max;
}

/**
 * Handle one poll's newly pressed buttons exactly like the asm's dispatch table.
 * Returns what the screen has to redraw:
 *   {ret: 'dpad'|'ab'|'select'|'none', erase: boolean (EraseMenuCursor first),
 *    sound: boolean (SFX_PRESS_AB), button}
 * After an 'ab'/'select' return, call namingAfterAB() (it forces the cursor to ED when the
 * name is full, unless the name was submitted).
 * @param {NamingState} s
 * @param {number} pressed hJoyPressed bits (engine PAD layout)
 */
export function namingInput(s, pressed) {
  const order = ['down', 'up', 'left', 'right', 'start', 'select', 'b', 'a'];
  const button = order.find((b) => pressed & PAD[b]);
  const r = { ret: 'none', erase: false, sound: false, button: button || null };
  switch (button) {
    case 'down':
      r.ret = 'dpad';
      s.item++;
      if (s.item === 7) { s.item = 1; s.x = 1; r.erase = true; }
      else if (s.item === CASE_ITEM) { s.x = 1; r.erase = true; }
      break;
    case 'up':
      r.ret = 'dpad';
      s.item--;
      if (s.item === 0) { s.item = CASE_ITEM; s.x = 1; r.erase = true; }
      break;
    case 'left':
      r.ret = 'dpad';
      if (s.item === CASE_ITEM) break;
      s.x = s.x - 1 === 0 ? ED_X : s.x - 2;
      r.erase = true;
      break;
    case 'right':
      r.ret = 'dpad';
      if (s.item === CASE_ITEM) break;
      s.x = s.x === ED_X ? 1 : s.x + 2;
      r.erase = true;
      break;
    case 'start':
      r.ret = 'ab';
      s.submit = true;
      break;
    case 'select':
      r.ret = 'select';
      s.lower = !s.lower;
      break;
    case 'b':
      r.ret = 'ab';
      if (s.name.length) s.name.pop();
      break;
    case 'a': {
      r.ret = 'ab';
      if (s.item === ED_ITEM && s.x === ED_X) { s.submit = true; break; }
      if (s.item === CASE_ITEM && s.x === 1) { r.ret = 'select'; s.lower = !s.lower; break; }
      const letter = namingLetter(s);
      if (letter && s.name.length < s.max) {
        s.name.push(letter);
        r.sound = true;
      }
      break;
    }
    default:
      break;
  }
  return r;
}

/**
 * .ABStartReturnPoint: if not submitted and the name is full, force the cursor onto ED.
 * @returns {boolean} true if the cursor was moved (the old ▶ must be erased)
 */
export function namingAfterAB(s) {
  if (s.submit || !namingFull(s)) return false;
  s.x = ED_X;
  s.item = ED_ITEM;
  return true;
}

/** The finished name as a string of charmap keys. */
export function namingResult(s) {
  return s.name.join('');
}

// ------------------------------------------------------------------ drawing

/** Charmap byte of an alphabet key ($F0 = ED, loaded over '¥' by LoadEDTile). */
function keyByte(font, key) {
  if (key === '<ED>') return CH.ed;
  return font.tile(key);
}

/** PrintAlphabet: the 5x9 grid at (2,5) (one blank column after each letter) + case text. */
export function drawAlphabet(font, map, s) {
  const rows = ALPHABET[s.lower ? 'lower' : 'upper'];
  rows.forEach((row, r) => row.forEach((key, c) => map.set(2 + 2 * c, 5 + 2 * r, keyByte(font, key))));
  placeString(font, map, 2, 15, CASE_TEXT[s.lower ? 'lower' : 'upper']);
}

/** PrintNicknameAndUnderscores (without the cursor forcing, see namingAfterAB). */
export function drawNameAndUnderscores(font, map, s) {
  clearScreenArea(map, 10, 2, 10, 1);
  map.putTiles(10, 2, s.name.map((k) => keyByte(font, k)));
  for (let i = 0; i < s.max; i++) map.set(10 + i, 3, CH.underscore);
  const raised = namingFull(s) ? s.max - 1 : s.name.length;
  map.set(10 + raised, 3, CH.raisedUnderscore);
}

/** PrintNamingText. */
export function drawNamingTitle(font, map, kind, speciesName = '') {
  if (kind === 'nickname') {
    const x = placeString(font, map, 4, 1, speciesName);
    map.set(x, 1, 0xc9); // 'の' in the Japanese version, a blank tile in English
    placeString(font, map, 1, 3, 'NICKNAME?');
  } else if (kind === 'rival') {
    placeString(font, map, 0, 1, "RIVAL's NAME?");
  } else if (kind === 'box') {
    placeString(font, map, 0, 1, 'BOX NAME?');
  } else {
    placeString(font, map, 0, 1, 'YOUR NAME?');
  }
}

/**
 * DisplayNamingScreen as a coroutine on an intro context.
 * @param {import('./gb.js').IntroContext} ctx
 * @param {{kind?: string, initial?: string, maxLength?: number, species?: number,
 *          speciesName?: string, icon?: {image:any, animation:string}|null}} opts
 * @returns {Generator<any, string>} the entered name ('' if none)
 */
export function* displayNamingScreen(ctx, opts = {}) {
  const { gb, game, joy, sound, wram } = ctx;
  const font = game.font, map = gb.tilemap, pal = game.palette;
  const kind = opts.kind || 'player';
  gbPalWhiteOut(pal);
  yield 3;
  yield* clearScreen(gb);
  // LoadHpBarAndStatusTilePatterns: $62-$7F = font_battle_extra (page 1 of the font sheet)
  yield* copyVideoData(gb, NAMING_TIMING.hpBarTiles, (f, n) => gb.vram.load(VCHARS2 + 0x62 + f, font.gfx, 256 + 0x62 + f, n));
  // LoadEDTile at vFont tile $70 ($F0)
  yield* copyVideoData(gb, NAMING_TIMING.edTiles, () => gb.vram.setTile(VCHARS1 + 0x70, font.gfx.tile(font.tile('<ED>'))));
  // LoadMonPartySpriteGfx (28 CopyVideoData calls)
  const icon = kind === 'nickname' ? opts.icon || null : null;
  if (icon) {
    const im = icon.image;
    // frame 1 = top 16x16, frame 2 = bottom 16x16; 4 tiles each (TL, TR, BL, BR)
    [0, 1, 2, 3].forEach((i) => gb.vram.setTile(VCHARS0 + i, im.tile(i)));
    [4, 5, 6, 7].forEach((i) => gb.vram.setTile(VCHARS0 + i, im.tile(i)));
  }
  yield NAMING_TIMING.partySpriteFrames;
  textBoxBorder(font, map, 0, 4, 18, 9);
  drawNamingTitle(font, map, kind, opts.speciesName || '');
  gb.clearSprites();
  if (icon) {
    // WriteMonPartySpriteOAMBySpecies: 2x2 OBJs at Y=$10, X=$10 (screen 8,0)
    gb.setSprite(0, 0x10, 0x10, 0); gb.setSprite(1, 0x10, 0x18, 1);
    gb.setSprite(2, 0x18, 0x10, 2); gb.setSprite(3, 0x18, 0x18, 3);
  }
  const s = createNamingState({ kind, initial: opts.initial, maxLength: opts.maxLength, lower: wram.alphabetLower });
  const m = new MenuState({ topX: 1, topY: 3, cur: 1, last: 1, max: 7, watched: 0xff });
  let animCounter = 0;
  const speed = NAMING_TIMING.iconFrames;
  const animateIcon = () => {
    // AnimatePartyMon_ForceSpeed1
    if (icon) {
      const second = animCounter >= speed;
      const bob = icon.animation === 'bob';
      for (let i = 0; i < 4; i++) {
        const o = gb.oam[i];
        o.tile = i + (second && !bob ? 4 : 0);
        o.y = (i < 2 ? 0x10 : 0x18) + (second && bob ? 1 : 0);
      }
    }
    animCounter = (animCounter + 1) % (2 * speed);
  };
  let ret = 'select';
  for (;;) {
    if (ret === 'select') {
      // .selectReturnPoint: PrintAlphabet (transfer off while writing, Delay3), GBPalNormal
      gb.autoTransfer = false;
      drawAlphabet(font, map, s);
      gb.autoTransfer = true;
      yield 3;
      gbPalNormal(pal);
    }
    if (ret === 'select' || ret === 'ab') {
      // .ABStartReturnPoint
      if (s.submit) break;
      if (namingAfterAB(s)) {
        eraseMenuCursor(map, m);
      }
      drawNameAndUnderscores(font, map, s);
    }
    // .dPadReturnPoint
    m.topX = s.x;
    m.cur = s.item;
    placeMenuCursor(map, m);
    // .inputLoop
    let pressed = 0;
    while (!pressed) {
      animateIcon();
      yield 1;
      pressed = joy.poll();
    }
    const r = namingInput(s, pressed);
    if (r.sound) sound.playSfx('SFX_PRESS_AB');
    if (r.erase) eraseMenuCursor(map, m);
    ret = r.ret === 'none' ? 'dpad' : r.ret;
  }
  // .submitNickname
  wram.alphabetLower = s.lower;
  gbPalWhiteOut(pal);
  yield 3;
  yield* clearScreen(gb);
  gb.clearSprites();
  gbPalNormal(pal);
  // LoadTextBoxTilePatterns
  yield* copyVideoData(gb, 32, (f, n) => gb.vram.load(VCHARS2 + 0x60 + f, font.gfx, 0x60 + f, n));
  return namingResult(s);
}

/**
 * The naming screen with the callers' conventions: player/rival names cannot be empty
 * (the screen reopens, like ChoosePlayerName's .customName loop); an empty nickname
 * returns `fallback` (AskName keeps the species name).
 * @returns {Generator<any, string>}
 */
export function* runNamingScreen(ctx, opts = {}) {
  const kind = opts.kind || 'player';
  const allowEmpty = opts.allowEmpty ?? (kind === 'nickname' || kind === 'box');
  for (;;) {
    const name = yield* displayNamingScreen(ctx, opts);
    if (name) return name;
    if (allowEmpty) return opts.fallback ?? '';
  }
}

export class NamingScene extends GbScene {
  get id() { return 'naming'; }

  *script(opts) {
    const name = yield* runNamingScreen(this.ctx, opts);
    return { pop: name };
  }
}

/**
 * Reusable widget: push the naming screen on game.scenes and resolve with the name.
 *   const nick = await namingScreen({ kind: 'nickname', speciesForIcon: 25 });
 *   // inside a scene coroutine: const name = yield namingScreen({ kind: 'rival' });
 * @param {{kind?: 'player'|'rival'|'nickname'|'box', initial?: string,
 *          speciesForIcon?: number, maxLength?: number, allowEmpty?: boolean,
 *          fallback?: string, audio?: any}} [opts]
 *   speciesForIcon: Pokédex number (nickname: title text + party icon);
 *   fallback: returned for an empty nickname (default: the species name, like AskName).
 * @param {any} [game] engine services (default window.game)
 * @returns {Promise<string>}
 */
export async function namingScreen(opts = {}, game = globalThis.game) {
  if (!game || !game.scenes || !game.font) throw new Error('namingScreen: needs the engine game object (window.game)');
  const kind = opts.kind || 'player';
  let speciesName = '', icon = null;
  if (kind === 'nickname' && opts.speciesForIcon) {
    const [pokemon, uiGfx] = await Promise.all([game.assets.json('data/pokemon.json'), game.assets.json('data/ui_gfx.json')]);
    const mon = pokemon.find((p) => p.dex === opts.speciesForIcon);
    speciesName = mon ? mon.name : '';
    const sheet = uiGfx.sheets.find((s) => s.path === 'assets/ui/icons/<icon>.png');
    const entry = sheet && sheet.files && (sheet.files[mon && mon.menuIcon] || sheet.files.ICON_MON);
    if (entry) icon = { image: await game.assets.image(entry.path), animation: entry.animation || 'swap' };
  }
  const ctx = standaloneContext(game, { audio: opts.audio || null });
  const scene = new NamingScene(ctx, {
    ...opts, kind, speciesName, icon,
    fallback: opts.fallback ?? (kind === 'nickname' ? speciesName : ''),
  });
  game.scenes.push(scene);
  return scene.finished;
}
