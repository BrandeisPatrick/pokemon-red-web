// Tiny Web Audio square-wave beeper for UI blips. No music.
//
// 'press' reproduces SFX_PRESS_AB (audio/sfx/press_ab_1.asm), a channel-5 square wave at
// 50% duty:  square_note length, volume, fade, frequency
//     0, 9, 1, 1984 / 0, 8, 1, 2000 / 0, 9, 1, 1984 / 12, 10, 1, 2000
// with length+1 frames per note, GB frequency f = 131072 / (2048 - reg) Hz and an envelope
// that drops one volume step every fade/64 s.
//
// The AudioContext is only created by unlock(), which must run inside a user gesture
// (main.js calls it on the first key/pointer press) so browsers never complain.

const GB_FRAME_SECONDS = 1 / 59.7275;

/** name -> {notes: [frames, volume 0..15, fade, freqReg][]} */
export const SFX = Object.freeze({
  press: { notes: [[1, 9, 1, 1984], [1, 8, 1, 2000], [1, 9, 1, 1984], [13, 10, 1, 2000]] },
});

/** GB square channel frequency register -> Hz. */
export function gbFreqToHz(reg) {
  return 131072 / (2048 - reg);
}

export class Sfx {
  /** @param {{volume?: number}} [opts] master volume 0..1 */
  constructor({ volume = 0.12 } = {}) {
    this.volume = volume;
    this.muted = false;
    /** @type {AudioContext|null} */
    this.ctx = null;
    this._master = null;
  }

  /** Create/resume the AudioContext. Call from a user-gesture handler. */
  unlock() {
    try {
      if (!this.ctx) {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this._master = this.ctx.createGain();
        this._master.gain.value = this.volume;
        this._master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch {
      this.ctx = null;
    }
  }

  /** @returns {boolean} */
  has(name) {
    return Object.prototype.hasOwnProperty.call(SFX, name);
  }

  setVolume(v) {
    this.volume = v;
    if (this._master) this._master.gain.value = v;
  }

  /** Play a sound effect by name (silently ignored before unlock() or when muted). */
  play(name) {
    const def = SFX[name];
    const ctx = this.ctx;
    if (!def || this.muted || !ctx || ctx.state !== 'running') return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.connect(gain);
    gain.connect(this._master);
    let t = ctx.currentTime + 0.002;
    const start = t;
    for (const [frames, vol, fade, reg] of def.notes) {
      const dur = frames * GB_FRAME_SECONDS;
      const v0 = vol / 15;
      osc.frequency.setValueAtTime(gbFreqToHz(reg), t);
      gain.gain.setValueAtTime(v0, t);
      if (fade > 0) {
        const toSilence = (vol * fade) / 64;
        if (toSilence <= dur) gain.gain.linearRampToValueAtTime(0, t + toSilence);
        else gain.gain.linearRampToValueAtTime(v0 * (1 - dur / toSilence), t + dur);
      }
      t += dur;
    }
    gain.gain.setValueAtTime(0, t);
    osc.start(start);
    osc.stop(t + 0.02);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }
}
