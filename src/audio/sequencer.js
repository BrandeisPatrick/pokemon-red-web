// Port of Pokémon Red's sound engine (vendor/pokered/audio/engine_1.asm + the engine_2.asm
// differences), plus the bits of home/audio.asm, home/fade_audio.asm and
// audio/low_health_alarm.asm that drive it from the VBlank handler.
//
// Pure JS: no Web Audio, no DOM. It talks to hardware through a `registers` object:
//
//   registers.read(addr)  -> byte     addr is the low byte of $FFxx ($10-$3F)
//   registers.write(addr, byte)
//
// src/audio/apu.js implements that interface (software Game Boy APU); tests use a recorder.
//
// The routine and RAM names follow the disassembly so the two can be read side by side.
// Sound data is the decoded JSON from tools/extract_audio.py: a channel "stream" is
// `{ commands: [...], labels: {...} }` and a channel pointer is (stream, index).

/** @typedef {{op: string, [k: string]: any}} Command */
/** @typedef {{channel: number, label?: string, entry?: number, labels?: Object<string, number>, commands: Command[]}} Stream */
/** @typedef {{name?: string, bank?: number, id?: number|null, channels: Stream[]}} Sound */
/** @typedef {{read(addr: number): number, write(addr: number, value: number): void}} Registers */

export const CHAN1 = 0, CHAN2 = 1, CHAN3 = 2, CHAN4 = 3, CHAN5 = 4, CHAN6 = 5, CHAN7 = 6, CHAN8 = 7;
export const NUM_CHANNELS = 8;
export const NUM_MUSIC_CHANS = 4;

// hardware register addresses (low byte of $FFxx)
export const NR10 = 0x10, NR11 = 0x11, NR12 = 0x12, NR13 = 0x13, NR14 = 0x14;
export const NR21 = 0x16, NR22 = 0x17, NR23 = 0x18, NR24 = 0x19;
export const NR30 = 0x1A, NR31 = 0x1B, NR32 = 0x1C, NR33 = 0x1D, NR34 = 0x1E;
export const NR41 = 0x20, NR42 = 0x21, NR43 = 0x22, NR44 = 0x23;
export const NR50 = 0x24, NR51 = 0x25, NR52 = 0x26;
export const WAVE_RAM = 0x30;

// constants/audio_constants.asm
const HW_CH_BASE = [0x10, 0x15, 0x1A, 0x1F]; // NR10, NR21-1, NR30, NR41-1
const HW_ENABLE_MASK = [0x11, 0x22, 0x44, 0x88];
const HW_DISABLE_MASK = HW_ENABLE_MASK.map((m) => ~m & 0xff);
const REG_DUTY_SOUND_LEN = 1, REG_VOLUME_ENVELOPE = 2, REG_FREQUENCY_LO = 3;

// wChannelFlags1 bits
const BIT_PERFECT_PITCH = 0;
const BIT_SOUND_CALL = 1;
const BIT_NOISE_OR_SFX = 2;
const BIT_VIBRATO_DIRECTION = 3;
const BIT_PITCH_SLIDE_ON = 4;
const BIT_PITCH_SLIDE_DECREASING = 5;
const BIT_ROTATE_DUTY_CYCLE = 6;
// wChannelFlags2
const BIT_EXECUTE_MUSIC = 0;

const AUD1SWEEP_DOWN = 0x08;
const AUD3ENA_ON = 0x80;
const AUDENA_ON = 0x80;
const AUD1HIGH_LENGTH_ON = 0x40;

export const SFX_STOP_ALL_MUSIC = 0xff;
const DISABLE_LOW_HEALTH_ALARM = 0xff;

/** Values from constants/music_constants.asm (overridden by index.json "engine"). */
export const DEFAULT_ENGINE_CONSTANTS = {
  NOISE_INSTRUMENTS_END: 20,
  CRY_SFX_START: 20,
  CRY_SFX_END: 134,
  BATTLE_SFX_START: 157,
  BATTLE_SFX_END: 234,
  MAX_SFX_ID_1: 185,
  MAX_SFX_ID_2: 233,
  MAX_SFX_ID_3: 194,
};

/** audio/notes.asm */
export const DEFAULT_PITCH_TABLE = [
  0xF82C, 0xF89D, 0xF907, 0xF96B, 0xF9CA, 0xFA23, 0xFA77, 0xFAC7, 0xFB12, 0xFB58, 0xFB9B, 0xFBDA,
];

/** The one-command stream Audio1_CryRet (a lone sound_ret) used for CHAN7 during cries. */
const CRY_RET_STREAM = Object.freeze({ channel: 7, label: 'Audio1_CryRet', commands: [{ op: 'sound_ret' }], labels: {} });

const swapNibbles = (a) => ((a << 4) | (a >> 4)) & 0xff;
const nibSigned = (v) => (v < 0 ? (0x8 | -v) : v) & 0xf;

/**
 * Audio1_CalculateFrequency: frequency register (as `de`) for pitch 0-11 and the stored
 * octave value (8 - octave). Returns a 16-bit value; low 11 bits are the GB period.
 */
export function calcFrequency(pitch, octaveStored, table = DEFAULT_PITCH_TABLE) {
  let v = table[pitch & 0xf];
  if (v === undefined) v = 0; // out-of-table pitch (never in the data)
  if (v >= 0x8000) v -= 0x10000;
  let a = octaveStored & 0xff;
  // `cp 7; jr z, .done; sra d; rr e; inc a` (a wraps like the CPU would)
  for (let guard = 0; a !== 7 && guard < 256; guard++) {
    v >>= 1;
    a = (a + 1) & 0xff;
  }
  const de = v & 0xffff;
  const d = ((de >> 8) + 8) & 0xff;
  return (d << 8) | (de & 0xff);
}

/**
 * Audio1_note_length arithmetic: frames until the next note.
 * delay = high byte of (frac + length*speed*tempo), new frac = low byte.
 */
export function noteDelay(length, speed, tempo, frac = 0) {
  const a = (length * speed) & 0xff; // `ld a, l`
  const hl = (frac + a * tempo) & 0xffff;
  return { delay: hl >> 8, frac: hl & 0xff };
}

/** Byte written to NRx2 (or the wave/volume byte) for note_type / square_note / noise_note. */
export function envelopeByte(volume, fade) {
  return ((volume << 4) | nibSigned(fade)) & 0xff;
}

export class SoundEngine {
  /**
   * @param {Registers} registers
   * @param {object} [opts]
   * @param {object} [opts.constants] engine constants (index.json "engine")
   * @param {number[]} [opts.pitchTable] audio/notes.asm
   * @param {Object<string, number[][]>} [opts.waves] bank -> instrument -> 16 wave-RAM bytes
   * @param {(msg: string) => void} [opts.warn]
   */
  constructor(registers, opts = {}) {
    this.reg = registers;
    this.k = { ...DEFAULT_ENGINE_CONSTANTS, ...(opts.constants || {}) };
    this.pitchTable = opts.pitchTable || DEFAULT_PITCH_TABLE;
    this.waves = opts.waves || {};
    this.warn = opts.warn || (() => {});
    /** bank -> id -> Sound (the SFX_Headers_N table of each audio bank) */
    this.headers = { 1: new Map(), 2: new Map(), 3: new Map() };
    /** hook called when a music channel takes its infinite-loop jump (sound_loop 0) */
    this.onMusicLoop = null;
    this.initRam();
  }

  initRam() {
    const u8 = () => new Uint8Array(NUM_CHANNELS);
    // wChannelCommandPointers / wChannelReturnAddresses as (stream, index)
    this.cmdStream = new Array(NUM_CHANNELS).fill(null);
    this.cmdIndex = new Int32Array(NUM_CHANNELS);
    this.retStream = new Array(NUM_CHANNELS).fill(null);
    this.retIndex = new Int32Array(NUM_CHANNELS);
    this.soundIds = u8();
    this.flags1 = u8();
    this.flags2 = u8();
    this.dutyCycles = u8();
    this.dutyCyclePatterns = u8();
    this.vibratoDelayCounters = u8();
    this.vibratoExtents = u8();
    this.vibratoRates = u8();
    this.frequencyLowBytes = u8();
    this.vibratoDelayCounterReloadValues = u8();
    this.pitchSlideLengthModifiers = u8();
    this.pitchSlideFrequencySteps = u8();
    this.pitchSlideFrequencyStepsFractionalPart = u8();
    this.pitchSlideCurrentFrequencyFractionalPart = u8();
    this.pitchSlideCurrentFrequencyHighBytes = u8();
    this.pitchSlideCurrentFrequencyLowBytes = u8();
    this.pitchSlideTargetFrequencyHighBytes = u8();
    this.pitchSlideTargetFrequencyLowBytes = u8();
    this.noteDelayCounters = u8().fill(1);
    this.loopCounters = u8().fill(1);
    this.noteSpeeds = u8().fill(1);
    this.noteDelayCountersFractionalPart = u8();
    this.octaves = u8();
    this.volumes = u8();
    this.musicWaveInstrument = 0;
    this.sfxWaveInstrument = 0;
    this.musicTempo = 0x100;
    this.sfxTempo = 0x100;
    this.soundID = 0; // wSoundID
    this.unusedMusicByte = 0;
    this.muteAudioAndPauseMusic = 0;
    this.disableChannelOutputWhenSfxEnds = 0;
    this.stereoPanning = 0xff;
    this.savedVolume = 0;
    this.frequencyModifier = 0;
    this.tempoModifier = 0;
    // home/audio.asm + home/fade_audio.asm state
    this.newSoundID = 0;
    this.audioROMBank = 1; // which engine copy runs (1, 2 or 3 = AUDIO_1..3)
    this.audioSavedROMBank = 1;
    this.audioFadeOutControl = 0;
    this.audioFadeOutCounter = 0;
    this.audioFadeOutCounterReloadValue = 0;
    this.lastMusicSoundID = 0;
    this.noAudioFadeOut = false; // wStatusFlags2 BIT_NO_AUDIO_FADE_OUT
    this.lowHealthAlarm = 0; // wLowHealthAlarm
    // engine bank currently executing (set by updateMusic / playSound)
    this.engineBank = 1;
    this.frameCount = 0;
  }

  // ------------------------------------------------------------------------------------
  // data registration
  // ------------------------------------------------------------------------------------

  /** Register a decoded sound (one data/audio/{music,sfx}/*.json) in its bank's header table. */
  addSound(sound) {
    if (sound.id == null || !sound.bank) return;
    this.headers[sound.bank].set(sound.id, sound);
  }

  getHeader(bank, id) {
    return this.headers[bank] ? this.headers[bank].get(id) : undefined;
  }

  // ------------------------------------------------------------------------------------
  // VBlank: FadeOutAudio, Music_DoLowHealthAlarm (bank 2 only), AudioN_UpdateMusic
  // ------------------------------------------------------------------------------------

  /** One Game Boy frame of audio work, in the order home/vblank.asm does it. */
  frame() {
    this.frameCount++;
    this.fadeOutAudio();
    this.engineBank = this.audioROMBank;
    if (this.engineBank === 2) this.doLowHealthAlarm();
    this.updateMusic();
  }

  // Audio1_UpdateMusic
  updateMusic() {
    this.engineBank = this.audioROMBank;
    for (let c = 0; c < NUM_CHANNELS; c++) {
      if (this.soundIds[c] === 0) continue;
      if (c < CHAN5 && this.muteAudioAndPauseMusic !== 0) {
        if (this.muteAudioAndPauseMusic & 0x80) continue;
        this.muteAudioAndPauseMusic |= 0x80;
        this.reg.write(NR51, 0);
        this.reg.write(NR30, 0);
        this.reg.write(NR30, AUD3ENA_ON);
        continue;
      }
      this.applyMusicAffects(c);
    }
  }

  // Audio1_ApplyMusicAffects
  applyMusicAffects(c) {
    const delay = this.noteDelayCounters[c];
    if (delay === 1) {
      this.playNextNote(c);
      return;
    }
    this.noteDelayCounters[c] = (delay - 1) & 0xff;
    if (c < CHAN5 && this.soundIds[c + 4] !== 0) return;
    if (this.flags1[c] & (1 << BIT_ROTATE_DUTY_CYCLE)) this.applyDutyCyclePattern(c);
    if (!(this.flags2[c] & (1 << BIT_EXECUTE_MUSIC)) && (this.flags1[c] & (1 << BIT_NOISE_OR_SFX))) return;
    if (this.flags1[c] & (1 << BIT_PITCH_SLIDE_ON)) {
      this.applyPitchSlide(c);
      return;
    }
    if (this.vibratoDelayCounters[c] !== 0) {
      this.vibratoDelayCounters[c]--;
      return;
    }
    const extents = this.vibratoExtents[c];
    if (extents === 0) return;
    const rate = this.vibratoRates[c];
    if ((rate & 0x0f) !== 0) {
      this.vibratoRates[c] = rate - 1;
      return;
    }
    this.vibratoRates[c] = (rate & 0xf0) | (rate >> 4); // reload the counter
    const e = this.frequencyLowBytes[c];
    let a;
    if (this.flags1[c] & (1 << BIT_VIBRATO_DIRECTION)) {
      this.flags1[c] &= ~(1 << BIT_VIBRATO_DIRECTION);
      a = e - (extents & 0x0f);
      if (a < 0) a = 0;
    } else {
      this.flags1[c] |= 1 << BIT_VIBRATO_DIRECTION;
      a = e + (extents >> 4);
      if (a > 0xff) a = 0xff;
    }
    this.reg.write(this.regAddr(c, REG_FREQUENCY_LO), a);
  }

  // Audio1_PlayNextNote
  playNextNote(c) {
    this.vibratoDelayCounters[c] = this.vibratoDelayCounterReloadValues[c];
    this.flags1[c] &= ~((1 << BIT_PITCH_SLIDE_ON) | (1 << BIT_PITCH_SLIDE_DECREASING));
    // engine_2.asm only: the low health alarm owns CHAN5
    if (this.engineBank === 2 && c === CHAN5 && (this.lowHealthAlarm & 0x80)) return;
    this.runCommands(c);
  }

  // Audio1_GetNextMusicByte, at command granularity
  nextCommand(c) {
    const s = this.cmdStream[c];
    if (!s) return null;
    const cmd = s.commands[this.cmdIndex[c]];
    this.cmdIndex[c]++;
    return cmd || null;
  }

  // Audio1_sound_ret ... Audio1_note: execute commands until one takes time
  runCommands(c) {
    for (let guard = 0; guard < 4096; guard++) {
      const cmd = this.nextCommand(c);
      if (!cmd) {
        this.warn(`channel ${c + 1}: command pointer ran off its stream; stopping the channel`);
        this.soundIds[c] = 0;
        return;
      }
      switch (cmd.op) {
        case 'sound_ret':
          if (this.cmdSoundRet(c)) continue;
          return;
        case 'sound_call':
          this.retStream[c] = this.cmdStream[c];
          this.retIndex[c] = this.cmdIndex[c];
          this.cmdIndex[c] = cmd.target;
          this.flags1[c] |= 1 << BIT_SOUND_CALL;
          continue;
        case 'sound_loop':
          if (cmd.count === 0) {
            if (c < CHAN5 && this.onMusicLoop) {
              if (this.onMusicLoop(c) === false) return;
            }
            this.cmdIndex[c] = cmd.target;
            continue;
          }
          if (this.loopCounters[c] === cmd.count) {
            this.loopCounters[c] = 1; // done looping: skip the pointer
            continue;
          }
          this.loopCounters[c] = (this.loopCounters[c] + 1) & 0xff;
          this.cmdIndex[c] = cmd.target;
          continue;
        case 'note_type':
        case 'drum_speed':
          this.cmdNoteType(c, cmd);
          continue;
        case 'toggle_perfect_pitch':
          this.flags1[c] ^= 1 << BIT_PERFECT_PITCH;
          continue;
        case 'vibrato': {
          this.vibratoDelayCounters[c] = cmd.delay;
          this.vibratoDelayCounterReloadValues[c] = cmd.delay;
          const n = cmd.depth & 0xf;
          this.vibratoExtents[c] = ((((n >> 1) + (n & 1)) << 4) | (n >> 1)) & 0xff;
          this.vibratoRates[c] = ((cmd.rate << 4) | cmd.rate) & 0xff;
          continue;
        }
        case 'pitch_slide': {
          this.pitchSlideLengthModifiers[c] = (cmd.length - 1) & 0xff;
          const de = calcFrequency(cmd.pitch, 8 - cmd.octave, this.pitchTable);
          this.pitchSlideTargetFrequencyHighBytes[c] = de >> 8;
          this.pitchSlideTargetFrequencyLowBytes[c] = de & 0xff;
          this.flags1[c] |= 1 << BIT_PITCH_SLIDE_ON;
          // the following byte is handed straight to Audio1_note_length
          const note = this.nextCommand(c);
          if (!note) return;
          this.noteLengthAndPitch(c, note);
          return;
        }
        case 'duty_cycle':
          this.dutyCycles[c] = (cmd.duty & 3) << 6;
          continue;
        case 'tempo':
          if (c < CHAN5) {
            this.musicTempo = cmd.tempo & 0xffff;
            this.noteDelayCountersFractionalPart.fill(0, 0, 4);
          } else {
            this.sfxTempo = cmd.tempo & 0xffff;
            this.noteDelayCountersFractionalPart.fill(0, 4, 8);
          }
          continue;
        case 'stereo_panning':
          this.stereoPanning = ((cmd.left << 4) | cmd.right) & 0xff;
          continue;
        case 'unknownmusic0xef':
          this.enginePlaySound(cmd.value);
          if (!this.disableChannelOutputWhenSfxEnds) {
            this.disableChannelOutputWhenSfxEnds = this.soundIds[CHAN8];
            this.soundIds[CHAN8] = 0;
          }
          continue;
        case 'duty_cycle_pattern': {
          const p = cmd.pattern;
          const v = ((p[0] << 6) | (p[1] << 4) | (p[2] << 2) | p[3]) & 0xff;
          this.dutyCyclePatterns[c] = v;
          this.dutyCycles[c] = v & 0xc0;
          this.flags1[c] |= 1 << BIT_ROTATE_DUTY_CYCLE;
          continue;
        }
        case 'volume':
          this.reg.write(NR50, ((cmd.left << 4) | cmd.right) & 0xff);
          continue;
        case 'execute_music':
          this.flags2[c] |= 1 << BIT_EXECUTE_MUSIC;
          continue;
        case 'octave':
          this.octaves[c] = (8 - cmd.octave) & 0xf;
          continue;
        case 'square_note':
        case 'noise_note':
          this.cmdSfxNote(c, cmd);
          return;
        case 'pitch_sweep':
          this.reg.write(NR10, ((cmd.length << 4) | nibSigned(cmd.change)) & 0xff);
          continue;
        case 'drum_note':
        case 'drum_note_short':
          this.cmdDrumNote(c, cmd);
          return;
        case 'note':
          if (c === CHAN4) {
            // Audio1_note on the noise channel: a 1-byte drum (instrument = high nybble)
            this.cmdDrumNote(c, { op: 'drum_note_short', instrument: cmd.pitch, length: cmd.length });
            return;
          }
          this.noteLengthAndPitch(c, cmd);
          return;
        case 'rest':
          this.noteLengthAndPitch(c, cmd);
          return;
        default:
          this.warn(`unknown command ${cmd.op}`);
          continue;
      }
    }
    this.warn(`channel ${c + 1}: no note after 4096 commands (endless loop); stopping the channel`);
    this.soundIds[c] = 0;
  }

  /** Audio1_sound_ret after reading $ff. Returns true when parsing continues (return from call). */
  cmdSoundRet(c) {
    if (this.flags1[c] & (1 << BIT_SOUND_CALL)) {
      this.flags1[c] &= ~(1 << BIT_SOUND_CALL);
      this.cmdStream[c] = this.retStream[c];
      this.cmdIndex[c] = this.retIndex[c];
      return true;
    }
    if (c < CHAN4) {
      this.reg.write(NR51, this.reg.read(NR51) & HW_DISABLE_MASK[c & 3]); // .disableChannelOutput
    } else {
      this.flags1[c] &= ~(1 << BIT_NOISE_OR_SFX);
      this.flags2[c] &= ~(1 << BIT_EXECUTE_MUSIC);
      if (c === CHAN7) {
        // restart hardware channel 3 (wave channel) output
        this.reg.write(NR30, 0x00);
        this.reg.write(NR30, AUD3ENA_ON);
        if (this.disableChannelOutputWhenSfxEnds) {
          this.disableChannelOutputWhenSfxEnds = 0;
          this.reg.write(NR51, this.reg.read(NR51) & HW_DISABLE_MASK[c & 3]);
        }
      }
    }
    // .afterDisable
    if (this.isCry()) {
      if (c !== CHAN5) {
        // Audio1_GoBackOneCommandIfCry: stay parked on this sound_ret until CHAN5 ends
        this.cmdIndex[c] -= 1;
        return false;
      }
      this.reg.write(NR50, this.savedVolume);
      this.savedVolume = 0;
    }
    this.soundIds[c] = 0;
    return false;
  }

  // Audio1_note_type (also drum_speed: the noise channel reads no parameter byte)
  cmdNoteType(c, cmd) {
    this.noteSpeeds[c] = cmd.speed & 0xf;
    if (c === CHAN4) return;
    let d;
    if (c === CHAN3 || c === CHAN7) {
      const wave = cmd.wave !== undefined ? cmd.wave : nibSigned(cmd.fade || 0);
      d = ((cmd.volume << 4) | wave) & 0xff;
      if (c === CHAN3) this.musicWaveInstrument = d & 0xf;
      else this.sfxWaveInstrument = d & 0xf;
      d = ((d & 0x30) << 1) & 0xff;
    } else {
      d = envelopeByte(cmd.volume, cmd.fade || 0);
    }
    this.volumes[c] = d;
  }

  // Audio1_note (noise channel, drum_note / drum_note_short)
  cmdDrumNote(c, cmd) {
    if (!this.disableChannelOutputWhenSfxEnds) this.enginePlaySound(cmd.instrument & 0xff);
    this.noteLengthAndPitch(c, cmd);
  }

  // Audio1_sfx_note: square_note / noise_note (raw register writes)
  cmdSfxNote(c, cmd) {
    const delay = this.computeNoteDelay(c, (cmd.length & 0xf) + 1);
    // "This code seems to do the same thing as Audio1_ApplyDutyCycleAndSoundLength" (unmasked)
    this.reg.write(this.regAddr(c, REG_DUTY_SOUND_LEN), (this.dutyCycles[c] | delay) & 0xff);
    this.reg.write(this.regAddr(c, REG_VOLUME_ENVELOPE), envelopeByte(cmd.volume, cmd.fade));
    let e, d;
    if (c === CHAN8) {
      e = cmd.value & 0xff;
      d = 0;
    } else {
      e = cmd.frequency & 0xff;
      d = (cmd.frequency >> 8) & 0xff;
    }
    this.applyDutyCycleAndSoundLength(c);
    this.enableChannelOutput(c);
    this.applyWavePatternAndFrequency(c, d, e);
  }

  // Audio1_note_length (+ the length part of the drum / sfx note paths)
  computeNoteDelay(c, length) {
    const a = (length * this.noteSpeeds[c]) & 0xff;
    let tempo;
    if (c < CHAN5) tempo = this.musicTempo;
    else if (c === CHAN8) tempo = 0x100;
    else {
      this.setSfxTempo();
      tempo = this.sfxTempo;
    }
    const hl = (this.noteDelayCountersFractionalPart[c] + a * tempo) & 0xffff;
    this.noteDelayCountersFractionalPart[c] = hl & 0xff;
    this.noteDelayCounters[c] = hl >> 8;
    return hl >> 8;
  }

  // Audio1_note_length followed by Audio1_note_pitch
  noteLengthAndPitch(c, cmd) {
    this.computeNoteDelay(c, cmd.length);
    if (!(this.flags2[c] & (1 << BIT_EXECUTE_MUSIC)) && (this.flags1[c] & (1 << BIT_NOISE_OR_SFX))) return;
    this.notePitch(c, cmd);
  }

  // Audio1_note_pitch
  notePitch(c, cmd) {
    if (cmd.op === 'rest') {
      if (c < CHAN5 && this.soundIds[c + 4] !== 0) return;
      if (c === CHAN3 || c === CHAN7) {
        this.reg.write(NR51, this.reg.read(NR51) & HW_DISABLE_MASK[2]);
        return;
      }
      this.reg.write(this.regAddr(c, REG_VOLUME_ENVELOPE), 0x08); // fade in sound (volume 0)
      this.reg.write(this.regAddr(c, REG_FREQUENCY_LO) + 1, 0x80); // restart sound
      return;
    }
    const pitch = cmd.op === 'note' ? cmd.pitch : 0; // drums never get here (NOISE_OR_SFX)
    const de = calcFrequency(pitch, this.octaves[c], this.pitchTable);
    if (this.flags1[c] & (1 << BIT_PITCH_SLIDE_ON)) this.initPitchSlideVars(c, de);
    if (c < CHAN5 && this.soundIds[c + 4] !== 0) return; // .noSfx
    this.reg.write(this.regAddr(c, REG_VOLUME_ENVELOPE), this.volumes[c]);
    this.applyDutyCycleAndSoundLength(c);
    this.enableChannelOutput(c);
    let d = de >> 8;
    let e = de & 0xff;
    if (this.flags1[c] & (1 << BIT_PERFECT_PITCH)) {
      // `inc e; jr nc` - inc never sets carry and carry is clear here, so d is never bumped
      e = (e + 1) & 0xff;
    }
    this.frequencyLowBytes[c] = e;
    this.applyWavePatternAndFrequency(c, d, e);
  }

  // Audio1_EnableChannelOutput
  enableChannelOutput(c) {
    const nr51 = this.reg.read(NR51);
    let d = nr51 | HW_ENABLE_MASK[c & 3];
    if (c === CHAN8 || (c < CHAN5 && this.soundIds[c + 4] === 0)) {
      const pan = this.stereoPanning & HW_ENABLE_MASK[c & 3];
      d = (nr51 & HW_DISABLE_MASK[c & 3]) | pan;
    }
    this.reg.write(NR51, d & 0xff);
  }

  // Audio1_ApplyDutyCycleAndSoundLength
  applyDutyCycleAndSoundLength(c) {
    let d = this.noteDelayCounters[c];
    if (c !== CHAN3 && c !== CHAN7) d = (d & 0x3f) | this.dutyCycles[c];
    this.reg.write(this.regAddr(c, REG_DUTY_SOUND_LEN), d & 0xff);
  }

  // Audio1_ApplyWavePatternAndFrequency
  applyWavePatternAndFrequency(c, d, e) {
    if (c === CHAN3 || c === CHAN7) {
      const inst = c === CHAN3 ? this.musicWaveInstrument : this.sfxWaveInstrument;
      const table = this.waves[this.engineBank] || this.waves[1];
      const bytes = table && table[inst];
      this.reg.write(NR30, 0); // stop hardware channel 3
      for (let i = 0; i < 16; i++) this.reg.write(WAVE_RAM + i, bytes ? bytes[i] : 0);
      this.reg.write(NR30, AUD3ENA_ON); // start hardware channel 3
      if (!bytes) this.warn(`missing wave instrument ${inst} for bank ${this.engineBank}`);
    }
    d = ((d | 0x80) & 0xc7) & 0xff; // trigger; keep the length-enable bit and frequency bits
    const lo = this.regAddr(c, REG_FREQUENCY_LO);
    this.reg.write(lo, e & 0xff);
    this.reg.write(lo + 1, d);
    // engine_2.asm only applies the modifier to SFX channels
    if (this.engineBank !== 2 || c >= CHAN5) this.applyFrequencyModifier(c, d, e);
  }

  // Audio1_ApplyFrequencyModifier (cries; engine 2 also battle SFX)
  applyFrequencyModifier(c, d, e) {
    if (!this.isCryOrBattleSfx()) return;
    const a = e + this.frequencyModifier;
    if (a > 0xff) d = (d + 1) & 0xff;
    const lo = this.regAddr(c, REG_FREQUENCY_LO);
    this.reg.write(lo, a & 0xff);
    this.reg.write(lo + 1, d);
  }

  // Audio1_SetSfxTempo
  setSfxTempo() {
    if (this.isCryOrBattleSfx()) this.sfxTempo = (this.tempoModifier + 0x80) & 0x1ff;
    else this.sfxTempo = 0x100;
  }

  // Audio1_IsCry
  isCry() {
    const id = this.soundIds[CHAN5];
    return id >= this.k.CRY_SFX_START && id < this.k.CRY_SFX_END;
  }

  // Audio2_IsBattleSFX (note: ORs the CHAN8 and CHAN5 ids, as the original does)
  isBattleSfx() {
    const id = this.soundIds[CHAN8] | this.soundIds[CHAN5];
    return id >= this.k.BATTLE_SFX_START && id < this.k.BATTLE_SFX_END;
  }

  isCryOrBattleSfx() {
    if (this.isCry()) return true;
    return this.engineBank === 2 && this.isBattleSfx();
  }

  // Audio1_ApplyPitchSlide
  applyPitchSlide(c) {
    const th = this.pitchSlideTargetFrequencyHighBytes[c];
    const tl = this.pitchSlideTargetFrequencyLowBytes[c];
    let d, e, reached;
    if (!(this.flags1[c] & (1 << BIT_PITCH_SLIDE_DECREASING))) {
      let de = (this.pitchSlideCurrentFrequencyHighBytes[c] << 8) | this.pitchSlideCurrentFrequencyLowBytes[c];
      de = (de + this.pitchSlideFrequencySteps[c]) & 0xffff;
      const frac = this.pitchSlideFrequencyStepsFractionalPart[c] + this.pitchSlideCurrentFrequencyFractionalPart[c];
      this.pitchSlideCurrentFrequencyFractionalPart[c] = frac & 0xff;
      const c1 = frac > 0xff ? 1 : 0;
      e = (de & 0xff) + c1;
      const c2 = e > 0xff ? 1 : 0;
      e &= 0xff;
      d = ((de >> 8) + c2) & 0xff;
      if (th < d) reached = true;
      else if (th !== d) reached = false;
      else reached = tl < e;
    } else {
      let t = this.pitchSlideCurrentFrequencyLowBytes[c] - this.pitchSlideFrequencySteps[c];
      const c1 = t < 0 ? 1 : 0;
      e = t & 0xff;
      d = (this.pitchSlideCurrentFrequencyHighBytes[c] - c1) & 0xff;
      // `add a` on the steps' fractional part: it doubles every frame (a bug kept as is)
      const sf = this.pitchSlideFrequencyStepsFractionalPart[c] * 2;
      const c2 = sf > 0xff ? 1 : 0;
      this.pitchSlideFrequencyStepsFractionalPart[c] = sf & 0xff;
      t = e - c2;
      const c3 = t < 0 ? 1 : 0;
      e = t & 0xff;
      d = (d - c3) & 0xff;
      if (d < th) reached = true;
      else if (d !== th) reached = false;
      else reached = e < tl;
    }
    if (reached) {
      this.flags1[c] &= ~((1 << BIT_PITCH_SLIDE_ON) | (1 << BIT_PITCH_SLIDE_DECREASING));
      return;
    }
    this.pitchSlideCurrentFrequencyLowBytes[c] = e;
    this.pitchSlideCurrentFrequencyHighBytes[c] = d;
    const lo = this.regAddr(c, REG_FREQUENCY_LO);
    this.reg.write(lo, e);
    this.reg.write(lo + 1, d);
  }

  // Audio1_InitPitchSlideVars
  initPitchSlideVars(c, de) {
    let d = de >> 8;
    let e = de & 0xff;
    this.pitchSlideCurrentFrequencyHighBytes[c] = d;
    this.pitchSlideCurrentFrequencyLowBytes[c] = e;
    let a = this.noteDelayCounters[c] - this.pitchSlideLengthModifiers[c];
    if (a < 0) a = 1;
    this.pitchSlideLengthModifiers[c] = a & 0xff;
    const tl = this.pitchSlideTargetFrequencyLowBytes[c];
    const th = this.pitchSlideTargetFrequencyHighBytes[c];
    let t = e - tl;
    const c1 = t < 0 ? 1 : 0;
    e = t & 0xff;
    const a2 = (d - c1) & 0xff;
    if (a2 >= th) {
      d = (a2 - th) & 0xff;
      this.flags1[c] |= 1 << BIT_PITCH_SLIDE_DECREASING;
    } else {
      // target greater: |target - current|, borrowing from the *current* high byte (bug)
      d = this.pitchSlideCurrentFrequencyHighBytes[c];
      e = this.pitchSlideCurrentFrequencyLowBytes[c];
      t = tl - e;
      const c2 = t < 0 ? 1 : 0;
      e = t & 0xff;
      d = (d - c2) & 0xff;
      d = (th - d) & 0xff;
      this.flags1[c] &= ~(1 << BIT_PITCH_SLIDE_DECREASING);
    }
    // .divideLoop: steps = quotient + 1, fraction = remainder
    const m = this.pitchSlideLengthModifiers[c];
    let steps, rem;
    if (m === 0) {
      // the original would spin forever here; never happens with the game's data
      this.warn(`pitch slide with zero length on channel ${c + 1}`);
      steps = 0;
      rem = 0;
    } else {
      const v = (d << 8) | e;
      steps = (Math.floor(v / m) + 1) & 0xff;
      rem = v % m;
    }
    this.pitchSlideFrequencySteps[c] = steps;
    this.pitchSlideFrequencyStepsFractionalPart[c] = rem;
    this.pitchSlideCurrentFrequencyFractionalPart[c] = rem;
  }

  // Audio1_ApplyDutyCyclePattern
  applyDutyCyclePattern(c) {
    let p = this.dutyCyclePatterns[c];
    p = ((p << 2) | (p >> 6)) & 0xff; // rlca x2
    this.dutyCyclePatterns[c] = p;
    const addr = this.regAddr(c, REG_DUTY_SOUND_LEN);
    this.reg.write(addr, (this.reg.read(addr) & 0x3f) | (p & 0xc0));
  }

  // Audio1_GetRegisterPointer
  regAddr(c, b) {
    return HW_CH_BASE[c & 3] + b;
  }

  // ------------------------------------------------------------------------------------
  // Audio1_PlaySound (engine level: id within the bank whose engine is running)
  // ------------------------------------------------------------------------------------

  /**
   * @param {number} id sound id in the current engine bank
   * @param {Sound} [headerOverride] play this header under `id` instead of the bank's own
   *   (used for synthetic headers and cross-bank SFX; not something the original can do)
   */
  enginePlaySound(id, headerOverride) {
    id &= 0xff;
    this.soundID = id;
    if (id === SFX_STOP_ALL_MUSIC) {
      this.stopAllAudio();
      return;
    }
    const max = this.k[`MAX_SFX_ID_${this.engineBank}`];
    if (id <= max || id > 0xfe) this.playSfxHeader(id, headerOverride);
    else this.playMusicHeader(id, headerOverride);
  }

  // .playMusic
  playMusicHeader(id, headerOverride) {
    const header = headerOverride || this.getHeader(this.engineBank, id);
    if (!header) {
      this.warn(`no music header ${id} loaded in bank ${this.engineBank}`);
      return;
    }
    this.unusedMusicByte = 0;
    this.disableChannelOutputWhenSfxEnds = 0;
    this.musicTempo &= 0xff00;
    this.musicWaveInstrument = 0;
    this.sfxWaveInstrument = 0;
    for (let c = 0; c < NUM_CHANNELS; c++) {
      this.retStream[c] = null;
      this.retIndex[c] = 0;
      this.cmdStream[c] = null;
      this.cmdIndex[c] = 0;
    }
    for (let c = 0; c < NUM_MUSIC_CHANS; c++) {
      this.resetChannel(c);
      this.soundIds[c] = 0;
    }
    this.musicTempo = (1 << 8) | (this.musicTempo & 0xff);
    this.stereoPanning = 0xff;
    this.reg.write(NR50, 0);
    this.reg.write(NR10, AUD1SWEEP_DOWN);
    this.reg.write(NR51, 0);
    this.reg.write(NR30, 0);
    this.reg.write(NR30, AUD3ENA_ON);
    this.reg.write(NR50, 0x77);
    this.playSoundCommon(header);
  }

  // .playSfx
  playSfxHeader(id, headerOverride) {
    const header = headerOverride || this.getHeader(this.engineBank, id);
    if (!header) {
      this.warn(`no sfx header ${id} loaded in bank ${this.engineBank}`);
      return;
    }
    const entries = header.channels;
    for (let k = entries.length - 1; k >= 0; k--) {
      const ch = entries[k].channel - 1;
      const cur = this.soundIds[ch];
      if (cur !== 0) {
        let allowed;
        if (ch === CHAN8) {
          if (id < this.k.NOISE_INSTRUMENTS_END) return; // a drum never interrupts CHAN8
          allowed = cur <= this.k.NOISE_INSTRUMENTS_END || id <= cur;
        } else {
          allowed = id <= cur;
        }
        if (!allowed) return; // aborts the whole PlaySound (channels already reset stay reset)
      }
      // .playChannel
      this.retStream[ch] = null;
      this.retIndex[ch] = 0;
      this.cmdStream[ch] = null;
      this.cmdIndex[ch] = 0;
      this.soundIds[ch] = 0;
      this.resetChannel(ch);
      if (ch === CHAN5) this.reg.write(NR10, AUD1SWEEP_DOWN); // sweep off
    }
    this.playSoundCommon(header);
  }

  /** Clear the per-channel state that .playMusic / .playChannel clear. */
  resetChannel(c) {
    this.flags1[c] = 0;
    this.dutyCycles[c] = 0;
    this.dutyCyclePatterns[c] = 0;
    this.vibratoDelayCounters[c] = 0;
    this.vibratoExtents[c] = 0;
    this.vibratoRates[c] = 0;
    this.frequencyLowBytes[c] = 0;
    this.vibratoDelayCounterReloadValues[c] = 0;
    this.flags2[c] = 0;
    this.pitchSlideLengthModifiers[c] = 0;
    this.pitchSlideFrequencySteps[c] = 0;
    this.pitchSlideFrequencyStepsFractionalPart[c] = 0;
    this.pitchSlideCurrentFrequencyFractionalPart[c] = 0;
    this.pitchSlideCurrentFrequencyHighBytes[c] = 0;
    this.pitchSlideCurrentFrequencyLowBytes[c] = 0;
    this.pitchSlideTargetFrequencyHighBytes[c] = 0;
    this.pitchSlideTargetFrequencyLowBytes[c] = 0;
    this.loopCounters[c] = 1;
    this.noteDelayCounters[c] = 1;
    this.noteSpeeds[c] = 1;
  }

  // .playSoundCommon
  playSoundCommon(header) {
    const id = this.soundID;
    for (const stream of header.channels) {
      const c = stream.channel - 1;
      this.cmdStream[c] = stream;
      this.cmdIndex[c] = stream.entry || 0;
      this.soundIds[c] = id;
      if (c >= CHAN4) this.flags1[c] |= 1 << BIT_NOISE_OR_SFX;
    }
    if (id >= this.k.CRY_SFX_START && id < this.k.CRY_SFX_END) {
      for (let c = CHAN5; c <= CHAN8; c++) this.soundIds[c] = id;
      this.cmdStream[CHAN7] = CRY_RET_STREAM;
      this.cmdIndex[CHAN7] = 0;
      if (this.savedVolume === 0) {
        this.savedVolume = this.reg.read(NR50);
        this.reg.write(NR50, 0x77); // full volume
      }
    }
  }

  // .stopAllAudio
  stopAllAudio() {
    this.reg.write(NR52, AUDENA_ON);
    this.reg.write(NR30, AUDENA_ON);
    this.reg.write(NR51, 0);
    this.reg.write(NR32, 0);
    this.reg.write(NR10, AUD1SWEEP_DOWN);
    this.reg.write(NR12, AUD1SWEEP_DOWN);
    this.reg.write(NR22, AUD1SWEEP_DOWN);
    this.reg.write(NR42, AUD1SWEEP_DOWN);
    this.reg.write(NR14, AUD1HIGH_LENGTH_ON);
    this.reg.write(NR24, AUD1HIGH_LENGTH_ON);
    this.reg.write(NR44, AUD1HIGH_LENGTH_ON);
    this.reg.write(NR50, 0x77);
    this.unusedMusicByte = 0;
    this.disableChannelOutputWhenSfxEnds = 0;
    this.muteAudioAndPauseMusic = 0;
    this.musicTempo &= 0xff00;
    this.sfxTempo &= 0xff00;
    this.musicWaveInstrument = 0;
    this.sfxWaveInstrument = 0;
    // FillMem $a0 bytes from wChannelCommandPointers with 0
    for (let c = 0; c < NUM_CHANNELS; c++) {
      this.cmdStream[c] = null;
      this.cmdIndex[c] = 0;
      this.retStream[c] = null;
      this.retIndex[c] = 0;
    }
    for (const arr of [this.soundIds, this.flags1, this.flags2, this.dutyCycles, this.dutyCyclePatterns,
      this.vibratoDelayCounters, this.vibratoExtents, this.vibratoRates, this.frequencyLowBytes,
      this.vibratoDelayCounterReloadValues, this.pitchSlideLengthModifiers, this.pitchSlideFrequencySteps,
      this.pitchSlideFrequencyStepsFractionalPart, this.pitchSlideCurrentFrequencyFractionalPart,
      this.pitchSlideCurrentFrequencyHighBytes, this.pitchSlideCurrentFrequencyLowBytes]) arr.fill(0);
    // FillMem $18 bytes from wChannelNoteDelayCounters with 1
    this.noteDelayCounters.fill(1);
    this.loopCounters.fill(1);
    this.noteSpeeds.fill(1);
    this.musicTempo = 0x100;
    this.sfxTempo = 0x100;
    this.stereoPanning = 0xff;
  }

  // ------------------------------------------------------------------------------------
  // home/audio.asm, home/fade_audio.asm
  // ------------------------------------------------------------------------------------

  /** PlaySound (home bank): a = id, played by the engine of wAudioROMBank. */
  playSound(id, headerOverride) {
    const b = id & 0xff;
    if (this.newSoundID !== 0) {
      for (let c = CHAN5; c <= CHAN8; c++) this.soundIds[c] = 0;
    }
    if (this.audioFadeOutControl !== 0) {
      if (this.newSoundID === 0) return;
      this.newSoundID = 0;
      if (this.lastMusicSoundID !== 0xff) {
        // .fadeOut: fade the current music, then play b
        this.lastMusicSoundID = b;
        this.audioFadeOutCounterReloadValue = this.audioFadeOutControl;
        this.audioFadeOutCounter = this.audioFadeOutControl;
        this.audioFadeOutControl = b;
        this.pendingHeaderAfterFade = headerOverride || null;
        return;
      }
      this.audioFadeOutControl = 0;
    }
    this.newSoundID = 0;
    this.engineBank = this.audioROMBank;
    this.enginePlaySound(b, headerOverride);
  }

  /** PlayMusic: c = bank, a = id. */
  playMusic(bank, id, headerOverride) {
    this.newSoundID = id & 0xff;
    this.audioFadeOutControl = 0;
    this.audioROMBank = bank;
    this.audioSavedROMBank = bank;
    this.playSound(id, headerOverride);
  }

  /** `ld a, SFX_STOP_ALL_MUSIC; ld [wNewSoundID], a; call PlaySound` */
  stopAll() {
    this.newSoundID = SFX_STOP_ALL_MUSIC;
    this.playSound(SFX_STOP_ALL_MUSIC);
  }

  /**
   * PlayDefaultMusicCommon's fade path: fade the current music out (one NR50 step every
   * rate+1 frames, 8 steps) and then play (bank, id). rate 10 = map change, 8 = after battle.
   */
  fadeToMusic(bank, id, rate = 10, headerOverride) {
    this.audioSavedROMBank = bank;
    this.audioFadeOutControl = rate & 0xff;
    this.lastMusicSoundID = id & 0xff;
    this.newSoundID = id & 0xff;
    this.playSound(id, headerOverride);
  }

  /** Fade out and stop (what Music_Cities1AlternateTempo does with wAudioFadeOutControl = $ff). */
  fadeOutMusic(rate = 10) {
    this.audioFadeOutCounterReloadValue = rate & 0xff;
    this.audioFadeOutCounter = rate & 0xff;
    this.audioFadeOutControl = 0xff;
    this.audioSavedROMBank = this.audioROMBank;
    this.pendingHeaderAfterFade = null;
  }

  // FadeOutAudio
  fadeOutAudio() {
    if (this.audioFadeOutControl === 0) {
      if (this.noAudioFadeOut) return;
      this.reg.write(NR50, 0x77);
      return;
    }
    if (this.audioFadeOutCounter !== 0) {
      this.audioFadeOutCounter--;
      return;
    }
    this.audioFadeOutCounter = this.audioFadeOutCounterReloadValue;
    const v = this.reg.read(NR50);
    if (v !== 0) {
      const c = ((v & 0x0f) - 1) & 0xff;
      const hi = swapNibbles((((v & 0xf0) >> 4) - 1) & 0xff);
      this.reg.write(NR50, (hi | c) & 0xff);
      return;
    }
    // .fadeOutComplete
    const b = this.audioFadeOutControl;
    const header = this.pendingHeaderAfterFade;
    this.pendingHeaderAfterFade = null;
    this.audioFadeOutControl = 0;
    this.newSoundID = SFX_STOP_ALL_MUSIC;
    this.playSound(SFX_STOP_ALL_MUSIC);
    this.audioROMBank = this.audioSavedROMBank;
    this.newSoundID = b;
    this.playSound(b, header || undefined);
  }

  // ------------------------------------------------------------------------------------
  // audio/low_health_alarm.asm (runs before Audio2_UpdateMusic when bank 2 is loaded)
  // ------------------------------------------------------------------------------------

  doLowHealthAlarm() {
    const a = this.lowHealthAlarm;
    if (a === DISABLE_LOW_HEALTH_ALARM) {
      this.lowHealthAlarm = 0;
      this.soundIds[CHAN5] = 0;
      this.playAlarmTone(0x00, 0x00, 0x8000);
      return;
    }
    if (!(a & 0x80)) return;
    const t = a & 0x7f;
    if (t === 0) {
      this.playAlarmTone(0xa0, 0xe2, 0x8750);
      this.lowHealthAlarm = 30 | 0x80;
      return;
    }
    if (t === 20) this.playAlarmTone(0xb0, 0xe2, 0x86ee);
    this.soundIds[CHAN5] = this.k.CRY_SFX_END;
    this.lowHealthAlarm = ((t - 1) & 0x7f) | 0x80;
  }

  playAlarmTone(length, envelope, frequency) {
    this.reg.write(NR10, 0);
    this.reg.write(NR11, length);
    this.reg.write(NR12, envelope);
    this.reg.write(NR13, frequency & 0xff);
    this.reg.write(NR14, (frequency >> 8) & 0xff);
  }

  /** The battle engine's switch (engine/battle/core.asm DrawPlayerHUDAndHPBar). */
  setLowHealthAlarm(on) {
    if (on) {
      this.lowHealthAlarm |= 0x80;
    } else if (this.lowHealthAlarm & 0x80) {
      this.lowHealthAlarm = 0;
      this.soundIds[CHAN5] = 0;
    }
  }

  // ------------------------------------------------------------------------------------
  // helpers for the player / tests
  // ------------------------------------------------------------------------------------

  /** Override a channel's command pointer (Audio1_OverwriteChannelPointer). */
  overwriteChannelPointer(channel, stream, index = 0) {
    this.cmdStream[channel - 1] = stream;
    this.cmdIndex[channel - 1] = index;
  }

  /** True while any of the music channels (1-4) holds a sound. */
  isMusicPlaying() {
    for (let c = 0; c < NUM_MUSIC_CHANS; c++) if (this.soundIds[c] !== 0) return true;
    return false;
  }

  /** WaitForSoundToFinish's condition: CHAN5, CHAN6 or CHAN8 busy (ignores the alarm). */
  isSfxPlaying() {
    return (this.soundIds[CHAN5] | this.soundIds[CHAN6] | this.soundIds[CHAN8]) !== 0;
  }
}
