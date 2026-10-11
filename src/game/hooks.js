// createHooks(game): the overworld's game hooks (docs/overworld.md "Game hooks") for the real
// game - battles (src/battle), menus (src/menus), items / party / Pokédex (GameState),
// audio, the blackout, the START menu and its field moves / items, the per-step logic
// (poison, Safari Zone) and the map-change bookkeeping (music, Fly towns, palettes,
// elevators). The story scripts reach everything through these hooks (ctx.hooks), never by
// importing src/battle or src/menus themselves. See docs/story.md.
//
//   const hooks = createHooks(game, { data });          // data = the OverworldData
//   game.hooks = hooks;
//   new OverworldScene({ data, state: game.state, hooks });
//
// src/battle and src/menus are loaded with dynamic imports when the hooks are created; a
// module that is missing (or fails to load) degrades to the overworld's built-in default
// with one console.warn, so the game stays playable while those areas are being written.

import { getGameData } from '../pokemon/data.js';
import { makeMon } from '../pokemon/mon.js';
import { giveMon, healParty as healPartyMons } from '../pokemon/party.js';
import { addCoins, hasRoomForCoins } from '../pokemon/bag.js';
import { poisonStep, safariStep } from '../pokemon/status.js';
import { fish } from '../pokemon/items_effects.js';
import { defaultWildBattleGen, defaultTrainerBattleGen, canCut, doCut } from '../overworld/interact.js';
import { canStartSurf, isPairBlocked, isWalkable } from '../overworld/collision.js';
import { MODE } from '../overworld/constants.js';
import { namingScreen as introNamingScreen } from '../intro/naming.js';
import * as lib from './scripts/lib.js';

/** Module paths (relative to this file) of the systems wired in at run time. */
export const BATTLE_MODULE = '../battle/index.js';
export const MENUS_MODULE = '../menus/index.js';

const isThen = (v) => !!v && typeof v.then === 'function';
const isIter = (v) => !!v && typeof v.next === 'function';
const RIVAL_CLASSES = ['RIVAL1', 'RIVAL2', 'RIVAL3'];
const FADE_MAP = 10;      // PlayDefaultMusicFadeOutCurrent on a map change
const FADE_BATTLE = 8;    // map music back after a battle
/** Tile ids of IsNextTileShoreOrWater (engine/items/item_effects.asm). */
const WATER_TILE = 0x14, SHORE_TILE = 0x32, SAFARI_SHORE_TILE = 0x48;

function* settle(r) {
  if (isIter(r)) return yield* r;
  if (isThen(r)) return yield r;
  return r;
}

/** A promise that never rejects: resolves with the module or null. */
function tryImport(path) {
  return import(path).then((m) => m, (err) => ({ __error: err }));
}

// =========================================================================== audio

/**
 * hooks.audio: the overworld's playMusic / playSfx in front of the src/audio facade
 * (game.audio). Map songs requested by the engine while it enters a map get the game's
 * map-change behaviour (onMapChange marks them): fade the old song out (speed 10), keep a
 * song that is already playing, nothing at all while BIT_NO_MAP_MUSIC is set. Songs
 * requested by scripts (ctx.playMusic) always (re)start at once, like PlayMusic.
 */
export function createAudioAdapter(game) {
  let current = null;
  let pending = null;
  const real = () => game.audio || null;
  const noMapMusic = () => {
    try { return !!(game.state && game.state.statusFlags && game.state.statusFlags.get('BIT_NO_MAP_MUSIC')); } catch { return false; }
  };
  const start = (name, fade) => {
    current = name;
    const a = real();
    if (!a || typeof a.playMusic !== 'function') return undefined;
    try { return a.playMusic(name, fade ? { fade } : undefined); } catch (err) { console.warn('[hooks] playMusic', name, err); return undefined; }
  };
  const flush = (req) => {
    if (pending !== req) return;
    pending = null;
    if (req.mapChange) {
      if (noMapMusic()) return;
      if (req.name === current) return;
    }
    start(req.name, req.fade);
  };
  const call = (fn, ...args) => {
    const a = real();
    if (!a || typeof a[fn] !== 'function') return undefined;
    try { return a[fn](...args); } catch (err) { console.warn(`[hooks] audio.${fn}`, err); return undefined; }
  };
  return {
    /** Request a song (deferred to the end of the current task so onMapChange can mark it). */
    playMusic(name, opts = {}) {
      if (!name) return undefined;
      const req = { name, fade: opts.fade || 0, mapChange: false };
      pending = req;
      queueMicrotask(() => flush(req));
      return undefined;
    },
    /** Start a song right now (no map-change rules). */
    playNow(name, opts = {}) { pending = null; return start(name, opts.fade || 0); },
    /** onMapChange: the song the engine just asked for is the map's (PlayDefaultMusicFadeOutCurrent). */
    markMapChange(fade = FADE_MAP) {
      if (pending) { pending.mapChange = true; pending.fade = fade; }
    },
    /** Someone else (battle, menus) played music: the next map song must start. */
    forget() { current = null; },
    get current() { return current; },
    playSfx: (name, opts) => call('playSfx', name, opts),
    playCry: (dex) => call('playCry', dex),
    stopMusic() { pending = null; current = null; return call('stopMusic'); },
    fadeOutMusic(frames = 10) { pending = null; current = null; return call('fadeOutMusic', frames); },
    waitForSfx: () => call('waitForSfx'),
    duck: (on) => call('duck', on),
    setLowHealthAlarm: (on) => call('setLowHealthAlarm', on),
  };
}

// =========================================================================== hooks

/**
 * @param {any} game engine services + game.state (GameState), game.audio (createAudio()),
 *   game.scenes, game.palette, game.rng
 * @param {object} [o]
 * @param {any} [o.data] the OverworldData (map JSON for warps / elevators)
 * @param {boolean} [o.loadModules=true] import src/battle and src/menus now
 * @param {object|null} [o.battle] inject the battle module (null = none; tests)
 * @param {object|null} [o.menus] inject the menus module (null = none; tests)
 * @returns {object} the hooks object
 */
export function createHooks(game, { data = null, loadModules = true, battle, menus } = {}) {
  const audio = createAudioAdapter(game);
  const warned = new Set();
  const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); console.warn(msg); } };
  const gd = () => getGameData();
  const st = () => game.state;

  // ---------------------------------------------------------------- optional systems
  const systems = { battle: undefined, menus: undefined, menusFormat: undefined };
  const loading = {};
  function loadSystem(key, path, check) {
    if (!loading[key]) {
      loading[key] = tryImport(new URL(path, import.meta.url).href).then((m) => {
        if (m.__error || !check(m)) {
          systems[key] = null;
          const why = m.__error ? (m.__error.message || m.__error) : 'entry point missing';
          console.warn(`[hooks] ${path} not available (${why}); using the overworld defaults`);
        } else {
          systems[key] = m;
        }
        return systems[key];
      });
    }
    return loading[key];
  }
  if (battle !== undefined) { systems.battle = battle; loading.battle = Promise.resolve(battle); }
  if (menus !== undefined) { systems.menus = menus; loading.menus = Promise.resolve(menus); }
  const loadBattle = () => loadSystem('battle', BATTLE_MODULE, (m) => typeof m.startBattle === 'function');
  const loadMenus = () => loadSystem('menus', MENUS_MODULE, (m) => typeof m.startMenu === 'function');
  const loadMenusFormat = () => loadSystem('menusFormat', '../menus/format.js', (m) => typeof m.printBCD === 'function');
  if (loadModules) { loadBattle(); loadMenus(); }
  // game.hooks.evolve (the menus' Rare Candy / stone evolutions): src/battle's evolution
  // movie (evolveHook(game) of src/battle/evolution_scene.js), else the menus' stand-in
  Promise.resolve(loading.battle).then((m) => {
    if (!m || hooks.evolve) return;
    if (typeof m.evolveHook === 'function') hooks.evolve = m.evolveHook(game);
  });
  // game.menus.* (installMenus of docs/menus.md): the same entry points bound to game, for
  // window.game.menus while debugging and for scripts that want a menu scene directly
  Promise.resolve(loading.menus).then((m) => {
    if (m && !game.menus && typeof m.installMenus === 'function') m.installMenus(game);
  });

  /** Run a menus entry point (returns its result, or `fallback` when menus are missing / fail). */
  function* withMenus(fn, fallback = null) {
    const m = systems.menus !== undefined ? systems.menus : yield loadMenus();
    if (!m) return fallback;
    const pal = snapshotPalette();
    try {
      return yield Promise.resolve().then(() => fn(m)).catch((err) => {
        console.error('[hooks] menu scene failed:', err);
        return fallback;
      });
    } finally {
      restorePalette(pal);
    }
  }

  // ---------------------------------------------------------------- palette hand-off
  function snapshotPalette() {
    const p = game.palette;
    if (!p) return null;
    return { colors: p.colors && p.colors.map((c) => c.slice()), obj0: p.obj0Colors, obj1: p.obj1Colors };
  }
  function restorePalette(s) {
    const p = game.palette;
    if (!p || !s) return;
    if (s.colors) p.setColors(s.colors);
    p.setObjColors(0, s.obj0 || null);
    p.setObjColors(1, s.obj1 || null);
  }

  // ---------------------------------------------------------------- helpers
  const mapConstOf = (ctx) => (ctx && ctx.mapData && ctx.mapData.const) || (st().pos && st().pos.map) || null;

  function rawText(ctx, label) {
    if (!label) return null;
    if (Array.isArray(label)) return label;
    const ov = ctx && ctx.ov;
    const own = ov && ov.map && ov.map.text && ov.map.text.texts[label];
    const common = ov && ov.data && ov.data.commonText && ov.data.commonText.texts[label];
    const t = own || common;
    return t ? t.commands : null;
  }

  function playDefaultMusic(ctx, fade = 0) {
    const name = lib.defaultMusic(ctx);
    if (!name) return;
    if (ctx.ov) ctx.ov.currentMusic = name;
    audio.playNow(name, { fade });
  }

  // ---------------------------------------------------------------- battles
  /**
   * Run a battle through src/battle's startBattle(game, params) and return the outcome
   * string for the overworld ('win' | 'lose' | 'ran' | 'caught' | 'forfeit').
   */
  function* runBattle(ctx, params, fallback) {
    const mod = systems.battle !== undefined ? systems.battle : yield loadBattle();
    if (!mod) {
      warnOnce('battle', '[hooks] src/battle has no startBattle(game, params) yet: battles use the overworld default');
      hooks.lastBattleResult = null;
      return yield* fallback();
    }
    const pal = snapshotPalette();
    audio.forget();
    let res;
    try {
      res = yield mod.startBattle(game, params);
    } finally {
      restorePalette(pal);
    }
    hooks.lastBattleResult = res || null;
    game.lastBattleResult = res || null;
    const outcome = lib.battleOutcome(res);
    if (outcome !== 'lose' && !(res && res.noMapMusic)) playDefaultMusic(ctx, FADE_BATTLE);
    // 'blackout' (not 'lose'): the overworld then skips its fade-in from white
    if (outcome === 'lose' && res && res.blackout) return 'blackout';
    if (ctx.getFlag && safeFlag(ctx, 'EVENT_IN_SAFARI_ZONE') && st().safari && (st().safari.balls | 0) === 0) {
      // SafariZoneCheck at the next overworld iteration: out of balls -> game over
      lib.afterScript(ctx, safariGameOverGen);
    }
    return outcome;
  }

  function safeFlag(ctx, name) {
    try { return !!ctx.getFlag(name); } catch { return false; }
  }

  /**
   * startBattle params of a wild / static / scripted non-trainer battle. `kind` is only
   * passed for scripted kinds (oldman, ghost, safari): src/battle derives the Safari Zone and
   * the Pokémon Tower ghosts from the map itself.
   */
  function wildParams(dex, level, info, ctx) {
    const extra = info.battle || {};
    const kind = info.battleKind || extra.kind;
    const params = {
      ...extra,
      species: dex, level, map: mapConstOf(ctx), mapName: ctx.map,
      fishing: !!info.fishing,
      resolveText: (label) => rawText(ctx, label),
    };
    if (kind && kind !== 'wild') params.kind = kind;
    else delete params.kind;
    if (!params.music) delete params.music;
    return params;
  }

  /**
   * startBattle params of a trainer battle: the end-battle text stays a label of the map's
   * text file (src/battle loads data/text/<mapName>.json for it), with resolveText as a
   * fallback; lib.scriptedBattle's extras (music, gymLeader, loseText) come through
   * hooks.pendingBattle.
   */
  function trainerParams(mapName, objectIndex, trainerClass, partyIndex, texts, ctx) {
    const pending = hooks.pendingBattle && hooks.pendingBattle.kind === 'trainer' ? hooks.pendingBattle : null;
    const cls = String(trainerClass).replace(/^OPP_/, '');
    const params = {
      ...(pending || {}),
      kind: 'trainer', trainerClass: cls, partyIndex,
      texts: texts || {}, objectIndex, map: mapConstOf(ctx), mapName,
      endBattleText: (texts && texts.end) || undefined,
      loseText: (texts && texts.lose) || undefined,
      resolveText: (label) => rawText(ctx, label),
    };
    if (!params.music) delete params.music;
    if (!params.trainerName) delete params.trainerName;
    return params;
  }

  // ---------------------------------------------------------------- per-step logic
  /** ApplyOutOfBattlePoisonDamage's visible part: "X fainted!", the flash, the blackout. */
  function* poisonGen(ctx, res) {
    for (const i of res.fainted) {
      const mon = st().party[i];
      yield ctx.showText('_PokemonFaintedText', { subs: { wNameBuffer: mon ? mon.nickname : '' } });
    }
    if (res.flash) {
      // ChangeBGPalColor0_4Frames: BG colour 0 -> dark grey for 4 frames, SFX_POISONED
      const ov = ctx.ov;
      const pal = game.palette;
      if (ov && pal) {
        const saved = pal.bgp.slice();
        ov.paletteHeld = true;
        pal.setMap([2, saved[1], saved[2], saved[3]]);
        yield ctx.wait(4);
        pal.setMap(saved);
        ov.paletteHeld = false;
      }
      ctx.playSfx('SFX_POISONED');
    }
    if (res.blackout) {
      yield ctx.showText('PlayerBlackedOutText', { wait: false }); // prompt; then HoldTextDisplayOpen
      lib.setStatusFlag(ctx, 'BIT_ALWAYS_ON_BIKE', false);
      yield* lib.blackout(ctx);
    }
  }

  /** SafariZoneGameOver: PA chime, "Time's up!" / "Your SAFARI GAME is over!", back to the gate. */
  function* safariGameOverGen(ctx) {
    audio.stopMusic();
    const pa = ctx.playSfx('SFX_SAFARI_ZONE_PA');
    yield ctx.wait(1);
    if ((st().safari.balls | 0) > 0) yield ctx.showText('_TimesUpText', { wait: false, close: false });
    yield ctx.showText('_GameOverText');
    if (isThen(pa)) yield* lib.waitFor(pa, 240);
    ctx.setFlag('EVENT_SAFARI_GAME_OVER');
    lib.setMapScript(ctx, 5, 'SafariZoneGate'); // SCRIPT_SAFARIZONEGATE_LEAVING_SAFARI
    yield ctx.warp('SafariZoneGate', 3, { facing: 'down' });
  }

  // ---------------------------------------------------------------- START menu
  function frontTile(ov) {
    return ov && ov.map ? ov.frontTile() : null;
  }

  /** IsNextTileShoreOrWater. */
  function facingWater(ov) {
    if (!ov || !ov.map) return false;
    const ts = ov.map.tileset;
    if (!ts.isWaterTileset) return false;
    const t = frontTile(ov);
    if (t === WATER_TILE) return true;
    if (ts.const === 'SHIP_PORT') return false;
    return t === SHORE_TILE || t === SAFARI_SHORE_TILE;
  }

  /** Can SURF start here (ItemUseSurfboard's checks, as ov.useSurf does them)? */
  function surfAllowed(ov) {
    if (!ov || !ov.map) return false;
    const p = ov.player;
    const ts = ov.map.tileset;
    const g = ov.map.grid;
    const f = ov.frontCell();
    const front = g.cellTile(f.x, f.y), under = g.cellTile(p.x, p.y);
    if (p.mode === MODE.SURF) return isWalkable(ts, front) && !isPairBlocked(ts, under, front, true);
    return canStartSurf(ts, front) && !isPairBlocked(ts, under, front, true);
  }

  /** HiddenItemNear (engine/items/itemfinder.asm). */
  function hiddenItemNear(ov) {
    if (!ov || !ov.map) return false;
    const p = ov.player;
    const sub5 = (v) => Math.max(0, v - 5);
    return (ov.map.json.hiddenObjects || []).some((h) => h.routine === 'HiddenItems'
      && !st().hiddenItems.has(`item:${h.flagIndex}`)
      && sub5(p.y) < h.y && h.y <= p.y + 4 && sub5(p.x) < h.x && h.x <= p.x + 5);
  }

  function startMenuEnv(ctx) {
    const ov = ctx.ov;
    const p = ctx.player || {};
    return {
      map: mapConstOf(ctx),
      tileset: ctx.mapData ? ctx.mapData.tileset : undefined,
      coords: { x: p.x, y: p.y },
      facingWater: facingWater(ov) || p.mode === 'surf',
      surfAllowed: surfAllowed(ov),
      canCut: () => canCut(ov),
      hiddenItemNear: () => hiddenItemNear(ov),
      alwaysOnBike: lib.statusFlag(ctx, 'BIT_ALWAYS_ON_BIKE'),
      link: false,
    };
  }

  function* startMenuGen(ctx) {
    const req = yield* withMenus((m) => m.startMenu(game, { env: startMenuEnv(ctx) }), undefined);
    if (req === undefined) {
      warnOnce('menus', '[hooks] src/menus is not available: the START menu does nothing');
      return;
    }
    if (req && typeof req === 'object') yield* fulfilRequest(ctx, req);
  }

  /** Teleport to a fly spot (Fly / Dig / Teleport / Escape Rope) with the warp sounds. */
  function* specialWarp(ctx, mapConst, { sfx = 'SFX_TELEPORT_EXIT_1' } = {}) {
    const dest = lib.flyWarpFor(mapConst);
    if (sfx) ctx.playSfx(sfx);
    if (ctx.ov) ctx.ov.currentMusic = null;
    yield ctx.teleport(dest.name, dest.x, dest.y, { facing: 'down', fade: 'white' });
  }

  /** Fulfil a START-menu request (docs/menus.md): field moves and close-the-menu items. */
  function* fulfilRequest(ctx, req) {
    const ov = ctx.ov;
    const r = req.request || {};
    if (req.type === 'reset') {
      // START > RESET (Cable Club only): soft reset
      if (typeof game.softReset === 'function') game.softReset();
      return;
    }
    if (req.type === 'fieldMove') {
      const mon = st().party[req.monIndex];
      const vars = { wNameBuffer: mon ? mon.nickname : '' };
      switch (req.move) {
        case 'CUT':
          if (!canCut(ov)) { yield ctx.showText('_NothingToCutText'); return; }
          yield ctx.showText('_UsedCutText', { subs: vars });
          doCut(ov);
          return;
        case 'FLY': {
          const dest = req.warp || r.warp || (req.destination ? { map: req.destination } : r.destination ? { map: r.destination } : null);
          if (!dest) return;
          yield* specialWarp(ctx, dest.map, { sfx: 'SFX_FLY' });
          return;
        }
        case 'SURF': {
          const res = ov.useSurf();
          if (res === 'cant') yield ctx.showText(r.kind === 'stopSurfing' ? '_SurfingNoPlaceToGetOffText' : '_NoSurfingHereText', { subs: vars });
          return;
        }
        case 'STRENGTH':
          ov.strengthActive = true;
          return;
        case 'FLASH':
          st().mapPalOffset = 0;
          ov.mapPalOffset = 0;
          ov.loadGBPal();
          return;
        case 'DIG':
        case 'TELEPORT':
          yield* specialWarp(ctx, r.destination || st().lastBlackoutMap);
          return;
        default:
          return;
      }
    }
    if (req.type === 'useItem') {
      switch (r.kind) {
        case 'bike': {
          const on = !!r.on;
          if (on !== (ctx.player.mode === 'bike')) {
            const res = ov.useBike();
            if (res === 'cant') st().bike = ctx.player.mode === 'bike';
          }
          return;
        }
        case 'surf':
        case 'stopSurfing':
          ov.useSurf();
          return;
        case 'escapeRope':
          yield* specialWarp(ctx, r.destination || st().lastBlackoutMap);
          return;
        case 'fish':
          yield* fishingGen(ctx, r.rod);
          return;
        case 'wakeSnorlax':
          // the flag (EVENT_FIGHT_ROUTE12/16_SNORLAX) is set; the map script starts the fight
          hooks.lastPokeFlute = { map: r.map, event: r.event, frame: ov ? ov.frameCount : 0 };
          playDefaultMusic(ctx);
          return;
        case 'itemfinder':
        case 'townMap':
        case 'pokedex':
        default:
          if (req.item === 'POKE_FLUTE') playDefaultMusic(ctx);
          return;
      }
    }
  }

  /** The rods (ItemUseOldRod / GoodRod / SuperRod + FishingAnim): a bite -> a wild battle. */
  function* fishingGen(ctx, rod) {
    const res = fish(rod, mapConstOf(ctx), game.rng);
    yield ctx.wait(40); // FishingAnim: the rod is out
    if (!res.bite) {
      yield ctx.showText(res.nothingHere ? '_NothingHereText' : '_NoNibbleText');
      return;
    }
    yield ctx.wait(20);
    yield ctx.showText('_ItsABiteText');
    yield ctx.startBattle({ species: res.species, level: res.level, fishing: true });
  }

  // ---------------------------------------------------------------- built-in UIs
  function pcGen(kind) {
    return function* pc(ctx) { yield* withMenus((m) => m.pcScene(game, kind)); };
  }

  /** VendingMachineMenu (engine/events/vending_machine.asm) on top of the menus' MenuScene. */
  function* vendingMachineGen(ctx) {
    const m = systems.menus !== undefined ? systems.menus : yield loadMenus();
    const fmt = systems.menusFormat !== undefined ? systems.menusFormat : yield loadMenusFormat();
    if (!m || !fmt) { yield ctx.showText('_VendingMachineText1'); return; }
    const mapName = ctx.map;
    const Base = m.MenuScene;
    const drinks = [['FRESH_WATER', 200], ['SODA_POP', 300], ['LEMONADE', 350]];
    class VendingScene extends Base {
      constructor() { super({ opaque: false, vramMode: 'text' }); }
      moneyBox() {
        const s = this.scr;
        s.box(11, 0, 9, 3);
        s.text(13, 0, 'MONEY');
        s.clearArea(13, 1, 6, 1);
        s.bcd(12, 1, this.state.money, 3, fmt.LEADING_ZEROES | fmt.MONEY_SIGN);
      }
      *main() {
        yield this.ctx.loadMapText(mapName);
        const say = (label, o = {}) => this.print(label, { map: mapName, ...o });
        yield* say('_VendingMachineText1');
        this.moneyBox();
        const s = this.scr;
        s.box(0, 3, 14, 10);
        s.text(2, 5, 'FRESH WATER\nSODA POP\nLEMONADE\nCANCEL');
        s.text(9, 6, '¥200\n¥300\n¥350');
        const r = yield* this.menuInput({ x: 1, y: 5, max: 3, current: 0, last: 0 });
        if (r.keys.b || r.index === 3) { yield* say('_VendingMachineText7', { wait: true }); return null; }
        const [item, price] = drinks[r.index];
        if (this.state.money < price) { yield* say('_VendingMachineText4', { wait: true }); return null; }
        if (!this.state.bag.add(item, 1)) { yield* say('_VendingMachineText6', { wait: true }); return null; }
        for (let i = 0; i < 60; i++) { yield 2; this.sfx('SFX_PUSH_BOULDER'); }
        this.state.money -= price;
        yield* say('_VendingMachineText5', { subs: { wStringBuffer: this.gd.item(item).name } });
        this.moneyBox();
        yield* this.waitButton();
        return null;
      }
    }
    yield* withMenus(() => m.ensureMenus(game).then(() => { const sc = new VendingScene(); game.scenes.push(sc); return sc.finished; }));
  }

  /** CableClubNPC without a link cable: welcome, then the preparations / no-friend text. */
  function* cableClubGen(ctx) {
    yield ctx.showText('_CableClubNPCWelcomeText', { wait: false, close: false });
    if (!safeFlag(ctx, 'EVENT_GOT_POKEDEX')) {
      yield ctx.wait(60);
      yield ctx.showText('_CableClubNPCMakingPreparationsText');
      return;
    }
    yield ctx.wait(90); // .establishConnectionLoop times out: nobody on the other end
    yield ctx.showText('_CableClubNPCAreaReservedFor2FriendsLinkedByCableText');
  }

  // ---------------------------------------------------------------- the hooks object
  let lastMapName = null;
  let lastStep = null;

  const hooks = {
    audio,
    /** set by lib.scriptedBattle for the next battle (music, end texts, gym leader ...) */
    pendingBattle: null,
    /** the last result object of src/battle's startBattle */
    lastBattleResult: null,
    lastPokeFlute: null,

    // ---------------- battles
    onWildEncounter(dex, level, info = {}, ctx) {
      const params = wildParams(dex, level, info, ctx);
      return runBattle(ctx, params, function* () {
        return yield* defaultWildBattleGen(ctx.ov, { species: dex, level });
      });
    },

    onTrainerBattle(mapName, objectIndex, trainerClass, partyIndex, texts, ctx) {
      const params = trainerParams(mapName, objectIndex, trainerClass, partyIndex, texts, ctx);
      return runBattle(ctx, params, function* () {
        const r = yield* defaultTrainerBattleGen(ctx.ov, { trainerClass });
        const end = params.endBattleText && (rawText(ctx, params.endBattleText) || null);
        if (end) yield ctx.showText(end);
        return r;
      });
    },

    onBlackout(ctx, battleOpts = {}) {
      const o = battleOpts || {};
      if (o.scripted && o.canLose) return undefined;
      // .allPokemonFainted -> HandleBlackOut once the battle has returned to the map: the
      // screen stays black until then (the battle cleared it)
      if (game.palette && ctx.ov) {
        game.palette.blackOut();
        ctx.ov.paletteHeld = true;
      }
      // scripted battles: lib.scriptedBattle runs it after the map script (RunMapScript first)
      if (o.scripted) return undefined;
      lib.afterScript(ctx, (c) => lib.blackout(c, { fadedOut: !!(game.palette && c.ov) }));
      return undefined;
    },

    // ---------------- items, party, Pokédex
    giveItem(item, qty = 1) {
      const bag = st() && st().bag;
      return !!(bag && bag.add(item, qty));
    },
    hasItem(item) {
      const bag = st() && st().bag;
      return !!(bag && bag.has(item, 1));
    },
    /** @returns {boolean} the mon was received (party or box) */
    givePokemon(dex, level) {
      return !!hooks.addPokemon(dex, level).ok;
    },
    /** _GivePokemon: {ok, where: 'party'|'box', boxNumber, mon, partyIndex} */
    addPokemon(dex, level, { nickname } = {}) {
      const s = st();
      const mon = makeMon({ species: dex, level, otName: s.playerName, otId: s.playerId, rng: game.rng, nickname });
      const r = giveMon(s, mon);
      return { ...r, mon, partyIndex: r.where === 'party' ? s.party.length - 1 : undefined };
    },
    giveCoins(n) {
      const s = st();
      if (!hasRoomForCoins(s)) return false;
      addCoins(s, n);
      return true;
    },
    getLeadLevel() {
      const lead = st() && st().party[0];
      return lead ? lead.level : null;
    },
    healParty() {
      healPartyMons(st().party);
    },
    setLastBlackoutMap(mapId) {
      const s = st();
      const cur = s.pos && s.pos.map;
      const rest = (gd().mapsMeta.safariRestHouses || []);
      if (rest.includes(cur)) return; // SetLastBlackoutMap: Safari rest houses don't count
      if (mapId) s.lastBlackoutMap = mapId;
    },
    getPokedexOwnedCount() {
      return st().pokedex ? st().pokedex.ownedCount : 0;
    },

    // ---------------- UI for the story scripts (lib.js)
    namingScreen(opts = {}) {
      return introNamingScreen({ ...opts, audio: game.audio || undefined }, game);
    },
    partyMenu(opts = {}) {
      return withMenusPromise((m) => m.partyMenu(game, opts), -1);
    },
    tradeScene(tradeId) {
      return withMenusPromise((m) => m.tradeScene(game, tradeId), { traded: false });
    },
    pokedexPage(species, { forceOwned = false } = {}) {
      return withMenusPromise((m) => {
        const dex = st().pokedex;
        // StarterDex: the first byte of wPokedexOwned temporarily marks the starters owned
        // (StarterDex: ld [wPokedexOwned], a ... xor a / ld [wPokedexOwned], a)
        if (forceOwned && dex) dex.owned[0] = 0b01001011; // BULBASAUR IVYSAUR CHARMANDER SQUIRTLE
        return m.pokedexScene(game, { species }).finally(() => { if (forceOwned && dex) dex.owned[0] = 0; });
      }, null);
    },
    dexRating() {
      return withMenusPromise((m) => m.dexRatingScene(game), null);
    },
    townMap() { return withMenusPromise((m) => m.townMapScene(game), null); },
    flyMap() { return withMenusPromise((m) => m.flyMapScene(game), null); },
    listMenu({ prompt, entries, initial = 0 }) {
      return withMenusPromise((m) => listMenuScene(m, { prompt, entries, initial }), -1);
    },

    // ---------------- overworld callbacks
    onHiddenObject(routine, entry, ctx) {
      const facing = ctx.player.facing;
      const need = entry && entry.arg === 'SPRITE_FACING_UP' ? 'up' : null;
      switch (routine) {
        case 'OpenPokemonCenterPC':
          if (need && facing !== need) return true;
          return pcGen('pokecenter')(ctx);
        case 'OpenRedsPC':
          if (need && facing !== need) return true;
          return pcGen('players')(ctx);
        case 'BillsHousePC':
          if (need && facing !== need) return true;
          return pcGen('bills')(ctx);
        case 'StartSlotMachine':
          return (function* slots() { yield* withMenus((m) => m.slotsScene(game, {})); }());
        case 'CableClubLeftGameboy':
        case 'CableClubRightGameboy':
          return true;
        default:
          warnOnce(`hidden:${routine}`, `[hooks] hidden object routine ${routine} on ${ctx.map} has no handler`);
          return false;
      }
    },

    onTextAsm(mapName, label, ctx) {
      const fn = hooks.textAsm[label];
      return fn ? fn(ctx, mapName) : false;
    },
    /** generic text_asm handlers by label (shared texts); map scripts come first */
    textAsm: {},

    onBuiltinScript(handler, info = {}, ctx) {
      switch (handler) {
        case 'script_pokecenter_nurse':
          if (systems.menus === null) return false;
          return (function* nurse() {
            yield* withMenus((m) => m.healScene(game, { nurse: info.npc || null, mapMusic: ctx.mapData && ctx.mapData.music }));
          }());
        case 'script_mart':
          if (systems.menus === null) return false;
          return (function* mart() {
            const id = (info.entry && info.entry.label) || ctx.map;
            yield* withMenus((m) => m.martScene(game, id));
          }());
        case 'script_pokecenter_pc':
          if (systems.menus === null) return false;
          return pcGen('pokecenter')(ctx);
        case 'script_players_pc':
          if (systems.menus === null) return false;
          return pcGen('players')(ctx);
        case 'script_bills_pc':
          if (systems.menus === null) return false;
          return pcGen('bills')(ctx);
        case 'script_vending_machine':
          return vendingMachineGen(ctx);
        case 'script_prize_vendor': {
          if (systems.menus === null) return false;
          const table = (ctx.ov && ctx.ov.map && ctx.ov.map.textTable && ctx.ov.map.textTable.entries) || [];
          const vendors = table.filter((e) => e.handler === 'script_prize_vendor');
          const menu = Math.max(0, vendors.findIndex((e) => info.entry && e.id === info.entry.id));
          return (function* prizes() { yield* withMenus((m) => m.gameCornerScene(game, { mode: 'prizes', menu })); }());
        }
        case 'script_cable_club_receptionist':
          return cableClubGen(ctx);
        default:
          return false;
      }
    },

    onStartMenu(ctx) {
      return startMenuGen(ctx);
    },

    onStep(ctx, info) {
      lastStep = { map: info.map, x: info.x, y: info.y };
      const s = st();
      if (safeFlag(ctx, 'EVENT_IN_SAFARI_ZONE')) {
        const r = safariStep(s);
        if (r.gameOver) return safariGameOverGen(ctx);
      }
      const res = poisonStep(s, { scripted: !!info.scripted });
      if (res.fainted.length || res.flash || res.blackout) return poisonGen(ctx, res);
      return undefined;
    },

    onMapChange(name, ctx, info = {}) {
      const kind = info.kind || 'warp';
      audio.markMapChange(kind === 'boot' ? 0 : FADE_MAP);
      const s = st();
      const c = ctx.mapData && ctx.mapData.const;
      // MarkTownVisitedAndLoadToggleableObjects: the Fly destinations
      if (c && typeof s.markTownVisited === 'function') {
        try { s.markTownVisited(c); } catch (err) { console.warn('[hooks] markTownVisited', c, err); }
      }
      // wWarpedFromWhichWarp / wWarpedFromWhichMap
      if (kind === 'warp' && lastMapName && lastStep && data) {
        const prev = data.getMapJson(lastMapName);
        const idx = prev ? (prev.warps || []).findIndex((w) => w.x === lastStep.x && w.y === lastStep.y) : -1;
        if (idx >= 0) s.warpedFrom = { map: prev.const, warp: idx };
      }
      // elevators: on entry the exits lead back where the player came from
      const elev = data && data.meta && (data.meta.elevators || []).find((e) => e.mapName === name);
      if (elev && s.warpedFrom && (kind === 'warp' || kind === 'boot')) {
        lib.setElevatorDestination(ctx, s.warpedFrom.map, s.warpedFrom.warp);
      }
      // SGB palette hand-off: the colours the battle / menus must restore
      if (game.palette) game.mapPalette = { name: ctx.ov ? ctx.ov.currentPaletteName : null, colors: game.palette.colors.map((x) => x.slice()) };
      lastMapName = name;
    },
  };

  function withMenusPromise(fn, fallback) {
    return (async () => {
      const m = systems.menus !== undefined ? systems.menus : await loadMenus();
      if (!m) return fallback;
      const pal = snapshotPalette();
      try {
        return await fn(m);
      } catch (err) {
        console.error('[hooks] menu scene failed:', err);
        return fallback;
      } finally {
        restorePalette(pal);
      }
    })();
  }

  /** A DisplayListMenuID list (elevator floors ...) in a menus scene. @returns {Promise<number>} */
  async function listMenuScene(m, { prompt, entries, initial }) {
    await m.ensureMenus(game);
    const list = await import(new URL('../menus/list.js', import.meta.url).href);
    class ListScene extends m.MenuScene {
      constructor() { super({ opaque: false, vramMode: 'text' }); }
      *main() {
        if (prompt) yield* this.print(prompt);
        const state = new list.ListMenuState(entries.length, { cursor: Math.min(initial | 0, 3), scroll: 0 });
        const sel = yield* list.displayListMenu(this, {
          kind: list.LIST_KIND.ITEM,
          entries: () => entries.map((name) => ({ name, keyItem: true })),
          state,
        });
        return sel ? sel.index : -1;
      }
    }
    const scene = new ListScene();
    game.scenes.push(scene);
    const r = await scene.finished;
    return Number.isInteger(r) ? r : -1;
  }

  return hooks;
}
