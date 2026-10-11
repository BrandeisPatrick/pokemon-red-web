// Enemy move selection and trainer AI (engine/battle/trainer_ai.asm, SelectEnemyMove in
// core.asm). The class routines come from data/trainer_classes.json (ai.behavior, the steps of
// TrainerAIPointers' routines) and the move-choice layers from moveChoiceLayers.
// Installed on Battle.prototype (see core.js).

import { aiTypeEffectiveness } from '../pokemon/types.js';
import {
  PLAYER, ENEMY, CANNOT_MOVE, EFFECT, MOVE, ANIM, WILD_BATTLE, PERCENT, STATUS_AILMENT_MOVE_EFFECTS,
  NEEDS_TO_RECHARGE, USING_RAGE, CHARGING_UP, THRASHING_ABOUT, USING_TRAPPING_MOVE, STORING_ENERGY,
  FRZ, SLP_MASK, BADLY_POISONED, PROTECTED_BY_MIST, USING_X_ACCURACY, GETTING_PUMPED,
} from './constants.js';
import { moveDataById } from './battle_mon.js';
import { far } from './text.js';

const E = EFFECT;

/** Action -> {item, amount|kind} of the AIUse* routines. */
const AI_ITEMS = Object.freeze({
  usePotion: { item: 'POTION', heal: 20 },
  useSuperPotion: { item: 'SUPER_POTION', heal: 50 },
  useHyperPotion: { item: 'HYPER_POTION', heal: 200 },
  useFullRestore: { item: 'FULL_RESTORE' },
  useFullHeal: { item: 'FULL_HEAL' },
  useXAttack: { item: 'X_ATTACK', effect: E.ATTACK_UP1_EFFECT },
  useXDefend: { item: 'X_DEFEND', effect: E.DEFENSE_UP1_EFFECT },
  useXSpeed: { item: 'X_SPEED', effect: E.SPEED_UP1_EFFECT },
  useXSpecial: { item: 'X_SPECIAL', effect: E.SPECIAL_UP1_EFFECT },
  useGuardSpec: { item: 'GUARD_SPEC' },
  useXAccuracy: { item: 'X_ACCURACY' },
  useDireHit: { item: 'DIRE_HIT' },
});

/** "1/5" -> 5 (AICheckIfHPBelowFraction's divisor). */
function fractionDivisor(f) {
  if (typeof f === 'number') return f;
  const m = /^1\/(\d+)$/.exec(String(f));
  return m ? Number(m[1]) : 1;
}

export const aiMixin = {
  /**
   * SelectEnemyMove: keeps the previous selection while recharging/raging/charging/thrashing,
   * asleep or frozen, using a trapping move or Bide; CANNOT_MOVE while caught in the player's
   * trapping move; Struggle when the only move is disabled; otherwise a random slot (25% each,
   * thresholds 63/127/190) among the moves the trainer AI layers left, rerolled for empty or
   * disabled slots. Gen 1 enemies never run out of PP.
   */
  selectEnemyMove() {
    const En = this.side[ENEMY];
    if (this.link) return;
    if (En.status2 & (NEEDS_TO_RECHARGE | USING_RAGE)) return;
    if (En.status1 & (CHARGING_UP | THRASHING_ABOUT)) return;
    if (En.status & (FRZ | SLP_MASK)) return;
    if (En.status1 & (USING_TRAPPING_MOVE | STORING_ENERGY)) return;
    if (this.side[PLAYER].status1 & USING_TRAPPING_MOVE) {
      En.selectedMove = CANNOT_MOVE;
      return;
    }
    if (!En.moves[1] && En.disabledMove) {
      En.selectedMove = MOVE.STRUGGLE;
      return;
    }
    let list = En.moves;
    if (this.isInBattle !== WILD_BATTLE) list = this.aiEnemyTrainerChooseMoves();
    const disabledSlot = (En.disabledMove >> 4) & 0xf;
    for (let guard = 0; guard < 100000; guard++) {
      const r = this.random();
      let b = 1;
      if (r >= PERCENT(25)) {
        b = 2;
        if (r >= PERCENT(50)) {
          b = 3;
          if (r >= PERCENT(75) - 1) b = 4;
        }
      }
      if (disabledSlot === b) continue;
      const m = list[b - 1];
      if (!m) continue;
      En.moveListIndex = b - 1;
      En.selectedMove = m;
      return;
    }
    throw new Error('SelectEnemyMove: no selectable move');
  },

  /**
   * AIEnemyTrainerChooseMoves: score every slot (10, 80 for the disabled one), apply the class'
   * layers, keep only the minimum-score slots. Returns a 4-entry move list with the other
   * slots zeroed (the wBuffer the random pick then reads).
   * Layer functions call ReadMove, which overwrites wEnemyMove* (the engine relies on
   * GetCurrentMove reloading it later; Counter checks in between see the last read move).
   */
  aiEnemyTrainerChooseMoves() {
    const En = this.side[ENEMY];
    const buf = [10, 10, 10, 10];
    const dis = (En.disabledMove >> 4) & 0xf;
    if (dis) buf[dis - 1] = 0x50;
    const layers = this.trainerAI ? this.trainerAI.moveChoiceLayers || [] : [];
    if (!layers.length) return En.moves.slice();
    for (const layer of layers) {
      if (layer === 1) this.aiLayer1(buf);
      else if (layer === 2) this.aiLayer2(buf);
      else if (layer === 3) this.aiLayer3(buf);
      // layer 4 does nothing
    }
    this.aiTrace?.('scores', buf.slice());
    // .loopFindMinimumEntries: decrement every existing slot until one hits 0, undo that pass
    let min = Infinity;
    for (let i = 0; i < 4; i++) if (En.moves[i] && buf[i] < min) min = buf[i];
    const out = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) if (En.moves[i] && buf[i] === min) out[i] = En.moves[i];
    return out;
  },

  /** ReadMove: load a move's data into wEnemyMove*. */
  aiReadMove(id) {
    this.side[ENEMY].move = moveDataById(id, this.gd);
  },

  /** AIMoveChoiceModification1: +5 to power-0 status-ailment moves if the player is statused. */
  aiLayer1(buf) {
    const En = this.side[ENEMY];
    if (!this.side[PLAYER].status) return;
    for (let i = 0; i < 4; i++) {
      const id = En.moves[i];
      if (!id) return;
      this.aiReadMove(id);
      if (En.move.power) continue;
      if (!STATUS_AILMENT_MOVE_EFFECTS.includes(En.move.effect)) continue;
      buf[i] += 5;
    }
  },

  /** AIMoveChoiceModification2: -1 to stat/field moves when wAILayer2Encouragement == 1. */
  aiLayer2(buf) {
    const En = this.side[ENEMY];
    if (this.aiLayer2Encouragement !== 1) return;
    for (let i = 0; i < 4; i++) {
      const id = En.moves[i];
      if (!id) return;
      this.aiReadMove(id);
      const eff = En.move.effect;
      if (eff < E.ATTACK_UP1_EFFECT) continue;
      if (eff < E.BIDE_EFFECT) { buf[i] -= 1; continue; }
      if (eff < E.ATTACK_UP2_EFFECT) continue;
      if (eff < E.POISON_EFFECT) buf[i] -= 1;
    }
  },

  /**
   * AIMoveChoiceModification3: -1 for super effective moves (AIGetTypeEffectiveness: first
   * matching row, default $10), +1 for not very effective / no effect moves when another move
   * is "better" (Super Fang, a fixed-damage move, Fly, or a damaging move of another type).
   */
  aiLayer3(buf) {
    const En = this.side[ENEMY];
    const P = this.side[PLAYER];
    for (let i = 0; i < 4; i++) {
      const id = En.moves[i];
      if (!id) return;
      this.aiReadMove(id);
      const eff = aiTypeEffectiveness(En.move.type, P.type1, P.type2, this.gd);
      if (eff === 0x10) continue;
      if (eff > 0x10) { buf[i] -= 1; continue; }
      const d = En.move.type;
      let better = false;
      for (let j = 0; j < 4; j++) {
        const m = En.moves[j];
        if (!m) break;
        this.aiReadMove(m);
        const e = En.move.effect;
        if (e === E.SUPER_FANG_EFFECT || e === E.SPECIAL_DAMAGE_EFFECT || e === E.FLY_EFFECT) { better = true; break; }
        if (En.move.type === d) continue;
        if (En.move.power) { better = true; break; }
      }
      // (wEnemyMove* keeps the last move the inner loop read, like the game)
      if (better) buf[i] += 1;
    }
  },

  // ===================================================================== class routines

  /**
   * TrainerAI: in trainer battles (not link), if wAICount allows it, run the class routine
   * with a = Random(). @returns {Generator<any, boolean>} true when an action replaced the
   * enemy's move this turn (carry)
   */
  *trainerAIAction() {
    if (this.isInBattle === WILD_BATTLE) return false;
    if (this.link || !this.trainerAI) return false;
    if (this.aiCount === 0) return false;
    if (this.aiCount === 0xff) this.aiCount = this.trainerAI.usesPerMon & 0xff;
    const a = this.random();
    return yield* this.runAIBehavior(this.trainerAI.behavior || [], a);
  },

  /** Interpret the ai.behavior steps of trainer_classes.json. */
  *runAIBehavior(steps, a) {
    for (const st of steps) {
      switch (st.op) {
        case 'none':
          return false;
        case 'continueIfRandomBelow':
          if (!(a < st.value)) return false;
          break;
        case 'ifRandomBelow':
          if (a < st.value) return yield* this.runAIAction(st.then);
          break;
        case 'continueIfHPBelow':
          if (!this.aiHPBelowFraction(fractionDivisor(st.fraction))) return false;
          break;
        case 'ifHPBelow':
          if (this.aiHPBelowFraction(fractionDivisor(st.fraction))) return yield* this.runAIAction(st.then);
          break;
        case 'continueIfStatused':
          if (!this.side[ENEMY].status) return false;
          break;
        case 'compareIgnored':
          break; // CooltrainerFAI: the cp's result is never tested
        case 'do':
          return yield* this.runAIAction(st.action);
        default:
          throw new Error(`trainer AI: unknown step ${st.op}`);
      }
    }
    return false;
  },

  /** AICheckIfHPBelowFraction: current HP < max HP / n. */
  aiHPBelowFraction(n) {
    const En = this.side[ENEMY];
    return En.hp < Math.floor(En.maxHP / n);
  },

  /** DecrementAICount + carry. */
  aiUsed() {
    this.aiCount = (this.aiCount - 1) & 0xff;
    this.aiActions.push(this.lastAIAction);
    return true;
  },

  *runAIAction(action) {
    const En = this.side[ENEMY];
    this.lastAIAction = action;
    if (action === 'switchIfEnoughMons') {
      let alive = 0;
      for (const m of this.enemyParty || []) if (m.hp) alive++;
      if (alive < 2) return false;
      this.aiActions.push(action);
      yield* this.switchEnemyMon();
      return true; // the switch does not decrement wAICount (EnemySendOut resets it to $ff)
    }
    const it = AI_ITEMS[action];
    if (!it) throw new Error(`trainer AI: unknown action ${action}`);
    this.aiItemName = this.gd.item(it.item).name;
    switch (action) {
      case 'usePotion': case 'useSuperPotion': case 'useHyperPotion': {
        const old = En.hp;
        let nw = (old + it.heal) & 0xffff;
        if (nw > En.maxHP) nw = En.maxHP;
        En.hp = nw;
        yield* this.aiPrintItemUse();
        yield* this.ui.hpBar(ENEMY, old, nw);
        return this.aiUsed();
      }
      case 'useFullRestore': {
        this.aiCureStatus();
        const old = En.hp;
        En.hp = En.maxHP;
        yield* this.aiPrintItemUse();
        yield* this.ui.hpBar(ENEMY, old, En.hp);
        return this.aiUsed();
      }
      case 'useFullHeal':
        yield* this.ui.sfxWait('SFX_HEAL_AILMENT');
        this.aiCureStatus();
        yield* this.aiPrintItemUse();
        return this.aiUsed();
      case 'useGuardSpec':
        yield* this.ui.sfxWait('SFX_HEAL_AILMENT');
        En.status2 |= PROTECTED_BY_MIST;
        yield* this.aiPrintItemUse();
        return this.aiUsed();
      case 'useXAccuracy':
        yield* this.ui.sfxWait('SFX_HEAL_AILMENT');
        En.status2 |= USING_X_ACCURACY;
        yield* this.aiPrintItemUse();
        return this.aiUsed();
      case 'useDireHit':
        yield* this.ui.sfxWait('SFX_HEAL_AILMENT');
        En.status2 |= GETTING_PUMPED;
        yield* this.aiPrintItemUse();
        return this.aiUsed();
      default: {
        // AIIncreaseStat: X Attack / Defend / Speed / Special through StatModifierUpEffect
        yield* this.aiPrintItemUse();
        const savedNum = En.move.num;
        const savedEffect = En.move.effect;
        En.move.num = ANIM.XSTATITEM_DUPLICATE_ANIM;
        En.move.effect = it.effect;
        this.turn = ENEMY;
        yield* this.statModifierUpEffect();
        En.move.num = savedNum;
        En.move.effect = savedEffect;
        return this.aiUsed();
      }
    }
  },

  /** AICureStatus: party + battle status, Toxic flag. */
  aiCureStatus() {
    const En = this.side[ENEMY];
    const pm = this.enemyParty && this.enemyParty[En.partyPos];
    if (pm) pm.status = 0;
    En.status = 0;
    En.status3 &= ~BADLY_POISONED;
  },

  /** AIPrintItemUse_: "<TRAINER> used <ITEM> on <MON>!" */
  *aiPrintItemUse() {
    this.nameBuffer = this.aiItemName;
    yield* this.text(far('_AIBattleUseItemText'));
  },

  /**
   * SwitchEnemyMon (AgathaAI / CooltrainerFAI / JugglerAI): save HP and status to the party,
   * "<TRAINER> withdrew <MON>!", send out the next mon (no Shift prompt).
   */
  *switchEnemyMon() {
    const En = this.side[ENEMY];
    const pm = this.enemyParty[En.partyPos];
    if (pm) {
      pm.hp = En.hp;
      pm.status = En.status;
    }
    yield* this.text(far('_AIBattleWithdrawText'));
    this.firstMonsNotOutYet = 1;
    yield* this.enemySendOut();
    this.firstMonsNotOutYet = 0;
  },
};
