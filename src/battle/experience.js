// Experience and learning moves: GainExperience (engine/battle/experience.asm), the EXP.ALL
// part of FaintEnemyPokemon (core.asm), LearnMoveFromLevelUp (engine/pokemon/evos_moves.asm)
// and LearnMove (engine/pokemon/learn_move.asm) with their texts and prompts.
// Installed on Battle.prototype (see core.js).

import { levelForExp, maxExp, boostExp } from '../pokemon/exp.js';
import { addStatExp, recalcStats } from '../pokemon/stats.js';
import { isHMMove } from '../pokemon/learnset.js';
import { PLAYER, ENEMY, TRAINER_BATTLE, TRANSFORMED } from './constants.js';
import {
  calculateModifiedStats, quarterSpeedDueToParalysis, halveAttackDueToBurn, applyBadgeStatBoosts,
  partyMoveIds, partyRawPP,
} from './battle_mon.js';
import { far } from './text.js';

function popcount(n) {
  let c = 0;
  for (let m = n & 0xff; m; m >>= 1) c += m & 1;
  return c;
}

export const experienceMixin = {
  /**
   * The exp part of FaintEnemyPokemon: with EXP.ALL the 7 exp bytes are halved first, the
   * participants gain exp, then every party mon is flagged and GainExperience runs again on the
   * already divided values.
   */
  *gainExperienceForFaint(expAll) {
    if (this.link) return;
    const En = this.side[ENEMY];
    if (expAll) {
      for (const k of Object.keys(En.baseStats)) En.baseStats[k] >>= 1;
      En.actualCatchRate >>= 1;
      En.baseExp >>= 1;
    }
    this.boostExpByExpAll = 0;
    yield* this.gainExperience();
    if (!expAll) return;
    this.boostExpByExpAll = 1;
    this.gainExpFlags = (1 << this.party.length) - 1;
    yield* this.gainExperience();
  },

  /** GainExperience */
  *gainExperience() {
    const En = this.side[ENEMY];
    // DivideExpDataByNumMonsGainingExp (in place)
    const n = popcount(this.gainExpFlags);
    if (n >= 2) {
      for (const k of Object.keys(En.baseStats)) En.baseStats[k] = Math.floor(En.baseStats[k] / n);
      En.actualCatchRate = Math.floor(En.actualCatchRate / n);
      En.baseExp = Math.floor(En.baseExp / n);
    }
    for (let i = 0; i < this.party.length; i++) {
      const mon = this.party[i];
      if (!(mon.hp > 0)) continue;
      if (!(this.gainExpFlags & (1 << i))) continue;
      this.whichPokemon = i;
      mon.statExp = addStatExp(mon.statExp, En.baseStats);
      let exp = Math.floor((En.baseExp * En.level) / 7) & 0xffff;
      const traded = (mon.otId & 0xffff) !== (this.state.playerId & 0xffff);
      if (traded) exp = boostExp(exp);
      this.gainBoostedExp = traded ? 1 : 0;
      if (this.isInBattle === TRAINER_BATTLE) exp = boostExp(exp);
      this.expAmountGained = exp;
      const sp = this.gd.species(mon.species);
      let total = (mon.exp + exp) % 0x1000000;
      const cap = maxExp(sp.growthRate, this.gd);
      if (total >= cap) total = cap;
      mon.exp = total;
      this.nameBuffer = mon.nickname;
      const cmds = [{ cmd: 'text_far', label: '_GainedText' }];
      if (this.boostExpByExpAll) cmds.push({ cmd: 'text_far', label: '_WithExpAllText' });
      else if (this.gainBoostedExp) cmds.push({ cmd: 'text_far', label: '_BoostedText' });
      cmds.push({ cmd: 'text_far', label: '_ExpPointsText' }, { cmd: 'text_end' });
      yield* this.text(cmds);
      const newLevel = levelForExp(sp.growthRate, mon.exp, this.gd);
      if (newLevel === mon.level) continue;
      const savedLevel = this.curEnemyLevel;
      this.curEnemyLevel = newLevel;
      const oldLevel = mon.level;
      mon.level = newLevel;
      recalcStats(mon, { keepHpDifference: true }, this.gd);
      if (i === this.playerMonNumber) {
        const P = this.side[PLAYER];
        P.hp = mon.hp;
        P.level = mon.level;
        P.maxHP = mon.stats.hp;
        P.atk = mon.stats.atk;
        P.def = mon.stats.def;
        P.spd = mon.stats.spd;
        P.spc = mon.stats.spc;
        if (!(P.status3 & TRANSFORMED)) P.unmod = { level: P.level, maxHP: P.maxHP, atk: P.atk, def: P.def, spd: P.spd, spc: P.spc };
        calculateModifiedStats(P);
        // ApplyBurnAndParalysisPenaltiesToPlayer
        quarterSpeedDueToParalysis(P);
        halveAttackDueToBurn(P);
        applyBadgeStatBoosts(P, this.badges());
        this.ui.drawHUD(PLAYER);
        yield* this.emptyText();
        this.ui.saveScreen();
      }
      this.levelUps = this.levelUps || [];
      this.levelUps.push({ partyIndex: i, from: oldLevel, to: newLevel });
      this.nameBuffer = mon.nickname;
      yield* this.text([{ cmd: 'text_far', label: '_GrewLevelText' }, { cmd: 'sound', sound: 'SFX_LEVEL_UP' }, { cmd: 'text_end' }]);
      yield* this.ui.levelUpStats(mon);
      this.ui.restoreScreen();
      yield* this.learnMoveFromLevelUp(i);
      this.canEvolveFlags |= 1 << i;
      this.curEnemyLevel = savedLevel;
    }
    this.gainExpFlags = 1 << this.playerMonNumber;
    this.foughtFlags = 1 << this.playerMonNumber;
  },

  /**
   * LearnMoveFromLevelUp: the first learnset entry of the mon's species at wCurEnemyLevel; if
   * already known nothing happens (later entries of the same level are not looked at).
   */
  *learnMoveFromLevelUp(partyIndex, opts = {}) {
    const mon = this.party[partyIndex];
    const sp = this.gd.species(mon.species);
    const entry = sp.learnset.find((e) => e.level === this.curEnemyLevel);
    if (!entry) return;
    if ((mon.moves || []).some((m) => m.move === entry.move)) return;
    yield* this.learnMove(partyIndex, entry.move, opts);
  },

  /**
   * LearnMove: empty slot -> learned; otherwise "trying to learn ... Delete an older move?",
   * the forget menu (HMs can't be forgotten), "1, 2 and... Poof!", or abandon.
   * @returns {Generator<any, boolean>} learned
   */
  *learnMove(partyIndex, moveConst, { soundGetItem = false } = {}) {
    const mon = this.party[partyIndex];
    const move = this.gd.move(moveConst);
    this.learnMoveMonName = mon.nickname;
    this.stringBuffer = move.name;
    this.ui.saveScreen();
    let slot = -1;
    for (let guard = 0; guard < 1000; guard++) {
      if (mon.moves.length < 4) {
        slot = mon.moves.length;
        break;
      }
      const forget = yield* this.tryingToLearn(mon);
      if (forget >= 0) {
        this.nameBuffer = this.gd.move(mon.moves[forget].move).name;
        yield* this.text([
          { cmd: 'text_far', label: '_OneTwoAndText' }, { cmd: 'text_pause' }, { cmd: 'sound', sound: 'SFX_SWAP' },
          { cmd: 'text_far', label: '_PoofText' }, { cmd: 'text_pause' }, { cmd: 'text_far', label: '_ForgotAndText' }, { cmd: 'text_end' },
        ]);
        slot = forget;
        break;
      }
      yield* this.text(far('_AbandonLearningText'));
      const yes = yield* this.ui.yesNo({ x: 14, y: 7, kind: 'abandon' });
      if (!yes) continue;
      yield* this.text(far('_DidNotLearnText'));
      this.learnLog = this.learnLog || [];
      this.learnLog.push({ partyIndex, move: move.const, learned: false });
      return false;
    }
    const newSlot = { move: move.const, pp: move.pp, ppUps: 0 };
    if (slot >= mon.moves.length) mon.moves.push(newSlot);
    else mon.moves[slot] = newSlot;
    if (partyIndex === this.playerMonNumber && this.side[PLAYER].species) {
      // copied even when transformed (LearnMove doesn't check)
      const P = this.side[PLAYER];
      P.moves = partyMoveIds(mon, this.gd);
      P.pp = partyRawPP(mon);
    }
    this.learnLog = this.learnLog || [];
    this.learnLog.push({ partyIndex, move: move.const, learned: true, slot });
    yield* this.text([
      { cmd: 'text_far', label: '_LearnedMove1Text' },
      { cmd: 'sound', sound: soundGetItem ? 'SFX_GET_ITEM_1' : 'SFX_LEVEL_UP' },
      { cmd: 'text_promptbutton' }, { cmd: 'text_end' },
    ]);
    return true;
  },

  /** TryingToLearn: @returns {Generator<any, number>} the slot to forget, or -1 to abandon */
  *tryingToLearn(mon) {
    yield* this.text(far('_TryingToLearnText'));
    const yes = yield* this.ui.yesNo({ x: 14, y: 7, kind: 'tryingToLearn' });
    if (!yes) return -1;
    for (let guard = 0; guard < 1000; guard++) {
      yield* this.text(far('_WhichMoveToForgetText'));
      const r = yield* this.ui.forgetMoveMenu(mon.moves.map((m) => this.gd.move(m.move).id), mon);
      this.ui.restoreScreen();
      if (r < 0) return -1;
      if (isHMMove(mon.moves[r].move, this.gd)) {
        yield* this.text(far('_HMCantDeleteText'));
        continue;
      }
      return r;
    }
    return -1;
  },
};
