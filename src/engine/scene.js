// Scene stack + coroutine runner.
//
// Coroutines are generator functions stepped once per fixed update. What a generator
// yields decides when it resumes:
//   yield            / yield 1   -> next frame
//   yield n                      -> after n frames (yield 0 = keep going this frame)
//   yield promise / thenable     -> when it settles (resolved value is sent back in,
//                                   rejection is thrown into the generator)
//   yield generator / iterator   -> runs it as a sub-coroutine; its return value is sent
//                                   back (same as yield*, but explicit)
//   yield coroutine              -> waits until that coroutine finishes
//   yield () => boolean          -> polls the predicate every frame until it is truthy
// A Coroutine is itself thenable, so `await scene.run(gen)` works from async code (the
// continuation then runs between frames; use generators for frame-exact sequencing).

const MAX_IMMEDIATE_STEPS = 100000;

export class Coroutine {
  /**
   * @param {Iterator<any>|((...args:any[]) => Iterator<any>)} iterOrFn
   * @param {...any} args arguments when a generator function is given
   */
  constructor(iterOrFn, ...args) {
    const it = typeof iterOrFn === 'function' ? iterOrFn(...args) : iterOrFn;
    if (!it || typeof it.next !== 'function') throw new TypeError('Coroutine: expected a generator/iterator');
    /** @type {Iterator<any>[]} */
    this._stack = [it];
    this._wait = 0;
    this._pending = null; // {state: 'pending'|'fulfilled'|'rejected', value}
    this._until = null;
    this._child = null;
    this._send = undefined;
    this._throw = null;
    this.done = false;
    this.cancelled = false;
    this.value = undefined;
    this.error = null;
    this.promise = new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject; });
    this.promise.catch(() => {}); // errors are reported by the runner; avoid unhandled noise
  }

  then(onFulfilled, onRejected) {
    return this.promise.then(onFulfilled, onRejected);
  }

  /**
   * Advance by one frame. @returns {boolean} true while still running
   */
  step() {
    if (this.done) return false;
    if (this._wait > 0) {
      this._wait--;
      if (this._wait > 0) return true;
    }
    if (this._pending) {
      if (this._pending.state === 'pending') return true;
      const p = this._pending;
      this._pending = null;
      if (p.state === 'fulfilled') this._send = p.value;
      else this._throw = { error: p.value };
    }
    if (this._child) {
      if (!this._child.done) return true;
      const c = this._child;
      this._child = null;
      if (c.error) this._throw = { error: c.error };
      else this._send = c.value;
    }
    if (this._until) {
      if (!this._until()) return true;
      this._until = null;
    }
    for (let guard = 0; guard < MAX_IMMEDIATE_STEPS; guard++) {
      const it = this._stack[this._stack.length - 1];
      let r;
      try {
        if (this._throw) {
          const { error } = this._throw;
          this._throw = null;
          if (typeof it.throw !== 'function') throw error;
          r = it.throw(error);
        } else {
          const v = this._send;
          this._send = undefined;
          r = it.next(v);
        }
      } catch (err) {
        this._stack.pop();
        if (this._stack.length === 0) return this._finish(undefined, err);
        this._throw = { error: err };
        continue;
      }
      if (r.done) {
        this._stack.pop();
        if (this._stack.length === 0) return this._finish(r.value, null);
        this._send = r.value;
        continue;
      }
      const y = r.value;
      if (y === undefined || y === null || typeof y === 'boolean') { this._wait = 1; return true; }
      if (typeof y === 'number') {
        if (y <= 0) continue;
        this._wait = Math.ceil(y);
        return true;
      }
      if (y instanceof Coroutine) {
        this._child = y;
        if (y.done) continue;
        return true;
      }
      if (typeof y.next === 'function') { this._stack.push(y); continue; }
      if (typeof y.then === 'function') {
        const p = { state: 'pending', value: undefined };
        this._pending = p;
        y.then((v) => { p.state = 'fulfilled'; p.value = v; }, (e) => { p.state = 'rejected'; p.value = e; });
        return true;
      }
      if (typeof y === 'function') {
        if (y()) continue;
        this._until = y;
        return true;
      }
      this._throw = { error: new TypeError(`Coroutine: cannot yield ${Object.prototype.toString.call(y)}`) };
    }
    return this._finish(undefined, new Error('Coroutine: too many immediate steps (yield 0 loop?)'));
  }

  /** Stop the coroutine, running pending `finally` blocks. */
  cancel() {
    if (this.done) return;
    this.cancelled = true;
    while (this._stack.length) {
      const it = this._stack.pop();
      try { if (typeof it.return === 'function') it.return(undefined); } catch { /* ignore */ }
    }
    if (this._child) this._child.cancel();
    this._finish(undefined, null);
  }

  /** @private */
  _finish(value, error) {
    this.done = true;
    this.value = value;
    this.error = error;
    if (error) this._reject(error);
    else this._resolve(value);
    return false;
  }
}

/** A set of coroutines stepped together (each Scene owns one). */
export class Tasks {
  constructor() {
    /** @type {Coroutine[]} */
    this.list = [];
    /** called with (error, coroutine) when a coroutine throws; default console.error */
    this.onError = (err) => console.error(err);
  }

  /**
   * Start a coroutine; it first runs during the next update() (the same frame when called
   * from a scene's update(), since tasks are stepped after it).
   * @param {Iterator<any>|((...a:any[])=>Iterator<any>)} iterOrFn
   * @param {...any} args
   * @returns {Coroutine}
   */
  run(iterOrFn, ...args) {
    const co = iterOrFn instanceof Coroutine ? iterOrFn : new Coroutine(iterOrFn, ...args);
    this.list.push(co);
    return co;
  }

  /** Step every coroutine once (including ones started during this pass). */
  update() {
    for (let i = 0; i < this.list.length; i++) {
      const co = this.list[i];
      co.step();
      if (co.done && co.error && this.onError) this.onError(co.error, co);
    }
    if (this.list.some((c) => c.done)) this.list = this.list.filter((c) => !c.done);
  }

  cancelAll() {
    const l = this.list;
    this.list = [];
    for (const co of l) co.cancel();
  }

  /** True while any coroutine is running. */
  get busy() {
    return this.list.length > 0;
  }
}

/**
 * Base class for scenes. Override any of enter/exit/pause/resume/update/draw.
 * `this.game` is the shared game context, `this.stack` the owning SceneStack.
 */
export class Scene {
  constructor() {
    this.tasks = new Tasks();
    /** @type {SceneStack|null} */
    this.stack = null;
    /** @type {any} */
    this.game = null;
    /** opaque scenes hide everything below them when drawing */
    this.opaque = true;
    /** resolves with the value passed to pop() when this scene leaves the stack */
    this.finished = new Promise((resolve) => { this._resolveFinished = resolve; });
  }

  /** Called when pushed (params from push/replace). */
  enter(params) {}
  /** Called when removed from the stack. */
  exit() {}
  /** Called when another scene is pushed on top. */
  pause() {}
  /** Called when the scene above was popped (with its result). */
  resume(result) {}
  /** Fixed-step logic (top scene only). */
  update(frame, input) {}
  /** Draw into the framebuffer. */
  draw(fb) {}

  /** Start a coroutine owned by this scene (cancelled when the scene exits). */
  run(iterOrFn, ...args) {
    return this.tasks.run(iterOrFn, ...args);
  }

  /** Promise resolved after `frames` updates of this scene. */
  wait(frames) {
    return this.run(function* () { yield frames; }).promise;
  }

  /** True while any of this scene's coroutines is running. */
  get busy() {
    return this.tasks.busy;
  }

  /** Pop this scene if it is on top. */
  close(result) {
    if (this.stack && this.stack.top === this) this.stack.pop(result);
  }
}

export class SceneStack {
  /** @param {any} [game] shared context given to every scene as scene.game */
  constructor(game = {}) {
    this.game = game;
    /** @type {Scene[]} */
    this.scenes = [];
  }

  get top() {
    return this.scenes[this.scenes.length - 1] || null;
  }

  get length() {
    return this.scenes.length;
  }

  /** Push a scene on top (the previous top is paused). @returns {Scene} */
  push(scene, params) {
    const prev = this.top;
    if (prev) prev.pause();
    this.scenes.push(scene);
    scene.stack = this;
    scene.game = this.game;
    scene.enter(params);
    return scene;
  }

  /** Pop the top scene; the one below resumes with `result`. @returns {Scene|null} */
  pop(result) {
    const s = this.scenes.pop();
    if (!s) return null;
    this._leave(s, result);
    const top = this.top;
    if (top) top.resume(result);
    return s;
  }

  /** Swap the top scene for another (the one below is not resumed/paused). */
  replace(scene, params) {
    const s = this.scenes.pop();
    if (s) this._leave(s, undefined);
    this.scenes.push(scene);
    scene.stack = this;
    scene.game = this.game;
    scene.enter(params);
    return scene;
  }

  /** Remove every scene. */
  clear() {
    while (this.scenes.length) this._leave(this.scenes.pop(), undefined);
  }

  /** @private */
  _leave(s, result) {
    s.tasks.cancelAll();
    s.exit();
    s.stack = null;
    s._resolveFinished(result);
  }

  /** Update the top scene, then step its coroutines. */
  update(frame, input) {
    const s = this.top;
    if (!s) return;
    s.update(frame, input);
    if (this.top === s) s.tasks.update();
  }

  /** Draw from the topmost opaque scene upwards. */
  draw(fb) {
    let start = this.scenes.length - 1;
    while (start > 0 && !this.scenes[start].opaque) start--;
    for (let i = Math.max(0, start); i < this.scenes.length; i++) this.scenes[i].draw(fb);
  }
}
