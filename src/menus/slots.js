// The Game Corner slot machine (engine/slots/slot_machine.asm, game_corner_slots*.asm), with
// the reels and payouts of data/events.json slotMachine and the BG of assets/slots.
//
// Reels: 18 symbols (dw: low byte = OAM tile of the lower 16×8 half, high = upper half) read
// bottom-up from a byte offset (0-29, wraps at 30); six half-rows are drawn (OAM X $30/$50/$70,
// Y $58..$30, BG priority so the frame hides them). A wheel only stops on an odd stored offset
// (three whole symbols visible). The Gen 1 biases are kept exactly:
//   * SlotMachine_SetFlags each bet: a counter set by a 1/256 roll forces "can win" for 60 bets;
//     else Random() > wSlotMachineSevenAndBarModeChance (250 on the lucky machine, 253) allows
//     7/BAR wins, > 210 allows normal wins, else no win;
//   * wheel 1 slips up to 4 symbols while the middle symbol is a cherry; wheel 2 slips until a
//     line with wheel 1 is possible (7/BAR mode: until that symbol is a 7 or BAR); wheel 3 stops
//     at once; then wheel 3 is rolled down one symbol at a time to dodge a forbidden match, or
//     (allowed to win) up to 3 times to find one;
//   * the wheel-1 "stop on a 7" check of 7/BAR mode is bugged and never fires (kept).
// Payouts: 7 = 300, BAR = 100, CHERRY = 8, FISH / BIRD / MOUSE = 15.

import { MenuScene } from './base.js';
import { LEADING_ZEROES } from './format.js';
import { byteToMap } from '../engine/palette.js';
import { subtractCoins, addCoins } from '../pokemon/bag.js';

export const SLOTS_CAN_WIN = 0x40;
export const SLOTS_CAN_WIN_7_OR_BAR = 0x80;
/** Upper-tile ids (HIGH bytes) of the symbols. */
export const SYMBOL_TILE = Object.freeze({ SLOTS7: 0x02, SLOTSBAR: 0x06, SLOTSCHERRY: 0x0a, SLOTSFISH: 0x0e, SLOTSBIRD: 0x12, SLOTSMOUSE: 0x16 });
/** SlotRewardPointers by winning upper tile: coins, flash count, symbol name. */
export const SLOT_REWARD = Object.freeze({
  0x02: { coins: 300, flash: 0x14, symbol: 'SLOTS7' },
  0x06: { coins: 100, flash: 8, symbol: 'SLOTSBAR' },
  0x0a: { coins: 8, flash: 2, symbol: 'SLOTSCHERRY' },
  0x0e: { coins: 15, flash: 4, symbol: 'SLOTSFISH' },
  0x12: { coins: 15, flash: 4, symbol: 'SLOTSBIRD' },
  0x16: { coins: 15, flash: 4, symbol: 'SLOTSMOUSE' },
});

/**
 * Lines checked by SlotMachine_CheckForMatches for a bet, in order. Each wheel's tiles are
 * [bottom, middle, top]. @returns {number|null} the matching upper tile id
 */
export function findLineMatch(w1, w2, w3, bet) {
  const lines = [];
  if (bet >= 3) lines.push([w1[0], w2[1], w3[2]], [w1[2], w2[1], w3[0]]);
  if (bet >= 2) lines.push([w1[2], w2[2], w3[2]], [w1[0], w2[0], w3[0]]);
  lines.push([w1[1], w2[1], w3[1]]);
  for (const l of lines) if (l[0] === l[1] && l[0] === l[2]) return l[0];
  return null;
}

/** SlotMachine_FindWheel1Wheel2Matches: {match, tile} (tile = the wheel-2 tile [de] points at). */
export function findWheel1Wheel2Match(w1, w2) {
  if (w2[0] === w1[0]) return { match: true, tile: w2[0] };
  if (w2[1] === w1[0]) return { match: true, tile: w2[1] };
  if (w2[1] === w1[1]) return { match: true, tile: w2[1] };
  if (w2[1] === w1[2]) return { match: true, tile: w2[1] };
  if (w2[2] === w1[2]) return { match: true, tile: w2[2] };
  return { match: false, tile: w2[0] };
}

/** The slot machine's state and rules (pure; `rng.randByte()` = Random()). */
export class SlotMachine {
  /**
   * @param {any} slotData data/events.json slotMachine
   * @param {{randByte:()=>number}} rng
   * @param {{lucky?:boolean}} [o] the lucky machine (wSlotMachineSevenAndBarModeChance 250)
   */
  constructor(slotData, rng, { lucky = false } = {}) {
    this.rng = rng;
    this.reels = slotData.wheels.map((w) => {
      const bytes = [];
      for (const sym of w) {
        const s = slotData.symbols[sym];
        bytes.push(s.lowerTiles[0], s.upperTiles[0]);
      }
      return bytes;
    });
    /** stored offsets (the next AnimWheel draws from here) */
    this.offsets = [0, 0, 0];
    /** offsets last drawn */
    this.shown = [0x1c, 0x1c, 0x1c];
    this.slip = [0, 0];
    this.reroll = 0;
    this.flags = 0;
    this.allowCounter = 0;
    this.sevenAndBarChance = lucky ? 250 : 253;
    this.stopping = 0;
    this.bet = 0;
  }

  /** SlotMachine_AnimWheel: draw from the stored offset, then advance it (wrap at 30). */
  anim(w) {
    this.shown[w] = this.offsets[w];
    this.offsets[w] = this.offsets[w] + 1 >= 30 ? 0 : this.offsets[w] + 1;
  }

  /** The 6 half-symbol OAM tiles of a wheel as drawn (bottom first). */
  rows(w) {
    const o = this.shown[w];
    return this.reels[w].slice(o, o + 6);
  }

  /** SlotMachine_GetWheelTiles: [bottom, middle, top] upper-tile ids at the stored offset. */
  tiles(w) {
    const o = this.offsets[w], r = this.reels[w];
    return [r[o], r[o + 2], r[o + 4]];
  }

  /** Before a spin: slip counters and the reroll counter = 4, SlotMachine_SetFlags. */
  startSpin(bet) {
    this.bet = bet;
    this.slip = [4, 4];
    this.reroll = 4;
    this.stopping = 0;
    this.setFlags();
  }

  /** SlotMachine_SetFlags. */
  setFlags() {
    if (this.flags & SLOTS_CAN_WIN_7_OR_BAR) return;
    if (this.allowCounter) { this.flags |= SLOTS_CAN_WIN; return; }
    const r = this.rng.randByte() & 0xff;
    if (r === 0) { this.allowCounter = 60; return; }
    if (this.sevenAndBarChance < r) { this.flags |= SLOTS_CAN_WIN_7_OR_BAR; return; }
    if (210 < r) { this.flags |= SLOTS_CAN_WIN; return; }
    this.flags = 0;
  }

  /** SlotMachine_HandleInputWhileWheelsSpin for an A press. @returns {boolean} accepted (SFX) */
  pressA() {
    if (this.stopping === 1 && this.slip[0] !== 0) return false;
    if (this.stopping === 2 && this.slip[1] !== 0) return false;
    this.stopping++;
    return true;
  }

  /** One SpinWheels loop2 step for the three wheels. @returns {boolean} wheel 3 stopped */
  spinStep() {
    // wheel 1
    let anim = true;
    if (this.stopping >= 1 && (this.offsets[0] & 1)) {
      if (this.slip[0] === 0) anim = false;
      else {
        this.slip[0]--;
        if (!(this.flags & SLOTS_CAN_WIN_7_OR_BAR) && this.tiles(0)[1] !== SYMBOL_TILE.SLOTSCHERRY) {
          this.slip[0] = 0;
          anim = false;
        }
      }
    }
    if (anim) this.anim(0);
    // wheel 2
    anim = true;
    if (this.stopping >= 2 && (this.offsets[1] & 1)) {
      if (this.slip[1] === 0) anim = false;
      else {
        this.slip[1]--;
        const m = findWheel1Wheel2Match(this.tiles(0), this.tiles(1));
        const stop = this.flags & SLOTS_CAN_WIN_7_OR_BAR ? m.tile < 0x07 : m.match;
        if (stop) { this.slip[1] = 0; anim = false; }
      }
    }
    if (anim) this.anim(1);
    // wheel 3
    if (this.stopping >= 3 && (this.offsets[2] & 1)) return true;
    this.anim(2);
    return false;
  }

  /** Roll wheel 3 down one symbol (two AnimWheel3). */
  roll3() { this.anim(2); this.anim(2); }

  /**
   * SlotMachine_CheckForMatches without the screen: decides rolls and the outcome.
   * @returns {{tile:number|null, rolls:number}} tile = winning upper tile id or null
   */
  checkForMatches() {
    let rolls = 0;
    for (let guard = 0; guard < 1000; guard++) {
      const m = findLineMatch(this.tiles(0), this.tiles(1), this.tiles(2), this.bet);
      const canWin = this.flags & (SLOTS_CAN_WIN | SLOTS_CAN_WIN_7_OR_BAR);
      if (m === null) {
        if (canWin) {
          this.reroll = (this.reroll - 1) & 0xff;
          if (this.reroll !== 0) { this.roll3(); rolls++; continue; }
        }
        return { tile: null, rolls };
      }
      if (!canWin) { this.roll3(); rolls++; continue; }
      if (!(this.flags & SLOTS_CAN_WIN_7_OR_BAR) && m < 0x07) { this.roll3(); rolls++; continue; }
      return { tile: m, rolls };
    }
    return { tile: null, rolls };
  }

  /** The reward function's side effects (SlotReward*Func). @returns reward info */
  applyReward(tile) {
    const rw = SLOT_REWARD[tile];
    if (rw.coins === 8 || rw.coins === 15) {
      if (this.allowCounter) this.allowCounter--;
    } else if (rw.coins === 100) {
      this.flags = 0;
    } else if (rw.coins === 300) {
      const r = this.rng.randByte() & 0xff;
      if (r >= 0x80) this.flags = 0;
      this.allowCounter = 0;
    }
    return rw;
  }
}

export class SlotsScene extends MenuScene {
  /**
   * @param {{lucky?:boolean, check?:boolean}} [params] lucky machine; check = AbleToPlaySlotsCheck
   */
  constructor(params = {}) {
    super({ ...params, opaque: false, vramMode: 'slots' });
    this.machine = null;
  }

  *main() {
    const st = this.state;
    const gd = this.gd;
    if (this.params.check !== false) {
      if (!st.bag.has('COIN_CASE', 1, gd)) { yield* this.print('_GameCornerCoinCaseText', { wait: true }); this.scr.reset(); return null; }
      if (!st.coins) { yield* this.print('_GameCornerNoCoinsText', { wait: true }); this.scr.reset(); return null; }
    }
    yield* this.print('_PlaySlotMachineText');
    const yes = yield* this.yesNo();
    if (!yes) { this.scr.reset(); return null; }
    const savedPal = this.savePalette();
    yield* this.whiteOutDelay3();
    const ui = yield this.game.assets.json('data/ui_gfx.json');
    const sheet = ui.sheets.find((x) => x.path === 'assets/slots/slots_screen.png');
    this.opaque = true;
    const s = this.scr;
    s.clear();
    for (let i = 0; i < 240; i++) s.put(i % 20, Math.floor(i / 20), sheet.tilemap[i]);
    const m = new SlotMachine(gd.events.slotMachine, this.game.rng, { lucky: !!this.params.lucky });
    this.machine = m;
    // LoadSlotMachineTiles draws the wheels at offset $1C, then the WRAM block is cleared
    m.shown = [0x1c, 0x1c, 0x1c];
    m.offsets = [0, 0, 0];
    this.palNormal();
    this.setObp0(0xe4);
    yield* this.mainLoop();
    this.machine = null;
    yield* this.whiteOutDelay3();
    this.restorePalette(savedPal);
    this.opaque = false;
    this.scr.reset();
    yield 3;
    return null;
  }

  setObp0(byte) {
    const p = this.game.palette;
    if (p) p.setMaps(p.bgp, byteToMap(byte), p.obp1);
    this.obp0 = byte;
  }

  setBgp(byte) {
    const p = this.game.palette;
    if (p) p.setMaps(byteToMap(byte), p.obp0, p.obp1);
    this.bgp = byte;
  }

  printCredit() { this.scr.bcd(5, 1, this.state.coins, 2); }
  printPayout(n) { this.scr.num(11, 1, n, 4, LEADING_ZEROES); }

  /** SlotMachine_LightBalls / PutOutLitBalls. */
  balls(bet, tile) {
    const rows = bet >= 3 ? [2, 10, 4, 8, 6] : bet === 2 ? [4, 8, 6] : [6];
    for (const y of rows) {
      this.scr.put(3, y, tile); this.scr.put(16, y, tile);
      this.scr.put(3, y + 1, tile + 1); this.scr.put(16, y + 1, tile + 1);
    }
  }

  *mainLoop() {
    const st = this.state;
    const m = this.machine;
    for (;;) {
      this.printCredit();
      this.printPayout(0);
      yield* this.print('_BetHowManySlotMachineText', { instant: true });
      const saved = this.scr.save();
      let bet;
      for (;;) {
        this.scr.box(14, 11, 6, 7);
        this.scr.text(16, 12, '×3\n×2\n×1');
        const r = yield* this.menuInput({ x: 15, y: 12, max: 2, current: 0, last: 0 });
        if (r.keys.b) { this.scr.restore(saved); return; }
        bet = 3 - r.index;
        if (st.coins < bet) {
          yield* this.print('_NotEnoughCoinsSlotMachineText', { instant: true });
          continue;
        }
        break;
      }
      this.scr.restore(saved);
      subtractCoins(st, bet);
      this.printCredit();
      this.balls(bet, 0x14);
      m.startSpin(bet);
      this.sfx('SFX_SLOTS_NEW_SPIN');
      yield* this.print('_StartSlotMachineText', { instant: true });
      yield* this.spinWheels();
      yield* this.checkForMatches();
      if (!st.coins) {
        yield* this.print('_OutOfCoinsSlotMachineText', { instant: true });
        yield 60;
        return;
      }
      yield* this.print('_OneMoreGoSlotMachineText', { instant: true });
      const again = yield* this.yesNo({ x: 14, y: 12 });
      if (!again) return;
      this.balls(3, 0x23);
    }
  }

  /** SlotMachine_SpinWheels (DMG timing: 2 + 1 frames per step). */
  *spinWheels() {
    const m = this.machine;
    for (let i = 0; i < 20; i++) {
      m.anim(0); m.anim(1); m.anim(2);
      yield 2;
    }
    m.stopping = 0;
    for (;;) {
      yield 1;
      const k = this.poll();
      if (k.a && m.pressA()) this.sfx('SFX_SLOTS_STOP_WHEEL');
      if (m.spinStep()) return;
      yield 2;
    }
  }

  /** SlotMachine_CheckForMatches with the screen (rolls, flashes, payout). */
  *checkForMatches() {
    const m = this.machine;
    const st = this.state;
    for (let guard = 0; guard < 1000; guard++) {
      const match = findLineMatch(m.tiles(0), m.tiles(1), m.tiles(2), m.bet);
      const canWin = m.flags & (SLOTS_CAN_WIN | SLOTS_CAN_WIN_7_OR_BAR);
      let roll = false;
      if (match === null) {
        if (canWin) {
          m.reroll = (m.reroll - 1) & 0xff;
          roll = m.reroll !== 0;
        }
        if (!roll) {
          yield* this.print('_NotThisTimeText', { instant: true });
          return;
        }
      } else if (!canWin || (!(m.flags & SLOTS_CAN_WIN_7_OR_BAR) && match < 0x07)) {
        roll = true;
      }
      if (roll) {
        m.anim(2); yield 1; m.anim(2); yield 1;
        continue;
      }
      // .acceptMatch
      const rw = SLOT_REWARD[match];
      if (rw.coins === 300) {
        yield* this.print([{ cmd: 'text_far', label: '_YeahText' }, { cmd: 'text_pause' }, { cmd: 'text_end' }], { instant: true });
        this.sfx('SFX_GET_ITEM_2');
      } else if (rw.coins === 100) {
        this.sfx('SFX_GET_KEY_ITEM');
      }
      m.applyReward(match);
      // flash the screen (rBGP ^ $40 every 5 frames)
      let bgp = 0xe4;
      for (let i = 0; i < rw.flash; i++) {
        bgp ^= 0x40;
        this.setBgp(bgp);
        yield 5;
      }
      let payout = rw.coins;
      this.printPayout(payout);
      // SymbolLinedUpSlotMachineText: the symbol in the box, " lined up! Scored N coins!"
      const sym = match - 2;
      this.box.open();
      yield 3;
      const s = this.scr;
      s.put(2, 14, 0x25 + sym); s.put(3, 14, 0x26 + sym);
      s.put(2, 13, 0x27 + sym); s.put(3, 13, 0x28 + sym);
      s.put(18, 16, 0xee);
      this.box.cx = 5; this.box.cy = 14;
      yield* this.print([{ cmd: 'text_far', label: '_LinedUpText' }, { cmd: 'text_end' }], { open: false, instant: true, subs: { wStringBuffer: String(rw.coins) } });
      yield* this.waitButton();
      // SlotMachine_PayCoinsToPlayer
      let counter = 5;
      while (payout > 0) {
        payout--;
        addCoins(st, 1);
        this.printCredit();
        this.printPayout(payout);
        this.sfx('SFX_SLOTS_REWARD');
        if (--counter === 0) { this.setObp0(this.obp0 ^ 0x40); counter = 5; }
        yield match < 0x07 ? 4 : 8;
      }
      this.printPayout(0);
      this.setObp0(0xe4);
      return;
    }
  }

  drawExtra(fb) {
    const m = this.machine;
    const img = this.ctx.images.slotsSymbols;
    if (!m || !img) return;
    const xs = [40, 72, 104];
    for (let w = 0; w < 3; w++) {
      const rows = m.rows(w);
      for (let k = 0; k < 6; k++) {
        const t = rows[k];
        const y = 72 - 8 * k;
        for (let h = 0; h < 2; h++) {
          const tt = t + h;
          fb.blit(img, (tt % 4) * 8, Math.floor(tt / 4) * 8, 8, 8, xs[w] + 8 * h, y, { obj: 0, behind: true });
        }
      }
    }
  }
}
