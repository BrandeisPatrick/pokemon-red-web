// Install / immersive-mode helpers for phones.
//
//  * iOS has no Fullscreen API for pages on iPhone (and we hide the button on iPad too): the way to
//    get a chrome-less game there is Share > Add to Home Screen, which index.html supports with the
//    apple-mobile-web-app-* tags and the 180 px touch icon.
//  * Android Chrome gets a Fullscreen button (and "Add to Home screen" / "Install app" from the
//    manifest). There is deliberately no service worker: over plain http on a LAN address a browser
//    would not register one, and the game needs none (everything is fetched from the server).
//
// The detection helpers are pure (node-testable); createFullscreenButton() is the DOM part.
// See docs/mobile.md.

/**
 * iPhone / iPod / iPad, including iPadOS 13+ which presents itself as a Mac (Macintosh user agent,
 * MacIntel platform) but has multi-touch.
 * @param {{userAgent?: string, platform?: string, maxTouchPoints?: number}} [nav]
 */
export function isIOS({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && platform === 'MacIntel' && maxTouchPoints > 1;
}

/** Launched from the home screen / installed (no browser chrome). */
export function isStandalone(win = globalThis.window) {
  if (!win) return false;
  if (win.navigator && win.navigator.standalone) return true;
  if (!win.matchMedia) return false;
  return ['standalone', 'fullscreen'].some((mode) => win.matchMedia(`(display-mode: ${mode})`).matches);
}

/** Does this document allow requestFullscreen on an element? */
export function fullscreenSupported(doc = globalThis.document) {
  return !!(doc && (doc.fullscreenEnabled || doc.webkitFullscreenEnabled));
}

/**
 * Show the Fullscreen button only where it can work and helps: not on iOS, not when the page is
 * already installed / fullscreen.
 */
export function shouldOfferFullscreen({ ios, standalone, supported }) {
  return !!supported && !ios && !standalone;
}

export function fullscreenElement(doc = globalThis.document) {
  return doc.fullscreenElement || doc.webkitFullscreenElement || null;
}

/** Enter or leave fullscreen (call from a user gesture). Resolves when done; never rejects. */
export async function toggleFullscreen(doc = globalThis.document) {
  try {
    if (fullscreenElement(doc)) {
      const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
      if (exit) await exit.call(doc);
      return false;
    }
    const el = doc.documentElement;
    const request = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!request) return false;
    await request.call(el, { navigationUI: 'hide' });
    return true;
  } catch (err) {
    console.warn('[pokered-web] fullscreen unavailable:', err && err.message ? err.message : err);
    return false;
  }
}

const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path class="ico-enter" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'
  + '<path class="ico-exit" d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'
  + '</svg>';

/**
 * The Fullscreen button, or null where it should not exist (iOS, installed, no Fullscreen API).
 * @param {{document?: Document, window?: Window, parent?: HTMLElement}} [o]
 * @returns {{el: HTMLElement, destroy(): void}|null}
 */
export function createFullscreenButton({ document: doc = globalThis.document, window: win = globalThis.window, parent } = {}) {
  const nav = (win && win.navigator) || {};
  const offer = shouldOfferFullscreen({
    ios: isIOS(nav),
    standalone: isStandalone(win),
    supported: fullscreenSupported(doc),
  });
  if (!offer) return null;

  const el = doc.createElement('button');
  el.type = 'button';
  el.className = 'tc-fs';
  el.title = 'Fullscreen';
  el.setAttribute('aria-label', 'Toggle fullscreen');
  el.setAttribute('tabindex', '-1'); // never keyboard-focusable: Enter is the game's A button
  el.innerHTML = ICON;
  (parent || doc.body).appendChild(el);

  const sync = () => { el.dataset.fs = fullscreenElement(doc) ? 'on' : 'off'; };
  const onClick = () => {
    toggleFullscreen(doc).then(sync);
    if (el.blur) el.blur();
  };
  el.addEventListener('click', onClick);
  doc.addEventListener('fullscreenchange', sync);
  doc.addEventListener('webkitfullscreenchange', sync);
  sync();

  return {
    el,
    destroy() {
      el.removeEventListener('click', onClick);
      doc.removeEventListener('fullscreenchange', sync);
      doc.removeEventListener('webkitfullscreenchange', sync);
      if (el.remove) el.remove();
    },
  };
}
