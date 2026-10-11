// Getting sound out of a phone.
//
// Browsers only let an AudioContext start from a user gesture, and iOS Safari is the strictest:
// the context must be created or resumed *inside* a gesture handler. So the listeners below
// (capture phase, on window) call audio.init() / sfx.unlock() synchronously from the very first
// pointerdown / touchstart / keydown, and keep calling ctx.resume() on every later gesture until
// the contexts really run. That second part matters: touchstart / pointerdown(touch) are not
// "activation" events on every browser (touchend / pointerup / click are), and iOS also moves a
// running context to 'interrupted' after a call or an app switch, so the first attempt may not
// stick and a later tap has to finish the job.
//
//   * audio.init() creates the AudioContext and calls ctx.resume() synchronously (src/audio/audio.js),
//     then loads the worklet; it is idempotent. If the worklet module cannot load, the facade falls
//     back to the bundled copy (tools/bundle_worklet.py); if that fails too we warn once and play
//     on without music.
//   * sfx.unlock() does the same for the engine beeper (UI blips).
//   * With `lifecycle: true` (phones) the sound engine is frozen while the page is hidden and
//     continued when it comes back: a game left in the background must not keep playing its
//     music. Desktop keeps the old behaviour (no lifecycle handling).
//
// iPhone note: Web Audio follows the ringer switch. With the switch on silent the game is mute by
// design (we do not override it with navigator.audioSession). See docs/mobile.md.

/** Events whose handlers may unlock audio. */
export const UNLOCK_EVENTS = Object.freeze(['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'click', 'keydown']);

/**
 * @param {object} o
 * @param {{init(): Promise<unknown>, pause(): void, resume(): void, readonly context: AudioContext|null, readonly isReady: boolean}} o.audio
 * @param {{unlock(): void, readonly ctx?: AudioContext|null}} [o.sfx]
 * @param {EventTarget} [o.win]
 * @param {Document} [o.doc]
 * @param {boolean} [o.lifecycle] pause the sound engine while the page is hidden
 * @param {(...args: unknown[]) => void} [o.warn]
 */
export function installAudioUnlock({ audio, sfx = null, win = globalThis.window, doc = globalThis.document, lifecycle = false, warn = console.warn.bind(console) }) {
  let attempted = false;
  let failed = false;
  let paused = false;

  /** Both contexts exist and run (an unavailable one counts as done). */
  function unlocked() {
    if (!attempted) return false;
    const music = failed || (audio.isReady && !!audio.context && audio.context.state === 'running');
    const beeper = !sfx || !sfx.ctx || sfx.ctx.state === 'running';
    return music && beeper;
  }

  function unlock() {
    if (!unlocked()) {
      attempted = true;
      if (sfx) sfx.unlock();
      if (!failed) {
        audio.init().catch((err) => {
          failed = true;
          warn('[pokered-web] audio unavailable:', err && err.message ? err.message : err);
        });
      }
      const ctx = audio.context;
      if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
    }
    if (paused) wake();
  }

  function sleep() {
    if (paused) return;
    paused = true;
    audio.pause();
  }

  /** Continue the engine once the context runs again (maybe only after the next tap). */
  function wake() {
    if (!paused) return;
    const go = () => {
      if (!paused) return;
      paused = false;
      audio.resume();
    };
    const ctx = audio.context;
    if (!ctx || ctx.state === 'running') go();
    else ctx.resume().then(go, () => {});
  }

  const onVisibility = () => (doc.hidden ? sleep() : wake());
  for (const type of UNLOCK_EVENTS) win.addEventListener(type, unlock, { capture: true, passive: true });
  if (lifecycle) {
    doc.addEventListener('visibilitychange', onVisibility);
    win.addEventListener('pagehide', sleep);
    win.addEventListener('pageshow', wake);
  }

  return {
    unlock,
    get unlocked() { return unlocked(); },
    get failed() { return failed; },
    destroy() {
      for (const type of UNLOCK_EVENTS) win.removeEventListener(type, unlock, { capture: true });
      if (lifecycle) {
        doc.removeEventListener('visibilitychange', onVisibility);
        win.removeEventListener('pagehide', sleep);
        win.removeEventListener('pageshow', wake);
      }
    },
  };
}
