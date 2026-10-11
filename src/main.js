// Boot: create the engine services, show a loading screen while the data loads, then the
// real game: the intro (copyright ... title ... main menu ... Oak's speech) hands over to the
// overworld through hooks.onNewGame / hooks.onContinue. Everything is exposed on
// window.game for debugging. See docs/story.md.
//
// (src/engine/demo.js, the engine's proof-of-life scene, is kept but no longer used.)

import { FrameBuffer } from './engine/framebuffer.js';
import { Palette, PALETTES } from './engine/palette.js';
import { Input } from './engine/input.js';
import { Rng } from './engine/rng.js';
import { Loop } from './engine/loop.js';
import { Scene, SceneStack } from './engine/scene.js';
import { Assets } from './engine/assets.js';
import { Font } from './engine/font.js';
import { Sfx } from './engine/sfx.js';
import * as gfx from './engine/gfx.js';
import { createAudio } from './audio/audio.js';
import { startIntro } from './intro/index.js';
import { loadGameData } from './pokemon/data.js';
import { newGame } from './game/new_game.js';
import { DEFAULT_OPTIONS } from './game/state.js';
import { createSaveStore, loadGame, hasSave, deleteSave } from './game/save.js';
import { OverworldData, OverworldScene } from './overworld/index.js';
import { createHooks } from './game/hooks.js';
import { installScripts } from './game/scripts/index.js';
import { detectTouch, createMobile } from './mobile/index.js';
import { installAudioUnlock } from './mobile/audio_unlock.js';

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('screen'));
// Phone mode (docs/mobile.md): a coarse primary pointer, or ?touch=1 (?touch=0 forces it off). It adds
// the on-screen controls and gives the framebuffer only the canvas region of the phone layout.
const touch = detectTouch(window);
const mobile = touch ? createMobile({ canvas }) : null;
const fb = new FrameBuffer();
fb.attachCanvas(canvas, mobile ? { getViewport: mobile.getViewport } : {});
const palette = new Palette(PALETTES.dmg);
const input = new Input().attach(window);
const rng = new Rng();
const assets = new Assets();
const sfx = new Sfx();
const audio = createAudio();
const saveStore = createSaveStore();
const data = OverworldData.fromAssets(assets);

const game = {
  fb, input, palette, rng, assets, sfx, gfx, audio, data,
  /** the save store shared by CONTINUE, the START menu's SAVE and the PCs */
  saveStore,
  storage: saveStore,
  /** @type {Font|null} */ font: null,
  /** @type {SceneStack|null} */ scenes: null,
  /** @type {Loop|null} */ loop: null,
  /** wOptions: one object shared by the intro's OPTION screen, the START menu and state.options */
  options: { ...DEFAULT_OPTIONS },
  /** @type {import('./game/state.js').GameState|null} */ state: null,
  /** @type {any} the game hooks (src/game/hooks.js) */ hooks: null,
  /** @type {OverworldScene|null} */ overworld: null,
  /** the play-time counter runs once a game is started (BIT_GAME_TIMER_COUNTING) */
  playing: false,
  /** map names that got a story script (installScripts) */
  scriptedMaps: [],
};
game.scenes = new SceneStack(game);
/** START > RESET (Cable Club) and the clear-save combo end in a soft reset (jp Init). */
game.softReset = () => window.location.reload();
window.game = game;

// Audio may only start inside a user gesture (the music requested before plays then). keydown and the
// pointer / touch events all try it; iOS needs the AudioContext created or resumed inside the gesture
// handler, and a later tap finishes the job if the first one did not stick (src/mobile/audio_unlock.js).
installAudioUnlock({ audio, sfx, lifecycle: touch });
if (mobile) game.mobile = mobile.start({ fb, input });

fb.clear(0);
fb.present(palette);

/** A plain loading screen while the data tables load. */
class LoadingScene extends Scene {
  constructor() {
    super();
    this.done = 0;
    this.total = 1;
  }
  draw(f) {
    f.clear(0);
    if (game.font) game.font.drawText(f, 'Loading...', 44, 60);
    const w = Math.round(96 * Math.min(1, this.done / this.total));
    f.fillRect(32, 76, 96, 1, 2);
    f.fillRect(32, 76, w, 1, 3);
  }
}

/** The overworld for a game state (new game or continue). */
function startOverworld(state) {
  state.options = Object.assign(game.options, state.options || {});
  game.state = state;
  game.playing = true;
  const ov = new OverworldScene({ data, state, hooks: game.hooks, paletteMode: 'sgb' });
  game.overworld = ov;
  return ov;
}

/** The main menu's CONTINUE box: name, badges, Pokédex, time of the saved game. */
function saveInfo() {
  if (!hasSave(saveStore)) return null;
  const s = loadGame(saveStore);
  if (!s) return null;
  return { playerName: s.playerName, badges: s.badges, dexOwned: s.pokedex.ownedCount, playTimeFrames: s.playTime };
}

async function boot() {
  console.info(`[pokered-web] RNG seed ${rng.seed}`);
  game.font = await Font.load(assets);
  const loading = new LoadingScene();
  game.scenes.push(loading);
  game.loop = new Loop({
    update(frame) {
      input.sample();
      game.scenes.update(frame, input);
      if (game.playing && game.state) game.state.addPlayTime(1);
    },
    render() {
      fb.clear(0);
      game.scenes.draw(fb);
      fb.present(palette);
    },
  });
  game.loop.start();

  const track = (p) => p.then((v) => { loading.done++; return v; });
  const jobs = [loadGameData(), data.init(), audio.load().catch((err) => { console.warn('[pokered-web] audio data:', err); })];
  loading.total = jobs.length + 1;
  await Promise.all(jobs.map(track));
  game.scriptedMaps = await track(installScripts({ mapNames: data.mapNames }));
  console.info(`[pokered-web] story scripts for ${game.scriptedMaps.length} maps`);

  game.hooks = createHooks(game, { data });

  await startIntro(game, {
    audio,
    options: game.options,
    saveInfo,
    clearSave: () => deleteSave(saveStore),
    onNewGame: ({ playerName, rivalName }) => startOverworld(newGame({ playerName, rivalName, options: game.options })),
    onContinue: () => {
      const state = loadGame(saveStore);
      if (!state) {
        console.error('[pokered-web] the save could not be loaded:', saveStore.lastError);
        return null;
      }
      return startOverworld(state);
    },
  }, { replace: true });
}

boot().catch((err) => {
  console.error('[pokered-web] boot failed:', err);
  const pre = document.createElement('pre');
  pre.className = 'boot-error';
  pre.textContent = `Boot failed: ${err && err.message ? err.message : err}`;
  document.body.appendChild(pre);
});
