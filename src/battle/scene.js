// BattleScene: the battle as a scene on the engine's scene stack, and startBattle(game, params)
// which pushes it and resolves to the result object when it pops.
//
//   import { startBattle } from './battle/index.js';
//   const r = await startBattle(game, { species: 'PIDGEY', level: 5 });          // wild
//   const r = await startBattle(game, { trainerClass: 'BROCK', partyIndex: 1 });  // trainer
//   r.outcome -> 'win' | 'lose' | 'ran' | 'caught' | 'forfeit' (see core.js makeResult)

import { Scene } from '../engine/scene.js';
import { getGameData, hasGameData, loadGameData } from '../pokemon/data.js';
import { buildTrainerParty } from '../pokemon/trainer.js';
import { loadBattleAnimData, BattleAnimView } from '../battle_anims/index.js';
import { Battle } from './core.js';
import { SceneUI, PicCache, RED_BACK, OLD_MAN_BACK, GHOST_PIC, BALLS, iconUrl } from './scene_ui.js';
import { TextLibrary } from './text.js';

let sharedResources = null;

/** Battle animation data + the common texts, loaded once per game. */
export function loadBattleResources(game) {
  if (!sharedResources) {
    sharedResources = (async () => {
      const anims = game.anims && game.anims.animations ? game.anims : await loadBattleAnimData(game.assets);
      const common = await game.assets.json('data/text/common.json');
      return { anims, common };
    })();
    sharedResources.catch(() => { sharedResources = null; });
  }
  return sharedResources;
}

/** Every image a battle can show right away (pics of both parties, trainer, icons, balls). */
export function battleImageUrls(state, params, gd) {
  const urls = [RED_BACK, OLD_MAN_BACK, GHOST_PIC, BALLS];
  const addSpecies = (s) => {
    const sp = gd.findSpecies(s);
    if (!sp) return;
    urls.push(sp.sprites.front, sp.sprites.back2x, iconUrl(sp.menuIcon));
  };
  for (const m of state.party || []) addSpecies(m.species);
  if (params.species != null) addSpecies(params.species);
  if (params.trainerClass) {
    const cls = gd.trainerClass(params.trainerClass);
    urls.push(cls.pic);
    try {
      const party = Array.isArray(params.party) && params.party.length ? params.party : buildTrainerParty(cls.const, params.partyIndex ?? 1, {}, gd).mons;
      for (const m of party) addSpecies(m.species);
    } catch (err) {
      console.warn('[battle] trainer party:', err && err.message);
    }
  }
  return urls;
}

export class BattleScene extends Scene {
  /** @param {import('./core.js').BattleParams & {restorePalette?:boolean, mapName?:string}} params */
  constructor(params = {}) {
    super();
    this.params = params;
    /** @type {SceneUI|null} */
    this.ui = null;
    /** @type {Battle|null} */
    this.battle = null;
    this.result = null;
    // the screen below (the overworld) stays visible until the transition has captured it
    this.opaque = false;
  }

  enter() {
    this.run(this.main());
  }

  *main() {
    const game = this.game;
    let result;
    try {
      const prep = yield this.prepare();
      const { battle } = prep;
      result = yield* battle.run();
    } catch (err) {
      console.error('[battle] crashed:', err);
      result = { outcome: 'error', error: String(err && err.stack ? err.stack : err) };
    }
    if (this.params.restorePalette) game.palette.reset();
    this.result = result;
    if (game.battle === this.battle) game.battle = null;
    this.close(result);
  }

  async prepare() {
    const game = this.game;
    if (!game.state) throw new Error('startBattle: game.state (GameState) is required');
    const gd = hasGameData() ? getGameData() : await loadGameData();
    const res = await loadBattleResources(game);
    const texts = new TextLibrary(res.common);
    const params = { ...this.params };
    if (params.trainerClass) params.trainerClass = gd.trainerClass(params.trainerClass).const;
    if (!params.map && params.mapName) {
      const m = gd.findMap(params.mapName);
      if (m) params.map = m.const;
    }
    // the trainer's end-of-battle text lives in the map's text file
    if (typeof params.endBattleText === 'string' && !texts.has(params.endBattleText)) {
      const file = params.textFile || params.mapName;
      if (file) {
        try { texts.add(await game.assets.json(`data/text/${file}.json`)); } catch { /* label resolved by resolveText or skipped */ }
      }
    }
    const images = new PicCache(game.assets);
    await images.load(battleImageUrls(game.state, params, gd));
    const view = new BattleAnimView(res.anims);
    const ui = new SceneUI({ game, scene: this, view, images, texts, gd, state: game.state, audio: game.audio || null });
    const battle = new Battle({ state: game.state, params, rng: game.rng, ui, text: texts, gd });
    ui.attach(battle);
    this.ui = ui;
    this.battle = battle;
    game.battle = battle;
    return { battle, ui };
  }

  update() {}

  draw(fb) {
    if (this.ui) this.ui.draw(fb);
  }
}

/**
 * Push a battle on game.scenes. Resolves with the result object when it ends.
 * @param {any} game engine services + game.state (+ optional audio, hooks)
 * @param {import('./core.js').BattleParams & {restorePalette?:boolean, mapName?:string, textFile?:string}} params
 * @returns {Promise<object>}
 */
export function startBattle(game, params = {}) {
  const scene = new BattleScene(params);
  game.scenes.push(scene, params);
  return scene.finished;
}
