// Private helpers of the kanto4 region scripts (src/game/scripts/regions/kanto4.js): the small
// text / sound / movement helpers every region needs (copies of the kanto1-3 ones, so the regions
// stay independent), the Pokémon Tower 7F exit table, the Saffron gate drink, the Game Corner's
// coin box and slot machine selection, the Cycling Road's forced bike and the Diploma.

import * as lib from '../lib.js';
import { getGameData } from '../../../pokemon/data.js';

/** Pokédex numbers of the Pokémon whose cries / entries the scripts use (PlayCry takes the species). */
export const DEX = Object.freeze({
  FEAROW: 22, NIDORAN_F: 29, NIDORINO: 33, CLEFAIRY: 35, MEOWTH: 52, PSYDUCK: 54, POLIWRATH: 62,
  CUBONE: 104, MAROWAK: 105, EEVEE: 133, SNORLAX: 143,
});

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

/** A byte from the game's RNG (hRandomAdd); tests may set ctx.rng. */
export function randByte(ctx) {
  const rng = ctx.rng || (ctx.hooks && ctx.hooks.rng) || (ctx.ov && ctx.ov.game && ctx.ov.game.rng) || (ctx.ov && ctx.ov.rng);
  if (rng && typeof rng.randByte === 'function') return rng.randByte() & 0xff;
  return Math.floor(Math.random() * 256);
}

/**
 * The engine's wild-battle switch (BIT_NO_BATTLES in wStatusFlags4): the saved status bit, and the
 * overworld's own switch when there is one. `ctx.ov.noBattles` is also the test page's debug
 * toggle, so it is only turned off again when this function turned it on.
 */
const ownNoBattles = new WeakSet();
export function setNoBattles(ctx, on) {
  lib.setStatusFlag(ctx, 'BIT_NO_BATTLES', on);
  const ov = ctx.ov;
  if (!ov) return;
  if (on) {
    if (!ov.noBattles) { ov.noBattles = true; ownNoBattles.add(ov); }
  } else if (ownNoBattles.has(ov)) {
    ov.noBattles = false;
    ownNoBattles.delete(ov);
  }
}

/** w<Map> persistent script variables (GameState.scriptVars). */
export const scriptVars = (ctx) => ctx.state.scriptVars || (ctx.state.scriptVars = {});

// =========================================================================== Saffron gates

/** RemoveGuardDrink: the first of FRESH WATER / SODA POP / LEMONADE in the bag is taken. @returns {string|null} */
export function removeGuardDrink(ctx) {
  const list = getGameData().raw.items.guardDrinks;
  for (const item of list) {
    if (lib.hasItem(ctx, item)) {
      lib.takeItem(ctx, item, 1);
      return item;
    }
  }
  return null;
}

// =========================================================================== Pokémon Tower 7F

const DOWN5 = Object.freeze(['down', 'down', 'down', 'down', 'down']);
const DOWN6 = Object.freeze([...DOWN5, 'down']);

/**
 * PokemonTower7FNPCCoordMovementTable (map_coord_movement x, y, path): four entries per Rocket in
 * object order, keyed by where the PLAYER stood when the fight ended. Paths are the
 * PokemonTower7FRocket*Exit*Movement lists.
 */
export const TOWER7F_ROCKET_EXITS = Object.freeze([
  Object.freeze([
    Object.freeze({ x: 9, y: 12, path: Object.freeze(['right', ...DOWN5, 'left']) }), // Rocket1ExitRightDown
    Object.freeze({ x: 10, y: 11, path: Object.freeze(['down', 'right', 'down', 'down', 'down', 'down']) }), // Rocket1ExitDownRight
    Object.freeze({ x: 11, y: 11, path: DOWN5 }),
    Object.freeze({ x: 12, y: 11, path: DOWN5 }),
  ]),
  Object.freeze([
    Object.freeze({ x: 12, y: 10, path: Object.freeze(['left', ...DOWN6]) }), // Rocket2ExitLeftDown
    Object.freeze({ x: 11, y: 9, path: Object.freeze(['down', 'down', 'down', 'left', 'down', 'down']) }), // Rocket2ExitDownLeft
    Object.freeze({ x: 10, y: 9, path: DOWN5 }),
    Object.freeze({ x: 9, y: 9, path: DOWN5 }),
  ]),
  Object.freeze([
    Object.freeze({ x: 9, y: 8, path: Object.freeze(['right', ...DOWN6]) }), // Rocket3ExitRightDown
    Object.freeze({ x: 10, y: 7, path: DOWN5 }),
    Object.freeze({ x: 11, y: 7, path: DOWN5 }),
    Object.freeze({ x: 12, y: 7, path: DOWN5 }),
  ]),
]);

/**
 * PokemonTower7FRocketLeaveMovementScript: the table is searched from the Rocket's own four entries
 * (wSpriteIndex - 1, swap) on to its end for the player's (x, y); the asm would read on into the
 * movement data past the table when nothing matches (the Rockets only meet the player on a few
 * tiles), here the Rocket then simply walks down the five steps most entries use.
 * @param {number} rocket 1-3 (the object index = sprite index)
 * @returns {string[]} the Rocket's path
 */
export function towerRocketExit(rocket, x, y) {
  for (let r = rocket - 1; r < TOWER7F_ROCKET_EXITS.length; r++) {
    const hit = TOWER7F_ROCKET_EXITS[r].find((e) => e.x === x && e.y === y);
    if (hit) return [...hit.path];
  }
  return [...DOWN5];
}

// =========================================================================== Game Corner

/** BCD helpers on plain numbers: coins are a 2-byte BCD (max 9999), the Coin Case. */
export const MAX_COINS = 9999;

/** Has9990Coins: the case is full when it already holds 9990 coins or more (nc after the compare). */
export function coinCaseFull(ctx) {
  return (ctx.state.coins | 0) >= 9990;
}

/** AddBCD on wPlayerCoins: saturates at 9999. */
export function addCoins(ctx, n) {
  ctx.state.coins = Math.min(MAX_COINS, (ctx.state.coins | 0) + n);
  return ctx.state.coins;
}

/**
 * GameCornerSelectLuckySlotMachine: hRandomAdd < 7 becomes 8, then >> 3: 1 (twice as likely) to
 * 31, or 0 (no lucky machine). The machine with hidden-event index n - 1 is the lucky one.
 */
export function pickLuckySlot(rand) {
  const a = (rand & 0xff) < 7 ? 8 : rand & 0xff;
  return a >> 3;
}

/** PrintBCDNumber for a Game Corner box: no leading zeros, right aligned, ¥ before the first digit. */
export function bcdText(value, bytes, { money = false } = {}) {
  const digits = bytes * 2;
  const s = String(Math.max(0, Math.floor(Number(value) || 0)) % (10 ** digits)).padStart(digits, '0');
  let out = '';
  let started = false;
  for (const d of s) {
    if (!started && d === '0') { out += ' '; continue; }
    if (!started) { started = true; if (money) out += '¥'; }
    out += d;
  }
  if (!started) out = out.slice(0, -1) + (money ? '¥' : '') + '0';
  return out;
}

/**
 * GameCornerDrawCoinBox: the 9x7 box at (11,0) with MONEY / the money and COIN / the coins, drawn
 * on the overworld's UI layer (it stays until hideCoinBox, like the asm's box until the dialogue
 * closes). Without an overworld (tests) there is nothing to draw.
 */
export function drawCoinBox(ctx) {
  const ov = ctx.ov;
  if (!ov || !ov.ui || !ov.font) return;
  const font = ov.font;
  font.drawBox(ov.ui, 11, 0, 9, 7);
  font.putText(ov.ui, 'MONEY', 12, 2);
  font.putText(ov.ui, bcdText(ctx.state.money, 3, { money: true }), 12, 3);
  font.putText(ov.ui, 'COIN', 12, 4);
  font.putText(ov.ui, bcdText(ctx.state.coins, 2), 15, 5);
}

export function hideCoinBox(ctx) {
  const ov = ctx.ov;
  if (ov && ov.ui) ov.ui.clearRect(11, 0, 9, 7);
}

// =========================================================================== Cycling Road

/**
 * CheckForceBikeOrSurf for Route 16 / Route 18: arriving on one of the Cycling Road's entry
 * tiles (the gate's door tiles) puts the player on the bike and sets BIT_ALWAYS_ON_BIKE, which
 * the gate's map script clears again on the next visit inside. @returns {boolean} forced
 */
export function forceBikeAt(ctx, coords) {
  if (lib.statusFlag(ctx, 'BIT_ALWAYS_ON_BIKE')) return false;
  if (!coordIndex(ctx, coords)) return false;
  lib.setStatusFlag(ctx, 'BIT_ALWAYS_ON_BIKE', true);
  if (ctx.player.mode !== 'bike') {
    const ov = ctx.ov;
    if (ov && typeof ov.useBike === 'function') ov.useBike(); // wWalkBikeSurfState = 1: sprite + bike music
    else { ctx.state.bike = true; ctx.state.surfing = false; }
  }
  return true;
}

// =========================================================================== Name Rater

/**
 * NameRatersHouseCheckMonOTScript: is the mon's OT name and ID the player's? (A traded mon is
 * refused with the "impeccable name" text.)
 */
export function isOwnMon(ctx, mon) {
  const st = ctx.state;
  return !!mon && mon.otName === st.playerName && (mon.otId & 0xffff) === (st.playerId & 0xffff);
}

/**
 * DisplayNameRaterScreen: the naming screen for a party Pokémon, empty = cancelled.
 * @returns {string} the typed name, '' when the player left it empty (the asm's wStringBuffer == "@")
 */
export function* nameRaterScreen(ctx, partyIndex) {
  const mon = (ctx.state.party || [])[partyIndex];
  const hooks = ctx.hooks || {};
  if (!mon || typeof hooks.namingScreen !== 'function') {
    console.warn('[kanto4] nameRaterScreen: no hooks.namingScreen, nothing renamed');
    return '';
  }
  let r = hooks.namingScreen({ kind: 'nickname', speciesForIcon: lib.dexOf(mon.species), initial: '', fallback: '' });
  if (r && typeof r.next === 'function') r = yield* r;
  else if (r && typeof r.then === 'function') r = yield r;
  return typeof r === 'string' ? r : '';
}

// =========================================================================== Diploma

/**
 * DisplayDiploma (engine/events/diploma.asm) on the overworld's UI layer: white out, the page
 * ("Diploma", the player's name, "Congrats! This diploma certifies that you have completed your
 * #DEX.", GAME FREAK), wait for A / B, white out and back. The player's picture and the circle
 * tiles of the original are not drawn. hooks.diploma (a menus scene), when there is one, wins.
 */
export function* showDiploma(ctx) {
  const hooks = ctx.hooks || {};
  if (typeof hooks.diploma === 'function') {
    let r = hooks.diploma();
    if (r && typeof r.next === 'function') yield* r;
    else if (r && typeof r.then === 'function') yield r;
    return;
  }
  const ov = ctx.ov;
  if (!ov || !ov.ui || !ov.font) return;
  const { ui, font } = ov;
  ctx.closeText();
  yield ctx.fadeOut('white');
  yield ctx.wait(3);
  const saved = ui.save(0, 0, 20, 18);
  ui.fillRect(0, 0, 20, 18, font.space);
  font.drawBox(ui, 0, 0, 20, 18);
  font.putText(ui, 'Diploma', 6, 2);
  font.putText(ui, 'Player', 3, 4);
  font.putText(ui, ctx.state.playerName || '', 10, 4);
  font.putText(ui, 'Congrats! This', 2, 6, { lineStep: 2 });
  font.putText(ui, 'diploma certifies', 2, 8);
  font.putText(ui, 'that you have', 2, 10);
  font.putText(ui, 'completed your', 2, 12);
  font.putText(ui, '#DEX.', 2, 14);
  font.putText(ui, 'GAME FREAK', 9, 16);
  yield ctx.fadeIn('white');
  yield* ov.textBox.waitForButton(); // WaitForTextScrollButtonPress (the text box is not drawn)
  yield ctx.fadeOut('white');
  yield ctx.wait(3);
  ui.restore(saved);
  yield ctx.fadeIn('white');
}
