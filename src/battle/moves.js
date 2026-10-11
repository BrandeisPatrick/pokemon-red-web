// Move execution: ExecutePlayerMove / ExecuteEnemyMove and everything they call in
// engine/battle/core.asm - status checks, the damage pipeline (CriticalHitTest ->
// HandleCounterMove -> GetDamageVars -> CalculateDamage -> AdjustDamageForMoveType ->
// RandomizeDamage -> MoveHitTest), damage application, substitutes, Rage, Mirror Move,
// Metronome, disobedience, confusion self-hits and the end-of-turn poison/burn/Leech Seed.
//
// Installed on Battle.prototype (see core.js). The asm jumps between labels ("jp hl" after the
// status checks, Mirror Move / Metronome going back to CheckIfPlayerNeedsToChargeUp); here
// that is the label loop in moveFrom(). One routine serves both sides; the few asymmetries of
// the original (PP only for the player, disobedience, animation types, Psywave range, the
// order of the sleep animation, ...) are kept and commented.

import { getGameData } from '../pokemon/data.js';
import { calculateDamage } from '../pokemon/damage.js';
import { isSpecialType } from '../pokemon/types.js';
import {
  PLAYER, ENEMY, CANNOT_MOVE, EFFECT, MOVE, ANIM, ANIMATIONTYPE, EFFECTIVE, PERCENT,
  STORING_ENERGY, THRASHING_ABOUT, ATTACKING_MULTIPLE_TIMES, FLINCHED, CHARGING_UP,
  USING_TRAPPING_MOVE, INVULNERABLE, CONFUSED, USING_X_ACCURACY, PROTECTED_BY_MIST,
  GETTING_PUMPED, HAS_SUBSTITUTE_UP, NEEDS_TO_RECHARGE, USING_RAGE, SEEDED, BADLY_POISONED,
  HAS_LIGHT_SCREEN_UP, HAS_REFLECT_UP, TRANSFORMED, SLP_MASK, PSN, BRN, FRZ, PAR, PP_MASK,
  MOD_ATTACK, MOD_ACCURACY, MOD_EVASION, RESIDUAL_EFFECTS_1, SPECIAL_EFFECTS_CONT,
  SET_DAMAGE_EFFECTS, RESIDUAL_EFFECTS_2, ALWAYS_HAPPEN_SIDE_EFFECTS, SPECIAL_EFFECTS,
  HIGH_CRITICAL_MOVES, NUM_ATTACKS, BADGE,
} from './constants.js';
import { STAT_MODIFIER_RATIOS, moveDataById, getEnemyMonStat, rawPP, setRawPP } from './battle_mon.js';
import { far } from './text.js';

const E = EFFECT;

/** MoveHitTest's Mist check: effects $12-$19 and $3A-$41. */
function isMistEffect(eff) {
  return (eff >= E.ATTACK_DOWN1_EFFECT && eff <= E.HAZE_EFFECT) || (eff >= E.ATTACK_DOWN2_EFFECT && eff <= E.REFLECT_EFFECT);
}

export const movesMixin = {
  // ======================================================================= entry points

  /**
   * ExecutePlayerMove / ExecuteEnemyMove.
   * @param {number} s side (0 player, 1 enemy)
   * @returns {Generator<any, number>} b: 0 when the target fainted (the caller then handles
   *   the faint), 1 otherwise
   */
  *executeMove(s) {
    const A = this.side[s];
    this.turn = s;
    if (s === PLAYER) {
      if (A.selectedMove === CANNOT_MOVE) return this.executeMoveDone(s);
      this.moveMissed = 0;
      this.monIsDisobedient = 0;
      this.moveDidntMiss = 0;
      this.damageMultipliers = EFFECTIVE;
      if (this.actionResult) return this.executeMoveDone(s);
      if (yield* this.printGhostText()) return this.executeMoveDone(s);
      let label = yield* this.checkStatusConditions(s);
      if (!label) {
        this.getCurrentMove(s);
        if (A.status1 & CHARGING_UP) label = 'canExecuteChargingMove';
        else {
          if (!(yield* this.checkForDisobedience())) return this.executeMoveDone(s);
          label = 'checkIfNeedsToChargeUp';
        }
      }
      return yield* this.moveFrom(s, label);
    }
    // enemy
    if (A.selectedMove === CANNOT_MOVE) return this.executeMoveDone(s);
    if (yield* this.printGhostText()) return this.executeMoveDone(s);
    this.aiLayer2Encouragement = (this.aiLayer2Encouragement + 1) & 0xff;
    this.moveMissed = 0;
    this.moveDidntMiss = 0;
    this.damageMultipliers = EFFECTIVE;
    let label = yield* this.checkStatusConditions(s);
    if (!label) {
      if (A.status1 & CHARGING_UP) label = 'canExecuteChargingMove';
      else {
        this.getCurrentMove(s);
        label = 'checkIfNeedsToChargeUp';
      }
    }
    return yield* this.moveFrom(s, label);
  },

  /** ExecutePlayerMoveDone / ExecuteEnemyMoveDone. */
  executeMoveDone(s) {
    if (s === PLAYER) this.actionResult = 0;
    return 1;
  },

  /**
   * The label flow of ExecutePlayerMove/ExecuteEnemyMove starting at `label`.
   * @returns {Generator<any, number>} b
   */
  *moveFrom(s, label) {
    const A = this.side[s];
    const D = this.side[s ^ 1];
    let animType = 0;
    for (let guard = 0; guard < 100; guard++) {
      switch (label) {
        case 'checkIfNeedsToChargeUp':
          if (A.move.effect === E.CHARGE_EFFECT || A.move.effect === E.FLY_EFFECT) {
            yield* this.jumpMoveEffect();
            return 1;
          }
          label = 'canExecuteMove';
          break;

        case 'canExecuteChargingMove':
          A.status1 &= ~(CHARGING_UP | INVULNERABLE);
          if (s === ENEMY) this.setMoveNameBuffers(A.move.num);
          label = 'canExecuteMove';
          break;

        case 'canExecuteMove':
          if (s === ENEMY) this.monIsDisobedient = 0;
          yield* this.displayUsedMoveText(s);
          if (s === PLAYER) this.decrementPP();
          if (RESIDUAL_EFFECTS_1.includes(A.move.effect)) {
            yield* this.jumpMoveEffect();
            return 1;
          }
          if (SPECIAL_EFFECTS_CONT.includes(A.move.effect)) yield* this.jumpMoveEffect();
          label = 'calcMoveDamage';
          break;

        case 'calcMoveDamage': {
          if (SET_DAMAGE_EFFECTS.includes(A.move.effect)) { label = 'moveHitTest'; break; }
          this.criticalHitTest(s);
          if (this.handleCounterMove(s)) { label = 'handleIfMoveMissed'; break; }
          const vars = this.getDamageVars(s);
          if (!(yield* this.calculateDamage(s, vars))) { label = 'checkIfFlyOrChargeEffect'; break; }
          this.adjustDamageForMoveType(s);
          this.randomizeDamage();
          label = 'moveHitTest';
          break;
        }

        case 'moveHitTest':
          this.moveHitTest(s);
          label = 'handleIfMoveMissed';
          break;

        case 'handleIfMoveMissed':
          if (this.moveMissed) {
            if (A.move.effect === E.EXPLODE_EFFECT) { animType = 0; label = 'playMoveAnimation'; } else label = 'checkIfFlyOrChargeEffect';
          } else label = 'getAnimationType';
          break;

        case 'getAnimationType':
          if (s === PLAYER) animType = A.move.effect ? ANIMATIONTYPE.SHAKE_SCREEN_HORIZONTALLY_LIGHT : ANIMATIONTYPE.BLINK_ENEMY_MON_SPRITE;
          else animType = A.move.effect ? ANIMATIONTYPE.SHAKE_SCREEN_HORIZONTALLY_HEAVY : ANIMATIONTYPE.SHAKE_SCREEN_VERTICALLY;
          label = 'playMoveAnimation';
          break;

        case 'playMoveAnimation':
          if (A.status2 & HAS_SUBSTITUTE_UP) yield* this.hideSubstituteShowMon(s);
          this.animationType = animType;
          yield* this.playMoveAnimation(A.move.num);
          yield* this.handleExplodingAnimation(s);
          this.ui.drawHUD(s);
          if (A.status2 & HAS_SUBSTITUTE_UP) yield* this.reshowSubstitute(s);
          label = 'mirrorMoveCheck';
          break;

        case 'checkIfFlyOrChargeEffect':
          yield* this.ui.delay(30);
          if (A.move.effect === E.FLY_EFFECT || A.move.effect === E.CHARGE_EFFECT) {
            this.animationType = 0;
            yield* this.playMoveAnimation(ANIM.STATUS_AFFECTED_ANIM);
          }
          label = 'mirrorMoveCheck';
          break;

        case 'mirrorMoveCheck':
          if (A.move.effect === E.MIRROR_MOVE_EFFECT) {
            if (!(yield* this.mirrorMoveCopyMove(s))) return this.executeMoveDone(s);
            if (s === PLAYER) this.monIsDisobedient = 0;
            label = 'checkIfNeedsToChargeUp';
            break;
          }
          if (A.move.effect === E.METRONOME_EFFECT) {
            yield* this.metronomePickMove(s);
            label = 'checkIfNeedsToChargeUp';
            break;
          }
          if (RESIDUAL_EFFECTS_2.includes(A.move.effect)) {
            yield* this.jumpMoveEffect();
            return 1;
          }
          if (this.moveMissed) {
            yield* this.printMoveFailureText(s);
            if (A.move.effect === E.EXPLODE_EFFECT) { label = 'notDone'; break; }
            return this.executeMoveDone(s);
          }
          yield* this.applyAttack(s);
          yield* this.printCriticalOHKOText();
          yield* this.displayEffectiveness();
          this.moveDidntMiss = 1;
          label = 'notDone';
          break;

        case 'notDone':
          if (ALWAYS_HAPPEN_SIDE_EFFECTS.includes(A.move.effect)) yield* this.jumpMoveEffect();
          if (D.hp === 0) return 0;
          yield* this.handleBuildingRage(s);
          if (A.status1 & ATTACKING_MULTIPLE_TIMES) {
            A.numAttacksLeft = (A.numAttacksLeft - 1) & 0xff;
            if (A.numAttacksLeft) { label = 'getAnimationType'; break; }
            A.status1 &= ~ATTACKING_MULTIPLE_TIMES;
            yield* this.text(far(s === PLAYER ? '_MultiHitText' : '_HitXTimesText'));
            A.numHits = 0;
          }
          if (A.move.effect && !SPECIAL_EFFECTS.includes(A.move.effect)) yield* this.jumpMoveEffect();
          return this.executeMoveDone(s);

        case 'done': // ExecutePlayerMoveDone / ExecuteEnemyMoveDone
          return this.executeMoveDone(s);

        default:
          throw new Error(`moveFrom: unknown label ${label}`);
      }
    }
    throw new Error('moveFrom: label loop did not terminate');
  },

  // ======================================================================= status checks

  /**
   * PrintGhostText: in an unidentified-ghost battle the player's mon is too scared to move
   * (unless asleep/frozen) and the ghost only says "Get out...".
   * @returns {Generator<any, boolean>} true = turn over
   */
  *printGhostText() {
    if (!this.isGhostBattle()) return false;
    if (this.turn === PLAYER) {
      if (this.side[PLAYER].status & (FRZ | SLP_MASK)) return false;
      yield* this.text(far('_ScaredText'));
      return true;
    }
    yield* this.text(far('_GetOutText'));
    return true;
  },

  /**
   * CheckPlayerStatusConditions / CheckEnemyStatusConditions.
   * @returns {Generator<any, string|null>} null = can move normally, else the label to jump to
   */
  *checkStatusConditions(s) {
    const A = this.side[s];
    const D = this.side[s ^ 1];
    // sleep
    if (A.status & SLP_MASK) {
      A.status = ((A.status & SLP_MASK) - 1) & 0xff;
      if (A.status === 0) {
        yield* this.text(far('_WokeUpText'));
      } else if (s === PLAYER) {
        this.animationType = 0;
        yield* this.playMoveAnimation(ANIM.SLP_PLAYER_ANIM);
        yield* this.text(far('_FastAsleepText'));
      } else {
        yield* this.text(far('_FastAsleepText'));
        this.animationType = 0;
        yield* this.playMoveAnimation(ANIM.SLP_ANIM);
      }
      A.usedMove = 0;
      return 'done';
    }
    if (A.status & FRZ) {
      yield* this.text(far('_IsFrozenText'));
      A.usedMove = 0;
      return 'done';
    }
    if (D.status1 & USING_TRAPPING_MOVE) {
      yield* this.text(far('_CantMoveText'));
      return 'done';
    }
    if (A.status1 & FLINCHED) {
      A.status1 &= ~FLINCHED;
      yield* this.text(far('_FlinchedText'));
      return 'done';
    }
    if (A.status2 & NEEDS_TO_RECHARGE) {
      A.status2 &= ~NEEDS_TO_RECHARGE;
      yield* this.text(far('_MustRechargeText'));
      return 'done';
    }
    if (A.disabledMove) {
      A.disabledMove = (A.disabledMove - 1) & 0xff;
      if ((A.disabledMove & 0xf) === 0) {
        A.disabledMove = 0;
        A.disabledMoveNumber = 0;
        yield* this.text(far('_DisabledNoMoreText'));
      }
    }
    let hurtOrParalysed = false;
    if (A.status1 & CONFUSED) {
      A.confusedCounter = (A.confusedCounter - 1) & 0xff;
      if (A.confusedCounter === 0) {
        A.status1 &= ~CONFUSED;
        yield* this.text(far('_ConfusedNoMoreText'));
      } else {
        yield* this.text(far('_IsConfusedText'));
        this.animationType = 0;
        yield* this.playMoveAnimation(s === PLAYER ? ANIM.CONF_PLAYER_ANIM : ANIM.CONF_ANIM);
        if (this.random() >= PERCENT(50) + 1) {
          A.status1 &= CONFUSED; // clear every other status1 bit
          if (s === PLAYER) yield* this.handleSelfConfusionDamage();
          else yield* this.enemySelfConfusionDamage();
          hurtOrParalysed = true;
        }
      }
    }
    if (!hurtOrParalysed) {
      if (A.disabledMoveNumber && A.disabledMoveNumber === A.selectedMove) {
        yield* this.printMoveIsDisabledText(s);
        return 'done';
      }
      if ((A.status & PAR) && this.random() < PERCENT(25)) {
        yield* this.text(far('_FullyParalyzedText'));
        hurtOrParalysed = true;
      }
    }
    if (hurtOrParalysed) {
      // clear Bide, Thrash, charging and trapping (already cleared for confusion damage)
      A.status1 &= ~(STORING_ENERGY | THRASHING_ABOUT | CHARGING_UP | USING_TRAPPING_MOVE);
      // INVULNERABLE stays set: a Fly/Dig user stays invulnerable (Gen 1 bug)
      if (A.move.effect === E.FLY_EFFECT || A.move.effect === E.CHARGE_EFFECT) {
        this.animationType = 0;
        yield* this.playMoveAnimation(ANIM.STATUS_AFFECTED_ANIM);
      }
      return 'done';
    }
    if (A.status1 & STORING_ENERGY) {
      A.move.num = 0;
      A.bide = (A.bide + this.damage) & 0xffff;
      A.numAttacksLeft = (A.numAttacksLeft - 1) & 0xff;
      if (A.numAttacksLeft) return 'done';
      A.status1 &= ~STORING_ENERGY;
      yield* this.text(far('_UnleashedEnergyText'));
      A.move.power = 1;
      this.damage = (A.bide * 2) & 0xffff;
      if (this.damage === 0) this.moveMissed = 1;
      A.bide = 0;
      A.move.num = MOVE.BIDE;
      return 'handleIfMoveMissed';
    }
    if (A.status1 & THRASHING_ABOUT) {
      A.move.num = MOVE.THRASH; // Petal Dance shows Thrash's animation on later turns
      yield* this.text(far('_ThrashingAboutText'));
      A.numAttacksLeft = (A.numAttacksLeft - 1) & 0xff;
      if (A.numAttacksLeft) return 'calcMoveDamage';
      A.status1 &= ~THRASHING_ABOUT;
      A.status1 |= CONFUSED;
      A.confusedCounter = (this.random() & 3) + 2;
      return 'calcMoveDamage';
    }
    if (A.status1 & USING_TRAPPING_MOVE) {
      yield* this.text(far('_AttackContinuesText'));
      A.numAttacksLeft = (A.numAttacksLeft - 1) & 0xff;
      return 'getAnimationType';
    }
    if (A.status2 & USING_RAGE) {
      this.setMoveNameBuffers(MOVE.RAGE);
      A.move.effect = 0;
      return 'canExecuteMove';
    }
    return null;
  },

  /** PrintMoveIsDisabledText */
  *printMoveIsDisabledText(s) {
    const A = this.side[s];
    A.status1 &= ~CHARGING_UP;
    this.nameBuffer = this.moveName(A.selectedMove);
    yield* this.text(far('_MoveIsDisabledText'));
  },

  /**
   * HandleSelfConfusionDamage (player): a typeless 40-power hit of its own Attack against its
   * own Defense (doubled by the ENEMY's Reflect); wPlayerMovePower/Type keep 40/NORMAL
   * afterwards (Counter can then strike back at confusion damage).
   */
  *handleSelfConfusionDamage() {
    const P = this.side[PLAYER];
    const En = this.side[ENEMY];
    yield* this.text(far('_HurtItselfText'));
    const savedDef = En.def;
    En.def = P.def;
    const savedEffect = P.move.effect;
    P.move.effect = 0;
    this.criticalHitOrOHKO = 0;
    P.move.power = 40;
    P.move.type = 'NORMAL';
    const vars = this.getDamageVars(PLAYER);
    yield* this.calculateDamage(PLAYER, vars);
    P.move.effect = savedEffect;
    En.def = savedDef;
    this.animationType = 0;
    this.turn = ENEMY;
    yield* this.playMoveAnimation(MOVE.POUND);
    this.ui.drawHUD(PLAYER);
    this.turn = PLAYER;
    yield* this.applyDamageToSide(PLAYER);
  },

  /** The enemy's confusion self-hit (inline in CheckEnemyStatusConditions). */
  *enemySelfConfusionDamage() {
    const P = this.side[PLAYER];
    const En = this.side[ENEMY];
    yield* this.text(far('_HurtItselfText'));
    const savedDef = P.def;
    P.def = En.def;
    const savedEffect = En.move.effect;
    En.move.effect = 0;
    this.criticalHitOrOHKO = 0;
    En.move.power = 40;
    En.move.type = 'NORMAL';
    const vars = this.getDamageVars(ENEMY);
    yield* this.calculateDamage(ENEMY, vars);
    En.move.effect = savedEffect;
    P.def = savedDef;
    this.animationType = 0;
    this.turn = PLAYER;
    yield* this.playMoveAnimation(MOVE.POUND);
    this.turn = ENEMY;
    yield* this.applyDamageToSide(ENEMY);
  },

  /**
   * CheckForDisobedience: traded mons above the badge level cap may loaf around, nap, hurt
   * themselves or use another move.
   * @returns {Generator<any, boolean>} true = the mon uses a move (maybe a random one)
   */
  *checkForDisobedience() {
    this.monIsDisobedient = 0;
    if (this.link) return true;
    const mon = this.party[this.playerMonNumber];
    if ((mon.otId & 0xffff) === (this.state.playerId & 0xffff)) return true;
    const P = this.side[PLAYER];
    const badges = this.state.badges | 0;
    let cap = 10;
    if (badges & (1 << BADGE.EARTH)) cap = 101;
    else if (badges & (1 << BADGE.MARSH)) cap = 70;
    else if (badges & (1 << BADGE.RAINBOW)) cap = 50;
    else if (badges & (1 << BADGE.CASCADE)) cap = 30;
    const c = cap;
    const d = P.level;
    let b = d + cap;
    if (b > 255) b = 255;
    if (c >= d) return true;
    let r;
    do r = swapNybbles(this.random()); while (r >= b);
    if (r < c) return true;
    do r = this.random(); while (r >= b);
    if (r < c) {
      // .useRandomMove
      if (yield* this.disobedientRandomMove()) return true;
      yield* this.monDoesNothing();
      return false;
    }
    const b2 = (d - c) & 0xff;
    r = swapNybbles(this.random());
    if (r < b2) {
      // .monNaps
      let sl;
      do sl = swapNybbles((this.random() * 2) & 0xff) & SLP_MASK; while (sl === 0);
      P.status = sl;
      yield* this.text(far('_BeganToNapText'));
      return false;
    }
    if (((r - b2) & 0xff) >= b2) {
      yield* this.monDoesNothing();
      return false;
    }
    yield* this.text(far('_WontObeyText'));
    yield* this.handleSelfConfusionDamage();
    return false;
  },

  /** .monDoesNothing of CheckForDisobedience */
  *monDoesNothing() {
    const labels = ['_LoafingAroundText', '_WontObeyText', '_TurnedAwayText', '_IgnoredOrdersText'];
    yield* this.text(far(labels[this.random() & 3]));
  },

  /** .useRandomMove: @returns true when another move was picked */
  *disobedientRandomMove() {
    const P = this.side[PLAYER];
    if (!P.moves[1]) return false;
    if (P.disabledMoveNumber) return false;
    if (P.selectedMove === MOVE.STRUGGLE) return false;
    let total = 0;
    for (let i = 0; i < 4; i++) total = (total + (P.pp[i] & PP_MASK)) & 0xff;
    const cur = this.currentMenuItem;
    if (total === (P.pp[cur] & PP_MASK)) return false;
    this.monIsDisobedient = 1;
    const b = this.maxMenuItem;
    let i;
    for (;;) {
      i = this.random() & 3;
      if (i >= b) continue;
      if (i === cur) continue;
      if (!P.pp[i]) continue; // raw byte: a move with PP Ups but 0 PP passes (PP underflow glitch)
      break;
    }
    this.currentMenuItem = i;
    P.selectedMove = P.moves[i];
    this.getCurrentMove(PLAYER);
    return true;
  },

  // ======================================================================= move data

  /** GetCurrentMove: load the selected move's data and name. */
  getCurrentMove(s) {
    const A = this.side[s];
    const id = A.selectedMove;
    A.move = id >= 1 && id <= NUM_ATTACKS ? moveDataById(id, this.gd) : { num: id, effect: 0, power: 0, type: 'NORMAL', accuracy: 0, maxPP: 0 };
    this.setMoveNameBuffers(id);
  },

  /** GetName/GetMoveName + CopyToStringBuffer: wNameBuffer and wStringBuffer = move name. */
  setMoveNameBuffers(id) {
    const n = this.moveName(id);
    this.nameBuffer = n;
    this.stringBuffer = n;
  },

  moveName(id) {
    if (!(id >= 1 && id <= NUM_ATTACKS)) return '';
    return this.gd.move(id).name;
  },

  /** DisplayUsedMoveText (engine/battle/used_move_text.asm). */
  *displayUsedMoveText(s) {
    const A = this.side[s];
    A.usedMove = A.move.num;
    const cmds = [{ cmd: 'text_far', label: '_ActorNameText' }];
    if (this.monIsDisobedient) {
      cmds.push({ cmd: 'text_far', label: '_UsedMove2Text' }, { cmd: 'text_far', label: '_UsedInsteadText' });
    } else {
      cmds.push({ cmd: 'text_far', label: '_UsedMove1Text' });
    }
    cmds.push({ cmd: 'text_far', label: '_MoveNameText' }, { cmd: 'done' });
    yield* this.text(cmds);
  },

  /** DecrementPP (player only; Gen 1 enemies have unlimited PP). */
  decrementPP() {
    const P = this.side[PLAYER];
    if (P.selectedMove === MOVE.STRUGGLE) return;
    if (P.status1 & (STORING_ENERGY | THRASHING_ABOUT | ATTACKING_MULTIPLE_TIMES)) return;
    if (P.status2 & USING_RAGE) return;
    const i = P.moveListIndex;
    P.pp[i] = (P.pp[i] - 1) & 0xff;
    if (P.status3 & TRANSFORMED) return;
    const slot = this.party[this.playerMonNumber].moves[i];
    if (slot) setRawPP(slot, (rawPP(slot) - 1) & 0xff);
  },

  // ======================================================================= damage pipeline

  /** CriticalHitTest (one random byte unless the move has 0 power). */
  criticalHitTest(s) {
    this.criticalHitOrOHKO = 0;
    const A = this.side[s];
    let b = this.gd.species(A.species).baseStats.spd >> 1;
    if (!A.move.power) return;
    const id = A.move.num;
    if (A.status2 & GETTING_PUMPED) b >>= 1; // bug: should be *2
    else b = Math.min(255, b << 1);
    if (HIGH_CRITICAL_MOVES.includes(id)) {
      b = Math.min(255, b << 1);
      b = Math.min(255, b << 1);
    } else {
      b >>= 1;
    }
    const r = this.random();
    const rot = ((r << 3) | (r >> 5)) & 0xff;
    if (rot < b) this.criticalHitOrOHKO = 1;
  },

  /**
   * HandleCounterMove. @returns {boolean} true = Counter was used (hit or miss is in
   *   wMoveMissed and wDamage); false = not Counter, carry on
   */
  handleCounterMove(s) {
    const A = this.side[s];
    const D = this.side[s ^ 1];
    if (A.selectedMove !== MOVE.COUNTER) return false;
    this.moveMissed = 1;
    if (D.selectedMove === MOVE.COUNTER) return true;
    if (!D.move.power) return true;
    if (D.move.type !== 'NORMAL' && D.move.type !== 'FIGHTING') return true;
    if (!this.damage) return true;
    this.damage = Math.min(0xffff, this.damage * 2);
    this.moveMissed = 0;
    this.moveHitTest(s);
    return true;
  },

  /**
   * GetDamageVarsForPlayerAttack / GetDamageVarsForEnemyAttack. Zeroes wDamage.
   * @returns {{power:number, atk:number, def:number, level:number}|null} null for 0 power
   */
  getDamageVars(s) {
    this.damage = 0;
    const A = this.side[s];
    const D = this.side[s ^ 1];
    const power = A.move.power;
    if (!power) return null;
    const special = isSpecialType(A.move.type, this.gd);
    const key = special ? 'spc' : 'def';
    const akey = special ? 'spc' : 'atk';
    let def = D[key];
    if (D.status3 & (special ? HAS_LIGHT_SCREEN_UP : HAS_REFLECT_UP)) def = (def << 1) & 0xffff;
    let atk = A[akey];
    if (this.criticalHitOrOHKO) {
      const pm = this.party[this.playerMonNumber];
      if (s === PLAYER) {
        def = getEnemyMonStat(D, key, this.gd);
        atk = pm.stats[akey];
      } else {
        def = pm.stats[key];
        atk = getEnemyMonStat(A, akey, this.gd);
      }
    }
    if ((atk >> 8) | (def >> 8)) {
      def = (def >> 2) & 0xffff;
      atk = (atk >> 2) & 0xffff;
      if (atk === 0) atk = 1;
    }
    let level = A.level;
    if (this.criticalHitOrOHKO) level = (level << 1) & 0xff;
    return { power, atk: atk & 0xff, def: def & 0xff, level };
  },

  /**
   * CalculateDamage. @returns {Generator<any, boolean>} false (z) for 0-power moves and failed
   *   OHKO moves (the caller skips to the fly/charge check), true otherwise
   */
  *calculateDamage(s, vars) {
    const A = this.side[s];
    const eff = A.move.effect;
    if (eff !== E.TWO_TO_FIVE_ATTACKS_EFFECT && eff !== E.EFFECT_1E) {
      if (eff === E.OHKO_EFFECT) {
        yield* this.jumpMoveEffect();
        return !this.moveMissed;
      }
      if (!vars) return false;
    }
    if (!vars) return false;
    this.damage = calculateDamage({ level: vars.level, power: vars.power, attack: vars.atk, defense: vars.def, explode: eff === E.EXPLODE_EFFECT });
    return true;
  },

  /** AdjustDamageForMoveType: STAB, then every matching TypeEffects row in order. */
  adjustDamageForMoveType(s) {
    const A = this.side[s];
    const D = this.side[s ^ 1];
    const t = A.move.type;
    if (t === A.type1 || t === A.type2) {
      this.damage = (this.damage + (this.damage >> 1)) & 0xffff;
      this.damageMultipliers |= 0x80;
    }
    for (const row of this.gd.typeMatchups) {
      if (row.attacker !== t) continue;
      if (row.defender !== D.type1 && row.defender !== D.type2) continue;
      this.damageMultipliers = (this.damageMultipliers & 0x80) + row.factor;
      this.damage = Math.floor((this.damage * row.factor) / 10) & 0xffff;
      if (this.damage === 0) this.moveMissed = 1;
    }
  },

  /** RandomizeDamage: damage * r / 255, r = rotr(Random()) rerolled until >= 217. */
  randomizeDamage() {
    if (this.damage < 2) return;
    let r;
    do {
      const b = this.random();
      r = ((b >> 1) | (b << 7)) & 0xff;
    } while (r < PERCENT(85) + 1);
    this.damage = Math.floor((this.damage * r) / 255) & 0xffff;
  },

  /** MoveHitTest (+ CalcHitChance, which stores the scaled accuracy in the move data). */
  moveHitTest(s) {
    const A = this.side[s];
    const D = this.side[s ^ 1];
    const eff = A.move.effect;
    const miss = () => {
      this.damage = 0;
      this.moveMissed = 1;
      A.status1 &= ~USING_TRAPPING_MOVE;
    };
    if (eff === E.DREAM_EATER_EFFECT && !(D.status & SLP_MASK)) return miss();
    if (eff === E.SWIFT_EFFECT) return undefined;
    // (the Substitute check for draining moves here is broken in the game and does nothing)
    if (D.status1 & INVULNERABLE) return miss();
    if (isMistEffect(eff) && (D.status2 & PROTECTED_BY_MIST)) return miss();
    if (A.status2 & USING_X_ACCURACY) return undefined;
    let acc = A.move.accuracy;
    for (const mod of [A.mods[MOD_ACCURACY], 14 - D.mods[MOD_EVASION]]) {
      const [num, den] = STAT_MODIFIER_RATIOS[(mod - 1) & 0xff] || [1, 1];
      acc = Math.floor((acc * num) / den);
      if (acc === 0) acc = 1;
    }
    if (acc > 255) acc = 255;
    A.move.accuracy = acc;
    if (this.random() >= acc) miss();
    return undefined;
  },

  // ======================================================================= applying damage

  /** ApplyAttackToEnemyPokemon / ApplyAttackToPlayerPokemon. */
  *applyAttack(s) {
    const A = this.side[s];
    const D = this.side[s ^ 1];
    const eff = A.move.effect;
    if (eff === E.OHKO_EFFECT) {
      yield* this.applyDamageToSide(s ^ 1);
      return;
    }
    if (eff === E.SUPER_FANG_EFFECT) {
      let d = D.hp >> 1;
      if (!d) d = 1;
      this.damage = d;
      yield* this.applyDamageToSide(s ^ 1);
      return;
    }
    if (eff === E.SPECIAL_DAMAGE_EFFECT) {
      const id = A.move.num;
      let b = A.level;
      if (id === MOVE.SEISMIC_TOSS || id === MOVE.NIGHT_SHADE) b = A.level;
      else if (id === MOVE.SONICBOOM) b = 20;
      else if (id === MOVE.DRAGON_RAGE) b = 40;
      else {
        // Psywave: random in [1, 1.5L) for the player, [0, 1.5L) for the enemy (8-bit 1.5L)
        const lim = (A.level + (A.level >> 1)) & 0xff;
        const min = s === PLAYER ? 1 : 0;
        if (lim <= min) b = min; // the game would loop forever here
        else {
          let r;
          do r = this.random(); while (r < min || r >= lim);
          b = r;
        }
      }
      this.damage = b;
      yield* this.applyDamageToSide(s ^ 1);
      return;
    }
    if (!A.move.power) {
      this.ui.drawHUDs();
      return;
    }
    yield* this.applyDamageToSide(s ^ 1);
  },

  /**
   * ApplyDamageToEnemyPokemon / ApplyDamageToPlayerPokemon: subtract wDamage from side `t`
   * (or hit the substitute). On overkill wDamage becomes the HP the mon had.
   */
  *applyDamageToSide(t) {
    if (!this.damage) {
      this.ui.drawHUDs();
      return;
    }
    const T = this.side[t];
    if (T.status2 & HAS_SUBSTITUTE_UP) {
      yield* this.attackSubstitute();
      return;
    }
    const old = T.hp;
    let nw = old - this.damage;
    if (nw < 0) {
      this.damage = old;
      nw = 0;
    }
    T.hp = nw;
    yield* this.ui.hpBar(t, old, nw);
    this.ui.drawHUDs();
  },

  /**
   * AttackSubstitute: shared by both sides and keyed on hWhoseTurn - the substitute hit is the
   * one of the side whose turn it is NOT (so confusion damage / crash damage of a mon behind a
   * substitute hits the opponent's substitute, a known bug).
   */
  *attackSubstitute() {
    yield* this.text(far('_SubstituteTookDamageText'));
    const victim = this.side[this.turn ^ 1];
    const attacker = this.side[this.turn];
    let broke = false;
    if (this.damage > 0xff) broke = true;
    else {
      const v = victim.substituteHP - this.damage;
      victim.substituteHP = v & 0xff;
      if (v < 0) broke = true;
    }
    if (!broke) return;
    // wDamage is not reduced to the HP the substitute had
    victim.status2 &= ~HAS_SUBSTITUTE_UP;
    yield* this.text(far('_SubstituteBrokeText'));
    this.turn ^= 1;
    yield* this.hideSubstituteShowMon(this.turn);
    this.turn ^= 1;
    attacker.move.effect = 0; // no side effect (e.g. no Hyper Beam recharge)
    this.ui.drawHUDs();
  },

  /** HandleBuildingRage: the target using Rage raises its Attack when hit. */
  *handleBuildingRage(s) {
    const T = this.side[s ^ 1];
    if (!(T.status2 & USING_RAGE)) return;
    if (T.mods[MOD_ATTACK] === 13) return;
    this.turn ^= 1;
    T.move.num = 0;
    T.move.effect = E.ATTACK_UP1_EFFECT;
    yield* this.text(far('_BuildingRageText'));
    yield* this.statModifierUpEffect();
    T.move.effect = 0;
    T.move.num = MOVE.RAGE;
    this.turn ^= 1;
  },

  /** MirrorMoveCopyMove. @returns {Generator<any, boolean>} false on failure */
  *mirrorMoveCopyMove(s) {
    const A = this.side[s];
    const D = this.side[s ^ 1];
    const a = D.usedMove;
    A.selectedMove = a;
    if (a === MOVE.MIRROR_MOVE || !a) {
      yield* this.text(far('_MirrorMoveFailedText'));
      return false;
    }
    this.reloadMoveData(s, a);
    return true;
  },

  /** ReloadMoveData: copy the move's data, give back the PP (IncrementMovePP), reload names. */
  reloadMoveData(s, id) {
    this.side[s].move = moveDataById(id, this.gd);
    this.incrementMovePP(s);
    this.setMoveNameBuffers(id);
  },

  /** MetronomePickMove */
  *metronomePickMove(s) {
    this.animationType = 0;
    yield* this.playMoveAnimation(MOVE.METRONOME);
    let r;
    do r = this.random(); while (r === 0 || r >= MOVE.STRUGGLE || r === MOVE.METRONOME);
    this.side[s].selectedMove = r;
    this.reloadMoveData(s, r);
  },

  /**
   * IncrementMovePP: +1 to the PP of the move slot that was used (battle struct and party data),
   * so Mirror Move/Metronome cost 1 PP. The party copy is incremented even when transformed.
   */
  incrementMovePP(s) {
    const A = this.side[s];
    const i = A.moveListIndex & 3;
    A.pp[i] = (A.pp[i] + 1) & 0xff;
    if (s === PLAYER) {
      const slot = this.party[this.playerMonNumber].moves[i];
      if (slot) setRawPP(slot, (rawPP(slot) + 1) & 0xff);
    } else if (this.enemyParty && this.enemyParty[A.partyPos]) {
      const slot = this.enemyParty[A.partyPos].moves[i];
      if (slot) setRawPP(slot, (rawPP(slot) + 1) & 0xff);
    }
  },

  // ======================================================================= messages

  /** PrintMoveFailureText (+ Jump Kick crash damage). */
  *printMoveFailureText(s) {
    const A = this.side[s];
    let label = '_DoesntAffectMonText';
    if (this.damageMultipliers & 0x7f) {
      label = '_AttackMissedText';
      if (this.criticalHitOrOHKO === 0xff) label = '_UnaffectedText';
    }
    yield* this.text(far(label));
    this.criticalHitOrOHKO = 0;
    if (A.move.effect !== E.JUMP_KICK_EFFECT) return;
    // wDamage is 0 after a miss, so the crash damage is always 1
    let d = this.damage >> 3;
    if (!d) d = 1;
    this.damage = d;
    yield* this.text(far('_KeptGoingAndCrashedText'));
    yield* this.ui.shakeScreenHorizontally(4);
    yield* this.applyDamageToSide(s);
  },

  /** PrintCriticalOHKOText (+ the 20-frame delay that always follows). */
  *printCriticalOHKOText() {
    if (this.criticalHitOrOHKO === 1) {
      yield* this.text(far('_CriticalHitText'));
      this.criticalHitOrOHKO = 0;
    } else if (this.criticalHitOrOHKO === 2) {
      yield* this.text(far('_OHKOText'));
      this.criticalHitOrOHKO = 0;
    } else if (this.criticalHitOrOHKO) {
      this.criticalHitOrOHKO = 0;
    }
    yield* this.ui.delay(20);
  },

  /** DisplayEffectiveness */
  *displayEffectiveness() {
    const m = this.damageMultipliers & 0x7f;
    if (m === EFFECTIVE) return;
    yield* this.text(far(m > EFFECTIVE ? '_SuperEffectiveText' : '_NotVeryEffectiveText'));
  },

  // ======================================================================= animations

  /** PlayMoveAnimation (Delay3 + MoveAnimation) with the current turn and wAnimationType. */
  *playMoveAnimation(id) {
    yield* this.ui.anim(id, {
      attacker: this.turn,
      animationType: this.animationType,
      damageMultiplier: this.damageMultipliers & 0x7f,
      preDelay: 3,
    });
  },

  /** PlayBattleAnimation (no Delay3, current wAnimationType). */
  *playBattleAnimation(id) {
    yield* this.ui.anim(id, { attacker: this.turn, animationType: this.animationType, damageMultiplier: this.damageMultipliers & 0x7f });
  },

  /** HandleExplodingAnimation: Selfdestruct/Explosion that hit shake the screen (MEGA_PUNCH). */
  *handleExplodingAnimation(s) {
    const A = this.side[s];
    const target = this.side[s ^ 1];
    const id = A.move.num;
    if (id !== MOVE.SELFDESTRUCT && id !== MOVE.EXPLOSION) return;
    // bug: on the enemy's turn the INVULNERABLE check reads the enemy's own status
    if (this.side[ENEMY].status1 & INVULNERABLE) return;
    if (target.type1 === 'GHOST' || target.type2 === 'GHOST') return;
    if (this.moveMissed) return;
    this.animationType = ANIMATIONTYPE.SHAKE_SCREEN_HORIZONTALLY_LIGHT;
    yield* this.playMoveAnimation(MOVE.POUND + 4); // MEGA_PUNCH (5)
  },

  /** HideSubstituteShowMonAnim on side `owner`'s pic. */
  *hideSubstituteShowMon(owner) {
    const O = this.side[owner];
    yield* this.ui.sequence('HIDE_SUBSTITUTE_SHOW_MON', {
      attacker: owner, substituteUp: !!(O.status2 & HAS_SUBSTITUTE_UP), minimized: !!O.minimized,
    });
  },

  /** ReshowSubstituteAnim on side `owner`. */
  *reshowSubstitute(owner) {
    yield* this.ui.sequence('RESHOW_SUBSTITUTE', { attacker: owner });
  },

  // ======================================================================= end of turn

  /**
   * HandlePoisonBurnLeechSeed for the side whose turn it is (hWhoseTurn).
   * @returns {Generator<any, boolean>} false (z) when that side's HP is 0
   */
  *handlePoisonBurnLeechSeed() {
    const s = this.turn;
    const A = this.side[s];
    if (A.status & (BRN | PSN)) {
      yield* this.text(far(A.status & BRN ? '_HurtByBurnText' : '_HurtByPoisonText'));
      this.animationType = 0;
      yield* this.playMoveAnimation(ANIM.BURN_PSN_ANIM);
      yield* this.decreaseOwnHP(s);
    }
    if (A.status2 & SEEDED) {
      this.turn ^= 1;
      this.animationType = 0;
      yield* this.playMoveAnimation(MOVE.ABSORB);
      this.turn ^= 1;
      const dmg = yield* this.decreaseOwnHP(s);
      yield* this.increaseOpponentHP(s, dmg);
      yield* this.text(far('_HurtByLeechSeedText'));
    }
    if (A.hp !== 0) return true;
    this.ui.drawHUDs();
    yield* this.ui.delay(20);
    return false;
  },

  /**
   * HandlePoisonBurnLeechSeed_DecreaseOwnHP: max HP / 16 (min 1), times the Toxic counter when
   * badly poisoned - also for Leech Seed (the Toxic/Leech Seed glitch).
   * @returns {Generator<any, number>} the damage (not reduced when it exceeded the HP)
   */
  *decreaseOwnHP(s) {
    const A = this.side[s];
    let dmg = ((A.maxHP >> 2) & 0xff) >> 2;
    if (!dmg) dmg = 1;
    if (A.status3 & BADLY_POISONED) {
      A.toxicCounter = (A.toxicCounter + 1) & 0xff;
      dmg = (dmg * (A.toxicCounter || 256)) & 0xffff;
    }
    const old = A.hp;
    let nw = old - dmg;
    if (nw < 0) nw = 0;
    A.hp = nw;
    yield* this.ui.hpBar(s, old, nw);
    return dmg;
  },

  /** HandlePoisonBurnLeechSeed_IncreaseEnemyHP: the seeder gains the drained amount. */
  *increaseOpponentHP(s, dmg) {
    const T = this.side[s ^ 1];
    const old = T.hp;
    let nw = (old + dmg) & 0xffff;
    if (nw >= T.maxHP) nw = T.maxHP;
    T.hp = nw;
    yield* this.ui.hpBar(s ^ 1, old, nw);
  },
};

/** swap a: exchange the nybbles of a byte. */
export function swapNybbles(a) {
  return ((a << 4) | (a >> 4)) & 0xff;
}
