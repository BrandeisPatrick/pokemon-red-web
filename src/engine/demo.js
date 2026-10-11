// Proof-of-life scene for the core engine: a Gen-1 text box with a multi-page Oak
// message (text/line/cont/para/prompt), then a NEW GAME / OPTION / QUIT menu, a text
// speed submenu, a YES/NO box and GB palette fades. SELECT cycles the colour palette.
// Later tasks replace this with the real intro (src/game/); nothing depends on it.

import { Scene } from './scene.js';
import { TileMap } from './tilemap.js';
import { TextBox, TEXT_SPEED } from './text.js';
import { Menu, YesNoMenu } from './menu.js';
import { PALETTES } from './palette.js';

export const DEMO_TEXT = [
  { cmd: 'text', str: 'OAK: Hello there!' },
  { cmd: 'line', str: 'Welcome to the' },
  { cmd: 'cont', str: 'world of #MON!' },
  { cmd: 'para', str: 'My name is OAK!' },
  { cmd: 'line', str: 'People call me' },
  { cmd: 'cont', str: 'the #MON PROF!' },
  { cmd: 'para', str: "{PLAYER}! I'm ready" },
  { cmd: 'line', str: 'when you are!' },
  { cmd: 'prompt' },
];

const SPEEDS = [['FAST', TEXT_SPEED.fast], ['MEDIUM', TEXT_SPEED.medium], ['SLOW', TEXT_SPEED.slow]];

export class DemoScene extends Scene {
  enter() {
    const { font, input, sfx, palette, options } = this.game;
    this.ui = new TileMap(20, 18);
    this.text = new TextBox({ font, map: this.ui, input, sfx, speed: options.textSpeed, subs: { PLAYER: 'RED', RIVAL: 'BLUE' } });
    this.paletteNames = Object.keys(PALETTES);
    this.paletteIndex = 0;
    palette.setColors(PALETTES[this.paletteNames[0]]).whiteOut();
    this.run(this.script());
  }

  *script() {
    const { palette } = this.game;
    for (;;) {
      yield* palette.fadeInFromWhite();
      yield* this.text.run(DEMO_TEXT);
      this.text.close();
      yield* this.mainMenu();
      // QUIT -> YES: black out, then start over with a fade from black
      this.ui.clear();
      yield 30;
      yield* palette.fadeInFromBlack();
      yield* this.text.run([{ cmd: 'text', str: 'Welcome back!' }, { cmd: 'prompt' }]);
      this.text.close();
      palette.whiteOut();
    }
  }

  *mainMenu() {
    const { font, input, sfx, palette } = this.game;
    const menu = new Menu({ font, map: this.ui, input, sfx, items: ['NEW GAME', 'OPTION', 'QUIT'], x: 0, y: 0, width: 15 });
    for (;;) {
      const choice = yield* menu.run();
      if (choice === 0) {
        yield* this.text.run([
          { cmd: 'text', str: 'NEW GAME needs the' },
          { cmd: 'line', str: 'overworld module.' },
          { cmd: 'prompt' },
        ]);
        this.text.close();
      } else if (choice === 1) {
        menu.placeCursor(true);
        const current = SPEEDS.findIndex(([, f]) => f === this.text.speed);
        const sub = new Menu({ font, map: this.ui, input, sfx, items: SPEEDS.map(([n]) => n), x: 11, y: 3, width: 9, initial: Math.max(0, current) });
        const pick = yield* sub.run();
        sub.close();
        if (pick >= 0) {
          this.text.speed = SPEEDS[pick][1];
          this.game.options.textSpeed = this.text.speed;
          yield* this.text.run([{ cmd: 'text', str: `Text speed is now` }, { cmd: 'line', str: `${SPEEDS[pick][0]}.` }, { cmd: 'prompt' }]);
          this.text.close();
        }
        menu.placeCursor();
      } else {
        yield* this.text.run([{ cmd: 'text', str: 'Quit the demo?' }, { cmd: 'done' }]);
        const yes = yield* new YesNoMenu({ font, map: this.ui, input, sfx }).run();
        this.text.close();
        if (yes) {
          menu.close();
          yield* palette.fadeToBlack();
          return;
        }
      }
    }
  }

  update(frame, input) {
    if (input.pressed.select) {
      this.paletteIndex = (this.paletteIndex + 1) % this.paletteNames.length;
      this.game.palette.setColors(PALETTES[this.paletteNames[this.paletteIndex]]);
    }
  }

  draw(fb) {
    const { font, loop } = this.game;
    fb.clear(0);
    font.drawText(fb, `PALETTE ${this.paletteNames[this.paletteIndex].toUpperCase()}`, 8, 72);
    font.drawText(fb, `FRAME ${String(loop ? loop.frame : 0).padStart(7, '0')}`, 8, 80);
    this.ui.draw(fb, font.gfx);
  }
}
