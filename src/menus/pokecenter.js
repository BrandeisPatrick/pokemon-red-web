// The Pokémon Center nurse (engine/events/pokecenter.asm DisplayPokemonCenterDialogue_,
// engine/overworld/healing_machine.asm AnimateHealingMachine).
//
// "Welcome to our POKéMON CENTER! ..." (+ "Shall we heal your POKéMON?" the first time:
// BIT_USED_POKECENTER), HEAL / CANCEL at (11,6) (cursor (12,8)); on HEAL: the blackout map is
// set, "OK. We'll need your POKéMON.", the nurse turns to the machine, the party is healed,
// the machine animation (the monitor, one Poké Ball per party mon every 30 frames with
// SFX_HEALING_MACHINE after the music faded out, MUSIC_PKMN_HEALED with the balls flashing
// 8 times (OBP1 ^ $28 every 10 frames), 32 frames), the map music back, "Thank you! Your
// POKéMON are fighting fit!", the nurse bows (her "up" frame), 20 frames; then "We hope to see
// you again!" and the nurse faces down again (UpdateSprites).
//
// The machine sprites are drawn at the screen positions the game uses (the player stands in
// front of the counter). Options: {nurse} — an overworld NPC with face(dir): 'left' = turn to
// the machine, 'up' = the bow frame, 'down' = back to normal.

import { MenuScene } from './base.js';
import { healParty } from '../pokemon/party.js';
import { byteToMap } from '../engine/palette.js';

/** PokeCenterOAMData as screen pixels: the monitor, then the six balls (x, y, flipX). */
export const HEAL_MACHINE_SPRITES = Object.freeze({
  monitor: { x: 44, y: 20 },
  balls: [
    { x: 40, y: 27, flipX: false }, { x: 48, y: 27, flipX: true },
    { x: 40, y: 32, flipX: false }, { x: 48, y: 32, flipX: true },
    { x: 40, y: 37, flipX: false }, { x: 48, y: 37, flipX: true },
  ],
});

export class PokecenterScene extends MenuScene {
  /** @param {{nurse?:{face:(d:string)=>void}, mapMusic?:string}} [params] */
  constructor(params = {}) {
    super({ ...params, opaque: false, vramMode: 'text' });
    this.machine = null; // {balls: n}
  }

  *main() {
    const st = this.state;
    const savedPal = this.savePalette();
    yield* this.print('_PokemonCenterWelcomeText');
    let used = false;
    try { used = st.statusFlags.get('BIT_USED_POKECENTER'); st.statusFlags.set('BIT_USED_POKECENTER'); } catch { /* */ }
    if (!used) yield* this.print([{ cmd: 'text_pause' }, { cmd: 'text_far', label: '_ShallWeHealYourPokemonText' }, { cmd: 'text_end' }]);
    // YesNoChoicePokeCenter: HEAL_CANCEL_MENU at (11,6), items from (13,8)
    const choice = yield* this.twoOption({ x: 11, y: 6, w: 9, h: 6, items: ['HEAL', 'CANCEL'], top: 2 });
    if (choice === 0) {
      // SetLastBlackoutMap
      if (st.lastOutdoor && st.lastOutdoor.map) st.lastBlackoutMap = st.lastOutdoor.map;
      if (this.game.hooks && typeof this.game.hooks.setLastBlackoutMap === 'function') this.game.hooks.setLastBlackoutMap(st.lastBlackoutMap);
      yield* this.print('_NeedYourPokemonText');
      const nurse = this.params.nurse;
      if (nurse && typeof nurse.face === 'function') nurse.face('left');
      yield 3;
      healParty(st.party, this.gd);
      yield* this.animateHealingMachine(st.party.length);
      // back to the map music
      const music = this.params.mapMusic || this.prevMusic;
      if (music) this.snd.music(music);
      yield* this.print('_PokemonFightingFitText');
      // image index $14: the nurse's "up" frame is her bow; DelayFrames $14
      if (nurse && typeof nurse.face === 'function') nurse.face('up');
      yield 20;
    }
    yield* this.print([{ cmd: 'text_pause' }, { cmd: 'text_far', label: '_PokemonCenterFarewellText' }, { cmd: 'text_end' }], { wait: true });
    // jp UpdateSprites: the nurse's image follows her facing (down) again
    if (this.params.nurse && typeof this.params.nurse.face === 'function') this.params.nurse.face('down');
    this.restorePalette(savedPal);
    this.scr.reset();
    return { healed: choice === 0 };
  }

  /** AnimateHealingMachine. */
  *animateHealingMachine(partyCount) {
    const pal = this.game.palette;
    const saved = this.savePalette();
    const setObp1 = (byte) => { if (pal) pal.setMaps(pal.bgp, pal.obp0, byteToMap(byte)); };
    let obp1 = 0xe0;
    setObp1(obp1);
    this.machine = { balls: 0 };
    // fade the music out (wAudioFadeOutControl 4: 8 steps of 5 frames), SFX_STOP_ALL_MUSIC
    this.prevMusic = this.snd.currentMusic();
    this.snd.fadeOutMusic(4);
    yield 40;
    this.snd.stopMusic();
    for (let i = 0; i < partyCount; i++) {
      this.machine.balls = i + 1;
      this.sfx('SFX_HEALING_MACHINE');
      yield 30;
    }
    this.snd.music('MUSIC_PKMN_HEALED', { loop: false });
    for (let k = 0; k < 8; k++) {
      obp1 ^= 0x28;
      setObp1(obp1);
      yield 10;
    }
    // .waitLoop2: until the jingle (135 frames) is over
    yield* this.snd.waitMusicEnd('MUSIC_PKMN_HEALED', 135 - 80);
    yield 32;
    this.restorePalette(saved);
    this.machine = null;
  }

  drawExtra(fb) {
    if (!this.machine) return;
    const img = this.ctx.images.healMachine;
    if (!img) return;
    const m = HEAL_MACHINE_SPRITES;
    fb.blit(img, 0, 0, 8, 8, m.monitor.x, m.monitor.y, { obj: 1 });
    for (let i = 0; i < this.machine.balls && i < 6; i++) {
      const b = m.balls[i];
      fb.blit(img, 0, 8, 8, 8, b.x, b.y, { obj: 1, flipX: b.flipX });
    }
  }
}
