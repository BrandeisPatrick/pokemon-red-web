// EvolutionAfterBattle (engine/pokemon/evos_moves.asm) for the mons whose wCanEvolveFlags bit
// GainExperience set, with the battle-side texts of the evolution; the movie itself (EvolveMon,
// engine/movie/evolution.asm) is ui.evolutionScene. Installed on Battle.prototype (core.js).

import { recalcStats } from '../pokemon/stats.js';
import { far } from './text.js';

export const evolutionMixin = {
  /**
   * EvolutionAfterBattle: every flagged mon walks its evolution entries; a level entry whose
   * level is reached evolves it (B can cancel). Trade entries never apply here and item entries
   * only through the wCurItem/wCurPartySpecies aliasing glitch, which is not reproduced.
   */
  *evolutionAfterBattle() {
    for (let i = 0; i < this.party.length; i++) {
      if (!(this.canEvolveFlags & (1 << i))) continue;
      this.whichPokemon = i;
      const mon = this.party[i];
      const entries = this.gd.species(mon.species).evolutions || [];
      for (const evo of entries) {
        if (evo.method === 'trade') continue; // .checkTradeEvo: not trading -> next entry
        if (evo.method === 'item') continue; // .checkItemEvo: wCurItem never matches here
        if (this.forceEvolution) break; // only stones force an evolution
        if (evo.method !== 'level') continue;
        if (mon.level < evo.level) continue; // .nextEvoEntry2
        const evolved = yield* this.evolveAfterBattle(i, evo);
        if (!evolved) break; // CancelledEvolution -> next mon
      }
    }
  },

  /**
   * .doEvolution: "What? X is evolving!", the movie, "X evolved into Y!", RenameEvolvedMon,
   * new stats (HP += the max-HP gain), the evolution-level move, Pokédex owned + seen.
   * @returns {Generator<any, boolean>} false when cancelled
   */
  *evolveAfterBattle(i, evo) {
    const mon = this.party[i];
    const fromSp = this.gd.species(mon.species);
    const toSp = this.gd.species(evo.into);
    this.curEnemyLevel = mon.level;
    this.stringBuffer = mon.nickname;
    yield* this.text(far('_IsEvolvingText'));
    yield* this.ui.delay(50);
    this.ui.clearArea(0, 0, 20, 12);
    this.ui.clearSprites();
    this.lowHealthAlarm = false;
    this.ui.setLowHealthAlarm(false);
    const cancelled = yield* this.ui.evolutionScene({ from: fromSp.dex, into: toSp.dex, canCancel: !this.forceEvolution, mon });
    if (cancelled) {
      yield* this.text(far('_StoppedEvolvingText'));
      this.ui.clearScreen();
      this.evolutions.push({ partyIndex: i, from: fromSp.dex, into: toSp.dex, cancelled: true });
      return false;
    }
    this.nameBuffer = toSp.name;
    yield* this.text(far('_EvolvedText'));
    yield* this.text(far('_IntoText'), { open: false }); // PrintText_NoCreatingTextBox
    yield* this.ui.sfxWait('SFX_GET_ITEM_2');
    yield* this.ui.waitSound();
    yield* this.ui.delay(40);
    this.ui.clearScreen();
    // RenameEvolvedMon: only an unchanged species name follows the evolution
    if (mon.nickname === fromSp.name) mon.nickname = toSp.name;
    mon.species = toSp.dex;
    recalcStats(mon, { keepHpDifference: true }, this.gd);
    yield* this.learnMoveFromLevelUp(i);
    this.state.pokedex.setOwned(toSp.dex);
    this.state.pokedex.setSeen(toSp.dex);
    this.evolutions.push({ partyIndex: i, from: fromSp.dex, into: toSp.dex, cancelled: false });
    return true;
  },
};
