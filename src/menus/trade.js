// In-game NPC trades (engine/events/in_game_trades.asm DoInGameTradeDialogue /
// InGameTrade_DoTrade) and the trade animation (engine/movie/trade.asm InternalClockTradeAnim,
// engine/movie/trade2.asm), with the trades of data/events.json and the graphics of
// assets/ui/trade.
//
// The animation is reproduced on a small PPU model: wTileMap (this.ui, auto-transferred to BG
// map 1 when enabled), BG maps 0 and 1 (32×32), LCDC choosing which map the BG and the window
// show, SCX/SCY/WX/WY, OAM-like sprites (party icon + the 32×32 bubble), the cable flashing
// (BGP ^ $3C), and the four TRADE_BALL_* move animations played by src/battle_anims.

import { MenuScene } from './base.js';
import { TileMap, EMPTY } from '../engine/tilemap.js';
import { Screen } from './screen.js';
import { LEADING_ZEROES } from './format.js';
import { byteToMap } from '../engine/palette.js';
import { PartyMenuScene, PARTY_MENU } from './party_menu.js';
import { drawFlippedPic } from './status_screen.js';
import { makeMon } from '../pokemon/mon.js';
import { partyRemove, partyAdd } from '../pokemon/party.js';

/** TRADE_DIALOGSET_* -> TradeTextPointers1..3 (CASUAL, EVOLUTION, HAPPY). */
const DIALOG = Object.freeze({ TRADE_DIALOGSET_CASUAL: 1, TRADE_DIALOGSET_EVOLUTION: 2, TRADE_DIALOGSET_HAPPY: 3 });
/** InGameTrade_TrainerString. */
export const TRADE_OT = 'TRAINER';

/** Find a trade by id (0-9), TRADE_FOR_* const or nickname. */
export function findTrade(gd, id) {
  const list = gd.events.trades;
  return list.find((t) => t.id === id || t.const === id || t.nickname === id) || null;
}

/** The text labels of a trade's dialog set. */
export function tradeTexts(trade) {
  const n = DIALOG[trade.dialogSet] || 1;
  return {
    wanna: `_WannaTrade${n}Text`, no: `_NoTrade${n}Text`, wrong: `_WrongMon${n}Text`,
    thanks: `_Thanks${n}Text`, after: `_AfterTrade${n}Text`,
  };
}

/**
 * InGameTrade_DoTrade on the model (pure): remove the given mon, add the received one at the
 * same level (nickname, OT "TRAINER", random OT ID), set the completed flag, mark the Pokédex.
 * @returns {{ok:boolean, reason?:'wrongMon', mon?:any, given?:any}}
 */
export function doInGameTrade(state, trade, partyIndex, gd, rng) {
  const given = state.party[partyIndex];
  if (!given || given.species !== trade.give.species) return { ok: false, reason: 'wrongMon' };
  state.completedTrades |= 1 << trade.id;
  const otId = rng ? ((rng.randByte() << 8) | rng.randByte()) & 0xffff : Math.floor(Math.random() * 65536);
  partyRemove(state, partyIndex);
  const mon = makeMon({ species: trade.get.species, level: given.level, otName: TRADE_OT, otId, nickname: trade.nickname, rng }, gd);
  partyAdd(state, mon);
  state.pokedex.setOwned(trade.get.species);
  return { ok: true, mon, given, otId };
}

export class TradeScene extends MenuScene {
  /** @param {{trade:any}} params trade id / const / nickname */
  constructor(params = {}) {
    super({ ...params, opaque: false, vramMode: 'text' });
  }

  *main() {
    const gd = this.gd;
    const st = this.state;
    const trade = findTrade(gd, this.params.trade);
    if (!trade) throw new Error(`tradeScene: unknown trade ${this.params.trade}`);
    const t = tradeTexts(trade);
    const subs = { wInGameTradeGiveMonName: gd.species(trade.give.species).name, wInGameTradeReceiveMonName: gd.species(trade.get.species).name };
    const say = (label) => this.print(label, { subs, wait: true });
    if (st.completedTrades & (1 << trade.id)) {
      yield* say(t.after);
      this.scr.reset();
      return { traded: false };
    }
    yield* this.print(t.wanna, { subs });
    const yes = yield* this.yesNo();
    if (!yes) { yield* say(t.no); this.scr.reset(); return { traded: false }; }
    // InGameTrade_DoTrade
    const i = yield* this.child(new PartyMenuScene({ mode: PARTY_MENU.NORMAL }));
    yield* this.restoreScreen();
    if (i < 0) { yield* say(t.no); this.scr.reset(); return { traded: false }; }
    if (st.party[i].species !== trade.give.species) { yield* say(t.wrong); this.scr.reset(); return { traded: false }; }
    yield* this.print('_ConnectCableText');
    const given = st.party[i];
    const r = doInGameTrade(st, trade, i, gd, this.game.rng);
    yield* this.child(new TradeAnimScene({
      left: { species: given.species, otName: given.otName, otId: given.otId },
      right: { species: trade.get.species, otName: TRADE_OT, otId: r.otId },
      enemyName: TRADE_OT,
    }));
    yield* this.restoreScreen();
    yield* this.print([{ cmd: 'text_far', label: '_TradedForText' }, { cmd: 'sound_get_key_item' }, { cmd: 'text_pause' }, { cmd: 'text_end' }], { subs });
    // .printText: a fresh PrintText box, then DisplayTextID waits for a button
    yield* this.print(t.thanks, { subs, wait: true });
    this.scr.reset();
    return { traded: true, mon: r.mon };
  }

  /** InGameTrade_RestoreScreen: white out, back to the map, 10 frames. */
  *restoreScreen() {
    yield* this.whiteOutDelay3();
    yield 3;
    this.palNormal();
    yield 10;
  }
}

/** LCDC layouts used by the trade (which BG map the BG and the window show). */
const LCDC = Object.freeze({
  DEFAULT: { bg: 0, win: 1, winOn: true },          // LCDC_DEFAULT
  SHOW_MON: { bg: 1, win: 0, winOn: true },         // Trade_ShowPlayerMon / InitGameboyTransferGfx
  CABLE: { bg: 1, win: 0, winOn: false },           // Trade_DrawOpenEndOfLinkCable
});

/**
 * InternalClockTradeAnim. Params: {left:{species, otName, otId}, right:{...}, enemyName}.
 * left = the player's mon (sent), right = the received mon.
 */
export class TradeAnimScene extends MenuScene {
  constructor(params = {}) {
    super({ ...params, opaque: true, vramMode: 'trade' });
    this.maps = [new TileMap(32, 32), new TileMap(32, 32)];
    this.lcdc = LCDC.DEFAULT;
    this.scx = 0; this.scy = 0; this.wx = 7; this.wy = 0;
    this.autoTransfer = false;
    /** the mon pic at wTileMap (7,2) (flipped) and in each BG map after a transfer */
    this.tmPic = null;
    this.picOn = [null, null];
    /** sprites: {img, sx, sy, w, h, x, y, opts} */
    this.objs = [];
    this.anim = null; // battle anim view while one plays
  }

  get T() { return this.ctx.vram.trade; }

  *main() {
    const p = this.params;
    const gd = this.gd;
    const savedPal = this.savePalette();
    this.playerName = this.state.playerName;
    this.enemyName = p.enemyName || TRADE_OT;
    this.leftName = gd.species(p.left.species).name;
    this.rightName = gd.species(p.right.species).name;
    this.subs = { wStringBuffer: this.leftName, wNameBuffer: this.rightName, wLinkEnemyTrainerName: this.enemyName };
    this.uiData = yield this.game.assets.json('data/ui_gfx.json');
    this.circleImg = yield this.game.assets.image('assets/ui/trade/circle.png');
    try {
      const ba = yield import('../battle_anims/index.js');
      if (!this.ctx.battleAnimData) this.ctx.battleAnimData = yield ba.loadBattleAnimData(this.game.assets);
      this.ba = ba;
    } catch (err) {
      console.warn('[menus] trade: battle animations unavailable', err && err.message ? err.message : err);
      this.ba = null;
    }
    this.leftPic = yield this.ctx.frontPic(p.left.species);
    this.rightPic = yield this.ctx.frontPic(p.right.species);
    // OBP0 $E4 (non-SGB) for the trade sprites, OBP1 $D0 for the bubble
    this.setObp(0xe4, 0xd0);
    yield* this.loadGfx();
    yield* this.showPlayerMon();
    yield* this.drawOpenEndOfLinkCable();
    yield* this.ballEnteringLinkCable();
    yield* this.animLeftToRight();
    yield 100;
    this.showClearedWindow();
    yield* this.say('_TradeWentToText', 200);
    yield* this.slideTextBoxOffScreen();
    yield* this.say('_TradeForText', 80);
    yield* this.say('_TradeSendsText', 80);
    yield* this.say('_TradeWavesFarewellText', 80);
    yield* this.say('_TradeTransferredText', 80);
    yield* this.slideTextBoxOffScreen();
    yield* this.animRightToLeft();
    this.showClearedWindow();
    yield* this.drawOpenEndOfLinkCable();
    yield* this.showEnemyMon();
    yield 100;
    // Trade_Cleanup
    this.restorePalette(savedPal);
    this.palWhiteOut();
    return null;
  }

  setObp(obp0, obp1) {
    const pal = this.game.palette;
    if (pal) pal.setMaps(pal.bgp, byteToMap(obp0), byteToMap(obp1));
  }

  // ------------------------------------------------------------------ the PPU model

  /** Trade_ClearTileMap / ClearScreen on wTileMap. */
  clearTileMap() { this.scr.clear(); this.tmPic = null; }

  /** Copy wTileMap into BG map n (CopyScreenTileBufferToVRAM / the auto transfer). */
  transfer(n) {
    const m = this.maps[n];
    for (let y = 0; y < 18; y++) for (let x = 0; x < 20; x++) m.set(x, y, this.ui.get(x, y));
    this.picOn[n] = this.tmPic;
  }

  /** Put the flipped pic of `img` at wTileMap (7,2). */
  loadMonSprite(img) { this.tmPic = img; if (this.autoTransfer) this.transfer(1); }

  /** The pic was cleared from wTileMap (TradeHidePokemon / ClearScreen) and map 1. */
  hidePic() { this.tmPic = null; this.picOn[1] = null; }

  update(frame, input) {
    super.update(frame, input);
    if (this.autoTransfer) this.transfer(1);
  }

  draw(fb) {
    const gfx = this.ctx.sheet.gfx;
    fb.fillRect(0, 0, 160, 144, 0);
    const bgN = this.lcdc.bg;
    const scx = (this.scx + (this.anim ? this.animScxDelta() : 0)) & 0xff;
    drawWrapped(fb, gfx, this.maps[bgN], scx, this.scy);
    if (this.picOn[bgN]) {
      for (const dx of [0, -256, 256]) drawFlippedPic(fb, this.picOn[bgN], 7 + (dx - scx) / 8, 2 - this.scy / 8);
    }
    if (this.lcdc.winOn && this.wy < 144 && this.wx < 167) {
      const x0 = this.wx - 7;
      fb.fillRect(x0, this.wy, 160 - x0, 144 - this.wy, 0);
      const wm = this.maps[this.lcdc.win];
      for (let y = 0; y < 18; y++) for (let x = 0; x < 20; x++) {
        const t = wm.get(x, y);
        if (t >= 0) fb.drawTile(gfx, t, x0 + x * 8, this.wy + y * 8);
      }
      if (this.picOn[this.lcdc.win]) drawFlippedPic(fb, this.picOn[this.lcdc.win], x0 / 8 + 7, this.wy / 8 + 2);
    }
    for (const o of this.objs) if (o && !o.hidden) fb.blit(o.img, o.sx || 0, o.sy || 0, o.w, o.h, o.x, o.y, o.opts || { obj: 0 });
    if (this.anim && this.ba) this.ba.drawOam && drawAnimOam(this.ba, fb, this.anim.view);
  }

  animScxDelta() { return (this.anim.view.ppu.scx - this.anim.scx0) & 0xff; }

  // ------------------------------------------------------------------ trade functions

  *loadGfx() {
    // LoadTradingGFXAndMonNames
    this.clearTileMap();
    this.maps[0].fill(this.T[0x7f]);
    this.maps[1].fill(this.T[0x7f]);
    this.objs = [];
    this.autoTransfer = false;
    yield 1;
  }

  /** "──№." / name / OT/ / <ID>№. info box at (4,y). */
  monInfo(y, species, name, otName, otId) {
    const s = this.scr;
    s.box(4, y, 12, 8);
    s.text(5, y, '──№<DOT>\n\nOT/\n<ID>№<DOT>');
    s.num(9, y, this.gd.species(species).dex, 3, LEADING_ZEROES);
    s.text(5, y + 2, name);
    s.text(8, y + 4, otName);
    s.num(8, y + 6, otId, 5, LEADING_ZEROES);
  }

  *showPlayerMon() {
    const p = this.params;
    this.lcdc = LCDC.SHOW_MON;
    this.wy = 0x50; this.wx = 0x86; this.scx = 0x86;
    this.autoTransfer = false;
    this.monInfo(0, p.left.species, this.leftName, p.left.otName, p.left.otId);
    this.transfer(0);
    this.clearTileMap();
    // Trade_LoadMonSprite: hAutoBGTransferEnabled ^= 1, pic at (7,2), 10 frames
    this.autoTransfer = true;
    this.loadMonSprite(this.leftPic);
    yield 10;
    for (let a = 0x7e; a > 0; a -= 2) {
      yield 1;
      this.wx = a; this.scx = a;
    }
    yield 80;
    yield* this.ballAnim('TRADE_BALL_POOF_ANIM');
    yield* this.ballAnim('TRADE_BALL_DROP_ANIM');
    yield* this.cryWait(p.left.species); // PlayCry waits for the cry
    this.autoTransfer = false;
  }

  *drawOpenEndOfLinkCable() {
    this.clearTileMap();
    this.transfer(0);
    this.scx = 0xa0;
    yield 1;
    this.lcdc = LCDC.CABLE;
    this.copyTileIds(6, 2, 'assets/ui/trade/link_cable_tilemap.png');
    yield* this.copyTileMapToVram();
    this.sfx('SFX_HEAL_HP');
    this.scx = (this.scx + 80) & 0xff;
  }

  /** CopyTileIDsFromList (TILEMAP_GAME_BOY / TILEMAP_LINK_CABLE, absolute ids). */
  copyTileIds(x, y, path) {
    const sh = this.uiData.sheets.find((q) => q.path === path);
    const w = sh.tilemapWidth;
    sh.tilemap.forEach((id, i) => this.scr.put(x + (i % w), y + Math.floor(i / w), id));
  }

  /** Trade_CopyTileMapToVRAM: 3 frames of auto transfer. */
  *copyTileMapToVram() {
    this.autoTransfer = true;
    this.transfer(1);
    yield 3;
    this.autoTransfer = false;
  }

  *ballEnteringLinkCable() {
    yield* this.ballAnim('TRADE_BALL_SHAKE_ANIM');
    yield 10;
    this.setObp(0xe4, 0xd0);
    const img = this.ctx.images.tradeCableBall;
    let bulge = 0;
    for (let x = 0x60; ;) {
      bulge ^= 1;
      // Trade_BallInsideLinkCableOAMBlock: tile $7E (or $7F) mirrored into a 16×16 ball
      const t = 2 + bulge; // cable_ball tiles: $7C + 2 / $7C + 3
      const sx = (t % 2) * 8, sy = Math.floor(t / 2) * 8;
      const X = x - 8, Y = 0x20 - 16;
      this.objs = [
        { img, sx, sy, w: 8, h: 8, x: X, y: Y, opts: { obj: 0 } },
        { img, sx, sy, w: 8, h: 8, x: X + 8, y: Y, opts: { obj: 0, flipX: true } },
        { img, sx, sy, w: 8, h: 8, x: X, y: Y + 8, opts: { obj: 0, flipY: true } },
        { img, sx, sy, w: 8, h: 8, x: X + 8, y: Y + 8, opts: { obj: 0, flipX: true, flipY: true } },
      ];
      yield 3;
      x += 4;
      if (x >= 0xa0) break;
      this.sfx('SFX_TINK');
    }
    this.objs = [];
    this.autoTransfer = true;
    this.clearTileMap();
    this.transfer(1);
    this.transfer(0);
    yield 3;
    this.autoTransfer = false;
  }

  /** Trade_InitGameboyTransferGfx. */
  *initGameboyTransferGfx() {
    this.autoTransfer = true;
    this.clearTileMap();
    this.transfer(1);
    this.autoTransfer = false;
    yield 1;
    this.lcdc = LCDC.SHOW_MON;
    this.scx = 0;
    this.wy = 0x90;
  }

  /** Trade_WriteCircledMonOAM: the party icon in the bubble at base (bx, by). */
  writeCircledMon(species, bx, by) {
    const icon = this.ctx.icon(species);
    this.iconFrame2 = false;
    this.circleFrame = 0;
    this.circle = { x: bx, y: by - 8 };
    this.iconObj = { img: icon.img, bob: icon.bob, x: bx + 8, y: by };
    this.syncCircle();
  }

  syncCircle() {
    const c = this.circle, ic = this.iconObj;
    if (!c) { this.objs = []; return; }
    const f2 = this.iconFrame2;
    // the icon's OAM entries (0-3) share their X with circle tiles and win on index: on top
    this.objs = [
      { img: this.circleImg, sx: 0, sy: this.circleFrame * 32, w: 32, h: 32, x: c.x, y: c.y, opts: { obj: 1 } },
      ic.bob ? { img: ic.img, sx: 0, sy: 0, w: 16, h: 16, x: ic.x, y: ic.y + (f2 ? 1 : 0), opts: { obj: 0 } }
        : { img: ic.img, sx: 0, sy: f2 ? 16 : 0, w: 16, h: 16, x: ic.x, y: ic.y, opts: { obj: 0 } },
    ];
  }

  /** Trade_AnimCircledMon: cable flash (BGP ^ $3C), icon + bubble frames toggle. */
  animCircledMon() {
    const pal = this.game.palette;
    this.bgpByte = (this.bgpByte ?? 0xe4) ^ 0x3c;
    if (pal) pal.setMaps(byteToMap(this.bgpByte), pal.obp0, pal.obp1);
    this.iconFrame2 = !this.iconFrame2;
    this.circleFrame ^= 1;
    this.syncCircle();
  }

  /** Trade_AnimMonMoveHorizontal: b units of 16 px (8 frames × 2 px). */
  *moveHorizontal(b, right) {
    for (let k = 0; k < b; k++) {
      for (let d = 0; d < 8; d++) {
        this.scx = (this.scx + (right ? 2 : -2)) & 0xff;
        yield 1;
      }
      this.animCircledMon();
    }
  }

  /** Trade_AnimMonMoveVertical. */
  *moveVertical(right) {
    const steps = right ? [[4, 0], [0, 10]] : [[0, -10], [-4, 0]];
    for (const [dx, dy] of steps) {
      for (let k = 0; k < 4; k++) {
        this.circle.x += dx; this.circle.y += dy;
        this.iconObj.x += dx; this.iconObj.y += dy;
        this.animCircledMon();
        yield 8;
      }
    }
  }

  drawLeftGameboy() {
    const s = this.scr;
    this.clearTileMap();
    s.put(11, 4, 0x5d);
    for (let x = 12; x < 20; x++) s.put(x, 4, 0x5e);
    this.copyTileIds(5, 3, 'assets/ui/trade/game_boy_tilemap.png');
    s.box(4, 12, 9, 4);
    s.text(5, 14, this.playerName);
  }

  drawRightGameboy() {
    const s = this.scr;
    this.clearTileMap();
    for (let x = 0; x < 14; x++) s.put(x, 4, 0x5e);
    s.put(14, 4, 0x5f);
    for (let y = 5; y < 9; y++) s.put(14, y, 0x61);
    s.put(14, 9, 0x60);
    s.put(13, 9, 0x5d);
    this.copyTileIds(7, 8, 'assets/ui/trade/game_boy_tilemap.png');
    s.box(6, 0, 9, 4);
    s.text(7, 2, this.enemyName);
  }

  drawCableAcrossScreen() {
    this.clearTileMap();
    for (let x = 0; x < 20; x++) this.scr.put(x, 4, 0x5e);
  }

  /** Trade_CopyCableTilesOffScreen: the cable row into BG map 1 from column `col` (wrapping). */
  *copyCableOffScreen(col) {
    const m = this.maps[1];
    for (let i = 0; i < 20; i++) m.set((col + i) & 31, 4, this.T[0x5e]);
    yield 10;
  }

  *animLeftToRight() {
    yield* this.initGameboyTransferGfx();
    this.setObp(0xe4, 0xd0);
    this.writeCircledMon(this.params.left.species, 0x54, 0x1c);
    this.drawLeftGameboy();
    yield 1;
    yield* this.copyTileMapToVram();
    this.drawCableAcrossScreen();
    yield* this.copyCableOffScreen(12);
    yield* this.moveHorizontal(6, true);
    this.autoTransfer = true;
    this.drawCableAcrossScreen();
    yield* this.moveHorizontal(4, true);
    this.drawRightGameboy();
    yield 1;
    yield* this.moveHorizontal(6, true);
    this.autoTransfer = false;
    yield* this.moveVertical(true);
    this.circle = null;
    this.syncCircle();
    this.restoreBgp();
  }

  *animRightToLeft() {
    yield* this.initGameboyTransferGfx();
    this.writeCircledMon(this.params.right.species, 0x64, 0x44);
    this.drawRightGameboy();
    yield 1;
    yield* this.copyTileMapToVram();
    this.drawCableAcrossScreen();
    yield* this.copyCableOffScreen(20);
    yield* this.moveVertical(false);
    yield* this.moveHorizontal(6, false);
    this.autoTransfer = true;
    this.drawCableAcrossScreen();
    yield* this.moveHorizontal(4, false);
    this.drawLeftGameboy();
    yield 1;
    yield* this.moveHorizontal(6, false);
    this.autoTransfer = false;
    this.circle = null;
    this.syncCircle();
    this.restoreBgp();
  }

  restoreBgp() {
    const pal = this.game.palette;
    this.bgpByte = 0xe4;
    if (pal) pal.setMaps(byteToMap(0xe4), pal.obp0, pal.obp1);
  }

  /** Trade_ShowClearedWindow. */
  showClearedWindow() {
    this.autoTransfer = true;
    this.clearTileMap();
    this.transfer(1);
    this.lcdc = LCDC.DEFAULT;
    this.wx = 7; this.wy = 0; this.scx = 0x90;
  }

  /** PrintText + DelayFrames (texts print instantly: BIT_NO_TEXT_DELAY). */
  *say(label, frames) {
    yield* this.print(label, { instant: true, subs: this.subs });
    yield frames;
  }

  /** Trade_SlideTextBoxOffScreen. */
  *slideTextBoxOffScreen() {
    yield 50;
    while (this.wx !== 0xa1) {
      yield 1;
      this.wx += 2;
    }
    this.clearTileMap();
    yield 10;
    this.wx = 7;
  }

  *showEnemyMon() {
    const p = this.params;
    yield* this.ballAnim('TRADE_BALL_TILT_ANIM');
    this.showClearedWindow();
    this.monInfo(10, p.right.species, this.rightName, p.right.otName, p.right.otId);
    yield* this.copyTileMapToVram();
    this.autoTransfer = true;
    this.loadMonSprite(this.rightPic);
    yield 10;
    yield* this.ballAnim('TRADE_BALL_POOF_ANIM');
    this.autoTransfer = true;
    yield* this.cryWait(p.right.species); // PlayCry waits for the cry
    yield 100;
    this.scr.clearArea(4, 10, 12, 8);
    yield* this.say('_TradeTakeCareText', 80);
  }

  /** Trade_ShowAnimation through src/battle_anims (OAM over our screen). */
  *ballAnim(name) {
    if (!this.ba || !this.ctx.battleAnimData) {
      // fallback: the effects only
      yield 30;
      if (name === 'TRADE_BALL_DROP_ANIM') this.hidePic();
      if (name === 'TRADE_BALL_TILT_ANIM') { this.clearTileMap(); this.hidePic(); }
      return;
    }
    const view = new this.ba.BattleAnimView(this.ctx.battleAnimData, { ownRegions: false });
    const self = this;
    const clearArea = view.tilemap.clearArea.bind(view.tilemap);
    view.tilemap.clearArea = (x, y, w, h) => {
      clearArea(x, y, w, h);
      if (x === 7 && y === 2) self.hidePic();
      else if (w >= 20) { self.clearTileMap(); self.hidePic(); }
    };
    view.ppu.scx = this.scx;
    this.anim = { view, scx0: view.ppu.scx };
    try {
      yield* this.ba.playAnimation(name, { view, palette: this.game.palette, sfx: (n) => this.sfx(n), sgb: false, clearSprites: true });
    } catch (err) {
      console.warn('[menus] trade animation', name, err && err.message ? err.message : err);
    }
    this.scx = (this.scx + this.animScxDelta()) & 0xff;
    this.anim = null;
    this.setObp(0xe4, 0xd0);
  }
}

/** Draw a 32×32 tile map scrolled by (scx, scy) with wrap-around. */
function drawWrapped(fb, gfx, map, scx, scy) {
  for (let ty = 0; ty < 32; ty++) {
    let py = ty * 8 - scy;
    if (py < -8) py += 256;
    if (py >= 144) continue;
    for (let tx = 0; tx < 32; tx++) {
      let px = ((tx * 8 - scx) % 256 + 256) % 256;
      if (px > 160) px -= 256;
      if (px < -8 || px >= 160) continue;
      const t = map.get(tx, ty);
      if (t !== EMPTY && t >= 0) fb.drawTile(gfx, t, px, py);
    }
  }
}

/** The battle animation's sprites (DMG OAM rules) over the frame. */
function drawAnimOam(ba, fb, view) {
  ba.drawOam(fb.pixels, view.oam, view.objTiles);
}

export { Screen };
