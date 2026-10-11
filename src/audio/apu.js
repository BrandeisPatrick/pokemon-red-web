// Software Game Boy (DMG) APU: two pulse channels (CH1 with frequency sweep), the wave
// channel and the noise channel, mixed through NR50/NR51 like the hardware.
//
// Not cycle-exact: register writes are applied between output samples and each channel's
// output is box-filtered (integrated) over the output sample period, which keeps the
// pitches exact and removes most of the aliasing a naive sampler would produce.
// The 512 Hz frame sequencer (length 256 Hz, sweep 128 Hz, envelope 64 Hz) is clocked from
// the same cycle counter, so all timing derives from the sample clock.
//
// Pure JS (no Web Audio): used by apu.worklet.js in the browser and offline.js in node.

export const CPU_CLOCK = 4194304; // T-cycles per second
export const CYCLES_PER_FRAME = 70224; // one LCD frame
export const FRAME_RATE = CPU_CLOCK / CYCLES_PER_FRAME; // 59.7275 Hz
const FRAME_SEQ_PERIOD = 8192; // 512 Hz

// pandocs "Pulse channel" duty waveforms (8 steps)
const DUTY = [
  [0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
];
const NOISE_DIVISORS = [8, 16, 32, 48, 64, 80, 96, 112];

// Transparent below |x| = 0.85; above, a smooth knee that never exceeds 1.0 (the mix of four
// full-scale channels plus the high-pass overshoot can briefly exceed the gain headroom).
const KNEE = 0.85;
function softClip(x) {
  if (x > KNEE) return KNEE + (1 - KNEE) * Math.tanh((x - KNEE) / (1 - KNEE));
  if (x < -KNEE) return -KNEE - (1 - KNEE) * Math.tanh((-x - KNEE) / (1 - KNEE));
  return x;
}

// bits that read back as 1 (pandocs "Audio Registers")
const READ_OR = new Uint8Array(0x40).fill(0xff);
Object.entries({
  0x10: 0x80, 0x11: 0x3f, 0x12: 0x00, 0x13: 0xff, 0x14: 0xbf,
  0x16: 0x3f, 0x17: 0x00, 0x18: 0xff, 0x19: 0xbf,
  0x1a: 0x7f, 0x1b: 0xff, 0x1c: 0x9f, 0x1d: 0xff, 0x1e: 0xbf,
  0x20: 0xff, 0x21: 0x00, 0x22: 0x00, 0x23: 0xbf,
  0x24: 0x00, 0x25: 0x00, 0x26: 0x70,
}).forEach(([a, v]) => { READ_OR[a] = v; });
for (let a = 0x30; a < 0x40; a++) READ_OR[a] = 0;

class Envelope {
  constructor() { this.initial = 0; this.up = false; this.period = 0; this.volume = 0; this.timer = 0; }
  write(v) { this.initial = v >> 4; this.up = (v & 8) !== 0; this.period = v & 7; }
  trigger() { this.volume = this.initial; this.timer = this.period || 8; }
  clock() {
    if (this.period === 0) return;
    if (--this.timer <= 0) {
      this.timer = this.period;
      if (this.up && this.volume < 15) this.volume++;
      else if (!this.up && this.volume > 0) this.volume--;
    }
  }
}

class PulseChannel {
  constructor(hasSweep) {
    this.hasSweep = hasSweep;
    this.env = new Envelope();
    this.reset();
  }
  reset() {
    this.enabled = false; this.dac = false;
    this.duty = 0; this.step = 0; this.freq = 0; this.timer = 8192;
    this.length = 0; this.lengthEnable = false;
    this.env.write(0); this.env.volume = 0;
    this.sweepPace = 0; this.sweepDown = false; this.sweepShift = 0;
    this.sweepTimer = 8; this.sweepEnabled = false; this.shadow = 0;
  }
  period() { return (2048 - this.freq) * 4; }
  sweepCalc() {
    const delta = this.shadow >> this.sweepShift;
    const f = this.sweepDown ? this.shadow - delta : this.shadow + delta;
    if (f > 2047) this.enabled = false;
    return f;
  }
  trigger() {
    this.enabled = this.dac;
    if (this.length === 0) this.length = 64;
    this.timer = this.period();
    this.env.trigger();
    if (this.hasSweep) {
      this.shadow = this.freq;
      this.sweepTimer = this.sweepPace || 8;
      this.sweepEnabled = this.sweepPace !== 0 || this.sweepShift !== 0;
      if (this.sweepShift !== 0) this.sweepCalc();
    }
  }
  clockLength() {
    if (this.lengthEnable && this.length > 0 && --this.length === 0) this.enabled = false;
  }
  clockSweep() {
    if (--this.sweepTimer > 0) return;
    this.sweepTimer = this.sweepPace || 8;
    if (!this.sweepEnabled || this.sweepPace === 0) return;
    const f = this.sweepCalc();
    if (f <= 2047 && this.sweepShift !== 0) {
      this.shadow = f;
      this.freq = f;
      this.sweepCalc();
    }
  }
  level() { return DUTY[this.duty][this.step] ? this.env.volume : 0; }
  /** integrated digital output (0..15) * cycles over `cycles` T-cycles */
  run(cycles) {
    if (!this.enabled) return 0;
    let acc = 0;
    let left = cycles;
    const per = this.period();
    while (left >= this.timer) {
      acc += this.level() * this.timer;
      left -= this.timer;
      this.step = (this.step + 1) & 7;
      this.timer = per;
      if (left >= per * 8) {
        // whole periods: add their average directly
        const n = Math.floor(left / (per * 8));
        let sum = 0;
        for (let i = 0; i < 8; i++) sum += DUTY[this.duty][i];
        acc += sum * this.env.volume * per * n;
        left -= n * per * 8;
      }
    }
    acc += this.level() * left;
    this.timer -= left;
    return acc;
  }
}

class WaveChannel {
  constructor() { this.ram = new Uint8Array(16); this.reset(); }
  reset() {
    this.enabled = false; this.dac = false;
    this.length = 0; this.lengthEnable = false;
    this.levelCode = 0; this.freq = 0; this.timer = 4096; this.pos = 0; this.sample = 0;
  }
  period() { return (2048 - this.freq) * 2; }
  trigger() {
    this.enabled = this.dac;
    if (this.length === 0) this.length = 256;
    this.timer = this.period() + 6; // first sample fetch is slightly delayed on hardware
    this.pos = 0;
  }
  clockLength() {
    if (this.lengthEnable && this.length > 0 && --this.length === 0) this.enabled = false;
  }
  nibble(i) { const b = this.ram[i >> 1]; return i & 1 ? b & 0xf : b >> 4; }
  out() {
    const shift = [4, 0, 1, 2][this.levelCode];
    return shift === 4 ? 0 : this.sample >> shift;
  }
  run(cycles) {
    if (!this.enabled) return 0;
    let acc = 0;
    let left = cycles;
    const per = this.period();
    while (left >= this.timer) {
      acc += this.out() * this.timer;
      left -= this.timer;
      this.pos = (this.pos + 1) & 31;
      this.sample = this.nibble(this.pos);
      this.timer = per;
    }
    acc += this.out() * left;
    this.timer -= left;
    return acc;
  }
}

class NoiseChannel {
  constructor() { this.env = new Envelope(); this.reset(); }
  reset() {
    this.enabled = false; this.dac = false;
    this.length = 0; this.lengthEnable = false;
    this.shift = 0; this.width7 = false; this.divisor = 0;
    this.lfsr = 0x7fff; this.timer = 8;
    this.env.write(0); this.env.volume = 0;
  }
  period() { return NOISE_DIVISORS[this.divisor] << this.shift; }
  trigger() {
    this.enabled = this.dac;
    if (this.length === 0) this.length = 64;
    this.timer = this.period();
    this.env.trigger();
    this.lfsr = 0x7fff;
  }
  clockLength() {
    if (this.lengthEnable && this.length > 0 && --this.length === 0) this.enabled = false;
  }
  stepLfsr() {
    const x = (this.lfsr ^ (this.lfsr >> 1)) & 1;
    this.lfsr = (this.lfsr >> 1) | (x << 14);
    if (this.width7) this.lfsr = (this.lfsr & ~0x40) | (x << 6);
  }
  level() { return (this.lfsr & 1) ? 0 : this.env.volume; }
  run(cycles) {
    if (!this.enabled) return 0;
    if (this.shift >= 14) return this.level() * cycles; // no clocks reach the LFSR
    let acc = 0;
    let left = cycles;
    const per = this.period();
    while (left >= this.timer) {
      acc += this.level() * this.timer;
      left -= this.timer;
      this.stepLfsr();
      this.timer = per;
    }
    acc += this.level() * left;
    this.timer -= left;
    return acc;
  }
}

export class GbApu {
  /** @param {number} sampleRate output sample rate in Hz */
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.cyclesPerSample = CPU_CLOCK / sampleRate;
    this.ch1 = new PulseChannel(true);
    this.ch2 = new PulseChannel(false);
    this.ch3 = new WaveChannel();
    this.ch4 = new NoiseChannel();
    this.regs = new Uint8Array(0x40);
    this.power = true;
    this.seqTimer = FRAME_SEQ_PERIOD;
    this.seqStep = 0;
    // DMG high-pass ("capacitor") filter: charge factor 0.999958 per T-cycle
    this.hpCharge = Math.pow(0.999958, this.cyclesPerSample);
    this.capL = 0;
    this.capR = 0;
    this.gain = 0.2; // headroom: four full-scale channels plus high-pass overshoot stay below 1
    this.muted = [false, false, false, false];
    /** last per-channel analog level, for visualizers */
    this.levels = new Float32Array(4);
    this.reset();
  }

  reset() {
    this.ch1.reset(); this.ch2.reset(); this.ch3.reset(); this.ch4.reset();
    this.regs.fill(0);
    this.regs[0x26] = 0x80;
    this.regs[0x24] = 0x77;
    this.regs[0x25] = 0xff;
    this.power = true;
  }

  read(addr) {
    addr &= 0x3f;
    if (addr === 0x26) {
      return (this.power ? 0x80 : 0) | 0x70 |
        (this.ch1.enabled ? 1 : 0) | (this.ch2.enabled ? 2 : 0) | (this.ch3.enabled ? 4 : 0) | (this.ch4.enabled ? 8 : 0);
    }
    if (addr >= 0x30) return this.ch3.ram[addr - 0x30];
    return (this.regs[addr] | READ_OR[addr]) & 0xff;
  }

  write(addr, v) {
    addr &= 0x3f;
    v &= 0xff;
    if (addr >= 0x30) {
      this.ch3.ram[addr - 0x30] = v;
      return;
    }
    if (addr === 0x26) {
      const on = (v & 0x80) !== 0;
      if (!on && this.power) {
        for (let a = 0x10; a < 0x26; a++) this.write(a, 0);
        this.ch1.reset(); this.ch2.reset(); this.ch3.reset(); this.ch4.reset();
      }
      this.power = on;
      this.regs[0x26] = v & 0x80;
      return;
    }
    if (!this.power) return;
    this.regs[addr] = v;
    const c1 = this.ch1, c2 = this.ch2, c3 = this.ch3, c4 = this.ch4;
    switch (addr) {
      case 0x10:
        c1.sweepPace = (v >> 4) & 7; c1.sweepDown = (v & 8) !== 0; c1.sweepShift = v & 7;
        break;
      case 0x11: c1.duty = v >> 6; c1.length = 64 - (v & 0x3f); break;
      case 0x12: c1.env.write(v); c1.dac = (v & 0xf8) !== 0; if (!c1.dac) c1.enabled = false; break;
      case 0x13: c1.freq = (c1.freq & 0x700) | v; break;
      case 0x14:
        c1.freq = (c1.freq & 0xff) | ((v & 7) << 8); c1.lengthEnable = (v & 0x40) !== 0;
        if (v & 0x80) c1.trigger();
        break;
      case 0x16: c2.duty = v >> 6; c2.length = 64 - (v & 0x3f); break;
      case 0x17: c2.env.write(v); c2.dac = (v & 0xf8) !== 0; if (!c2.dac) c2.enabled = false; break;
      case 0x18: c2.freq = (c2.freq & 0x700) | v; break;
      case 0x19:
        c2.freq = (c2.freq & 0xff) | ((v & 7) << 8); c2.lengthEnable = (v & 0x40) !== 0;
        if (v & 0x80) c2.trigger();
        break;
      case 0x1a: c3.dac = (v & 0x80) !== 0; if (!c3.dac) c3.enabled = false; break;
      case 0x1b: c3.length = 256 - v; break;
      case 0x1c: c3.levelCode = (v >> 5) & 3; break;
      case 0x1d: c3.freq = (c3.freq & 0x700) | v; break;
      case 0x1e:
        c3.freq = (c3.freq & 0xff) | ((v & 7) << 8); c3.lengthEnable = (v & 0x40) !== 0;
        if (v & 0x80) c3.trigger();
        break;
      case 0x20: c4.length = 64 - (v & 0x3f); break;
      case 0x21: c4.env.write(v); c4.dac = (v & 0xf8) !== 0; if (!c4.dac) c4.enabled = false; break;
      case 0x22: c4.shift = v >> 4; c4.width7 = (v & 8) !== 0; c4.divisor = v & 7; break;
      case 0x23:
        c4.lengthEnable = (v & 0x40) !== 0;
        if (v & 0x80) c4.trigger();
        break;
      default:
        break;
    }
  }

  clockFrameSequencer() {
    const s = this.seqStep;
    if ((s & 1) === 0) {
      this.ch1.clockLength(); this.ch2.clockLength(); this.ch3.clockLength(); this.ch4.clockLength();
    }
    if (s === 2 || s === 6) this.ch1.clockSweep();
    if (s === 7) { this.ch1.env.clock(); this.ch2.env.clock(); this.ch4.env.clock(); }
    this.seqStep = (s + 1) & 7;
  }

  /**
   * Render `count` samples into left/right starting at `offset`.
   * @param {Float32Array} left
   * @param {Float32Array} right
   */
  render(left, right, offset, count) {
    const cps = this.cyclesPerSample;
    const inv = 1 / cps;
    const chans = this._chans || (this._chans = [this.ch1, this.ch2, this.ch3, this.ch4]);
    const acc = this._acc || (this._acc = new Float64Array(4));
    const lv = this.levels;
    for (let i = 0; i < count; i++) {
      // the frame sequencer may tick inside this sample: split the integration there
      let remaining = cps;
      acc[0] = acc[1] = acc[2] = acc[3] = 0;
      while (remaining > 0) {
        const span = remaining < this.seqTimer ? remaining : this.seqTimer;
        acc[0] += chans[0].run(span);
        acc[1] += chans[1].run(span);
        acc[2] += chans[2].run(span);
        acc[3] += chans[3].run(span);
        remaining -= span;
        this.seqTimer -= span;
        if (this.seqTimer <= 1e-9) {
          this.seqTimer += FRAME_SEQ_PERIOD;
          this.clockFrameSequencer();
        }
      }
      const nr50 = this.regs[0x24];
      const nr51 = this.regs[0x25];
      let l = 0, r = 0;
      if (this.power) {
        for (let k = 0; k < 4; k++) {
          const ch = chans[k];
          // DAC: digital 0..15 -> analog -1..+1 (output is 0 when the DAC is off)
          const a = ch.dac && !this.muted[k] ? (acc[k] * inv) / 7.5 - 1 : 0;
          lv[k] = a;
          if (nr51 & (0x10 << k)) l += a;
          if (nr51 & (1 << k)) r += a;
        }
        l *= ((nr50 >> 4) & 7) + 1;
        r *= (nr50 & 7) + 1;
        l /= 8; r /= 8;
      }
      // high-pass (removes the DAC's DC offset, like the GB's output capacitor)
      const ol = l - this.capL;
      this.capL = l - ol * this.hpCharge;
      const or = r - this.capR;
      this.capR = r - or * this.hpCharge;
      left[offset + i] = softClip(ol * this.gain);
      right[offset + i] = softClip(or * this.gain);
    }
  }

  /** Snapshot for visualizers / tests. */
  channelState() {
    const f = (x) => x.freq;
    return [
      { on: this.ch1.enabled, dac: this.ch1.dac, volume: this.ch1.env.volume, freq: f(this.ch1), hz: 131072 / (2048 - this.ch1.freq), duty: this.ch1.duty },
      { on: this.ch2.enabled, dac: this.ch2.dac, volume: this.ch2.env.volume, freq: f(this.ch2), hz: 131072 / (2048 - this.ch2.freq), duty: this.ch2.duty },
      { on: this.ch3.enabled, dac: this.ch3.dac, volume: [0, 15, 7, 3][this.ch3.levelCode], freq: f(this.ch3), hz: 65536 / (2048 - this.ch3.freq) },
      { on: this.ch4.enabled, dac: this.ch4.dac, volume: this.ch4.env.volume, nr43: this.regs[0x22],
        hz: CPU_CLOCK / this.ch4.period() },
    ];
  }
}

export { PulseChannel, WaveChannel, NoiseChannel };
