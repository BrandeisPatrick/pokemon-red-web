// Phone support entry point (src/main.js calls this only in touch mode). Wiring only; the logic is
// in layout.js (geometry + DOM placement), touch.js (controls), install.js (fullscreen) and
// audio_unlock.js (sound unlock). See docs/mobile.md.

import { detectTouch, createLayoutController } from './layout.js';
import { createTouchControls, installTouchGuards } from './touch.js';
import { createFullscreenButton } from './install.js';

export { detectTouch };

/**
 * Switch the page to the phone layout. Call before fb.attachCanvas() and pass `getViewport` to it;
 * then call `start()` once the Input exists.
 * @param {{canvas: HTMLCanvasElement, win?: Window, doc?: Document}} o
 */
export function createMobile({ canvas, win = globalThis.window, doc = win.document }) {
  doc.documentElement.classList.add('touch'); // index.html's inline script already did this before first paint
  const layout = createLayoutController({ win, doc, canvas });
  return {
    layout,
    getViewport: layout.getViewport,
    /**
     * Build the controls, bind them to the input and lay everything out.
     * @param {{fb: import('../engine/framebuffer.js').FrameBuffer, input: import('../engine/input.js').Input}} o
     */
    start({ fb, input }) {
      const controls = createTouchControls(input, { document: doc, window: win });
      const fullscreen = createFullscreenButton({ document: doc, window: win, parent: controls.root });
      const removeGuards = installTouchGuards({ document: doc });
      layout.bind(fb, { ...controls.elements, fullscreen: fullscreen ? fullscreen.el : null });
      return { layout, controls, fullscreen, removeGuards };
    },
  };
}
