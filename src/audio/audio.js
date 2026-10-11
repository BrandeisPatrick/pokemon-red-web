// Main-thread facade for the Game Boy sound system.
//
//   import { createAudio, SFX } from './src/audio/audio.js';
//   const audio = createAudio();
//   addEventListener('keydown', () => audio.init(), { once: true }); // needs a user gesture
//   audio.playMusic('PALLET_TOWN');            // or audio.playMusic(audio.songForMap('PALLET_TOWN'))
//   audio.playSfx(SFX.menuPress);               // resolves when the sound has finished
//   await audio.playCry(25);                    // Pokédex number (or {index}, or 'PIKACHU')
//
// All synthesis and sequencing happens in the AudioWorklet (apu.worklet.js); this module
// fetches the JSON produced by tools/extract_audio.py, lazily ships sound data to the
// worklet and forwards commands. See docs/audio.md.

import { AudioLibrary } from './library.js';

const DEFAULT_DATA_URL = new URL('../../data/audio/', import.meta.url);
const WORKLET_URL = new URL('./apu.worklet.js', import.meta.url);
// [mobile fallback] A self-contained copy of the worklet (tools/bundle_worklet.py, docs/mobile.md). It is only
// requested when loading the modular worklet above is rejected, e.g. by an AudioWorklet that cannot resolve
// `import` statements (Safari / iOS is the browser where that is least proven).
const WORKLET_BUNDLE_URL = new URL('./apu.worklet.bundle.js', import.meta.url);

/**
 * SFX the game UI needs (constant names from constants/music_constants.asm). Every one of
 * these exists in all three audio banks unless noted, so it works whatever music is on.
 */
export const SFX = Object.freeze({
  menuPress: 'SFX_PRESS_AB',          // A/B in menus and text boxes (and "text advance")
  startMenu: 'SFX_START_MENU',        // opening the START menu
  collision: 'SFX_COLLISION',         // bumping into a wall (banks 1, 3)
  ledge: 'SFX_LEDGE',                 // ledge hop (banks 1, 3)
  goInside: 'SFX_GO_INSIDE',          // entering a door (banks 1, 3)
  goOutside: 'SFX_GO_OUTSIDE',        // leaving through a door mat (banks 1, 3)
  save: 'SFX_SAVE',                   // game saved (banks 1, 3)
  turnOnPC: 'SFX_TURN_ON_PC',         // banks 1, 3
  turnOffPC: 'SFX_TURN_OFF_PC',       // banks 1, 3
  enterPC: 'SFX_ENTER_PC',            // banks 1, 3
  withdrawDeposit: 'SFX_WITHDRAW_DEPOSIT', // Bill's PC box ops (banks 1, 3)
  purchase: 'SFX_PURCHASE',           // mart buy/sell (banks 1, 3)
  denied: 'SFX_DENIED',               // invalid choice / can't do that (banks 1, 3)
  swap: 'SFX_SWAP',                   // swapping items / party order (banks 1, 3)
  switch: 'SFX_SWITCH',               // menu switch (banks 1, 3)
  tink: 'SFX_TINK',                   // small "tink" (all banks)
  healHP: 'SFX_HEAL_HP',              // HP bar filling (all banks)
  healAilment: 'SFX_HEAL_AILMENT',    // status healed (all banks)
  poisoned: 'SFX_POISONED',           // poison damage while walking (banks 1, 3)
  healingMachine: 'SFX_HEALING_MACHINE', // Pokémon Center balls (banks 1, 3)
  cut: 'SFX_CUT',                     // HM01 Cut (banks 1, 3)
  pushBoulder: 'SFX_PUSH_BOULDER',    // Strength (banks 1, 3)
  fly: 'SFX_FLY',                     // HM02 Fly (banks 1, 3)
  teleportExit1: 'SFX_TELEPORT_EXIT_1',   // warp out (banks 1, 3)
  teleportEnter1: 'SFX_TELEPORT_ENTER_1', // warp in (banks 1, 3)
  teleportExit2: 'SFX_TELEPORT_EXIT_2',
  teleportEnter2: 'SFX_TELEPORT_ENTER_2',
  arrowTiles: 'SFX_ARROW_TILES',      // spinner tiles (banks 1, 3)
  ssAnneHorn: 'SFX_SS_ANNE_HORN',
  tradeMachine: 'SFX_TRADE_MACHINE',
  shrink: 'SFX_SHRINK',
  getItem1: 'SFX_GET_ITEM_1',         // item fanfare (banks 1, 3; same id = SFX_LEVEL_UP in bank 2)
  getItem2: 'SFX_GET_ITEM_2',         // all banks
  getKeyItem: 'SFX_GET_KEY_ITEM',     // banks 1, 3
  pokedexRating: 'SFX_POKEDEX_RATING',
  safariZonePA: 'SFX_SAFARI_ZONE_PA', // bank 1
  pokeflute: 'SFX_POKEFLUTE',         // overworld flute: stopMusic() then playMusic(SFX.pokeflute)
  // battle (bank 2; played from bank 2 even if other music is on)
  levelUp: 'SFX_LEVEL_UP',
  ballToss: 'SFX_BALL_TOSS',
  ballPoof: 'SFX_BALL_POOF',
  faintThud: 'SFX_FAINT_THUD',
  faintFall: 'SFX_FAINT_FALL',
  run: 'SFX_RUN',                     // got away safely
  caughtMon: 'SFX_CAUGHT_MON',
  dexPageAdded: 'SFX_DEX_PAGE_ADDED',
  trainerAppeared: 'SFX_TRAINER_APPEARED',
  damage: 'SFX_DAMAGE',               // neutral hit (battle uses frequency $20 / tempo $30)
  notVeryEffective: 'SFX_NOT_VERY_EFFECTIVE', // ($50 / $01)
  superEffective: 'SFX_SUPER_EFFECTIVE',      // ($e0 / $ff)
  pokefluteInBattle: 'SFX_POKEFLUTE_IN_BATTLE', // Music_PokeFluteInBattle
  // intro / title (bank 3)
  introLunge: 'SFX_INTRO_LUNGE',
  introHip: 'SFX_INTRO_HIP',
  introHop: 'SFX_INTRO_HOP',
  introRaise: 'SFX_INTRO_RAISE',
  introCrash: 'SFX_INTRO_CRASH',
  introWhoosh: 'SFX_INTRO_WHOOSH',
  shootingStar: 'SFX_SHOOTING_STAR',
  slotsStopWheel: 'SFX_SLOTS_STOP_WHEEL',
  slotsReward: 'SFX_SLOTS_REWARD',
  slotsNewSpin: 'SFX_SLOTS_NEW_SPIN',
});

/** Battle hit sounds exactly as engine/battle/animations.asm plays them. */
export const HIT_SFX = Object.freeze({
  neutral: { name: 'SFX_DAMAGE', frequencyModifier: 0x20, tempoModifier: 0x30 },
  superEffective: { name: 'SFX_SUPER_EFFECTIVE', frequencyModifier: 0xe0, tempoModifier: 0xff },
  notVeryEffective: { name: 'SFX_NOT_VERY_EFFECTIVE', frequencyModifier: 0x50, tempoModifier: 0x01 },
});

/**
 * @param {object} [options]
 * @param {string|URL} [options.dataUrl] where data/audio lives (default: <project>/data/audio/)
 * @param {number} [options.volume] initial master volume 0..1
 * @param {string[]} [options.preload] SFX names to fetch right after init
 */
export function createAudio(options = {}) {
  const dataUrl = new URL(options.dataUrl || DEFAULT_DATA_URL, globalThis.location ? globalThis.location.href : DEFAULT_DATA_URL);
  let ctx = null;
  let node = null;
  let analyser = null;
  let ready = false;
  let loadPromise = null;
  let initPromise = null;
  let base = null; // {index, waves, notes}
  let library = null;
  let volume = options.volume != null ? options.volume : 1;
  let muted = false;
  let lastState = null;
  let pendingMusic = null;
  let nextToken = 1;
  const pending = new Map(); // token -> resolve
  const shipped = new Set(); // files sent to the worklet
  const fetching = new Map(); // file -> Promise<json>
  const stateListeners = new Set();
  const warnListeners = new Set();

  async function fetchJson(rel) {
    const res = await fetch(new URL(rel, dataUrl));
    if (!res.ok) throw new Error(`audio: ${res.status} fetching ${rel}`);
    return res.json();
  }

  /** Fetch index/waves/notes (no AudioContext needed; safe before a user gesture). */
  function load() {
    if (!loadPromise) {
      loadPromise = Promise.all([fetchJson('index.json'), fetchJson('waves.json'), fetchJson('notes.json')]).then(
        ([index, waves, notes]) => {
          base = { index, waves, notes };
          library = new AudioLibrary(index);
          return library;
        },
      );
    }
    return loadPromise;
  }

  function onMessage(msg) {
    switch (msg.type) {
      case 'ended': {
        const resolve = pending.get(msg.token);
        if (resolve) {
          pending.delete(msg.token);
          resolve(!!msg.played);
        }
        break;
      }
      case 'state':
        lastState = msg;
        for (const fn of stateListeners) fn(msg);
        break;
      case 'warn':
        for (const fn of warnListeners) fn(msg.message);
        if (!warnListeners.size) console.warn('[audio]', msg.message);
        break;
      case 'error':
        console.error('[audio worklet]', msg.message);
        break;
      default:
        break;
    }
  }

  /**
   * Create the AudioContext + worklet. Call from a user-gesture handler (keydown / click)
   * the first time; later calls return the same promise.
   */
  function init() {
    if (initPromise) return initPromise;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return Promise.reject(new Error('Web Audio is not available'));
    ctx = new AC({ latencyHint: 'interactive' });
    const resumed = ctx.resume().catch(() => {}); // inside the gesture
    initPromise = (async () => {
      await load();
      try {
        await ctx.audioWorklet.addModule(WORKLET_URL);
      } catch (err) {
        // [mobile fallback] the modular worklet was rejected: use the bundled copy (WORKLET_BUNDLE_URL)
        console.warn('[audio] worklet modules failed to load, using the bundled worklet:', err && err.message ? err.message : err);
        await ctx.audioWorklet.addModule(WORKLET_BUNDLE_URL);
      }
      node = new AudioWorkletNode(ctx, 'gb-apu', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      node.connect(analyser);
      analyser.connect(ctx.destination);
      node.port.onmessage = (e) => onMessage(e.data);
      node.port.postMessage({ type: 'loadData', ...base });
      node.port.postMessage({ type: 'setMasterVolume', value: muted ? 0 : volume });
      if (stateListeners.size) node.port.postMessage({ type: 'stateInterval', frames: 2 });
      await resumed;
      ready = true;
      if (pendingMusic) {
        const [spec, opts] = pendingMusic;
        pendingMusic = null;
        playMusic(spec, opts).catch((err) => console.warn('[audio]', err && err.message));
      }
      if (options.preload) preload(options.preload).catch(() => {});
      return true;
    })();
    return initPromise;
  }

  /** Fetch (once) and ship to the worklet every file needed for the given entries. */
  async function ensure(entries) {
    const files = new Set();
    for (const e of entries) for (const f of library.filesFor(e)) if (!shipped.has(f)) files.add(f);
    if (!files.size) return;
    const sounds = await Promise.all(
      [...files].map((f) => {
        if (!fetching.has(f)) {
          // forget failed fetches so a later call can retry
          fetching.set(f, fetchJson(f).catch((err) => { fetching.delete(f); throw err; }));
        }
        return fetching.get(f);
      }),
    );
    const fresh = [];
    [...files].forEach((f, i) => {
      if (!shipped.has(f)) {
        shipped.add(f);
        fresh.push(sounds[i]);
      }
    });
    if (fresh.length) node.port.postMessage({ type: 'loadData', sounds: fresh });
  }

  /** All bank copies of an SFX name (the worklet picks the one for the running bank). */
  function sfxEntries(spec, bank) {
    if (bank) return [library.sfx(`${bank}:${spec}`)].filter(Boolean);
    const out = [];
    for (const b of [1, 2, 3]) {
      const e = typeof spec === 'string' ? library.sfx(`${b}:${spec}`) : null;
      if (e) out.push(e);
    }
    if (!out.length) {
      const e = library.sfx(spec);
      if (e) out.push(e);
    }
    return out;
  }

  function track(token) {
    return new Promise((resolve) => pending.set(token, resolve));
  }

  /**
   * Start a song. `spec`: "PALLET_TOWN" / "MUSIC_PALLET_TOWN" / entry from songForMap /
   * variant ("MUSIC_MEET_RIVAL_ALT_START"). Requests made before init() are remembered and
   * start when init() completes. Resolves true once the song's data is loaded and the start
   * command is sent (with `fade`, the song itself begins when the fade-out finishes).
   * @param {{loop?: boolean, fade?: number}} [opts] fade = the game's fade speed (10 = map
   *   change): fade the current music out first, one volume step every fade+1 frames.
   */
  async function playMusic(spec, opts = {}) {
    if (spec && typeof spec === 'object' && spec.name) spec = spec.name;
    if (!ready) {
      pendingMusic = [spec, opts];
      return false;
    }
    const entry = library.music(spec) || library.sfx(spec);
    if (!entry) {
      console.warn('[audio] unknown music', spec);
      return false;
    }
    await ensure(entry.variant ? [library.music(entry.base)] : [entry]);
    node.port.postMessage({ type: 'playMusic', name: entry.name, bank: entry.bank, loop: opts.loop !== false, fade: opts.fade || 0 });
    return true;
  }

  /** SFX_STOP_ALL_MUSIC: stops music and sound effects. */
  function stopMusic() {
    pendingMusic = null;
    if (ready) node.port.postMessage({ type: 'stopMusic' });
  }

  /** Fade the music out (one NR50 step every frames+1 frames, 8 steps) and stop. */
  function fadeOutMusic(frames = 10) {
    pendingMusic = null;
    if (ready) node.port.postMessage({ type: 'fadeOutMusic', frames });
  }

  /**
   * Play a sound effect; resolves true when it has finished (false if it did not play,
   * e.g. a higher-priority sound held the channel, or before init()).
   * @param {string|{name:string, frequencyModifier?:number, tempoModifier?:number}} spec
   * @param {{bank?: number, frequencyModifier?: number, tempoModifier?: number}} [opts]
   */
  async function playSfx(spec, opts = {}) {
    if (!ready) return false;
    if (spec && typeof spec === 'object' && spec.name) {
      opts = { ...spec, ...opts };
      spec = spec.name;
    }
    const entries = sfxEntries(spec, opts.bank);
    if (!entries.length) {
      console.warn('[audio] unknown sfx', spec);
      return false;
    }
    await ensure(entries);
    const token = nextToken++;
    const done = track(token);
    node.port.postMessage({ type: 'playSfx', name: spec, bank: opts.bank, frequencyModifier: opts.frequencyModifier,
      tempoModifier: opts.tempoModifier, token });
    return done;
  }

  /**
   * Play a Pokémon cry. Number = Pokédex number 1-151; {index: n} = internal index;
   * string = species ("PIKACHU"). Resolves when the cry has finished.
   */
  async function playCry(spec) {
    if (!ready) return false;
    const cry = library.cry(spec);
    if (!cry) {
      console.warn('[audio] unknown cry', spec);
      return false;
    }
    await ensure([1, 2, 3].map((b) => library.crySfx(cry, b)).filter(Boolean));
    const token = nextToken++;
    const done = track(token);
    node.port.postMessage({ type: 'playCry', index: cry.index, token });
    return done;
  }

  /** WaitForSoundToFinish: resolves when no SFX holds CHAN5, CHAN6 or CHAN8. */
  function waitForSfx() {
    if (!ready) return Promise.resolve(true);
    const token = nextToken++;
    const done = track(token);
    node.port.postMessage({ type: 'waitForSfx', token });
    return done;
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, Number(v)));
    if (ready) node.port.postMessage({ type: 'setMasterVolume', value: muted ? 0 : volume });
  }

  /** Toggle (or set) mute. Returns the new muted state. */
  function mute(on = !muted) {
    muted = !!on;
    if (ready) node.port.postMessage({ type: 'setMasterVolume', value: muted ? 0 : volume });
    return muted;
  }

  /** data/maps/songs.asm: map constant ("PALLET_TOWN") or map id -> song entry (after load()). */
  function songForMap(map) {
    return library ? library.songForMap(map) : null;
  }

  async function preload(names) {
    await load();
    if (!ready) return;
    const entries = [];
    for (const n of names) entries.push(...sfxEntries(n));
    await ensure(entries);
  }

  function onState(fn) {
    stateListeners.add(fn);
    if (ready && stateListeners.size === 1) node.port.postMessage({ type: 'stateInterval', frames: 2 });
    return () => {
      stateListeners.delete(fn);
      if (ready && !stateListeners.size) node.port.postMessage({ type: 'stateInterval', frames: 0 });
    };
  }

  function post(msg) {
    if (ready) node.port.postMessage(msg);
  }

  /** Game code often fires and forgets: never reject, warn and resolve false instead. */
  const safe = (fn) => (...args) => fn(...args).catch((err) => {
    console.warn('[audio]', err && err.message ? err.message : err);
    return false;
  });

  return {
    load,
    init,
    get isReady() { return ready; },
    get context() { return ctx; },
    get analyser() { return analyser; },
    get library() { return library; },
    get state() { return lastState; },
    get muted() { return muted; },
    get volume() { return volume; },
    playMusic: safe(playMusic),
    stopMusic,
    fadeOutMusic,
    playSfx: safe(playSfx),
    playCry: safe(playCry),
    waitForSfx,
    setVolume,
    mute,
    songForMap,
    preload,
    onState,
    onWarning(fn) { warnListeners.add(fn); return () => warnListeners.delete(fn); },
    /** Low-HP beeping in battle (only sounds while battle music, bank 2, is playing). */
    setLowHealthAlarm(on) { post({ type: 'setLowHealthAlarm', on: !!on }); },
    /** Status screen / Pokédex entry: music at 3/7 volume, cries stay full volume. */
    duck(on) { post({ type: 'duck', on: !!on }); },
    /** Slot machine style: pause + mute the music while SFX keep playing. */
    pauseMusic(on) { post({ type: 'pauseMusic', on: !!on }); },
    /** Freeze / continue the whole sound engine (e.g. while the tab is hidden). */
    pause() { post({ type: 'pause' }); },
    resume() { post({ type: 'resume' }); if (ctx && ctx.state !== 'running') ctx.resume(); },
    /** Debug: silence hardware channels, e.g. [false, true, true, true] = only CH1. */
    muteChannels(channels) { post({ type: 'mute', channels }); },
    SFX,
    HIT_SFX,
  };
}
