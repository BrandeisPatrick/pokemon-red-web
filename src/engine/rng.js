// Deterministic, seedable RNG (mulberry32). Seeded from Date.now() by default; log or
// store `rng.seed` to reproduce a run.

export class Rng {
  /** @param {number} [seed] 32-bit seed (default: Date.now()) */
  constructor(seed = Date.now()) {
    this.seed = 0;
    this.state = 0;
    this.reseed(seed);
  }

  /** Restart the sequence from `seed`. */
  reseed(seed) {
    this.seed = seed >>> 0;
    this.state = this.seed;
    return this;
  }

  /** @returns {number} next uint32 */
  next() {
    let a = (this.state = (this.state + 0x6d2b79f5) | 0);
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** @returns {number} float in [0, 1) */
  float() {
    return this.next() / 4294967296;
  }

  /** @returns {number} 0..255, like the GB's hRandomAdd/hRandomSub bytes */
  randByte() {
    return this.next() >>> 24;
  }

  /** @returns {number} integer in [0, n) (unbiased) */
  randInt(n) {
    n = Math.floor(n);
    if (!(n > 0)) throw new RangeError(`randInt(${n})`);
    if (n === 1) return 0;
    const limit = 4294967296 - (4294967296 % n);
    let x;
    do x = this.next(); while (x >= limit);
    return x % n;
  }

  /** @returns {number} integer in [min, max] inclusive */
  range(min, max) {
    return min + this.randInt(max - min + 1);
  }

  /**
   * True with probability n/outOf. Gen-1 style odds are "n out of 256":
   * chance(25) is a 25/256 roll (randByte() < 25).
   */
  chance(n, outOf = 256) {
    return outOf === 256 ? this.randByte() < n : this.randInt(outOf) < n;
  }

  /** @template T @param {T[]} arr @returns {T} */
  pick(arr) {
    return arr[this.randInt(arr.length)];
  }

  /** Serializable state (for save files / bug repro). */
  getState() {
    return { seed: this.seed, state: this.state >>> 0 };
  }

  setState(s) {
    this.seed = s.seed >>> 0;
    this.state = s.state | 0;
    return this;
  }
}
