// The eight battle transitions of engine/battle/battle_transitions.asm, played over a snapshot
// of the screen the battle starts from (the overworld). The GB fills wTileMap cells with the
// black tile $FF and moves rows/columns of tile ids around; here a 20x18 grid of cells holds
// either the index of the snapshot tile it shows or BLACK, and render() draws it.
//
//   const grid = new TransitionGrid();
//   yield* battleTransition(id, grid, { setPalette, spiralDirection });  // generator of frame counts
//   grid.render(fb, snapshotPixels);                                       // every frame
//
// id: bit 0 trainer, bit 1 enemy >= lead level + 3, bit 2 dungeon map (core.js transitionId).

export const BLACK = -1;
const W = 20;
const H = 18;
/** Cells outside the 360-byte tile map (the spiral overruns it): writable, never drawn. */
const MARGIN = 2048;

export const TRANSITION_NAMES = Object.freeze([
  'DoubleCircle', 'Spiral', 'Circle', 'Spiral', 'HorizontalStripes', 'Shrink', 'VerticalStripes', 'Split',
]);

/** BattleTransition_FlashScreenPalettes (dc 3,3,2,1 ...) as rBGP bytes. */
export const FLASH_PALETTES = Object.freeze([
  [3, 3, 2, 1], [3, 3, 3, 2], [3, 3, 3, 3], [3, 3, 3, 2], [3, 3, 2, 1], [3, 2, 1, 0],
  [2, 1, 0, 0], [1, 0, 0, 0], [0, 0, 0, 0], [1, 0, 0, 0], [2, 1, 0, 0], [3, 2, 1, 0],
].map(([a, b, c, d]) => (a << 6) | (b << 4) | (c << 2) | d));

const CIRCLE_DATA = [
  null,
  [2, 3, 5, 4, 9, -1],
  [1, 1, 2, 2, 4, 2, 4, 2, 3, -1],
  [2, 1, 3, 1, 4, 1, 4, 1, 4, 1, 3, 1, 2, 1, 1, 1, 1, -1],
  [4, 1, 4, 0, 3, 1, 3, 0, 2, 1, 2, 0, 1, -1],
  [4, 0, 3, 0, 3, 0, 2, 0, 2, 0, 1, 0, 1, 0, 1, -1],
];
const LEFT = 0;
const RIGHT = 1;
/** BattleTransition_HalfCircle1 / 2: quadrant x, circle data, target coord. */
const HALF_CIRCLE_1 = [
  [RIGHT, 1, 18, 6], [RIGHT, 2, 19, 3], [RIGHT, 3, 18, 0], [RIGHT, 4, 14, 0], [RIGHT, 5, 10, 0],
  [LEFT, 5, 9, 0], [LEFT, 4, 5, 0], [LEFT, 3, 1, 0], [LEFT, 2, 0, 3], [LEFT, 1, 1, 6],
];
const HALF_CIRCLE_2 = [
  [LEFT, 1, 1, 11], [LEFT, 2, 0, 14], [LEFT, 3, 1, 17], [LEFT, 4, 5, 17], [LEFT, 5, 9, 17],
  [RIGHT, 5, 10, 17], [RIGHT, 4, 14, 17], [RIGHT, 3, 18, 17], [RIGHT, 2, 19, 14], [RIGHT, 1, 18, 11],
];

/** The tile map as cells: snapshot tile index (0..359) or BLACK. Linear like wTileMap. */
export class TransitionGrid {
  constructor() {
    this.mem = new Int32Array(W * H + 2 * MARGIN);
    this.reset();
  }

  reset() {
    this.mem.fill(-2); // memory around the map: "not $FF"
    for (let i = 0; i < W * H; i++) this.mem[MARGIN + i] = i;
  }

  /** Raw access by linear tile-map offset (may be outside 0..359). */
  peek(p) { return this.mem[MARGIN + p] ?? -2; }
  poke(p, v) { const i = MARGIN + p; if (i >= 0 && i < this.mem.length) this.mem[i] = v; }
  isBlack(p) { return this.peek(p) === BLACK; }
  get(x, y) { return this.peek(y * W + x); }
  set(x, y, v) { this.poke(y * W + x, v); }

  /** Copy a 20-tile row (CopyData) / an 18-tile column. */
  copyRow(srcY, dstY) { for (let x = 0; x < W; x++) this.set(x, dstY, this.get(x, srcY)); }
  copyCol(srcX, dstX) { for (let y = 0; y < H; y++) this.set(dstX, y, this.get(srcX, y)); }

  /** Count of black cells on screen (tests). */
  blackCount() { let n = 0; for (let i = 0; i < W * H; i++) if (this.mem[MARGIN + i] === BLACK) n++; return n; }

  /**
   * Draw the cells: BLACK as colour 3, others copied from `snapshot` (160x144 indices).
   * @param {{pixels: Uint8Array}} fb
   * @param {Uint8Array} snapshot
   */
  render(fb, snapshot) {
    const px = fb.pixels;
    for (let ty = 0; ty < H; ty++) {
      for (let tx = 0; tx < W; tx++) {
        const v = this.mem[MARGIN + ty * W + tx];
        for (let y = 0; y < 8; y++) {
          const d = (ty * 8 + y) * 160 + tx * 8;
          if (v === BLACK || v < 0 || !snapshot) {
            px.fill(v === BLACK ? 3 : 0, d, d + 8);
          } else {
            const s = (((v / W) | 0) * 8 + y) * 160 + (v % W) * 8;
            for (let x = 0; x < 8; x++) px[d + x] = snapshot[s + x];
          }
        }
      }
    }
  }
}

/**
 * BattleTransition: the 7-frame preamble, then the transition `id` (0-7). Yields frame counts.
 * @param {number} id
 * @param {TransitionGrid} grid
 * @param {{setPalette?: (bgp:number, obp?:number) => void, spiralDirection?: number}} [o]
 *   setPalette(bgp, obp) writes rBGP (and rOBP0/1 for the final black screen);
 *   spiralDirection 1 = inward (the enemy is not stronger), 0 = outward
 */
export function* battleTransition(id, grid, { setPalette = () => {}, spiralDirection = 1 } = {}) {
  yield 3; // Delay3
  yield 1; // DelayFrame
  yield 3; // Delay3 (after clearing OAM)
  const blackScreen = () => setPalette(0xff, 0xff);
  switch (id & 7) {
    case 0: yield* doubleCircle(grid, setPalette); break;
    case 2: yield* circle(grid, setPalette); break;
    case 1: case 3:
      if (spiralDirection) yield* inwardSpiral(grid);
      else yield* outwardSpiral(grid);
      break;
    case 4: yield* horizontalStripes(grid); break;
    case 5: yield* shrink(grid); blackScreen(); yield 10; return;
    case 6: yield* verticalStripes(grid); break;
    case 7: yield* split(grid); blackScreen(); yield 10; return;
    default: break;
  }
  blackScreen();
}

/** BattleTransition_FlashScreen (b = 3): 3 x 12 rBGP values, 2 frames each. */
function* flashScreen(setPalette) {
  for (let b = 0; b < 3; b++) {
    for (const v of FLASH_PALETTES) {
      setPalette(v);
      yield 2;
    }
  }
}

/** BattleTransition_Spiral, outward: 120 frames of 3 steps from (10,10). */
function* outwardSpiral(grid) {
  let p = 10 * W + 10;
  let dir = 3;
  const step = () => {
    let q;
    if (dir === 0) { // up: turn left if possible
      q = p - 1;
      if (!grid.isBlack(q)) { grid.poke(q, BLACK); p = q; dir = 1; return; }
      p -= W;
    } else if (dir === 1) { // left: turn down
      q = p + W;
      if (!grid.isBlack(q)) { grid.poke(q, BLACK); p = q; dir = 2; return; }
      p -= 1;
    } else if (dir === 2) { // down: turn right
      q = p + 1;
      if (!grid.isBlack(q)) { grid.poke(q, BLACK); p = q; dir = 3; return; }
      p += W;
    } else { // right: turn up
      q = p - W;
      if (!grid.isBlack(q)) { grid.poke(q, BLACK); p = q; dir = 0; return; }
      p += 1;
    }
    grid.poke(p, BLACK);
  };
  for (let b = 0; b < 120; b++) {
    for (let c = 0; c < 3; c++) step();
    yield 1;
  }
}

/** BattleTransition_InwardSpiral: down, right, up, left, a TransferDelay3 every 7 tiles. */
function* inwardSpiral(grid) {
  let counter = 7;
  let p = 0;
  function* run(c, de) {
    for (let i = 0; i < c; i++) {
      grid.poke(p, BLACK);
      p += de;
      if (--counter === 0) {
        yield 3;
        counter = 7;
      }
    }
  }
  let c = H - 1;
  yield* run(c, W);
  c++;
  for (let guard = 0; guard < 40; guard++) {
    c++;
    yield* run(c, 1);
    c -= 2;
    yield* run(c, -W);
    c++;
    yield* run(c, -1);
    c -= 2;
    if (c <= 0) break;
    yield* run(c, W);
  }
}

/** BattleTransition_Circle_Sub3 for one half-circle entry. */
function halfCircle(grid, entry, quadrantY) {
  const [qx, dataId, x, y] = entry;
  const data = CIRCLE_DATA[dataId];
  let hl = y * W + x;
  let k = 0;
  for (let guard = 0; guard < 64; guard++) {
    const start = hl;
    let c = data[k++];
    do {
      grid.poke(hl, BLACK);
      hl += qx ? 1 : -1;
    } while (--c > 0);
    hl = start + (quadrantY ? -W : W);
    const a = data[k++];
    if (a === -1) return;
    if (a === 0) continue;
    hl += qx ? -a : a;
  }
}

function* doubleCircle(grid, setPalette) {
  yield* flashScreen(setPalette);
  for (let i = 0; i < 10; i++) {
    halfCircle(grid, HALF_CIRCLE_1[i], 0);
    halfCircle(grid, HALF_CIRCLE_2[i], 1);
    yield 3;
  }
}

function* circle(grid, setPalette) {
  yield* flashScreen(setPalette);
  for (let i = 0; i < 10; i++) {
    halfCircle(grid, HALF_CIRCLE_1[i], 0);
    yield 3;
  }
  for (let i = 0; i < 10; i++) {
    halfCircle(grid, HALF_CIRCLE_2[i], 1);
    yield 3;
  }
}

/** BattleTransition_HorizontalStripes: one column from the left and one from the right per step. */
function* horizontalStripes(grid) {
  for (let i = 0; i < W; i++) {
    for (let y = 0; y < H; y += 2) grid.set(i, y, BLACK);
    for (let y = 1; y < H; y += 2) grid.set(W - 1 - i, y, BLACK);
    yield 3;
  }
}

/** BattleTransition_VerticalStripes: a row from the top and one from the bottom per step. */
function* verticalStripes(grid) {
  for (let i = 0; i < H; i++) {
    for (let x = 0; x < W; x += 2) grid.set(x, i, BLACK);
    for (let x = 1; x < W; x += 2) grid.set(x, H - 1 - i, BLACK);
    yield 3;
  }
}

/** BattleTransition_Shrink: the four quarters move one tile towards the centre per step. */
function* shrink(grid) {
  for (let step = 0; step < H / 2; step++) {
    for (let r = 7; r >= 0; r--) grid.copyRow(r, r + 1); // rows 7->8 ... 0->1
    for (let x = 0; x < W; x++) grid.set(x, 0, BLACK);
    for (let r = 10; r <= 17; r++) grid.copyRow(r, r - 1); // rows 10->9 ... 17->16
    for (let x = 0; x < W; x++) grid.set(x, 17, BLACK);
    for (let c = 8; c >= 0; c--) grid.copyCol(c, c + 1); // cols 8->9 ... 0->1
    for (let y = 0; y < H; y++) grid.set(0, y, BLACK);
    for (let c = 11; c <= 19; c++) grid.copyCol(c, c - 1); // cols 11->10 ... 19->18
    for (let y = 0; y < H; y++) grid.set(19, y, BLACK);
    yield 6;
  }
}

/** BattleTransition_Split: the four quarters move one tile outwards per step. */
function* split(grid) {
  for (let step = 0; step < H / 2; step++) {
    for (let r = 16; r >= 9; r--) grid.copyRow(r, r + 1); // rows 16->17 ... 9->10
    for (let x = 0; x < W; x++) grid.set(x, 9, BLACK);
    for (let r = 1; r <= 8; r++) grid.copyRow(r, r - 1); // rows 1->0 ... 8->7
    for (let x = 0; x < W; x++) grid.set(x, 8, BLACK);
    for (let c = 18; c >= 10; c--) grid.copyCol(c, c + 1); // cols 18->19 ... 10->11
    for (let y = 0; y < H; y++) grid.set(10, y, BLACK);
    for (let c = 1; c <= 9; c++) grid.copyCol(c, c - 1); // cols 1->0 ... 9->8
    for (let y = 0; y < H; y++) grid.set(9, y, BLACK);
    yield 6;
  }
}
