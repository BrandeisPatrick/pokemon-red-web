// Shared helpers for the story scripts (docs/scripting.md "lib.js contract"). Region files
// (src/game/scripts/regions/kantoN.js) call these from their map-script hooks; everything
// goes through the overworld `ctx` (src/overworld/scripts.js) and the game hooks
// (src/game/hooks.js, reachable as ctx.hooks), so the helpers also run on a fake ctx in
// node tests.
//
// Generators are yield*-able inside a map-script generator:
//   const outcome = yield* lib.scriptedBattle(ctx, { trainerClass: 'RIVAL1', partyIndex: 1 });
//   if (yield* lib.receiveItem(ctx, 'POTION')) ctx.setFlag('EVENT_GOT_POTION_SAMPLE');
//
// Text semantics: ctx.showText at the top level (onInteract / onFrame / onStep scripts) is
// DisplayTextID (waits for A/B at the end and closes); nested inside a displayed text (an
// onTextAsm handler) it is PrintText (prints into the same box, no wait). The helpers pick
// the right one for their intermediate texts; their last text uses the context default.

import { getGameData } from '../../pokemon/data.js';
import { healParty as healPartyMons } from '../../pokemon/party.js';

/** wObtainedBadges bit order (BIT_BOULDERBADGE = 0 ... BIT_EARTHBADGE = 7). */
export const BADGES = Object.freeze(['BOULDERBADGE', 'CASCADEBADGE', 'THUNDERBADGE', 'RAINBOWBADGE',
  'SOULBADGE', 'MARSHBADGE', 'VOLCANOBADGE', 'EARTHBADGE']);

/** Safari Zone (scripts/SafariZoneGate.asm): fee, balls and steps given at the gate. */
export const SAFARI_FEE = 500;
export const SAFARI_BALLS = 30;
export const SAFARI_STEPS = 502;

/** OaksAideScript results (hOaksAideResult). */
export const OAKS_AIDE = Object.freeze({ BAG_FULL: 0, GOT_ITEM: 1, NOT_ENOUGH_MONS: 0x80, REFUSED: 0xff });

/** Frames we wait at most for a sound promise (no audio, muted tab ...). */
const MAX_SOUND_WAIT = 600;

// =========================================================================== internals

const isThen = (v) => !!v && typeof v.then === 'function';
const isIter = (v) => !!v && typeof v.next === 'function';

function gd() {
  try { return getGameData(); } catch { return null; }
}

/** Item display name ('POTION' -> 'POTION', 'TM_FISSURE' -> 'TM27'). */
export function itemName(item) {
  const g = gd();
  const it = g && g.findItem ? g.findItem(item) : null;
  return it ? it.name : String(item);
}

/** Species display name for a dex number / const / name. */
export function speciesName(species) {
  const g = gd();
  const sp = g && g.findSpecies ? g.findSpecies(species) : null;
  return sp ? sp.name : String(species);
}

/** Dex number of a species ref (dex numbers pass through). */
export function dexOf(species) {
  if (typeof species === 'number') return species;
  const g = gd();
  const sp = g && g.findSpecies ? g.findSpecies(species) : null;
  if (!sp) throw new Error(`lib: unknown species ${species}`);
  return sp.dex;
}

/** Wait for a promise (sound end, menu scene) with a frame cap; returns its value. */
export function* waitFor(p, max = MAX_SOUND_WAIT) {
  if (!isThen(p)) return p;
  let done = false, value;
  p.then((v) => { done = true; value = v; }, () => { done = true; });
  let frames = 0;
  yield () => done || ++frames > max;
  return value;
}

/** Run whatever a hook returned (generator, promise or value) and return its result. */
function* settle(r) {
  if (isIter(r)) return yield* r;
  if (isThen(r)) return yield r;
  return r;
}

/** Is the caller running inside a displayed text (an onTextAsm handler)? */
export function inText(ctx) {
  if (typeof ctx.inText === 'boolean') return ctx.inText;
  return !!(ctx.ov && ctx.ov.textDepth > 0);
}

function statusFlags(ctx) {
  const s = ctx.state && ctx.state.statusFlags;
  return s && typeof s.get === 'function' ? s : null;
}

/** wStatusFlags* bit by name ('BIT_GOT_STARTER'); false when the state has none. */
export function statusFlag(ctx, name) {
  const s = statusFlags(ctx);
  try { return s ? s.get(name) : false; } catch { return false; }
}

export function setStatusFlag(ctx, name, value = true) {
  const s = statusFlags(ctx);
  if (s) s.set(name, value);
}

/** w<Map>CurScript of a map (default: the current one). */
export function getMapScript(ctx, map = ctx.map) {
  const st = ctx.state;
  if (typeof st.getMapScript === 'function') return st.getMapScript(map);
  return (st.currentMapScriptIndices && st.currentMapScriptIndices[map]) || 0;
}

export function setMapScript(ctx, index, map = ctx.map) {
  const st = ctx.state;
  if (typeof st.setMapScript === 'function') { st.setMapScript(map, index); return; }
  if (!st.currentMapScriptIndices) st.currentMapScriptIndices = {};
  st.currentMapScriptIndices[map] = index & 0xff;
}

/**
 * Run `genFn(ctx)` as a blocking script once the current script and its text box are
 * finished: what the asm gets by setting a script index / wCurOpponent in a text_asm and
 * letting the overworld loop act after DisplayTextID returned (gym leader battles, the
 * blackout after a lost scripted battle). From the moment it is scheduled the player cannot
 * move and no map script / trainer check runs (one reserved script slot + input lock);
 * NPC movement keeps working, so the current script can still finish its cutscene. Jobs run
 * one after another in scheduling order.
 * @returns {any} what ctx.defer returned on a test ctx, else undefined
 */
export function afterScript(ctx, genFn) {
  if (typeof ctx.defer === 'function') return ctx.defer(genFn);
  const ov = ctx.ov;
  if (!ov || typeof ov.run !== 'function') throw new Error('lib.afterScript: no overworld on this ctx');
  const q = ov.__afterScript || (ov.__afterScript = { jobs: [], running: false });
  q.jobs.push(genFn);
  if (q.running) return undefined;
  q.running = true;
  ov.scriptCount++;
  ov.inputLock++;
  ov.run(function* afterScriptRunner() {
    try {
      while (q.jobs.length) {
        yield () => ov.scriptCount <= 1 && ov.textDepth <= 0 && !ov.mapChanging;
        const job = q.jobs.shift();
        yield* job(ctx);
      }
    } finally {
      q.running = false;
      q.jobs.length = 0;
      ov.scriptCount = Math.max(0, ov.scriptCount - 1);
      ov.inputLock = Math.max(0, ov.inputLock - 1);
    }
  }());
  return undefined;
}

// =========================================================================== state helpers

export function hasBadge(ctx, name) {
  const st = ctx.state;
  if (typeof st.hasBadge === 'function') return st.hasBadge(name);
  const bit = BADGES.indexOf(name);
  if (bit < 0) throw new Error(`lib.hasBadge: unknown badge ${name}`);
  return ((st.badges | 0) & (1 << bit)) !== 0;
}

export function giveBadge(ctx, name) {
  const st = ctx.state;
  if (typeof st.giveBadge === 'function') { st.giveBadge(name); return; }
  const bit = BADGES.indexOf(name);
  if (bit < 0) throw new Error(`lib.giveBadge: unknown badge ${name}`);
  st.badges = (st.badges | 0) | (1 << bit);
}

export function badgeCount(ctx) {
  let n = 0;
  for (let b = ctx.state.badges | 0; b; b >>= 1) n += b & 1;
  return n;
}

export function partyCount(ctx) {
  return (ctx.state.party || []).length;
}

export function leadMon(ctx) {
  return (ctx.state.party || [])[0] || null;
}

/** Does any party mon know `move` (move const, e.g. 'CUT')? */
export function partyHasMove(ctx, move) {
  const g = gd();
  const want = g && g.findMove && g.findMove(move) ? g.findMove(move).const : move;
  return (ctx.state.party || []).some((m) => (m.moves || []).some((s) => s && s.move === want));
}

export function hasPokedex(ctx) {
  return !!ctx.getFlag('EVENT_GOT_POKEDEX');
}

export function dexOwnedCount(ctx) {
  const d = ctx.state.pokedex;
  return d ? d.ownedCount : 0;
}

export function dexSeenCount(ctx) {
  const d = ctx.state.pokedex;
  return d ? d.seenCount : 0;
}

/** IsItemInBag. */
export function hasItem(ctx, item, qty = 1) {
  const bag = ctx.state.bag;
  if (bag && typeof bag.has === 'function') return bag.has(item, qty);
  return !!ctx.hasItem(item);
}

/** RemoveItemFromInventory: @returns {boolean} false if there were fewer than `qty` */
export function takeItem(ctx, item, qty = 1) {
  const bag = ctx.state.bag;
  if (!bag || typeof bag.remove !== 'function') return false;
  return bag.remove(item, qty);
}

export function money(ctx) {
  return ctx.state.money | 0;
}

/** AddAmountSoldToMoney: capped at ¥999999. */
export function addMoney(ctx, n) {
  ctx.state.money = Math.min(999999, (ctx.state.money | 0) + Math.max(0, n | 0));
  return ctx.state.money;
}

/** HasEnoughMoney + SubBCD: @returns {boolean} false (nothing taken) when too poor */
export function takeMoney(ctx, n) {
  const have = ctx.state.money | 0;
  if (have < n) return false;
  ctx.state.money = have - n;
  return true;
}

// =========================================================================== text & sound

/** showText + wait for A/B + close (DisplayTextID semantics wherever it is called). */
export function* showTextAndWait(ctx, label, opts = {}) {
  yield ctx.showText(label, { ...opts, wait: true, close: true });
}

/** Play a jingle and wait for it (the music resumes by itself, like the GB's SFX channels). */
export function* fanfare(ctx, sfxName) {
  const r = ctx.playSfx(sfxName);
  if (isThen(r)) yield* waitFor(r);
}

/** The song PlayDefaultMusic picks right now: bike / surf / the map's. */
export function defaultMusic(ctx) {
  const p = ctx.player || {};
  if (p.mode === 'surf') return 'MUSIC_SURFING';
  if (p.mode === 'bike') return 'MUSIC_BIKE_RIDING';
  return (ctx.mapData && ctx.mapData.music) || null;
}

/** PlayDefaultMusic: restore the map's song (or the bike / surf music). */
export function* playMapMusic(ctx) {
  const m = defaultMusic(ctx);
  if (m) ctx.playMusic(m);
}

/** "<PLAYER> received <item>!" + jingle (most gift texts in text/*.asm have this shape). */
export function receivedText(item, sound = 'sound_get_item_1') {
  return [
    { cmd: 'text', str: '{PLAYER} received' },
    { cmd: 'line', str: `${itemName(item)}!` },
    { cmd: 'sound', sound },
    { cmd: 'text_end' },
  ];
}

const NO_ROOM_TEXT = [{ cmd: 'text_far', label: '_NoMoreRoomForItemText' }, { cmd: 'text_end' }];

// =========================================================================== items

/**
 * GiveItem + the "received" text. @returns {boolean} false = no room (the no-room text was
 * shown). Options: text (label / commands shown instead of the default "received" text),
 * noRoomText, sound (default text's jingle), subs.
 */
export function* receiveItem(ctx, item, qty = 1, { text, noRoomText, sound = 'sound_get_item_1', subs } = {}) {
  let ok = ctx.giveItem(item, qty);
  if (isThen(ok)) ok = yield ok;
  const s = { wStringBuffer: itemName(item), ...(subs || {}) };
  if (!ok) {
    yield ctx.showText(noRoomText || NO_ROOM_TEXT, { subs: s });
    return false;
  }
  yield ctx.showText(text || receivedText(item, sound), { subs: s });
  return true;
}

/** receiveItem with SFX_GET_KEY_ITEM. */
export function* receiveKeyItem(ctx, item, opts = {}) {
  return yield* receiveItem(ctx, item, 1, { sound: 'sound_get_key_item', ...opts });
}

// =========================================================================== Pokémon

/**
 * _GivePokemon (engine/events/give_pokemon.asm): "<PLAYER> got X!" (SFX_GET_ITEM_1), into
 * the party, or the current box with "There's no more room for POKéMON! X was sent to
 * POKéMON BOX n on PC!", or nothing ("...The POKéMON BOX is full...") -> false.
 * askNickname runs AskName (YES/NO + naming screen) for the new mon, as AddPartyMon /
 * SendNewMonToBox do. `text` replaces the "got X!" text (e.g. the starter's
 * OaksLabReceivedMonText); `nickname` sets one without asking.
 * @returns {boolean} received
 */
export function* receivePokemon(ctx, { dex, species, level, nickname, askNickname = false, text } = {}) {
  const d = dexOf(dex ?? species);
  const name = speciesName(d);
  const hooks = ctx.hooks || {};
  let res;
  if (typeof hooks.addPokemon === 'function') {
    res = hooks.addPokemon(d, level, { nickname });
    if (isThen(res)) res = yield res;
  } else {
    let ok = ctx.givePokemon(d, level);
    if (isThen(ok)) ok = yield ok;
    res = ok ? { ok: true, where: 'party', mon: null } : { ok: false, reason: 'boxFull' };
  }
  if (!res || !res.ok) {
    yield ctx.showText('_BoxIsFullText');
    return false;
  }
  const subs = { wNameBuffer: name };
  // SetPokedexOwnedFlag: GotMonText (text_end: no wait; the next text replaces it)
  yield ctx.showText(text || [{ cmd: 'text_far', label: '_GotMonText' }, { cmd: 'sound', sound: 'sound_get_item_1' }, { cmd: 'text_end' }],
    askNickname || res.where === 'box' ? { subs, wait: false, close: false } : { subs });
  if (askNickname) {
    const nick = yield* askName(ctx, d, res);
    if (nick && res.mon) res.mon.nickname = nick;
  }
  if (res.where === 'box') {
    const nick = res.mon ? res.mon.nickname : name;
    yield ctx.showText('_SentToBoxText', { subs: { wBoxMonNicks: nick, wStringBuffer: String(res.boxNumber ?? '') } });
  }
  return true;
}

/**
 * AskName (engine/menus/naming_screen.asm): "Do you want to give a nickname to X?" YES/NO,
 * YES -> the naming screen. @returns {string|null} the nickname, null if declined / empty
 */
export function* askName(ctx, species, info = {}) {
  const name = speciesName(species);
  yield ctx.showText([{ cmd: 'text_far', label: '_DoYouWantToNicknameText' }, { cmd: 'text_end' }],
    { subs: { wNameBuffer: name }, wait: false, close: false });
  const yes = yield ctx.yesNo();
  if (!yes) return null;
  const nick = yield* namingScreen(ctx, { kind: 'nickname', species, monIndex: info.partyIndex, initial: '' });
  return nick && nick !== name ? nick : null;
}

/**
 * The naming screen (intro's namingScreen through ctx.hooks.namingScreen).
 * kind: 'nickname' (monIndex = party index or species: the icon / fallback name), 'player',
 * 'rival'. @returns {string}
 */
export function* namingScreen(ctx, { kind = 'nickname', monIndex, species, initial } = {}) {
  const party = ctx.state.party || [];
  const mon = monIndex != null ? party[monIndex] : null;
  const sp = species ?? (mon ? mon.species : null);
  const fallback = kind === 'nickname' ? (mon ? mon.nickname : sp != null ? speciesName(sp) : '') : undefined;
  const hooks = ctx.hooks || {};
  if (typeof hooks.namingScreen !== 'function') {
    console.warn('[lib] namingScreen: no hooks.namingScreen, keeping the default name');
    return fallback ?? initial ?? '';
  }
  const r = yield* settle(hooks.namingScreen({ kind, speciesForIcon: sp != null ? dexOf(sp) : undefined, initial, fallback }));
  return typeof r === 'string' ? r : fallback ?? '';
}

/**
 * The party menu to pick a mon (Daycare, Name Rater, fossils...).
 * @returns {number} party index, -1 on B
 */
export function* choosePartyMon(ctx, { prompt, mode } = {}) {
  const hooks = ctx.hooks || {};
  if (typeof hooks.partyMenu !== 'function') {
    console.warn('[lib] choosePartyMon: no hooks.partyMenu');
    return -1;
  }
  const r = yield* settle(hooks.partyMenu({ prompt, mode }));
  return Number.isInteger(r) ? r : -1;
}

/** An in-game trade (DoInGameTradeDialogue, the whole dialogue). @returns {boolean} traded */
export function* npcTrade(ctx, tradeId) {
  const hooks = ctx.hooks || {};
  if (typeof hooks.tradeScene !== 'function') {
    console.warn('[lib] npcTrade: no hooks.tradeScene');
    return false;
  }
  const r = yield* settle(hooks.tradeScene(tradeId));
  return !!(r && r.traded);
}

/** HealParty without the nurse (Mom, the Silph Co. bed...). */
export function* healParty(ctx) {
  const hooks = ctx.hooks || {};
  if (typeof hooks.healParty === 'function') {
    yield* settle(hooks.healParty());
    return;
  }
  healPartyMons(ctx.state.party || []);
}

// =========================================================================== battles

/** 'win' | 'lose' | 'ran' | 'caught' | 'forfeit' from a battle hook result. */
export function battleOutcome(r) {
  const o = r && typeof r === 'object' ? r.outcome : r;
  if (o === 'blackout' || o === 'lose' || o === 'lost') return 'lose';
  if (o === 'run' || o === 'ran' || o === 'escaped') return 'ran';
  if (o === 'caught' || o === 'forfeit' || o === 'win') return o;
  return o == null ? 'win' : String(o);
}

/**
 * A battle started by a script (rival fights, Giovanni, legendaries, Snorlax, the ghost
 * Marowak, the Old Man demo). kind: 'trainer' | 'wild' | 'ghost' | 'oldman' | 'safari'.
 * trainerClass: 'RIVAL1' or 'OPP_RIVAL1'; partyIndex: 1-based party number; species (dex,
 * const or name) + level for the others. winText / loseText: the end-battle texts
 * (SaveEndBattleTextPointers: printed by the battle after a win / a loss). music overrides
 * the battle music; gymLeader = wGymLeaderNo (gym music + badge victory music).
 * On 'lose' with canLose = false the blackout runs after the calling script returns (the
 * asm's RunMapScript -> HandleBlackOut), so write the lose branch first, then return.
 * @returns {'win'|'lose'|'ran'|'caught'|'forfeit'}
 */
export function* scriptedBattle(ctx, {
  kind = 'trainer', trainerClass, partyIndex, name, species, level, music, canLose = false,
  winText, loseText, gymLeader = 0, objectIndex = null, ...extra
} = {}) {
  const bare = trainerClass ? String(trainerClass).replace(/^OPP_/, '') : null;
  const battle = {
    kind: kind === 'trainer' || bare ? 'trainer' : kind,
    trainerClass: bare, partyIndex, trainerName: name, music, canLose, winText, loseText,
    gymLeader, ...extra,
  };
  let opts;
  if (battle.kind === 'trainer') {
    if (!bare || !partyIndex) throw new Error('lib.scriptedBattle: trainerClass and partyIndex are needed');
    opts = {
      trainerClass: `OPP_${bare}`, partyIndex, objectIndex,
      texts: { end: winText || null, lose: loseText || null },
      scripted: true, canLose, battle,
    };
  } else {
    const dex = dexOf(species);
    battle.species = dex;
    battle.level = level;
    opts = { species: dex, level, scripted: true, canLose, battleKind: battle.kind, battle };
  }
  const hooks = ctx.hooks || null;
  if (hooks) hooks.pendingBattle = battle;
  let r;
  try {
    r = yield ctx.startBattle(opts);
  } finally {
    if (hooks && hooks.pendingBattle === battle) hooks.pendingBattle = null;
  }
  const outcome = battleOutcome(r);
  if (outcome === 'lose' && !canLose) {
    // hooks.onBlackout already turned the screen black on the overworld
    afterScript(ctx, (c) => blackout(c, { fadedOut: !!(c.ov && c.ov.paletteHeld) }));
  }
  return outcome;
}

/**
 * HandleBlackOut (home/overworld.asm) + ResetStatusAndHalveMoneyOnBlackout
 * (engine/events/black_out.asm): fade to black, the music fades out, money halved, walking,
 * party healed, then the special warp to wLastBlackoutMap's fly spot (in front of the last
 * Pokémon Center used) with EnterMapAnim's fade in from white. The "blacked out!" text is
 * printed before by the battle or the poison step. `fadedOut`: the screen is black already
 * (after a lost battle).
 */
export function* blackout(ctx, { fadedOut = false } = {}) {
  const st = ctx.state;
  const audio = ctx.hooks && ctx.hooks.audio;
  if (!fadedOut) yield ctx.fadeOut('black');
  if (audio && typeof audio.fadeOutMusic === 'function') audio.fadeOutMusic(8);
  else if (audio && typeof audio.stopMusic === 'function') audio.stopMusic();
  st.money = Math.floor((st.money | 0) / 2);
  st.bike = false;
  st.surfing = false;
  st.mapPalOffset = 0;
  setStatusFlag(ctx, 'BIT_ALWAYS_ON_BIKE', false);
  yield* healParty(ctx);
  const dest = flyWarpFor(st.lastBlackoutMap || 'PALLET_TOWN');
  const ov = ctx.ov;
  if (ov && typeof ov.teleportGen === 'function' && ov.palette) {
    // SpecialEnterMap -> EnterMapAnim: the map appears through GBFadeInFromWhite
    ov.currentMusic = null; // PlayDefaultMusicFadeOutCurrent always starts the map's song
    yield* ov.teleportGen(dest.name, dest.x, dest.y, { facing: 'down', fade: 'none' });
    ov.palette.whiteOut();
    ov.paletteHeld = true;
    yield ctx.fadeIn('white');
  } else {
    yield ctx.teleport(dest.name, dest.x, dest.y, { facing: 'down', fade: 'white' });
  }
}

/** FlyWarpDataPtr entry of a town / route const (or name): {map, name, x, y}. */
export function flyWarpFor(map) {
  const g = gd();
  const entry = g && g.findMap ? g.findMap(map) : null;
  const c = entry ? entry.const : String(map);
  const list = (g && g.mapsMeta && g.mapsMeta.flyWarps) || [];
  const w = list.find((f) => f.map === c) || list[0] || { map: 'PALLET_TOWN', x: 5, y: 6 };
  const m = g && g.findMap ? g.findMap(w.map) : null;
  return { map: w.map, name: m ? m.name : 'PalletTown', x: w.x, y: w.y };
}

/**
 * A gym leader (scripts/PewterGym.asm ... ViridianGym.asm pattern). First talk: textBefore,
 * the battle (winText = the "received the XBADGE!" end-battle text with its jingle), then
 * textBadge (the badge info / "Wait! Take this with you!"), badgeFlag (EVENT_BEAT_*), the TM
 * (textTm, or textNoRoom with a full bag: the TM is offered again on the next talk), tmFlag,
 * the badge bit, trainerFlags (the gym trainers that give up), then onVictory(ctx) for the
 * map's extras. Later talks: the TM again until it was taken, then textAfter.
 * Called from onTextAsm (inside the leader's text), the battle starts after the text box
 * closed, like the asm (EngageMapTrainer + the post-battle map script).
 * @returns {string} the battle outcome, 'tm' (TM offered again), 'after' (post-battle
 *   text) or 'scheduled' (battle queued after the current text)
 */
export function* gymLeader(ctx, o) {
  const {
    trainerClass, partyIndex, badge, badgeFlag, tmFlag, textBefore, textWin, textAfter,
  } = o;
  if (badgeFlag && ctx.getFlag(badgeFlag)) {
    if (o.tm && tmFlag && !ctx.getFlag(tmFlag)) {
      yield* gymLeaderRewards(ctx, o);
      return 'tm';
    }
    if (textAfter) yield ctx.showText(textAfter);
    return 'after';
  }
  if (textBefore) yield ctx.showText(textBefore);
  const fight = function* gymLeaderFight() {
    const outcome = yield* scriptedBattle(ctx, {
      kind: 'trainer', trainerClass, partyIndex, winText: textWin, gymLeader: o.gymLeaderNo || BADGES.indexOf(badge) + 1 || 1,
      objectIndex: o.objectIndex ?? null, music: o.music,
    });
    if (outcome !== 'win') return outcome;
    yield* gymLeaderRewards(ctx, o);
    return outcome;
  };
  if (inText(ctx)) {
    afterScript(ctx, () => fight());
    return 'scheduled';
  }
  return yield* fight();
}

/** The post-battle part of a gym leader (PewterGymScriptReceiveTM34 & co). */
function* gymLeaderRewards(ctx, o) {
  if (o.textBadge) yield ctx.showText(o.textBadge, inText(ctx) ? {} : { wait: true, close: true });
  if (o.badgeFlag) ctx.setFlag(o.badgeFlag);
  if (o.tm) {
    let ok = ctx.giveItem(o.tm, 1);
    if (isThen(ok)) ok = yield ok;
    if (ok) {
      yield ctx.showText(o.textTm || receivedText(o.tm), { subs: { wStringBuffer: itemName(o.tm) } });
      if (o.tmFlag) ctx.setFlag(o.tmFlag);
    } else {
      yield ctx.showText(o.textNoRoom || NO_ROOM_TEXT);
    }
  }
  if (o.badge) giveBadge(ctx, o.badge);
  for (const f of o.trainerFlags || []) ctx.setFlag(f);
  if (typeof o.onVictory === 'function') yield* settle(o.onVictory(ctx));
}

// =========================================================================== map mechanics

/**
 * Warp with a fade (cutscenes): warpIndexOrPos = 0-based warp index of `map`, or {x, y}.
 */
export function* cutsceneWarp(ctx, map, warpIndexOrPos, { facing } = {}) {
  if (typeof warpIndexOrPos === 'number') {
    yield ctx.warp(map, warpIndexOrPos, { facing, sound: false });
    return;
  }
  const p = warpIndexOrPos || {};
  yield ctx.teleport(map, p.x, p.y, { facing, fade: 'black' });
}

/** Forced movement (Seafoam currents, Cycling Road style): simulated joypad steps. */
export function* forcedMovement(ctx, path) {
  yield ctx.movePlayer(path);
}

/**
 * An elevator's floor menu (engine/events/elevator.asm DisplayElevatorFloorMenu): "Which
 * floor do you want?", the list (B / CANCEL -> -1). A chosen floor rewrites the elevator's
 * exit warps to {map, warpIndex} (0-based warp of the destination map) and shakes the
 * elevator (ShakeElevator: 100 × SFX_COLLISION every 2 frames, then SFX_SAFARI_ZONE_PA,
 * then the map music). floors: [{label: '1F', map: 'CeladonMart1F', warpIndex: 5}].
 * @returns {number} the chosen index or -1
 */
export function* elevatorMenu(ctx, floors, currentIndex = 0) {
  const hooks = ctx.hooks || {};
  const labels = floors.map((f) => f.label || String(f.floor || '').replace(/^FLOOR_/, ''));
  let index;
  if (typeof hooks.listMenu === 'function') {
    const r = yield* settle(hooks.listMenu({ prompt: '_WhichFloorText', entries: labels, initial: currentIndex }));
    index = Number.isInteger(r) ? r : -1;
  } else {
    yield ctx.showText([{ cmd: 'text_far', label: '_WhichFloorText' }, { cmd: 'text_end' }], { wait: false, close: false });
    index = yield ctx.menu([...labels, 'CANCEL'], { x: 4, y: 2, width: 16, top: 2, spacing: 2 });
    if (index >= labels.length) index = -1;
    ctx.closeText();
  }
  if (index < 0) return -1;
  const f = floors[index];
  setElevatorDestination(ctx, f.map, f.warpIndex);
  yield* shakeElevator(ctx);
  return index;
}

/** Point every exit warp of the current (elevator) map at warp `warpIndex` of `map`. */
export function setElevatorDestination(ctx, map, warpIndex) {
  const g = gd();
  const m = g && g.findMap ? g.findMap(map) : null;
  const dest = m ? { destMap: m.const, destMapId: m.id, destMapName: m.name } : { destMap: map, destMapId: null, destMapName: map };
  for (const w of (ctx.mapData && ctx.mapData.warps) || []) {
    Object.assign(w, dest, { destWarp: warpIndex + 1, destWarpIndex: warpIndex });
  }
  const st = ctx.state;
  if (st && typeof st === 'object') {
    if (!st.scriptVars || typeof st.scriptVars !== 'object') st.scriptVars = {};
    st.scriptVars.elevators = { ...(st.scriptVars.elevators || {}), [ctx.map]: { map: dest.destMapName, warpIndex } };
  }
}

/** ShakeElevator (sound part; the screen shake is not drawn). */
export function* shakeElevator(ctx) {
  const audio = ctx.hooks && ctx.hooks.audio;
  if (audio && typeof audio.stopMusic === 'function') audio.stopMusic();
  yield ctx.wait(3);
  for (let i = 0; i < 100; i++) {
    ctx.playSfx('SFX_COLLISION');
    yield ctx.wait(2);
  }
  if (audio && typeof audio.stopMusic === 'function') audio.stopMusic();
  yield* fanfare(ctx, 'SFX_SAFARI_ZONE_PA');
  yield* playMapMusic(ctx);
}

/**
 * Safari Zone entry (SafariZoneGateSafariZoneWorker1WouldYouLikeToJoinText after YES): pays
 * ¥500, 30 SAFARI BALLs, 502 steps, EVENT_IN_SAFARI_ZONE set, EVENT_SAFARI_GAME_OVER reset.
 * The texts, the MONEY box (lib.showMoneyBox) and the walk are the gate script's job; the
 * step countdown, "Time's up" and the warp back are done by hooks.onStep.
 * @returns {boolean} false (nothing changed) when the player has less than ¥500
 */
export function* safariEnter(ctx) {
  if (!takeMoney(ctx, SAFARI_FEE)) return false;
  const st = ctx.state;
  st.safari = { ...(st.safari || {}), steps: SAFARI_STEPS, balls: SAFARI_BALLS, gameOver: false };
  ctx.setFlag('EVENT_IN_SAFARI_ZONE');
  ctx.clearFlag('EVENT_SAFARI_GAME_OVER');
  return true;
}

/** Leaving the Safari Zone (gate / game over cleanup): flags, balls and steps reset. */
export function* safariExit(ctx) {
  const st = ctx.state;
  ctx.clearFlag('EVENT_IN_SAFARI_ZONE');
  ctx.clearFlag('EVENT_SAFARI_GAME_OVER');
  st.safari = { ...(st.safari || {}), steps: 0, balls: 0, gameOver: false };
}

/**
 * DisplayTextBoxID MONEY_BOX: the 9×3 box at (11,0) with "MONEY" and ¥ amount, drawn over
 * the map until the next text closes it (or lib.hideMoneyBox).
 */
export function showMoneyBox(ctx) {
  const ov = ctx.ov;
  if (!ov || !ov.ui || !ov.font) return;
  const font = ov.font;
  font.drawBox(ov.ui, 11, 0, 9, 3);
  font.putText(ov.ui, 'MONEY', 13, 0);
  const amount = String(Math.min(999999, ctx.state.money | 0));
  font.putText(ov.ui, `¥${amount}`.padStart(7, ' '), 12, 1);
}

export function hideMoneyBox(ctx) {
  const ov = ctx.ov;
  if (ov && ov.ui) ov.ui.clearRect(11, 0, 9, 3);
}

/**
 * OaksAideScript (engine/events/oaks_aide.asm): "Hi! Remember me? ... If you caught N kinds
 * of POKéMON, I'm supposed to give you an X!" YES/NO, then the owned-count check and the
 * item. Route 2 / 11 / 15 gates. @returns {number} OAKS_AIDE.*
 */
export function* oaksAide(ctx, { requirement, item }) {
  const subs = { hOaksAideRequirement: requirement, wOaksAideRewardItemName: itemName(item) };
  yield ctx.showText('_OaksAideHiText', { subs, wait: false, close: false });
  const yes = yield ctx.yesNo();
  if (!yes) {
    yield ctx.showText('_OaksAideComeBackText', { subs, wait: false, close: false });
    return OAKS_AIDE.REFUSED;
  }
  const owned = dexOwnedCount(ctx);
  subs.hOaksAideNumMonsOwned = owned;
  if (owned < requirement) {
    yield ctx.showText('_OaksAideUhOhText', { subs, wait: false, close: false });
    return OAKS_AIDE.NOT_ENOUGH_MONS;
  }
  yield ctx.showText('_OaksAideHereYouGoText', { subs, wait: false, close: false });
  let ok = ctx.giveItem(item, 1);
  if (isThen(ok)) ok = yield ok;
  if (!ok) {
    yield ctx.showText('_OaksAideNoRoomText', { subs, wait: false, close: false });
    return OAKS_AIDE.BAG_FULL;
  }
  yield ctx.showText([{ cmd: 'text_far', label: '_OaksAideGotItemText' }, { cmd: 'sound', sound: 'sound_get_item_1' }, { cmd: 'text_end' }],
    { subs, wait: false, close: false });
  return OAKS_AIDE.GOT_ITEM;
}

/** The Pokédex entry page of a species (Oak's lab StarterDex, the museum ...). */
export function* pokedexPage(ctx, species, { forceOwned = false } = {}) {
  const hooks = ctx.hooks || {};
  if (typeof hooks.pokedexPage !== 'function') return;
  yield* settle(hooks.pokedexPage(dexOf(species), { forceOwned }));
}
