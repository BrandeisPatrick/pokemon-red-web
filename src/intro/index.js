// The game start sequence of Pokémon Red as scenes on the engine's scene stack:
//
//   splash (copyright) -> gamefreak (shooting star) -> fight (Gengar vs Nidorino)
//   -> title -> mainMenu -> [options] / oakSpeech -> [naming] -> hooks.onNewGame
//                       \-> CONTINUE -> hooks.onContinue
//   title + Up+Select+B -> clearSave -> splash
//
//   import { startIntro } from './intro/index.js';
//   await startIntro(game, {
//     audio,                                  // createAudio() from src/audio/audio.js
//     saveInfo: () => save ? {playerName, badges, dexOwned, playTimeFrames} : null,
//     clearSave: () => deleteSave(),
//     options,                                // mutated by the OPTION screen
//     onNewGame: ({playerName, rivalName}) => new OverworldScene(...), // a Scene replaces the intro
//     onContinue: () => ...,
//   });
//
// See docs/intro.md for the hook contract and the naming screen API.

import { GbScreen, VCHARS1, VCHARS2, BG_MAP1 } from './ppu.js';
import { Joy, normalizeHooks, makeSound, setPal, loadGBPal, gbPalWhiteOut } from './gb.js';
import { loadIntroData } from './data.js';
import { SplashScene } from './splash.js';
import { GameFreakScene, loadIntroScreen } from './gamefreak.js';
import { IntroFightScene } from './intro_fight.js';
import { TitleScene } from './title.js';
import { MainMenuScene } from './main_menu.js';
import { OptionsScene } from './options.js';
import { OakSpeechScene } from './oak_speech.js';
import { NamingScene } from './naming.js';
import { ClearSaveScene } from './clear_save.js';

export { namingScreen, NamingScene, runNamingScreen, displayNamingScreen, NAME_MAX } from './naming.js';
export { optionMenu, optionsScreen, OptionsScene } from './options.js';
export { loadIntroData } from './data.js';
export { GbScreen } from './ppu.js';
export { normalizeHooks } from './gb.js';

/** Scene ids, in story order. */
export const INTRO_SCENES = Object.freeze(['splash', 'gamefreak', 'fight', 'title', 'mainMenu', 'options', 'oakSpeech', 'naming', 'clearSave']);

/**
 * Build the shared context (screen model, joypad, hooks, sound, "WRAM").
 * @param {any} game engine services ({font, input, palette, rng, sfx, scenes, assets})
 * @param {import('./gb.js').IntroHooks} [hooks]
 * @param {{data?: import('./data.js').IntroData}} [opts]
 * @returns {import('./gb.js').IntroContext}
 */
export function createIntroContext(game, hooks = {}, { data = null } = {}) {
  const h = normalizeHooks(hooks);
  const ctx = {
    game,
    gb: new GbScreen({ font: game.font }),
    joy: new Joy(game.input),
    hooks: h,
    sound: makeSound(h.audio, game.sfx),
    data,
    wram: { playerName: 'NINTEN', rivalName: 'SONY', titleMon: 4, alphabetLower: false, letterDelayFlags: 0, curOpponent: 0 },
    onScene: null,
    make: null,
  };
  ctx.make = {
    splash: (p) => new SplashScene(ctx, p),
    gamefreak: (p) => new GameFreakScene(ctx, p),
    fight: (p) => new IntroFightScene(ctx, p),
    title: (p) => new TitleScene(ctx, p),
    mainMenu: (p) => new MainMenuScene(ctx, p),
    options: (p) => new OptionsScene(ctx, p),
    oakSpeech: (p) => new OakSpeechScene(ctx, p),
    naming: (p) => new NamingScene(ctx, p),
    clearSave: (p) => new ClearSaveScene(ctx, p),
  };
  return ctx;
}

/**
 * Put the screen model in the state a scene finds when the real game reaches it (used to
 * start in the middle of the sequence: test page, unit tests).
 */
export function prepareScreenFor(ctx, id) {
  const { gb, game } = ctx;
  const pal = game.palette;
  const font = game.font;
  gb.reset();
  ctx.joy.reset();
  if (id === 'splash' || id === 'title') {
    gbPalWhiteOut(pal);
    return;
  }
  gb.vram.load(VCHARS2 + 0x60, font.gfx, 0x60, 32);
  gb.vram.load(VCHARS1, font.gfx, 0x80, 128);
  gb.autoTransfer = true;
  gb.autoDest = BG_MAP1;
  if (id === 'gamefreak') {
    const { copyright, gamefreakInc } = ctx.data.img;
    gb.vram.load(VCHARS2 + 0x60, copyright, 0, 19);
    gb.vram.load(VCHARS2 + 0x73, gamefreakInc, 0, 9);
    gb.hWY = gb.wy = 0;
    setPal(pal, 0xe4);
    return;
  }
  if (id === 'fight') {
    loadIntroScreen(ctx);
    gb.lcdc.winOn = false;
    gb.lcdc.bgMap = 1;
    gb.tilemap.fillRect(0, 4, 20, 10, 0);
    gb.transferAll(BG_MAP1);
    setPal(pal, 0xe4);
    ctx.sound.playMusic('MUSIC_INTRO_BATTLE');
    return;
  }
  // menus: what DisplayTitleScreen's exit leaves (window over the screen, both maps blank)
  gb.hWY = gb.wy = 0;
  ctx.wram.letterDelayFlags = 1;
  loadGBPal(pal);
}

/**
 * Load the data and push the first scene. Resolves with the context once the scene runs.
 * @param {any} game
 * @param {import('./gb.js').IntroHooks} [hooks]
 * @param {{at?: string, params?: any, replace?: boolean, data?: any,
 *          onScene?: (scene:any) => void}} [opts]
 */
export async function startIntro(game, hooks = {}, { at = 'splash', params, replace = false, data, onScene } = {}) {
  const ctx = createIntroContext(game, hooks, { data: data || await loadIntroData(game.assets) });
  if (onScene) ctx.onScene = onScene;
  return startIntroAt(ctx, at, { params, replace });
}

/** Start (or jump to) a scene of an existing context. */
export function startIntroAt(ctx, at = 'splash', { params, replace = false } = {}) {
  if (!ctx.make[at]) throw new Error(`startIntro: unknown scene ${at}`);
  prepareScreenFor(ctx, at);
  const p = at === 'title' ? { fromIntro: true, ...(params || {}) } : params;
  const scene = ctx.make[at](p);
  const stack = ctx.game.scenes;
  if (replace && stack.length) stack.replace(scene);
  else stack.push(scene);
  return ctx;
}
