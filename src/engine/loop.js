// Fixed-step main loop: game logic runs at exactly `hz` updates per second (60 = one GB
// frame per update) from an accumulator; rendering happens at most once per animation
// frame, and only when at least one update ran. Pauses while the tab is hidden (the
// accumulator is reset on return, so the game never fast-forwards).
//
// All browser hooks are injectable so the loop can be driven from node tests.

export class Loop {
  /**
   * @param {object} o
   * @param {(frame:number) => void} o.update   fixed-step logic; `frame` = updates so far
   * @param {(frame:number) => void} [o.render] draw + present (once per animation frame)
   * @param {number} [o.hz=60]
   * @param {number} [o.maxUpdatesPerFrame=4] cap for catch-up after a stall
   * @param {(cb: FrameRequestCallback) => number} [o.raf]
   * @param {(id: number) => void} [o.caf]
   * @param {Document} [o.document] for visibilitychange (defaults to globalThis.document)
   */
  constructor({ update, render = () => {}, hz = 60, maxUpdatesPerFrame = 4, raf, caf, document: doc } = {}) {
    if (typeof update !== 'function') throw new Error('Loop: update callback required');
    this.update = update;
    this.render = render;
    this.hz = hz;
    this.stepMs = 1000 / hz;
    /** jitter tolerated around one step so 60 Hz displays get exactly 1 update/frame */
    this.toleranceMs = 1.5;
    this.maxUpdatesPerFrame = maxUpdatesPerFrame;
    /** number of fixed updates executed so far (the frame counter) */
    this.frame = 0;
    this.running = false;
    this.paused = false;
    this._raf = raf || ((cb) => globalThis.requestAnimationFrame(cb));
    this._caf = caf || ((id) => globalThis.cancelAnimationFrame(id));
    this._doc = doc === undefined ? globalThis.document : doc;
    this._rafId = 0;
    this._last = null;
    this._acc = 0;
    this._forceRender = false;
    this._tick = (t) => this._onFrame(t);
    this._onVisibility = () => this._visibilityChanged();
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this._last = null;
    this._acc = 0;
    if (this._doc && this._doc.addEventListener) this._doc.addEventListener('visibilitychange', this._onVisibility);
    this.paused = !!(this._doc && this._doc.hidden);
    if (!this.paused) this._rafId = this._raf(this._tick);
    return this;
  }

  stop() {
    this.running = false;
    if (this._rafId) this._caf(this._rafId);
    this._rafId = 0;
    if (this._doc && this._doc.removeEventListener) this._doc.removeEventListener('visibilitychange', this._onVisibility);
    return this;
  }

  /** Ask for a render on the next animation frame even if no update runs (e.g. resize). */
  requestRender() {
    this._forceRender = true;
  }

  /** Run `n` updates synchronously, then render once (debugging / tests). */
  stepFrames(n = 1) {
    for (let i = 0; i < n; i++) this.update(this.frame++);
    this.render(this.frame);
  }

  /** @private */
  _visibilityChanged() {
    if (!this.running) return;
    if (this._doc.hidden) {
      this.paused = true;
      if (this._rafId) this._caf(this._rafId);
      this._rafId = 0;
    } else if (this.paused) {
      this.paused = false;
      this._last = null;
      this._acc = 0;
      this._rafId = this._raf(this._tick);
    }
  }

  /** @private */
  _onFrame(t) {
    if (!this.running || this.paused) return;
    this._rafId = this._raf(this._tick);
    if (this._last === null) {
      // first frame after start/resume: run exactly one update
      this._last = t;
      this._acc = this.stepMs;
    } else {
      let dt = t - this._last;
      this._last = t;
      if (dt < 0) dt = 0;
      if (dt > 250) dt = this.stepMs; // stalled (debugger, slow tab): don't spiral
      this._acc += dt;
    }
    let n = 0;
    while (this._acc >= this.stepMs - this.toleranceMs && n < this.maxUpdatesPerFrame) {
      this.update(this.frame++);
      this._acc -= this.stepMs;
      n++;
    }
    if (n === this.maxUpdatesPerFrame && this._acc > this.stepMs) this._acc = 0; // drop backlog
    if (n > 0 || this._forceRender) {
      this._forceRender = false;
      this.render(this.frame);
    }
  }
}
