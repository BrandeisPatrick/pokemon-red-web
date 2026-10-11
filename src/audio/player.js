// AudioPlayer = SoundEngine (sequencer.js) + GbApu (apu.js) + the Game Boy frame clock.
//
// The sound engine runs once per LCD frame (4194304 / 70224 = 59.7275 Hz) exactly like the
// VBlank handler calls AudioN_UpdateMusic; frame boundaries are derived from the sample
// counter, so timing never depends on the caller. Pure JS: hosted by apu.worklet.js in the
// browser and by offline.js in node.

import { GbApu, CYCLES_PER_FRAME } from './apu.js';
import { SoundEngine, NR51 } from './sequencer.js';
import { AudioLibrary } from './library.js';

const ID_LESS_MUSIC = 0xfe; // PlaySound treats $fe as a music id; used for the header-less song

export class AudioPlayer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.sampleRate]
   * @param {(ev: object) => void} [opts.onEvent] receives {type:'ended'|'state'|...}
   * @param {(msg: string) => void} [opts.warn]
   */
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate || 48000;
    this.apu = new GbApu(this.sampleRate);
    this.warnings = [];
    this.warn = opts.warn || ((m) => { if (this.warnings.length < 200) this.warnings.push(m); });
    this.engine = new SoundEngine(this.apu, { warn: (m) => this.warn(m) });
    this.engine.onMusicLoop = (c) => this.handleMusicLoop(c);
    this.onEvent = opts.onEvent || null;
    /** @type {AudioLibrary|null} */
    this.library = null;
    /** "bank:NAME" -> decoded sound json */
    this.sounds = new Map();
    this.cyclesToFrame = CYCLES_PER_FRAME;
    this.frame = 0;
    this.paused = false;
    this.volume = 1;
    this.appliedVolume = 1;
    this.musicLoop = true;
    this.currentMusic = null;
    this.watches = [];
    this.stateInterval = 0; // frames between 'state' events (0 = off)
    this.musicLoops = 0;
  }

  // ------------------------------------------------------------------------------------
  // data
  // ------------------------------------------------------------------------------------

  /** Accepts any of {index, waves, notes, sounds: [soundJson...]}. */
  loadData(data) {
    if (data.index) {
      this.library = new AudioLibrary(data.index);
      Object.assign(this.engine.k, data.index.engine || {});
    }
    if (data.waves) {
      const w = {};
      for (const b of Object.keys(data.waves.banks)) w[b] = data.waves.banks[b].instruments.map((i) => i.bytes);
      this.engine.waves = w;
    }
    if (data.notes) this.engine.pitchTable = data.notes.table;
    if (data.sounds) for (const s of data.sounds) this.addSound(s);
  }

  addSound(sound) {
    this.sounds.set(`${sound.bank}:${sound.name}`, sound);
    if (!sound.synthetic) this.engine.addSound(sound);
  }

  soundFor(entry) {
    if (!entry) return null;
    return this.sounds.get(`${entry.bank}:${entry.variant ? entry.base : entry.name}`) || null;
  }

  // ------------------------------------------------------------------------------------
  // commands
  // ------------------------------------------------------------------------------------

  /**
   * PlayMusic. `spec`: name (any spelling), {bank, id} or a variant name
   * ("MUSIC_MEET_RIVAL_ALT_START"). Falls back to SFX names (PlayMusic can start an SFX id,
   * e.g. SFX_POKEFLUTE or the fanfares).
   * @param {{loop?: boolean, fade?: number, token?: number}} [opts]
   *   loop=false stops the song when it reaches its loop point; fade=N fades the current
   *   music out first (one volume step every N+1 frames, the game uses 10 / 8).
   */
  playMusic(spec, opts = {}) {
    const lib = this.requireLibrary();
    let entry = lib.music(spec);
    let isSfx = false;
    if (!entry) {
      entry = lib.sfx(spec, this.engine.audioROMBank);
      isSfx = !!entry;
    }
    if (!entry) return this.fail(opts.token, `unknown music ${JSON.stringify(spec)}`);
    const base = entry.variant ? lib.music(entry.base) : entry;
    const sound = this.soundFor(base);
    if (!sound) return this.fail(opts.token, `${base.name} (bank ${base.bank}) is not loaded`);
    const id = base.id == null ? ID_LESS_MUSIC : base.id;
    const override = base.id == null || base.synthetic ? sound : undefined;
    this.musicLoop = opts.loop !== false;
    this.musicLoops = 0;
    const fade = opts.fade | 0;
    if (fade > 0 && this.engine.isMusicPlaying() && !entry.variant) {
      this.engine.fadeToMusic(base.bank, id, fade, override);
    } else {
      this.engine.playMusic(base.bank, id, override);
      if (entry.variant) {
        for (const [ch, label] of Object.entries(entry.entries)) {
          const stream = sound.channels.find((c) => c.channel === +ch);
          if (!stream || stream.labels[label] === undefined) {
            this.warn(`variant ${entry.name}: missing entry ${label}`);
            continue;
          }
          this.engine.overwriteChannelPointer(+ch, stream, stream.labels[label]);
        }
      }
    }
    this.currentMusic = isSfx ? null : entry;
    const delay = fade > 0 ? 8 * (fade + 1) + 4 : 2;
    return this.watch(opts.token, 'music', sound.channels.map((c) => c.channel - 1), id, delay);
  }

  /** SFX_STOP_ALL_MUSIC (stops music and sound effects, as the game does). */
  stopMusic() {
    this.engine.stopAll();
    this.currentMusic = null;
  }

  /** Fade the music out and stop (wAudioFadeOutControl = $ff); rate as in playMusic. */
  fadeOutMusic(rate = 10) {
    this.engine.fadeOutMusic(rate);
  }

  /**
   * PlaySound for an SFX. Resolves the name in the bank whose engine is running (like the
   * game); names that only exist in another bank are played from that bank (switching
   * banks when no music is playing).
   * @param {{bank?: number, frequencyModifier?: number, tempoModifier?: number, token?: number}} [opts]
   */
  playSfx(spec, opts = {}) {
    const lib = this.requireLibrary();
    const cur = this.engine.audioROMBank;
    const entry = typeof spec === 'string' && opts.bank ? lib.sfx(`${opts.bank}:${spec}`) : lib.sfx(spec, opts.bank || cur);
    if (!entry) return this.fail(opts.token, `unknown sfx ${JSON.stringify(spec)}`);
    const sound = this.soundFor(entry);
    if (!sound) return this.fail(opts.token, `${entry.name} (bank ${entry.bank}) is not loaded`);
    let override = entry.synthetic ? sound : undefined;
    if (entry.bank !== cur) {
      if (!this.engine.isMusicPlaying() && this.engine.audioFadeOutControl === 0) {
        this.engine.audioROMBank = entry.bank; // nothing to disturb: switch banks like the game would
        this.engine.audioSavedROMBank = entry.bank;
      } else {
        override = sound; // play the other bank's data under the running engine (extension)
      }
    }
    // wFrequencyModifier / wTempoModifier only affect cries and, under the bank-2 engine,
    // battle-range SFX ids. The game sets them from MoveSoundTable before each battle SFX;
    // when the caller gives none, use neutral values ($00, $80 -> tempo $100) for sounds they
    // would affect, and leave them alone otherwise (a cry may still be using them).
    const k = this.engine.k;
    const affected = this.engine.audioROMBank === 2 && entry.id >= k.BATTLE_SFX_START && entry.id < k.BATTLE_SFX_END;
    if (opts.frequencyModifier != null) this.engine.frequencyModifier = opts.frequencyModifier & 0xff;
    else if (affected) this.engine.frequencyModifier = 0;
    if (opts.tempoModifier != null) this.engine.tempoModifier = opts.tempoModifier & 0xff;
    else if (affected) this.engine.tempoModifier = 0x80;
    this.engine.playSound(entry.id, override);
    return this.watch(opts.token, 'sfx', sound.channels.map((c) => c.channel - 1), entry.id, 2);
  }

  /**
   * PlayCry: number = Pokédex number, {index} = internal index, or a species name.
   * The cry plays in the current bank with the species' pitch / length modifiers.
   */
  playCry(spec, opts = {}) {
    const lib = this.requireLibrary();
    const cry = lib.cry(spec);
    if (!cry) return this.fail(opts.token, `unknown cry ${JSON.stringify(spec)}`);
    const bank = this.engine.audioROMBank;
    let entry = lib.crySfx(cry, bank);
    let sound = this.soundFor(entry);
    let override;
    if (!sound) {
      for (const b of [1, 2, 3]) {
        const e = lib.crySfx(cry, b);
        const s = this.soundFor(e);
        if (s) { entry = e; sound = s; override = s; break; }
      }
    }
    if (!sound) return this.fail(opts.token, `cry ${cry.sfx} is not loaded`);
    this.engine.frequencyModifier = cry.pitch & 0xff;
    this.engine.tempoModifier = cry.length & 0xff;
    this.engine.playSound(cry.sfxId, override);
    return this.watch(opts.token, 'cry', [4, 5, 6, 7], cry.sfxId, 2);
  }

  /** Resolves (via an 'ended' event) once CHAN5, CHAN6 and CHAN8 are idle. */
  waitForSfx(token) {
    this.watches.push({ token, kind: 'idle', frame: this.frame });
    this.checkWatches();
    return token;
  }

  setMasterVolume(v) {
    this.volume = Math.max(0, Math.min(1, Number(v) || 0));
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  setLowHealthAlarm(on) { this.engine.setLowHealthAlarm(!!on); }

  /** Status screen / Pokédex: music at 3/7 volume (BIT_NO_AUDIO_FADE_OUT + NR50 = $33). */
  duck(on) {
    this.engine.noAudioFadeOut = !!on;
    if (on) this.apu.write(0x24, 0x33);
  }

  /** wMuteAudioAndPauseMusic (slot machine): mute + pause the music, SFX keep playing. */
  pauseMusic(on) {
    this.engine.muteAudioAndPauseMusic = on ? 1 : 0;
  }

  /** Name of the song actually playing (from the music channels' sound ids), or null. */
  playingMusic() {
    const e = this.engine;
    let id = 0;
    for (let c = 0; c < 4 && !id; c++) id = e.soundIds[c];
    if (!id) return null;
    const cur = this.currentMusic;
    if (cur && cur.bank === e.audioROMBank && (cur.id === id || (cur.id == null && id === ID_LESS_MUSIC))) return cur.name;
    const entry = this.library && this.library.byId[e.audioROMBank].get(id);
    return entry ? entry.name : null;
  }

  state() {
    const e = this.engine;
    return {
      type: 'state',
      frame: this.frame,
      bank: e.audioROMBank,
      music: this.playingMusic(),
      soundIds: Array.from(e.soundIds),
      nr50: this.apu.read(0x24),
      nr51: this.apu.read(0x25),
      fading: e.audioFadeOutControl !== 0,
      lowHealthAlarm: (e.lowHealthAlarm & 0x80) !== 0,
      channels: this.apu.channelState(),
    };
  }

  // ------------------------------------------------------------------------------------
  // rendering
  // ------------------------------------------------------------------------------------

  /** Advance the engine by exactly one GB frame without rendering audio (tests). */
  stepFrame() {
    this.runFrame();
  }

  runFrame() {
    this.engine.frame();
    this.frame++;
    this.checkWatches();
    if (this.stateInterval && this.onEvent && this.frame % this.stateInterval === 0) this.onEvent(this.state());
  }

  /**
   * Fill `n` samples of left/right. Sound-engine frames run at their exact positions in
   * the sample stream.
   */
  render(left, right, n) {
    if (this.paused) {
      left.fill(0, 0, n);
      right.fill(0, 0, n);
      return;
    }
    const cps = this.apu.cyclesPerSample;
    let i = 0;
    while (i < n) {
      if (this.cyclesToFrame <= 0) {
        this.runFrame();
        this.cyclesToFrame += CYCLES_PER_FRAME;
      }
      const k = Math.min(n - i, Math.max(1, Math.ceil(this.cyclesToFrame / cps)));
      this.apu.render(left, right, i, k);
      this.cyclesToFrame -= k * cps;
      i += k;
    }
    // master volume with a short ramp (no zipper noise)
    const v0 = this.appliedVolume;
    const v1 = this.volume;
    if (v0 !== 1 || v1 !== 1) {
      for (let j = 0; j < n; j++) {
        const g = v0 + ((v1 - v0) * (j + 1)) / n;
        left[j] *= g;
        right[j] *= g;
      }
    }
    this.appliedVolume = v1;
  }

  // ------------------------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------------------------

  requireLibrary() {
    if (!this.library) throw new Error('AudioPlayer: loadData({index}) first');
    return this.library;
  }

  fail(token, msg) {
    this.warn(msg);
    if (token != null && this.onEvent) this.onEvent({ type: 'ended', token, played: false, error: msg });
    return 0;
  }

  watch(token, kind, channels, id, graceFrames) {
    if (token == null) return 0;
    this.watches.push({ token, kind, channels, id, seen: false, deadline: this.frame + graceFrames });
    this.checkWatches();
    return token;
  }

  checkWatches() {
    if (!this.watches.length) return;
    const ids = this.engine.soundIds;
    const keep = [];
    for (const w of this.watches) {
      let done = false;
      let played = true;
      if (w.kind === 'idle') {
        done = !this.engine.isSfxPlaying();
      } else {
        const active = w.channels.some((c) => ids[c] === w.id);
        if (active) w.seen = true;
        if (w.seen && !active) done = true;
        else if (!w.seen && this.frame >= w.deadline) {
          done = true;
          played = false;
        }
      }
      if (done) {
        if (this.onEvent) this.onEvent({ type: 'ended', token: w.token, kind: w.kind, played, frame: this.frame });
      } else keep.push(w);
    }
    this.watches = keep;
  }

  handleMusicLoop() {
    this.musicLoops++;
    if (this.musicLoop) return true;
    // loop=false: end the song where it would loop (like a sound_ret on every music channel)
    const e = this.engine;
    let nr51 = this.apu.read(NR51);
    for (let c = 0; c < 4; c++) {
      if (e.soundIds[c] !== 0) {
        e.soundIds[c] = 0;
        if (e.soundIds[c + 4] === 0) nr51 &= ~(0x11 << c) & 0xff; // leave a playing SFX audible
      }
    }
    this.apu.write(NR51, nr51);
    return false;
  }
}
