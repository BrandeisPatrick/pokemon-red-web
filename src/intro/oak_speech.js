// Professor Oak's speech (OakSpeech in engine/movie/oak_speech/oak_speech.asm,
// ChoosePlayerName / ChooseRivalName and the pic slides in oak_speech2.asm).
//
//  music: SFX_STOP_ALL_MUSIC, MUSIC_ROUTES2 (what the asm plays)
//  1. Oak's pic fades in (IntroFadePalettes, 6 x 10 frames): "Hello there! ..."
//  2. fade to white; Nidorino (flipped) slides in from the right (rWX 119 -> 7, 8 px/frame):
//     "This world is inhabited by creatures called POKéMON!" + a cry — NIDORINA's, a bug
//     the asm documents (sound_cry_nidorina) — then the rest of the text.
//  3. fade; Red slides in: "First, what is your name?"; the pic slides 6 tiles right
//     (a linear 125-byte shift of wTileMap, 3 frames per tile) and the NEW NAME / RED /
//     ASH / JACK box appears; a preset slides the pic back, NEW NAME opens the naming
//     screen (re-opened while the name is empty). "Right! So your name is RED!"
//  4. fade; the rival fades in: "This is my grand-son..." -> NEW NAME / BLUE / GARY /
//     JOHN, "That's right! I remember now! His name is BLUE!"
//  5. fade; Red fades in from white: "RED! Your very own POKéMON legend is about to
//     unfold! ..."; SFX_SHRINK, the pic shrinks (shrink1, shrink2, each loaded in strips),
//     the music fades out, the pic is replaced by the overworld sprite, 50 frames, fade to
//     white, 20 frames -> hooks.onNewGame({playerName, rivalName}).

import { GbScene, PAD, MenuState, handleMenuInput, clearScreen, clearScreenArea, copyVideoData, textBoxBorder, placeString, setPal, textSpeedFrames, textBoxSfx, waitFor } from './gb.js';
import { VCHARS0 } from './ppu.js';
import { displayPic } from './pics.js';
import { loadTextBoxTilePatterns } from './main_menu.js';
import { DEX } from './data.js';
import { TextBox } from '../engine/text.js';

/** data/player/names.asm + constants/player_constants.asm (Red version). */
export const DEFAULT_NAMES = Object.freeze({
  player: Object.freeze(['RED', 'ASH', 'JACK']),
  rival: Object.freeze(['BLUE', 'GARY', 'JOHN']),
});

/** IntroFadePalettes (dc 1,1,1,0 ... dc 3,2,1,0), 10 frames each. */
export const INTRO_FADE_PALETTES = Object.freeze([0x54, 0xa8, 0xfc, 0xf8, 0xf4, 0xe4]);

export const OAK_TIMING = Object.freeze({
  fadeInStepFrames: 10,
  movePicStartWX: 119,
  movePicStep: 8,
  slideTiles: 6,
  slideRegion: 6 * 20 + 5,
  slideStepFrames: 3,
  nameBoxClearDelay: 10,
  shrinkDelay: 4,
  afterShrink: 20,
  spriteShown: 50,
  startNewGameDelay: 20,    // StartNewGame: DelayFrames 20 after OakSpeech
});

/** PrepareOakSpeech's debug names (wPlayerName/wRivalName before they are chosen). */
export const DEBUG_NAMES = Object.freeze({ player: 'NINTEN', rival: 'SONY' });

/**
 * One pass of OakSpeechSlidePicRight / OakSpeechSlidePicLeft on the 20-wide row-major
 * wTileMap cells: 125 cells move one to the right (region ending at hlcoord 5,4 + 125 +
 * pass) or one to the left (region starting at hlcoord 12,4 - pass, then the cell after
 * the region is zeroed). It is a linear memory shift, so row ends wrap into the next row
 * exactly like the GB. Pure; exported for tests.
 * @param {Int16Array|number[]} cells
 * @param {'right'|'left'} dir
 * @param {number} pass 0..5
 */
export function slidePicPass(cells, dir, pass) {
  const size = OAK_TIMING.slideRegion;
  if (dir === 'right') {
    let p = 4 * 20 + 5 + size + pass;
    for (let c = 0; c < size; c++) { cells[p + 1] = cells[p]; p--; }
  } else {
    let p = 4 * 20 + 12 - pass;
    for (let c = 0; c < size; c++) { cells[p - 1] = cells[p]; p++; }
    cells[p - 1] = 0;
  }
}

/** All six passes at once. */
export function slidePicCells(cells, dir) {
  for (let pass = 0; pass < OAK_TIMING.slideTiles; pass++) slidePicPass(cells, dir, pass);
}

export class OakSpeechScene extends GbScene {
  get id() { return 'oakSpeech'; }

  /** A PrintText-style text box on wTileMap with the current names and text speed. */
  textBox() {
    const { game, gb, sound, data, hooks, wram } = this.ctx;
    const speed = wram.letterDelayFlags ? textSpeedFrames(hooks.options) : 1;
    return new TextBox({
      font: game.font, map: gb.tilemap, input: game.input, sfx: textBoxSfx(sound), speed,
      subs: { PLAYER: wram.playerName, RIVAL: wram.rivalName },
      resolveFar: data.texts,
      onCall: (cmd) => (cmd.script === 'cryNidorina' ? this.cry(DEX.NIDORINA) : undefined),
    });
  }

  /** PrintText of a `text_far label; text_end` text. */
  *printText(label) {
    const { wram } = this.ctx;
    const box = this.textBox();
    yield* box.run([{ cmd: 'text_far', label }, { cmd: 'text_end' }], { subs: { PLAYER: wram.playerName, RIVAL: wram.rivalName } });
  }

  /** sound_cry_nidorina: PlayCry (waits for the cry). */
  *cry(dex) {
    yield* waitFor(this.ctx.sound.playCry(dex), 300);
  }

  /** FadeInIntroPic */
  *fadeInIntroPic() {
    const pal = this.ctx.game.palette;
    for (const p of INTRO_FADE_PALETTES) {
      setPal(pal, p);
      yield OAK_TIMING.fadeInStepFrames;
    }
  }

  /** MovePicLeft: the window (the whole wTileMap) slides in from x = 112. */
  *movePicLeft() {
    const { gb, game } = this.ctx;
    gb.wx = OAK_TIMING.movePicStartWX;
    yield 1;
    setPal(game.palette, 0xe4);
    for (;;) {
      yield 1;
      const wx = (gb.wx - OAK_TIMING.movePicStep) & 0xff;
      if (wx === 0xff) return;
      gb.wx = wx;
    }
  }

  /** OakSpeechSlidePicRight / Left: each pass with the transfer off, then Delay3. */
  *slidePic(dir) {
    const gb = this.ctx.gb;
    for (let pass = 0; pass < OAK_TIMING.slideTiles; pass++) {
      gb.autoTransfer = false;
      slidePicPass(gb.tilemap.cells, dir, pass);
      gb.autoTransfer = true;
      yield OAK_TIMING.slideStepFrames;
    }
  }

  /** ChoosePlayerName / ChooseRivalName. @returns {Generator<any, string>} */
  *chooseName(kind) {
    const ctx = this.ctx;
    const { gb, game, data, wram } = ctx;
    const font = game.font, map = gb.tilemap;
    const names = DEFAULT_NAMES[kind];
    yield* this.slidePic('right');
    // DisplayIntroNameTextBox
    textBoxBorder(font, map, 0, 0, 9, 10);
    placeString(font, map, 3, 0, 'NAME');
    placeString(font, map, 2, 2, ['NEW NAME', ...names].join('\n'));
    const m = new MenuState({ topX: 1, topY: 2, cur: 0, last: 0, max: 3, watched: PAD.a });
    yield* handleMenuInput(ctx, m);
    let name;
    if (m.cur !== 0) {
      name = names[m.cur - 1];
      // OakSpeechSlidePicLeft
      clearScreenArea(map, 0, 0, 11, 12);
      yield OAK_TIMING.nameBoxClearDelay;
      yield 3;
      yield* this.slidePic('left');
    } else {
      // .customName: DisplayNamingScreen until a name was entered
      name = yield* this.call(ctx.make.naming({ kind }));
      yield* clearScreen(gb);
      yield 3;
      yield* displayPic(ctx, kind === 'player' ? data.img.red : data.img.rival1);
    }
    if (kind === 'player') wram.playerName = name;
    else wram.rivalName = name;
    yield* this.printText(kind === 'player' ? '_YourNameIsText' : '_HisNameIsText');
    return name;
  }

  /** wUpdateSpritesEnabled = 1 with the player standing (facing down) at (64, 60). */
  showPlayerSprite() {
    const gb = this.ctx.gb;
    gb.clearSprites();
    gb.setSprite(0, 60 + 16, 64 + 8, 0, 0);
    gb.setSprite(1, 60 + 16, 64 + 16, 1, 0);
    gb.setSprite(2, 60 + 24, 64 + 8, 2, 0);
    gb.setSprite(3, 60 + 24, 64 + 16, 3, 0);
  }

  *script() {
    const ctx = this.ctx;
    const { gb, game, sound, data, wram, hooks } = ctx;
    const pal = game.palette;
    const { img } = data;
    sound.stopMusic();                                      // SFX_STOP_ALL_MUSIC
    sound.playMusic('MUSIC_ROUTES2');
    yield* clearScreen(gb);
    yield* loadTextBoxTilePatterns(ctx);
    // PrepareOakSpeech
    wram.playerName = DEBUG_NAMES.player;
    wram.rivalName = DEBUG_NAMES.rival;
    // Oak
    yield* displayPic(ctx, img.profOak);
    yield* this.fadeInIntroPic();
    yield* this.printText('_OakSpeechText1');
    yield* pal.fadeToWhite();
    yield* clearScreen(gb);
    // Nidorino
    yield* displayPic(ctx, data.front.get(DEX.NIDORINO), { flip: true });
    yield* this.movePicLeft();
    {
      const box = this.textBox();
      yield* box.run([
        { cmd: 'text_far', label: '_OakSpeechText2A' },
        { cmd: 'script', script: 'cryNidorina' },           // sound_cry_nidorina (sic)
        { cmd: 'text_far', label: '_OakSpeechText2B' },
        { cmd: 'text_end' },
      ]);
    }
    yield* pal.fadeToWhite();
    yield* clearScreen(gb);
    // the player
    yield* displayPic(ctx, img.red);
    yield* this.movePicLeft();
    yield* this.printText('_IntroducePlayerText');
    yield* this.chooseName('player');
    yield* pal.fadeToWhite();
    yield* clearScreen(gb);
    // the rival
    yield* displayPic(ctx, img.rival1);
    yield* this.fadeInIntroPic();
    yield* this.printText('_IntroduceRivalText');
    yield* this.chooseName('rival');
    // .skipSpeech
    yield* pal.fadeToWhite();
    yield* clearScreen(gb);
    yield* displayPic(ctx, img.red);
    yield* pal.fadeInFromWhite();
    yield* this.printText('_OakSpeechText3');
    // shrink
    sound.playSfx('SFX_SHRINK');
    yield OAK_TIMING.shrinkDelay;
    yield* copyVideoData(gb, 12, (f, n) => gb.vram.load(VCHARS0 + f, img.redSprite, f, n)); // RedSprite -> vSprites
    yield* displayPic(ctx, img.shrink1);
    yield OAK_TIMING.shrinkDelay;
    yield* displayPic(ctx, img.shrink2);
    // ResetPlayerSpriteData; fade the music out (wAudioFadeOutControl = 10, then stop)
    sound.fadeOutMusic(10);
    yield OAK_TIMING.afterShrink;
    clearScreenArea(gb.tilemap, 6, 5, 7, 7);
    yield* loadTextBoxTilePatterns(ctx);
    this.showPlayerSprite();
    yield OAK_TIMING.spriteShown;
    yield* pal.fadeToWhite();
    yield* clearScreen(gb);
    // StartNewGame
    yield OAK_TIMING.startNewGameDelay;
    const names = { playerName: wram.playerName, rivalName: wram.rivalName };
    return { call: () => hooks.onNewGame(names) };
  }
}
