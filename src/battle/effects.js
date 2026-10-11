// Move effect handlers: engine/battle/effects.asm and engine/battle/move_effects/*.asm,
// dispatched by JumpMoveEffect through MoveEffectPointerTable (data/moves/effects_pointers.asm).
// Every handler works on hWhoseTurn (this.turn): the user is side[turn], the target the other
// side. Installed on Battle.prototype (see core.js).

import {
  PLAYER, ENEMY, EFFECT, MOVE, ANIM, ANIMATIONTYPE, PERCENT, CANNOT_MOVE, TRAINER_BATTLE, WILD_BATTLE,
  STORING_ENERGY, THRASHING_ABOUT, ATTACKING_MULTIPLE_TIMES, FLINCHED, CHARGING_UP,
  USING_TRAPPING_MOVE, INVULNERABLE, CONFUSED, USING_X_ACCURACY, PROTECTED_BY_MIST, GETTING_PUMPED,
  HAS_SUBSTITUTE_UP, NEEDS_TO_RECHARGE, USING_RAGE, SEEDED, BADLY_POISONED, HAS_LIGHT_SCREEN_UP,
  HAS_REFLECT_UP, TRANSFORMED, SLP_MASK, PSN, BRN, FRZ, PAR, PP_MASK, NEUTRAL_MOD, MAX_MOD,
  STAT_MOD_NAMES,
} from './constants.js';
import {
  quarterSpeedDueToParalysis, halveAttackDueToBurn, applyBadgeStatBoosts, STAT_MODIFIER_RATIOS,
  BATTLE_STAT_KEYS,
} from './battle_mon.js';
import { far } from './text.js';

const E = EFFECT;

/** Handler name per effect id (MoveEffectPointerTable). */
export const EFFECT_HANDLERS = Object.freeze({
  [E.EFFECT_01]: 'sleepEffect',
  [E.POISON_SIDE_EFFECT1]: 'poisonEffect',
  [E.DRAIN_HP_EFFECT]: 'drainHPEffect',
  [E.BURN_SIDE_EFFECT1]: 'freezeBurnParalyzeEffect',
  [E.FREEZE_SIDE_EFFECT1]: 'freezeBurnParalyzeEffect',
  [E.PARALYZE_SIDE_EFFECT1]: 'freezeBurnParalyzeEffect',
  [E.EXPLODE_EFFECT]: 'explodeEffect',
  [E.DREAM_EATER_EFFECT]: 'drainHPEffect',
  [E.ATTACK_UP1_EFFECT]: 'statModifierUpEffect',
  [E.DEFENSE_UP1_EFFECT]: 'statModifierUpEffect',
  [E.SPEED_UP1_EFFECT]: 'statModifierUpEffect',
  [E.SPECIAL_UP1_EFFECT]: 'statModifierUpEffect',
  [E.ACCURACY_UP1_EFFECT]: 'statModifierUpEffect',
  [E.EVASION_UP1_EFFECT]: 'statModifierUpEffect',
  [E.PAY_DAY_EFFECT]: 'payDayEffect',
  [E.ATTACK_DOWN1_EFFECT]: 'statModifierDownEffect',
  [E.DEFENSE_DOWN1_EFFECT]: 'statModifierDownEffect',
  [E.SPEED_DOWN1_EFFECT]: 'statModifierDownEffect',
  [E.SPECIAL_DOWN1_EFFECT]: 'statModifierDownEffect',
  [E.ACCURACY_DOWN1_EFFECT]: 'statModifierDownEffect',
  [E.EVASION_DOWN1_EFFECT]: 'statModifierDownEffect',
  [E.CONVERSION_EFFECT]: 'conversionEffect',
  [E.HAZE_EFFECT]: 'hazeEffect',
  [E.BIDE_EFFECT]: 'bideEffect',
  [E.THRASH_PETAL_DANCE_EFFECT]: 'thrashPetalDanceEffect',
  [E.SWITCH_AND_TELEPORT_EFFECT]: 'switchAndTeleportEffect',
  [E.TWO_TO_FIVE_ATTACKS_EFFECT]: 'twoToFiveAttacksEffect',
  [E.EFFECT_1E]: 'twoToFiveAttacksEffect',
  [E.FLINCH_SIDE_EFFECT1]: 'flinchSideEffect',
  [E.SLEEP_EFFECT]: 'sleepEffect',
  [E.POISON_SIDE_EFFECT2]: 'poisonEffect',
  [E.BURN_SIDE_EFFECT2]: 'freezeBurnParalyzeEffect',
  [E.FREEZE_SIDE_EFFECT2]: 'freezeBurnParalyzeEffect',
  [E.PARALYZE_SIDE_EFFECT2]: 'freezeBurnParalyzeEffect',
  [E.FLINCH_SIDE_EFFECT2]: 'flinchSideEffect',
  [E.OHKO_EFFECT]: 'oneHitKOEffect',
  [E.CHARGE_EFFECT]: 'chargeEffect',
  [E.TRAPPING_EFFECT]: 'trappingEffect',
  [E.FLY_EFFECT]: 'chargeEffect',
  [E.ATTACK_TWICE_EFFECT]: 'twoToFiveAttacksEffect',
  [E.MIST_EFFECT]: 'mistEffect',
  [E.FOCUS_ENERGY_EFFECT]: 'focusEnergyEffect',
  [E.RECOIL_EFFECT]: 'recoilEffect',
  [E.CONFUSION_EFFECT]: 'confusionEffect',
  [E.ATTACK_UP2_EFFECT]: 'statModifierUpEffect',
  [E.DEFENSE_UP2_EFFECT]: 'statModifierUpEffect',
  [E.SPEED_UP2_EFFECT]: 'statModifierUpEffect',
  [E.SPECIAL_UP2_EFFECT]: 'statModifierUpEffect',
  [E.ACCURACY_UP2_EFFECT]: 'statModifierUpEffect',
  [E.EVASION_UP2_EFFECT]: 'statModifierUpEffect',
  [E.HEAL_EFFECT]: 'healEffect',
  [E.TRANSFORM_EFFECT]: 'transformEffect',
  [E.ATTACK_DOWN2_EFFECT]: 'statModifierDownEffect',
  [E.DEFENSE_DOWN2_EFFECT]: 'statModifierDownEffect',
  [E.SPEED_DOWN2_EFFECT]: 'statModifierDownEffect',
  [E.SPECIAL_DOWN2_EFFECT]: 'statModifierDownEffect',
  [E.ACCURACY_DOWN2_EFFECT]: 'statModifierDownEffect',
  [E.EVASION_DOWN2_EFFECT]: 'statModifierDownEffect',
  [E.LIGHT_SCREEN_EFFECT]: 'reflectLightScreenEffect',
  [E.REFLECT_EFFECT]: 'reflectLightScreenEffect',
  [E.POISON_EFFECT]: 'poisonEffect',
  [E.PARALYZE_EFFECT]: 'paralyzeEffect',
  [E.ATTACK_DOWN_SIDE_EFFECT]: 'statModifierDownEffect',
  [E.DEFENSE_DOWN_SIDE_EFFECT]: 'statModifierDownEffect',
  [E.SPEED_DOWN_SIDE_EFFECT]: 'statModifierDownEffect',
  [E.SPECIAL_DOWN_SIDE_EFFECT]: 'statModifierDownEffect',
  72: 'statModifierDownEffect',
  73: 'statModifierDownEffect',
  74: 'statModifierDownEffect',
  75: 'statModifierDownEffect',
  [E.CONFUSION_SIDE_EFFECT]: 'confusionSideEffect',
  [E.TWINEEDLE_EFFECT]: 'twoToFiveAttacksEffect',
  [E.SUBSTITUTE_EFFECT]: 'substituteEffect',
  [E.HYPER_BEAM_EFFECT]: 'hyperBeamEffect',
  [E.RAGE_EFFECT]: 'rageEffect',
  [E.MIMIC_EFFECT]: 'mimicEffect',
  [E.LEECH_SEED_EFFECT]: 'leechSeedEffect',
  [E.SPLASH_EFFECT]: 'splashEffect',
  [E.DISABLE_EFFECT]: 'disableEffect',
});

export const effectsMixin = {
  /** JumpMoveEffect: run the handler of the current side's move effect. */
  *jumpMoveEffect() {
    const eff = this.side[this.turn].move.effect;
    const name = EFFECT_HANDLERS[eff];
    if (!name) return; // NULL entries are never dispatched by the engine
    this.effectTrace?.(eff, name);
    yield* this[name]();
  },

  /** CheckTargetSubstitute */
  targetHasSubstitute() {
    return (this.side[this.turn ^ 1].status2 & HAS_SUBSTITUTE_UP) !== 0;
  },

  // -------------------------------------------------------------------- animation helpers

  /** PlayCurrentMoveAnimation2: the user's move animation with type 6 (player) / 3 (enemy). */
  *playCurrentMoveAnimation2() {
    const id = this.side[this.turn].move.num;
    if (!id) return;
    yield* this.playBattleAnimation2(id);
  },

  /** PlayBattleAnimation2: animation `id` with wAnimationType 6 / 3 by turn. */
  *playBattleAnimation2(id) {
    this.animationType = this.turn === PLAYER ? ANIMATIONTYPE.SHAKE_SCREEN_HORIZONTALLY_SLOW_2 : ANIMATIONTYPE.SHAKE_SCREEN_HORIZONTALLY_SLOW;
    yield* this.playBattleAnimation(id);
  },

  /** PlayCurrentMoveAnimation: the user's move animation, wAnimationType 0. */
  *playCurrentMoveAnimation() {
    this.animationType = 0;
    const id = this.side[this.turn].move.num;
    if (!id) return;
    yield* this.playBattleAnimation(id);
  },

  // -------------------------------------------------------------------- shared texts

  *printDidntAffectText() { yield* this.text(far('_DidntAffectText')); },
  *printButItFailedText() { yield* this.text(far('_ButItFailedText')); },
  *printNothingHappenedText() { yield* this.text(far('_NothingHappenedText')); },
  *printMayNotAttackText() { yield* this.text(far('_ParalyzedMayNotAttackText')); },
  /** ConditionalPrintButItFailed: only if the move itself did not hit */
  *conditionalPrintButItFailed() {
    if (this.moveDidntMiss) return;
    yield* this.printButItFailedText();
  },

  /** ClearHyperBeam: the target no longer needs to recharge. */
  clearHyperBeam() {
    this.side[this.turn ^ 1].status2 &= ~NEEDS_TO_RECHARGE;
  },

  // -------------------------------------------------------------------- status effects

  /** SleepEffect (Sleep Powder, Hypnosis, Sing, Spore, Lovely Kiss, EFFECT_01). */
  *sleepEffect() {
    const T = this.side[this.turn ^ 1];
    const recharging = (T.status2 & NEEDS_TO_RECHARGE) !== 0;
    T.status2 &= ~NEEDS_TO_RECHARGE;
    if (!recharging) {
      if (T.status & SLP_MASK) {
        yield* this.text(far('_AlreadyAsleepText'));
        return;
      }
      if (T.status) {
        yield* this.printDidntAffectText();
        return;
      }
      this.moveHitTest(this.turn);
      if (this.moveMissed) {
        yield* this.printDidntAffectText();
        return;
      }
    }
    let n;
    do n = this.random() & SLP_MASK; while (n === 0);
    T.status = n;
    yield* this.playCurrentMoveAnimation2();
    yield* this.text(far('_FellAsleepText'));
  },

  /** PoisonEffect (Poison Sting & co side effects, Poison Powder/Gas, Toxic). */
  *poisonEffect() {
    const A = this.side[this.turn];
    const T = this.side[this.turn ^ 1];
    const eff = A.move.effect;
    const noEffect = function* () {
      if (eff !== E.POISON_EFFECT) return;
      yield* this.ui.delay(50);
      yield* this.printDidntAffectText();
    }.bind(this);
    if (this.targetHasSubstitute()) { yield* noEffect(); return; }
    if (T.status) { yield* noEffect(); return; }
    if (T.type1 === 'POISON' || T.type2 === 'POISON') { yield* noEffect(); return; }
    if (eff === E.POISON_SIDE_EFFECT1 || eff === E.POISON_SIDE_EFFECT2) {
      const chance = eff === E.POISON_SIDE_EFFECT1 ? PERCENT(20) + 1 : PERCENT(40) + 1;
      if (this.random() >= chance) return;
    } else {
      this.moveHitTest(this.turn);
      if (this.moveMissed) {
        yield* this.ui.delay(50);
        yield* this.printDidntAffectText();
        return;
      }
    }
    T.status |= PSN;
    let label = '_PoisonedText';
    if (A.move.num === MOVE.TOXIC) {
      T.status3 |= BADLY_POISONED;
      T.toxicCounter = 0;
      label = '_BadlyPoisonedText';
    }
    if (eff === E.POISON_EFFECT) {
      yield* this.playCurrentMoveAnimation2();
    } else {
      yield* this.playBattleAnimation2(this.turn === PLAYER ? ANIM.ENEMY_HUD_SHAKE_ANIM : ANIM.SHAKE_SCREEN_ANIM);
    }
    yield* this.text(far(label));
  },

  /** FreezeBurnParalyzeEffect (side effects of Fire/Ice/Electric/... moves) + CheckDefrost. */
  *freezeBurnParalyzeEffect() {
    this.animationType = 0;
    if (this.targetHasSubstitute()) return;
    const A = this.side[this.turn];
    const T = this.side[this.turn ^ 1];
    if (T.status) {
      yield* this.checkDefrost();
      return;
    }
    const type = A.move.type;
    if (T.type1 === type || T.type2 === type) return;
    let eff = A.move.effect;
    let chance = PERCENT(10) + 1;
    if (eff > E.PARALYZE_SIDE_EFFECT1) {
      chance = PERCENT(30) + 1;
      eff -= E.PARALYZE_SIDE_EFFECT2 - E.PARALYZE_SIDE_EFFECT1;
    }
    if (this.random() >= chance) return;
    if (this.turn === PLAYER) {
      if (eff === E.BURN_SIDE_EFFECT1) {
        T.status = BRN;
        halveAttackDueToBurn(T);
        yield* this.playBattleAnimation(ANIM.ENEMY_HUD_SHAKE_ANIM);
        yield* this.text(far('_BurnedText'));
      } else if (eff === E.FREEZE_SIDE_EFFECT1) {
        this.clearHyperBeam();
        T.status = FRZ;
        yield* this.playBattleAnimation(ANIM.ENEMY_HUD_SHAKE_ANIM);
        yield* this.text(far('_FrozenText'));
      } else {
        T.status = PAR;
        quarterSpeedDueToParalysis(T);
        yield* this.playBattleAnimation(ANIM.ENEMY_HUD_SHAKE_ANIM);
        yield* this.printMayNotAttackText();
      }
    } else if (eff === E.BURN_SIDE_EFFECT1) {
      T.status = BRN;
      halveAttackDueToBurn(T);
      yield* this.text(far('_BurnedText'));
    } else if (eff === E.FREEZE_SIDE_EFFECT1) {
      // the player's Hyper Beam recharge is not cleared on this side
      T.status = FRZ;
      yield* this.text(far('_FrozenText'));
    } else {
      T.status = PAR;
      quarterSpeedDueToParalysis(T);
      yield* this.printMayNotAttackText();
    }
  },

  /** CheckDefrost: a Fire move with a burn chance thaws a frozen target. */
  *checkDefrost() {
    const A = this.side[this.turn];
    const T = this.side[this.turn ^ 1];
    if (!(T.status & FRZ)) return;
    if (A.move.type !== 'FIRE') return;
    T.status = 0;
    if (this.turn === PLAYER) {
      const pm = this.enemyParty && this.enemyParty[T.partyPos];
      if (pm) pm.status = 0;
    } else {
      this.party[this.playerMonNumber].status = 0;
    }
    yield* this.text(far('_FireDefrostedText'));
  },

  /** ParalyzeEffect_ (Thunder Wave, Stun Spore, Glare). */
  *paralyzeEffect() {
    const A = this.side[this.turn];
    const T = this.side[this.turn ^ 1];
    if (T.status) {
      yield* this.ui.delay(50);
      yield* this.printDidntAffectText();
      return;
    }
    if (A.move.type === 'ELECTRIC' && (T.type1 === 'GROUND' || T.type2 === 'GROUND')) {
      yield* this.ui.delay(50);
      yield* this.text(far('_DoesntAffectMonText'));
      return;
    }
    this.moveHitTest(this.turn);
    if (this.moveMissed) {
      yield* this.ui.delay(50);
      yield* this.printDidntAffectText();
      return;
    }
    T.status |= PAR;
    quarterSpeedDueToParalysis(T);
    yield* this.ui.delay(30);
    yield* this.playCurrentMoveAnimation();
    yield* this.printMayNotAttackText();
  },

  /** ConfusionSideEffect (Psybeam, Confusion): 10% (25/256). */
  *confusionSideEffect() {
    if (this.random() >= PERCENT(10)) return;
    yield* this.confusionSideEffectSuccess();
  },

  /** ConfusionEffect (Supersonic, Confuse Ray). */
  *confusionEffect() {
    if (this.targetHasSubstitute()) { yield* this.confusionEffectFailed(); return; }
    this.moveHitTest(this.turn);
    if (this.moveMissed) { yield* this.confusionEffectFailed(); return; }
    yield* this.confusionSideEffectSuccess();
  },

  *confusionSideEffectSuccess() {
    const A = this.side[this.turn];
    const T = this.side[this.turn ^ 1];
    if (T.status1 & CONFUSED) { yield* this.confusionEffectFailed(); return; }
    T.status1 |= CONFUSED;
    T.confusedCounter = (this.random() & 3) + 2;
    if (A.move.effect !== E.CONFUSION_SIDE_EFFECT) yield* this.playCurrentMoveAnimation2();
    yield* this.text(far('_BecameConfusedText'));
  },

  *confusionEffectFailed() {
    if (this.side[this.turn].move.effect === E.CONFUSION_SIDE_EFFECT) return;
    yield* this.ui.delay(50);
    yield* this.conditionalPrintButItFailed();
  },

  /** FlinchSideEffect: 10% / 30% (+1/256); clears the target's Hyper Beam recharge. */
  *flinchSideEffect() {
    if (this.targetHasSubstitute()) return;
    const A = this.side[this.turn];
    const T = this.side[this.turn ^ 1];
    const chance = A.move.effect === E.FLINCH_SIDE_EFFECT1 ? PERCENT(10) + 1 : PERCENT(30) + 1;
    if (this.random() >= chance) return;
    T.status1 |= FLINCHED;
    this.clearHyperBeam();
  },

  // -------------------------------------------------------------------- stat changes

  /** StatModifierUpEffect (+1 / +2 stat moves, X items, Rage building). */
  *statModifierUpEffect() {
    const s = this.turn;
    const A = this.side[s];
    let idx = (A.move.effect - E.ATTACK_UP1_EFFECT) & 0xff;
    if (idx >= E.EVASION_UP1_EFFECT + 3 - E.ATTACK_UP1_EFFECT) idx = (idx - (E.ATTACK_UP2_EFFECT - E.ATTACK_UP1_EFFECT)) & 0xff;
    let b = (A.mods[idx] + 1) & 0xff;
    if (b > MAX_MOD) {
      yield* this.printNothingHappenedText();
      return;
    }
    if (A.move.effect >= E.ATTACK_UP1_EFFECT + 8) {
      b++;
      if (b > MAX_MOD) b = MAX_MOD;
    }
    A.mods[idx] = b;
    if (idx < 4) {
      const key = BATTLE_STAT_KEYS[idx];
      if (A[key] === 999) {
        // RestoreOriginalStatModifier: only undoes one stage (a +2 move nets +1)
        A.mods[idx] = (A.mods[idx] - 1) & 0xff;
        yield* this.printNothingHappenedText();
        return;
      }
      const [num, den] = STAT_MODIFIER_RATIOS[b - 1];
      let v = Math.floor((A.unmod[key] * num) / den);
      if (v > 999) v = 999;
      A[key] = v;
    }
    // UpdateStatDone
    this.stringBuffer = STAT_MOD_NAMES[idx];
    const minimize = A.move.num === MOVE.MINIMIZE;
    const subUp = (A.status2 & HAS_SUBSTITUTE_UP) !== 0;
    if (minimize && subUp) yield* this.hideSubstituteShowMon(s);
    yield* this.playCurrentMoveAnimation();
    if (minimize) {
      A.minimized = 1;
      if (subUp) yield* this.reshowSubstitute(s);
    }
    if (s === PLAYER) applyBadgeStatBoosts(A, this.badges()); // re-applied to every stat (stacking bug)
    const greatly = A.move.effect >= E.ATTACK_DOWN1_EFFECT;
    const cmds = [{ cmd: 'text_far', label: '_MonsStatsRoseText' }];
    if (greatly) cmds.push({ cmd: 'text_pause' }, { cmd: 'text_far', label: '_GreatlyRoseText' });
    cmds.push({ cmd: 'text_far', label: '_RoseText' }, { cmd: 'text_end' });
    yield* this.text(cmds);
    // "these shouldn't be here": the penalties of the OTHER side are re-applied
    quarterSpeedDueToParalysis(this.side[s ^ 1]);
    halveAttackDueToBurn(this.side[s ^ 1]);
  },

  /** StatModifierDownEffect (stat-lowering moves and side effects). */
  *statModifierDownEffect() {
    const s = this.turn;
    const A = this.side[s];
    const T = this.side[s ^ 1];
    const eff = A.move.effect;
    const isSide = eff >= E.ATTACK_DOWN_SIDE_EFFECT;
    const moveMissed = function* () {
      if (isSide) return;
      yield* this.conditionalPrintButItFailed();
    }.bind(this);
    const cantLowerAnymore = function* () {
      if (isSide) return;
      yield* this.printNothingHappenedText();
    }.bind(this);
    if (s === ENEMY && !this.link) {
      if (this.random() < PERCENT(25) + 1) { yield* moveMissed(); return; }
    }
    if (this.targetHasSubstitute()) { yield* moveMissed(); return; }
    let idx;
    if (isSide) {
      if (this.random() >= PERCENT(33) + 1) { yield* cantLowerAnymore(); return; }
      idx = eff - E.ATTACK_DOWN_SIDE_EFFECT;
    } else {
      this.moveHitTest(s);
      if (this.moveMissed) { yield* moveMissed(); return; }
      if (T.status1 & INVULNERABLE) { yield* moveMissed(); return; }
      idx = (eff - E.ATTACK_DOWN1_EFFECT) & 0xff;
      if (idx >= E.EVASION_DOWN1_EFFECT + 3 - E.ATTACK_DOWN1_EFFECT) idx = (idx - (E.ATTACK_DOWN2_EFFECT - E.ATTACK_DOWN1_EFFECT)) & 0xff;
    }
    let b = (T.mods[idx] - 1) & 0xff;
    if (b === 0) { yield* cantLowerAnymore(); return; }
    if (eff >= E.ATTACK_DOWN2_EFFECT - 0x16 && eff < E.ATTACK_DOWN_SIDE_EFFECT) {
      b--;
      if (b === 0) b = 1;
    }
    T.mods[idx] = b;
    if (idx < 4) {
      const key = BATTLE_STAT_KEYS[idx];
      if (T[key] === 1) {
        // CantLowerAnymore_Pop: only one stage is given back (a -2 move nets -1)
        T.mods[idx] = (T.mods[idx] + 1) & 0xff;
        yield* cantLowerAnymore();
        return;
      }
      const [num, den] = STAT_MODIFIER_RATIOS[b - 1];
      let v = Math.floor((T.unmod[key] * num) / den);
      if (v === 0) v = 1;
      T[key] = v;
    }
    // UpdateLoweredStatDone
    this.stringBuffer = STAT_MOD_NAMES[idx];
    if (!isSide) yield* this.playCurrentMoveAnimation2();
    if (s === ENEMY) applyBadgeStatBoosts(this.side[PLAYER], this.badges()); // stacking bug
    const greatly = eff >= E.BIDE_EFFECT && eff < E.ATTACK_DOWN_SIDE_EFFECT;
    const cmds = [{ cmd: 'text_far', label: '_MonsStatsFellText' }];
    if (greatly) cmds.push({ cmd: 'text_pause' }, { cmd: 'text_far', label: '_GreatlyFellText' });
    cmds.push({ cmd: 'text_far', label: '_FellText' }, { cmd: 'text_end' });
    yield* this.text(cmds);
    quarterSpeedDueToParalysis(T);
    halveAttackDueToBurn(T);
  },

  // -------------------------------------------------------------------- multi-turn moves

  /** BideEffect: store energy for 2-3 turns. Zeroes BOTH sides' move effects. */
  *bideEffect() {
    const A = this.side[this.turn];
    A.status1 |= STORING_ENERGY;
    A.bide = 0;
    this.side[PLAYER].move.effect = 0;
    this.side[ENEMY].move.effect = 0;
    A.numAttacksLeft = (this.random() & 1) + 2;
    yield* this.playBattleAnimation2(ANIM.XSTATITEM_ANIM + this.turn);
  },

  /** ThrashPetalDanceEffect: 2-3 turns. */
  *thrashPetalDanceEffect() {
    const A = this.side[this.turn];
    A.status1 |= THRASHING_ABOUT;
    A.numAttacksLeft = (this.random() & 1) + 2;
    yield* this.playBattleAnimation2(ANIM.SHRINKING_SQUARE_ANIM + this.turn);
  },

  /** TrappingEffect (Wrap, Bind, Clamp, Fire Spin): 2-5 total attacks; clears the target's recharge. */
  *trappingEffect() {
    const A = this.side[this.turn];
    if (A.status1 & USING_TRAPPING_MOVE) return;
    this.clearHyperBeam();
    A.status1 |= USING_TRAPPING_MOVE;
    let n = this.random() & 3;
    if (n >= 2) n = this.random() & 3;
    A.numAttacksLeft = n + 1;
  },

  /** TwoToFiveAttacksEffect (+ Double Kick / Bonemerang / Twineedle). */
  *twoToFiveAttacksEffect() {
    const A = this.side[this.turn];
    if (A.status1 & ATTACKING_MULTIPLE_TIMES) return;
    A.status1 |= ATTACKING_MULTIPLE_TIMES;
    let n;
    if (A.move.effect === E.TWINEEDLE_EFFECT) {
      A.move.effect = E.POISON_SIDE_EFFECT1;
      n = 2;
    } else if (A.move.effect === E.ATTACK_TWICE_EFFECT) {
      n = 2;
    } else {
      n = this.random() & 3;
      if (n >= 2) n = this.random() & 3;
      n += 2;
    }
    A.numAttacksLeft = n;
    A.numHits = n;
  },

  /** ChargeEffect (Razor Wind, Solar Beam, Skull Bash, Sky Attack, Fly, Dig). */
  *chargeEffect() {
    const A = this.side[this.turn];
    A.status1 |= CHARGING_UP;
    let anim = this.turn === PLAYER ? ANIM.XSTATITEM_ANIM : ANIM.XSTATITEM_DUPLICATE_ANIM;
    if (A.move.effect === E.FLY_EFFECT) {
      A.status1 |= INVULNERABLE;
      anim = MOVE.TELEPORT;
    }
    if (A.move.num === MOVE.DIG) {
      A.status1 |= INVULNERABLE;
      anim = ANIM.SLIDE_DOWN_ANIM;
    }
    this.animationType = 0;
    yield* this.playBattleAnimation(anim);
    const n = A.move.num;
    this.chargeMoveNum = n;
    const line = {
      [MOVE.RAZOR_WIND]: '_MadeWhirlwindText', [MOVE.SOLARBEAM]: '_TookInSunlightText',
      [MOVE.SKULL_BASH]: '_LoweredItsHeadText', [MOVE.SKY_ATTACK]: '_SkyAttackGlowingText',
      [MOVE.FLY]: '_FlewUpHighText', [MOVE.DIG]: '_DugAHoleText',
    }[n];
    const cmds = [{ cmd: 'text_far', label: '_ChargeMoveEffectText' }];
    if (line) cmds.push({ cmd: 'text_far', label: line });
    cmds.push({ cmd: 'text_end' });
    yield* this.text(cmds);
  },

  /** HyperBeamEffect: must recharge (only reached when the target survived). */
  *hyperBeamEffect() {
    this.side[this.turn].status2 |= NEEDS_TO_RECHARGE;
  },

  /** RageEffect */
  *rageEffect() {
    this.side[this.turn].status2 |= USING_RAGE;
  },

  // -------------------------------------------------------------------- HP effects

  /** DrainHPEffect_ (Absorb, Mega Drain, Leech Life, Dream Eater): half of wDamage (min 1). */
  *drainHPEffect() {
    const s = this.turn;
    const A = this.side[s];
    let d = this.damage >> 1;
    if (!d) d = 1;
    this.damage = d;
    const old = A.hp;
    let nw = old + d;
    if (nw > 0xffff || nw >= A.maxHP) nw = A.maxHP;
    A.hp = nw;
    yield* this.ui.hpBar(s, old, nw);
    this.ui.drawHUD(PLAYER);
    this.ui.drawHUD(ENEMY);
    this.readPlayerMonCurHPAndStatus();
    yield* this.text(far(A.move.effect === E.DREAM_EATER_EFFECT ? '_DreamWasEatenText' : '_SuckedHealthText'));
  },

  /** ExplodeEffect: the user faints (HP and status 0, Leech Seed cleared). */
  *explodeEffect() {
    const A = this.side[this.turn];
    A.hp = 0;
    A.status = 0;
    A.status2 &= ~SEEDED;
  },

  /** RecoilEffect_: 1/4 of wDamage (Struggle 1/2), min 1. */
  *recoilEffect() {
    const s = this.turn;
    const A = this.side[s];
    let d = this.damage >> 1;
    if (A.move.num !== MOVE.STRUGGLE) d >>= 1;
    if (!d) d = 1;
    const old = A.hp;
    let nw = old - d;
    if (nw < 0) nw = 0;
    A.hp = nw;
    yield* this.ui.hpBar(s, old, nw);
    yield* this.text(far('_HitWithRecoilText'));
  },

  /** HealEffect_ (Recover, Softboiled, Rest). */
  *healEffect() {
    const s = this.turn;
    const A = this.side[s];
    const id = A.move.num;
    // the high bytes are compared but ignored: fails when max HP - HP is 0, 255 or 511
    const borrow = (A.hp >> 8) < (A.maxHP >> 8) ? 1 : 0;
    if ((((A.hp & 0xff) - (A.maxHP & 0xff) - borrow) & 0xff) === 0) {
      yield* this.ui.delay(50);
      yield* this.printButItFailedText();
      return;
    }
    let amount = A.maxHP;
    if (id === MOVE.REST) {
      yield* this.ui.delay(50);
      const had = A.status;
      A.status = 2;
      yield* this.text(far(had ? '_FellAsleepBecameHealthyText' : '_StartedSleepingEffect'));
    } else {
      amount = A.maxHP >> 1;
    }
    const old = A.hp;
    let nw = (old + amount) & 0xffff;
    if (nw >= A.maxHP) nw = A.maxHP;
    A.hp = nw;
    yield* this.playCurrentMoveAnimation();
    yield* this.ui.hpBar(s, old, nw);
    this.ui.drawHUDs();
    yield* this.text(far('_RegainedHealthText'));
  },

  /** SubstituteEffect_: costs max HP / 4 (may leave the user at 0 HP - bug). */
  *substituteEffect() {
    const s = this.turn;
    const A = this.side[s];
    yield* this.ui.delay(50);
    if (A.status2 & HAS_SUBSTITUTE_UP) {
      yield* this.text(far('_HasSubstituteText'));
      return;
    }
    const cost = (A.maxHP >> 2) & 0xff;
    A.substituteHP = cost;
    const nw = A.hp - cost;
    if (nw < 0) {
      yield* this.text(far('_TooWeakSubstituteText'));
      return;
    }
    A.hp = nw;
    A.status2 |= HAS_SUBSTITUTE_UP;
    if (this.state.options.battleAnimations !== false) yield* this.playCurrentMoveAnimation();
    else yield* this.ui.sequence('SUBSTITUTE_DOLL', { attacker: s });
    yield* this.text(far('_SubstituteText'));
    this.ui.drawHUDs();
  },

  // -------------------------------------------------------------------- field effects

  /** MistEffect_ */
  *mistEffect() {
    const A = this.side[this.turn];
    if (A.status2 & PROTECTED_BY_MIST) {
      yield* this.printButItFailedText();
      return;
    }
    A.status2 |= PROTECTED_BY_MIST;
    yield* this.playCurrentMoveAnimation();
    yield* this.text(far('_ShroudedInMistText'));
  },

  /** FocusEnergyEffect_ (lowers the crit rate because of the CriticalHitTest bug). */
  *focusEnergyEffect() {
    const A = this.side[this.turn];
    if (A.status2 & GETTING_PUMPED) {
      yield* this.ui.delay(50);
      yield* this.printButItFailedText();
      return;
    }
    A.status2 |= GETTING_PUMPED;
    yield* this.playCurrentMoveAnimation();
    yield* this.text([{ cmd: 'text_pause' }, { cmd: 'text_far', label: '_GettingPumpedText' }, { cmd: 'text_end' }]);
  },

  /** ReflectLightScreenEffect_ */
  *reflectLightScreenEffect() {
    const A = this.side[this.turn];
    const ls = A.move.effect === E.LIGHT_SCREEN_EFFECT;
    const bit = ls ? HAS_LIGHT_SCREEN_UP : HAS_REFLECT_UP;
    if (A.status3 & bit) {
      yield* this.ui.delay(50);
      yield* this.printButItFailedText();
      return;
    }
    A.status3 |= bit;
    yield* this.playCurrentMoveAnimation();
    yield* this.text(far(ls ? '_LightScreenProtectedText' : '_ReflectGainedArmorText'));
  },

  /**
   * HazeEffect_: every stat mod back to neutral and battle stats = unmodified stats (this also
   * removes burn/paralysis penalties and badge boosts) on both sides; the TARGET's non-volatile
   * status is cured (a sleeping/frozen target loses its selected move); confusion, X Accuracy,
   * Mist, Focus Energy, Leech Seed, Toxic, Reflect, Light Screen and Disable cleared on both.
   */
  *hazeEffect() {
    for (const S of this.side) {
      S.resetMods();
      for (const k of BATTLE_STAT_KEYS) S[k] = S.unmod[k];
    }
    const T = this.side[this.turn ^ 1];
    const old = T.status;
    T.status = 0;
    if (old & (FRZ | SLP_MASK)) T.selectedMove = CANNOT_MOVE;
    for (const S of this.side) {
      S.disabledMove = 0;
      S.disabledMoveNumber = 0;
      S.status1 &= ~CONFUSED;
      S.status2 &= ~(USING_X_ACCURACY | PROTECTED_BY_MIST | GETTING_PUMPED | SEEDED);
      S.status3 &= 0xf0 | TRANSFORMED;
    }
    yield* this.playCurrentMoveAnimation();
    yield* this.text(far('_StatusChangesEliminatedText'));
  },

  /** LeechSeedEffect_ */
  *leechSeedEffect() {
    const T = this.side[this.turn ^ 1];
    this.moveHitTest(this.turn);
    const evaded = this.moveMissed || T.type1 === 'GRASS' || T.type2 === 'GRASS' || (T.status2 & SEEDED);
    if (evaded) {
      yield* this.ui.delay(50);
      yield* this.text(far('_EvadedAttackText'));
      return;
    }
    T.status2 |= SEEDED;
    yield* this.playCurrentMoveAnimation();
    yield* this.text(far('_WasSeededText'));
  },

  /** SplashEffect */
  *splashEffect() {
    yield* this.playCurrentMoveAnimation();
    yield* this.text(far('_NoEffectText'));
  },

  /** DisableEffect: a random non-empty move of the target for 1-8 turns. */
  *disableEffect() {
    const s = this.turn;
    const T = this.side[s ^ 1];
    this.moveHitTest(s);
    if (this.moveMissed || T.disabledMove) {
      yield* this.printButItFailedText();
      return;
    }
    let c;
    let moveId;
    for (let guard = 0; ; guard++) {
      c = this.random() & 3;
      moveId = T.moves[c];
      if (!moveId) continue;
      if (s === ENEMY || this.link) {
        // the player's moves: fail if all have 0 PP, re-pick a move with 0 PP
        const any = (T.pp[0] | T.pp[1] | T.pp[2] | T.pp[3]) & PP_MASK;
        if (!any) {
          yield* this.printButItFailedText();
          return;
        }
        if (!T.pp[c]) continue;
      }
      break;
    }
    const turns = (this.random() & 7) + 1;
    T.disabledMove = (((c + 1) << 4) + turns) & 0xff;
    yield* this.playCurrentMoveAnimation2();
    T.disabledMoveNumber = moveId;
    this.nameBuffer = this.moveName(moveId);
    yield* this.text(far('_MoveWasDisabledText'));
  },

  /** PayDayEffect_: 2 x level (8-bit) scattered; added to the total even on the enemy's turn. */
  *payDayEffect() {
    const lvl = this.side[this.turn].level;
    const amount = (lvl * 2) & 0xff;
    this.totalPayDayMoney = Math.min(999999, this.totalPayDayMoney + amount);
    yield* this.text(far('_CoinsScatteredText'));
  },

  /** ConversionEffect_: user takes the target's types (fails vs Fly/Dig). */
  *conversionEffect() {
    const A = this.side[this.turn];
    const T = this.side[this.turn ^ 1];
    if (T.status1 & INVULNERABLE) {
      yield* this.printButItFailedText();
      return;
    }
    A.type1 = T.type1;
    A.type2 = T.type2;
    yield* this.playCurrentMoveAnimation();
    yield* this.text(far('_ConvertedTypeText'));
  },

  /**
   * TransformEffect_: species, types, catch rate, moves (5 PP each), DVs, the 4 stats, the
   * unmodified stats and the stat mods are copied. The INVULNERABLE check is broken (never
   * fails on the enemy's turn, checks the user's own status on the player's turn) and the
   * player's wPlayerMoveListIndex is zeroed.
   */
  *transformEffect() {
    const s = this.turn;
    const A = this.side[s];
    const T = this.side[s ^ 1];
    let a = this.turn; // the enemy branch tests hWhoseTurn (1) instead of a status byte
    if (s === PLAYER) {
      A.moveListIndex = 0;
      a = A.status1;
    }
    if (a & INVULNERABLE) {
      yield* this.printButItFailedText();
      return;
    }
    const subUp = (A.status2 & HAS_SUBSTITUTE_UP) !== 0;
    if (subUp) yield* this.hideSubstituteShowMon(s);
    if (this.state.options.battleAnimations !== false) {
      yield* this.playCurrentMoveAnimation();
    } else {
      yield* this.ui.sequence('TRANSFORM_PIC', { attacker: s, targetSpecies: T.species });
    }
    if (subUp) yield* this.reshowSubstitute(s);
    A.status3 |= TRANSFORMED;
    A.species = T.species;
    A.type1 = T.type1;
    A.type2 = T.type2;
    A.catchRate = T.catchRate;
    A.moves = T.moves.slice();
    if (s === ENEMY) this.transformedEnemyMonOriginalDVs = { ...A.dvs };
    A.dvs = { ...T.dvs };
    A.atk = T.atk;
    A.def = T.def;
    A.spd = T.spd;
    A.spc = T.spc;
    A.pp = A.moves.map((m) => (m ? 5 : 0));
    this.nameBuffer = this.gd.species(T.species).name;
    for (const k of BATTLE_STAT_KEYS) A.unmod[k] = T.unmod[k];
    A.mods = T.mods.slice();
    yield* this.text(far('_TransformedText'));
  },

  /** MimicEffect: the player picks one of the foe's moves; the AI picks at random. */
  *mimicEffect() {
    const s = this.turn;
    const A = this.side[s];
    const T = this.side[s ^ 1];
    yield* this.ui.delay(50);
    this.moveHitTest(s);
    if (this.moveMissed) {
      yield* this.printButItFailedText();
      return;
    }
    let newMove;
    let slot;
    if (s === PLAYER && !this.link) {
      if (T.status1 & INVULNERABLE) {
        yield* this.printButItFailedText();
        return;
      }
      const choice = yield* this.ui.mimicMenu(T.moves.slice());
      this.ui.restoreScreen();
      newMove = T.moves[choice] || 0;
      slot = this.playerMoveListIndexForMimic();
    } else {
      // enemy's turn: the target is the player; the invulnerability check reads the player
      if (this.side[PLAYER].status1 & INVULNERABLE) {
        yield* this.printButItFailedText();
        return;
      }
      for (;;) {
        const r = this.random() & 3;
        if (T.moves[r]) { newMove = T.moves[r]; break; }
      }
      slot = A.moveListIndex;
    }
    A.moves[slot & 3] = newMove;
    this.nameBuffer = this.moveName(newMove);
    yield* this.playCurrentMoveAnimation();
    yield* this.text(far('_MimicLearnedMoveText'));
  },

  /** The Mimic slot: wPlayerMoveListIndex at the time (the menu saved/restored wCurrentMenuItem). */
  playerMoveListIndexForMimic() {
    return this.side[PLAYER].moveListIndex;
  },

  /**
   * SwitchAndTeleportEffect (Roar, Whirlwind, Teleport): ends a wild battle when the user's
   * level is >= the foe's or rand(0..sum) >= foe level / 4; never works against trainers.
   */
  *switchAndTeleportEffect() {
    const s = this.turn;
    const A = this.side[s];
    const id = A.move.num;
    if (this.isInBattle === WILD_BATTLE) {
      const userLevel = s === PLAYER ? A.level : this.curEnemyLevel;
      const foeLevel = s === PLAYER ? this.curEnemyLevel : this.side[PLAYER].level;
      let ok = userLevel >= foeLevel;
      if (!ok) {
        const c = (userLevel + foeLevel + 1) & 0xff;
        let r;
        do r = this.random(); while (r >= c);
        ok = r >= (foeLevel >> 2);
      }
      if (ok) {
        this.readPlayerMonCurHPAndStatus();
        this.animationType = 0;
        this.escapedFromBattle = 1;
        yield* this.playBattleAnimation(id);
        yield* this.ui.delay(20);
        const label = id === MOVE.TELEPORT ? '_RanFromBattleText' : id === MOVE.ROAR ? '_RanAwayScaredText' : '_WasBlownAwayText';
        yield* this.text(far(label));
        this.escapeReason = id === MOVE.TELEPORT ? 'teleport' : 'blownAway';
        this.escapeMove = id;
        this.escapeSide = s;
        return;
      }
      yield* this.ui.delay(50);
      if (id !== MOVE.TELEPORT) yield* this.printDidntAffectText();
      else yield* this.printButItFailedText();
      return;
    }
    yield* this.ui.delay(50);
    if (id !== MOVE.TELEPORT) {
      yield* this.text(far('_IsUnaffectedText'));
      return;
    }
    if (s === PLAYER) yield* this.printButItFailedText();
    else yield* this.conditionalPrintButItFailed();
  },

  /** OneHitKOEffect_: 65535 damage if the user's current Speed >= the target's, else a miss. */
  *oneHitKOEffect() {
    const A = this.side[this.turn];
    const T = this.side[this.turn ^ 1];
    this.damage = 0;
    this.criticalHitOrOHKO = 0xff;
    if (A.spd >= T.spd) {
      this.damage = 0xffff;
      this.criticalHitOrOHKO = 2;
    } else {
      this.moveMissed = 1;
    }
  },
};

export { NEUTRAL_MOD, TRAINER_BATTLE, STORING_ENERGY };
