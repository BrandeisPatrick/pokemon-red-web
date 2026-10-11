// Sound for the menus: the real sound engine when the game has one (`game.audio`, the
// src/audio/audio.js facade, or `game.hooks.audio`), else the engine's square-wave blip for
// SFX_PRESS_AB. Every call is fire-and-forget safe: nothing here throws or hangs.
//
//   const snd = new MenuSound(game);
//   snd.sfx('SFX_TURN_ON_PC');                    // PlaySound
//   yield* snd.waitSfx('SFX_PURCHASE');           // PlaySoundWaitForCurrent + WaitForSoundToFinish
//   snd.cry(25);                                  // PlayCry (dex number)
//   new TextBox({ ..., sfx: snd.blip })           // engine widgets call blip.play('press')

/** Frames we wait at most for a sound promise before giving up (no audio, muted tab...). */
export const MAX_SOUND_WAIT = 600;

/** Rough lengths (frames) used when no audio engine can tell us when a sound ends. */
const FALLBACK_LENGTH = Object.freeze({
  SFX_PRESS_AB: 6, SFX_PURCHASE: 30, SFX_SAVE: 90, SFX_TURN_ON_PC: 30, SFX_TURN_OFF_PC: 30,
  SFX_ENTER_PC: 20, SFX_WITHDRAW_DEPOSIT: 20, SFX_HEAL_HP: 30, SFX_HEAL_AILMENT: 30,
  SFX_HEALING_MACHINE: 20, SFX_GET_ITEM_1: 90, SFX_GET_ITEM_2: 120, SFX_GET_KEY_ITEM: 120,
  SFX_LEVEL_UP: 90, SFX_DENIED: 20, SFX_SWAP: 15, SFX_TINK: 8, SFX_SLOTS_REWARD: 4,
  SFX_SLOTS_NEW_SPIN: 30, SFX_SLOTS_STOP_WHEEL: 10, SFX_TRADE_MACHINE: 30, SFX_POKEDEX_RATING: 60,
  SFX_CAUGHT_MON: 120, SFX_DEX_PAGE_ADDED: 60,
});

export class MenuSound {
  /** @param {any} game */
  constructor(game) {
    this.game = game;
    /** names of the sounds requested (debugging / tests) */
    this.log = [];
    const self = this;
    /** engine-widget adapter: { play('press') } */
    this.blip = { play: (name) => { if (name === 'press' || name === 'SFX_PRESS_AB') self.sfx('SFX_PRESS_AB'); else self.sfx(name); } };
  }

  /** The audio facade, if any. */
  get audio() {
    const g = this.game;
    return (g && (g.audio || (g.hooks && g.hooks.audio))) || null;
  }

  /**
   * PlaySound. @returns {Promise<boolean>} resolves when the sound ended (true) or did not
   * play (false); never rejects.
   */
  sfx(name) {
    this.log.push(name);
    const a = this.audio;
    if (a && typeof a.playSfx === 'function') {
      try {
        return Promise.resolve(a.playSfx(name)).then((v) => v !== false, () => false);
      } catch {
        return Promise.resolve(false);
      }
    }
    const s = this.game && this.game.sfx;
    if (name === 'SFX_PRESS_AB' && s && typeof s.play === 'function') {
      try { s.play('press'); } catch { /* ignore */ }
    }
    return Promise.resolve(false);
  }

  /** PlayCry (dex number). @returns {Promise<boolean>} */
  cry(dex) {
    this.log.push(`CRY_${dex}`);
    const a = this.audio;
    if (a && typeof a.playCry === 'function') {
      try {
        return Promise.resolve(a.playCry(dex)).then((v) => v !== false, () => false);
      } catch {
        return Promise.resolve(false);
      }
    }
    return Promise.resolve(false);
  }

  /** PlayMusic. */
  music(name, opts) {
    this.log.push(name);
    const a = this.audio;
    if (a && typeof a.playMusic === 'function') {
      try { return Promise.resolve(a.playMusic(name, opts)).catch(() => false); } catch { /* ignore */ }
    }
    return Promise.resolve(false);
  }

  /** SFX_STOP_ALL_MUSIC. */
  stopMusic() {
    const a = this.audio;
    if (a && typeof a.stopMusic === 'function') try { a.stopMusic(); } catch { /* ignore */ }
  }

  /** Fade the music out (wAudioFadeOutControl). */
  fadeOutMusic(frames = 4) {
    const a = this.audio;
    if (a && typeof a.fadeOutMusic === 'function') try { a.fadeOutMusic(frames); } catch { /* ignore */ }
  }

  /** The music the audio engine is playing (name) or null. */
  currentMusic() {
    const a = this.audio;
    const st = a && a.state;
    return (st && (st.music || st.musicName)) || null;
  }

  /** rAUDVOL $33 / $77 (status screen, Pokédex). */
  duck(on) {
    const a = this.audio;
    if (a && typeof a.duck === 'function') try { a.duck(on); } catch { /* ignore */ }
  }

  /**
   * Coroutine: play `name` and wait until it ends (PlaySoundWaitForCurrent +
   * WaitForSoundToFinish). Without an audio engine waits a plausible length instead.
   */
  *waitSfx(name, max = MAX_SOUND_WAIT) {
    const hasAudio = !!(this.audio && typeof this.audio.playSfx === 'function');
    const p = this.sfx(name);
    if (!hasAudio) {
      yield FALLBACK_LENGTH[name] ?? 20;
      return false;
    }
    return yield* waitPromise(p, max);
  }

  /**
   * Coroutine: wait while `name` is the playing music (the GB polls wChannelSoundIDs), at most
   * `max` frames. Listens to the facade's state stream (onState) for the duration. Without a
   * running audio engine, or when the song never shows up (muted, failed to load), waits
   * `fallback` frames instead (the measured length).
   */
  *waitMusicEnd(name, fallback, max = 600) {
    const a = this.audio;
    const live = a && (typeof a.onState === 'function' || 'state' in a) && a.isReady !== false;
    if (!live) {
      if (fallback > 0) yield fallback;
      return;
    }
    let cur = a.state ? a.state.music : null;
    let got = !!a.state;
    let off = null;
    if (typeof a.onState === 'function') {
      try { off = a.onState((st) => { cur = st ? st.music : null; got = true; }); } catch { off = null; }
    }
    try {
      let seen = false;
      for (let f = 0; f < max; f++) {
        if (got && cur === name) seen = true;
        else if (seen) return;
        if (!seen && f >= 30) {
          if (fallback > f) yield fallback - f;
          return;
        }
        yield 1;
      }
    } finally {
      if (typeof off === 'function') try { off(); } catch { /* ignore */ }
    }
  }

  /** Coroutine: play a cry and wait for it (PlayCry + WaitForSoundToFinish). */
  *waitCry(dex, max = MAX_SOUND_WAIT) {
    const hasAudio = !!(this.audio && typeof this.audio.playCry === 'function');
    const p = this.cry(dex);
    if (!hasAudio) {
      yield 30;
      return false;
    }
    return yield* waitPromise(p, max);
  }
}

/** Coroutine: wait for a promise, at most `max` frames. @returns its value or undefined */
export function* waitPromise(p, max = MAX_SOUND_WAIT) {
  let done = false;
  let value;
  Promise.resolve(p).then((v) => { done = true; value = v; }, () => { done = true; });
  for (let i = 0; i < max && !done; i++) yield 1;
  return value;
}
