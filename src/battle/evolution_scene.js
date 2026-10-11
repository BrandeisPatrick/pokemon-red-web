// The evolution movie outside battle (Rare Candy, evolution stones): the same EvolveMon
// screen and texts as EvolutionAfterBattle, as a scene, for `game.hooks.evolve(info)` of
// src/menus/evolution.js.
//
//   game.hooks.evolve = evolveHook(game);
//   // menus call it with {mon, partyIndex, from, into, cancellable, applied, name}
//   // and get {cancelled}; when not cancelled the mon is evolved (idempotent), its new
//   // species is owned in the Pokédex and the evolution-level move has been offered.

import { Scene } from '../engine/scene.js';
import { getGameData } from '../pokemon/data.js';
import { evolve } from '../pokemon/learnset.js';
import { SceneUI, PicCache } from './scene_ui.js';
import { experienceMixin } from './experience.js';
import { TextLibrary, far } from './text.js';

/** The few battle fields the learn-move routines read, without a battle. */
function learnContext(ui, state, gd, texts) {
  const ctx = Object.assign(Object.create(experienceMixin), {
    ui, state, gd, texts, party: state.party, playerMonNumber: -1, side: [{ species: 0 }, { species: 0 }],
    curEnemyLevel: 0, learnMoveMonName: '', stringBuffer: '', nameBuffer: '', learnLog: [],
  });
  ctx.subs = () => ({
    PLAYER: state.playerName, RIVAL: state.rivalName, wPlayerName: state.playerName, wRivalName: state.rivalName,
    wStringBuffer: ctx.stringBuffer, wNameBuffer: ctx.nameBuffer, wLearnMoveMonName: ctx.learnMoveMonName,
  });
  ctx.text = function* text(cmds, opts = {}) { yield* ui.printText(cmds, ctx.subs(), opts); };
  return ctx;
}

const STUB_VIEW = Object.freeze({
  tilemap: { set() {}, reset() {}, save() { return null; }, restore() {} },
  oam: { clear() {} },
});

export class EvolutionScene extends Scene {
  /** @param {{mon:any, partyIndex?:number, from:any, into:any, cancellable?:boolean, applied?:boolean, name?:string}} info */
  constructor(info) {
    super();
    this.info = info;
    this.ui = null;
    this.result = { cancelled: false };
  }

  enter() {
    this.run(this.main());
  }

  *main() {
    const game = this.game;
    const gd = getGameData();
    const info = this.info;
    try {
      const common = yield game.assets.json('data/text/common.json');
      const texts = new TextLibrary(common);
      const images = new PicCache(game.assets);
      const state = game.state;
      const ui = new SceneUI({ game, scene: this, view: STUB_VIEW, images, texts, gd, state, audio: game.audio || null });
      ui.mode = 'evolution';
      this.ui = ui;
      const ctx = learnContext(ui, state, gd, texts);
      const mon = info.mon;
      const fromSp = gd.species(info.from ?? mon.species);
      const toSp = gd.species(info.into);
      ctx.stringBuffer = info.name ?? mon.nickname;
      yield* ctx.text(far('_IsEvolvingText'));
      yield 50;
      ui.base.clearRect(0, 0, 20, 12);
      const cancelled = yield* ui.evolutionScene({ from: fromSp.dex, into: toSp.dex, canCancel: info.cancellable !== false });
      if (cancelled && !info.applied) {
        yield* ctx.text(far('_StoppedEvolvingText'));
        this.result = { cancelled: true };
      } else {
        ctx.nameBuffer = toSp.name;
        yield* ctx.text(far('_EvolvedText'));
        yield* ctx.text(far('_IntoText'), { open: false });
        yield* ui.sfxWait('SFX_GET_ITEM_2');
        yield* ui.waitSound();
        yield 40;
        ui.base.clear();
        ui.evoPic = null;
        if (!info.applied) evolve(mon, toSp.dex, gd);
        if (state.pokedex) state.pokedex.setOwned(toSp.dex);
        const partyIndex = info.partyIndex ?? state.party.indexOf(mon);
        if (partyIndex >= 0) {
          ctx.curEnemyLevel = mon.level;
          yield* ctx.learnMoveFromLevelUp(partyIndex);
        }
        this.result = { cancelled: false };
      }
    } catch (err) {
      console.error('[battle] evolution scene:', err);
    }
    if (game.palette) game.palette.reset();
    this.close(this.result);
  }

  draw(fb) {
    if (this.ui) this.ui.draw(fb);
    else fb.clear(0);
  }
}

/** `game.hooks.evolve` for src/menus/evolution.js: pushes the movie, resolves {cancelled}. */
export function evolveHook(game) {
  return (info) => {
    const scene = new EvolutionScene(info);
    game.scenes.push(scene, info);
    return scene.finished;
  };
}
