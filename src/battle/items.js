// Items used from the battle bag: UseItem_ / ItemUsePtrTable (engine/items/item_effects.asm)
// for everything that matters in battle - Poké Balls (ItemUseBall + the toss animation,
// Pokédex entry, nickname, box), medicine and PP items through the party menu (the state
// changes come from src/pokemon/items_effects.js), X items, Guard Spec., Dire Hit,
// X Accuracy, Poké Doll, Poké Flute, Safari bait/rock - and "OAK: This isn't the time to use
// that!" for the rest. Sets this.actionResult (wActionResultOrTookBattleTurn): 1 = the item
// was used (the turn is gone), 0 = not used (back to the bag).
// Installed on Battle.prototype (see core.js).

import { useItem as applyItem } from '../pokemon/items_effects.js';
import { throwBall } from '../pokemon/catch.js';
import { makeCaughtMon, toBoxMon } from '../pokemon/mon.js';
import { isCurrentBoxFull, PARTY_LENGTH } from '../pokemon/party.js';
import {
  PLAYER, ENEMY, TRAINER_BATTLE, WILD_BATTLE, BATTLE_TYPE_OLD_MAN, BATTLE_TYPE_SAFARI, ANIM,
  USING_X_ACCURACY, PROTECTED_BY_MIST, GETTING_PUMPED, BADLY_POISONED, TRANSFORMED, SLP_MASK, EFFECT,
} from './constants.js';
import { moveDataById, rawPP } from './battle_mon.js';
import { far } from './text.js';

/** wPokeBallAnimData -> message label */
const BALL_TEXT = Object.freeze({
  0x10: '_ItemUseBallText00', 0x20: '_ItemUseBallText01', 0x61: '_ItemUseBallText02',
  0x62: '_ItemUseBallText03', 0x63: '_ItemUseBallText04',
});

/** Party-menu message per item (PartyMenuItemUseMessagePointers). */
const CURE_TEXT = Object.freeze({
  ANTIDOTE: '_AntidoteText', BURN_HEAL: '_BurnHealText', ICE_HEAL: '_IceHealText',
  AWAKENING: '_AwakeningText', PARLYZ_HEAL: '_ParlyzHealText', FULL_HEAL: '_FullHealText',
});

export const itemsMixin = {
  /** UseItem_ for an item chosen in battle. */
  *useItem(item) {
    this.actionResult = 1;
    const it = this.gd.item(item);
    if (it.tm || it.hm) return yield* this.itemUseNotTime();
    const kind = it.effect ? it.effect.kind : 'none';
    switch (kind) {
      case 'ball': return yield* this.itemUseBall(it);
      case 'heal': case 'revive': case 'cureStatus': return yield* this.itemUseMedicine(it);
      case 'ppRestore': return yield* this.itemUsePPRestore(it);
      case 'xAccuracy':
        this.side[PLAYER].status2 |= USING_X_ACCURACY;
        return yield* this.printItemUseTextAndRemoveItem(it);
      case 'guardSpec':
        this.side[PLAYER].status2 |= PROTECTED_BY_MIST;
        return yield* this.printItemUseTextAndRemoveItem(it);
      case 'direHit':
        this.side[PLAYER].status2 |= GETTING_PUMPED;
        return yield* this.printItemUseTextAndRemoveItem(it);
      case 'xStat': return yield* this.itemUseXStat(it);
      case 'pokeDoll':
        if (this.isInBattle !== WILD_BATTLE) return yield* this.itemUseNotTime();
        this.escapedFromBattle = 1;
        this.escapeReason = 'pokeDoll';
        return yield* this.printItemUseTextAndRemoveItem(it);
      case 'pokeFlute': return yield* this.itemUsePokeFlute();
      case 'safariBait': return yield* this.itemUseBaitRock(true);
      case 'safariRock': return yield* this.itemUseBaitRock(false);
      case 'oaksParcel':
        this.actionResult = 0;
        yield* this.text(far('_ItemUseNotYoursToUseText'));
        return undefined;
      default:
        return yield* this.itemUseNotTime();
    }
  },

  /** ItemUseNotTime: "OAK: <PLAYER>! This isn't the time to use that!" (item not used). */
  *itemUseNotTime() {
    this.actionResult = 0;
    yield* this.text(far('_ItemUseNotTimeText'));
  },

  /** ItemUseNoEffect */
  *itemUseNoEffect() {
    this.actionResult = 0;
    yield* this.text(far('_ItemUseNoEffectText'));
  },

  /** "<PLAYER> used <ITEM>!" (ItemUseText00 = _ItemUseText001 + text_low + _ItemUseText002) */
  *itemUseText00() {
    yield* this.text([{ cmd: 'text_far', label: '_ItemUseText001' }, { cmd: 'text_low' }, { cmd: 'text_far', label: '_ItemUseText002' }, { cmd: 'text_end' }]);
  },

  /** PrintItemUseTextAndRemoveItem: text, SFX_HEAL_AILMENT, wait for a button, remove one. */
  *printItemUseTextAndRemoveItem(it) {
    yield* this.itemUseText00();
    this.ui.sfx('SFX_HEAL_AILMENT');
    yield* this.ui.waitButton();
    this.removeUsedItem(it.const);
  },

  removeUsedItem(itemConst) {
    if (this.state.bag.has(itemConst)) this.state.bag.remove(itemConst, 1);
  },

  // ===================================================================== balls

  /** ItemUseBall */
  *itemUseBall(it) {
    const En = this.side[ENEMY];
    if (this.isInBattle === TRAINER_BATTLE) return yield* this.throwBallAtTrainerMon(it);
    const oldMan = this.battleType === BATTLE_TYPE_OLD_MAN;
    if (!oldMan && this.party.length >= PARTY_LENGTH && isCurrentBoxFull(this.state)) {
      this.actionResult = 0;
      yield* this.text(far('_BoxFullCannotThrowBallText'));
      return undefined;
    }
    this.capturedMon = null;
    if (this.battleType === BATTLE_TYPE_SAFARI) this.state.safari.balls = Math.max(0, this.state.safari.balls - 1);
    this.ui.restoreScreen();
    yield* this.itemUseText00();
    let animData;
    if (this.isGhostBattle()) animData = 0x10;
    else if (oldMan) animData = 0x43;
    else if (this.map === 'POKEMON_TOWER_6F' && this.restlessSoul) animData = 0x10;
    else {
      const r = throwBall({ ball: it.const, hp: En.hp, maxHp: En.maxHP, status: En.status, catchRate: En.actualCatchRate }, this.rng, this.gd);
      animData = r.animData;
    }
    this.lastBallAnimData = animData;
    yield* this.ui.delay(20);
    this.turn = PLAYER;
    this.animationType = 0;
    this.damageMultipliers = 0;
    yield* this.ui.anim(ANIM.TOSS_ANIM, { attacker: PLAYER, animationType: 0, damageMultiplier: 0, ball: { item: it.const, animData } });
    if (animData !== 0x43) {
      yield* this.text(far(BALL_TEXT[animData]));
      this.ui.clearSprites();
      if (!this.battleType) this.removeUsedItem(it.const);
      return undefined;
    }
    // caught: reload the enemy (fresh stats, its DVs kept; a transformed mon is caught as Ditto)
    const transformed = (En.status3 & TRANSFORMED) !== 0;
    const caughtSpecies = transformed ? this.gd.species('DITTO').dex : En.species2 || En.species;
    const enemy = { species: caughtSpecies, level: En.level, dvs: transformed && this.transformedEnemyMonOriginalDVs ? this.transformedEnemyMonOriginalDVs : En.dvs, hp: En.hp, status: En.status };
    if (oldMan) {
      yield* this.caughtText();
      this.ui.clearSprites();
      this.oldManCaught = true;
      this.capturedMon = makeCaughtMon(enemy, { otName: this.state.playerName, otId: this.state.playerId }, this.gd);
      this.capturedMonOldMan = true;
      return undefined;
    }
    yield* this.caughtText();
    const firstCatch = !this.state.pokedex.isOwned(caughtSpecies);
    this.state.pokedex.setOwned(caughtSpecies);
    this.firstCatch = firstCatch;
    if (firstCatch) {
      yield* this.text([{ cmd: 'text_far', label: '_ItemUseBallText06' }, { cmd: 'sound', sound: 'SFX_DEX_PAGE_ADDED' }, { cmd: 'text_promptbutton' }, { cmd: 'text_end' }]);
      this.ui.clearSprites();
      yield* this.ui.pokedexEntry(caughtSpecies);
    }
    const mon = makeCaughtMon(enemy, { otName: this.state.playerName, otId: this.state.playerId }, this.gd);
    // _AddPartyMon copies wEnemyMonHP as is: a transformed mon caught as Ditto keeps its HP,
    // which may exceed Ditto's max HP (bug kept)
    mon.hp = enemy.hp;
    this.ui.clearSprites();
    if (this.party.length < PARTY_LENGTH) {
      yield* this.askName(mon);
      this.party.push(mon);
      this.caughtTo = 'party';
    } else {
      yield* this.askName(mon);
      this.state.pcBoxes[this.state.currentBox].unshift(toBoxMon(mon));
      this.caughtTo = 'box';
      this.boxMonNick = mon.nickname;
      const metBill = this.state.flags && this.state.flags.get ? safeFlag(this.state.flags, 'EVENT_MET_BILL') : false;
      yield* this.text(far(metBill ? '_ItemUseBallText07' : '_ItemUseBallText08'));
    }
    this.capturedMon = mon;
    if (!this.battleType) this.removeUsedItem(it.const);
    return undefined;
  },

  /** ItemUseBallText05: "All right! <MON> was caught!" + SFX_CAUGHT_MON */
  *caughtText() {
    yield* this.text([{ cmd: 'text_far', label: '_ItemUseBallText05' }, { cmd: 'sound', sound: 'SFX_CAUGHT_MON' }, { cmd: 'text_promptbutton' }, { cmd: 'text_end' }]);
  },

  /** AskName: in a wild battle the enemy HUD is cleared first; YES opens the naming screen. */
  *askName(mon) {
    this.ui.saveScreen();
    if (this.isInBattle === WILD_BATTLE) this.ui.clearArea(0, 0, 11, 4);
    this.nameBuffer = this.gd.species(mon.species).name;
    yield* this.text(far('_DoYouWantToNicknameText'));
    const yes = yield* this.ui.yesNo({ x: 14, y: 7, kind: 'nickname' });
    if (yes) {
      const name = yield* this.ui.namingScreen(mon.species);
      this.ui.restoreScreen();
      if (name) mon.nickname = name;
    }
  },

  /** ThrowBallAtTrainerMon: toss, blocked, "Don't be a thief!" - the ball is used up and so is the turn. */
  *throwBallAtTrainerMon(it) {
    this.ui.restoreScreen();
    yield* this.ui.delay(3);
    this.turn = PLAYER;
    yield* this.ui.anim(ANIM.TOSS_ANIM, { attacker: PLAYER, animationType: 0, damageMultiplier: 0, ball: { item: it.const, animData: 0x43 }, battleType: 'trainer' });
    yield* this.text(far('_ThrowBallAtTrainerMonText1'));
    yield* this.text(far('_ThrowBallAtTrainerMonText2'));
    this.removeUsedItem(it.const);
  },

  // ===================================================================== medicine

  /**
   * ItemUseMedicine in battle: the party menu ("Use item on which POKéMON?"), then the effect
   * (items_effects.js), the HP bar / message in the party menu, and the battle-mon updates
   * (status cure recopies the party stats to the battle stats - stat changes are lost -, a
   * revived mon that fought this foe gets its exp flag).
   */
  *itemUseMedicine(it) {
    if (!this.party.length) {
      this.actionResult = 0;
      yield* this.text([{ cmd: 'text', str: "You don't have" }, { cmd: 'line', str: 'any #MON!' }, { cmd: 'prompt' }]);
      return undefined;
    }
    const target = yield* this.ui.partyMenu({ type: 'item', battle: this });
    if (target < 0) {
      this.actionResult = 0;
      return undefined;
    }
    const mon = this.party[target];
    const oldHP = mon.hp;
    const oldStatus = mon.status;
    const r = applyItem(this.state, it.const, { inBattle: true, battleType: this.itemBattleType(), target, activeIndex: this.playerMonNumber }, this.gd);
    if (!r.ok) {
      yield* this.itemUseNoEffect();
      yield* this.ui.closePartyMenu?.();
      return undefined;
    }
    const P = this.side[PLAYER];
    const active = target === this.playerMonNumber;
    if (it.effect.kind === 'cureStatus' || (it.const === 'FULL_RESTORE' && oldHP === mon.maxHP && oldStatus)) {
      // .cureStatusAilment
      if (active) {
        P.status = 0;
        P.status3 &= ~BADLY_POISONED;
        P.maxHP = mon.stats.hp;
        P.atk = mon.stats.atk;
        P.def = mon.stats.def;
        P.spd = mon.stats.spd;
        P.spc = mon.stats.spc;
      }
      const label = CURE_TEXT[it.const] || '_FullHealText';
      this.nameBuffer = mon.nickname;
      yield* this.ui.partyMenuItemResult({ index: target, sfx: 'SFX_HEAL_AILMENT', text: far(label), subs: this.subs() });
      return undefined;
    }
    // HP items
    this.lowHealthAlarm = false;
    this.ui.setLowHealthAlarm(false);
    if (r.revived && (this.foughtFlags & (1 << target))) this.gainExpFlags |= 1 << target;
    if (active) {
      P.hp = mon.hp;
      if (it.const === 'FULL_RESTORE') P.status = 0;
    }
    this.nameBuffer = mon.nickname;
    this.hpBarHPDifference = mon.hp - oldHP;
    const label = r.revived ? '_ReviveText' : '_PotionText';
    yield* this.ui.partyMenuItemResult({ index: target, sfx: 'SFX_HEAL_HP', oldHP, newHP: mon.hp, text: far(label), subs: this.subs() });
    return undefined;
  },

  itemBattleType() {
    if (this.isInBattle === TRAINER_BATTLE) return 'trainer';
    if (this.battleType === BATTLE_TYPE_SAFARI) return 'safari';
    if (this.battleType === BATTLE_TYPE_OLD_MAN) return 'oldMan';
    return 'wild';
  },

  /** ItemUsePPRestore in battle (Ether, Max Ether, Elixer, Max Elixer). */
  *itemUsePPRestore(it) {
    for (let guard = 0; guard < 1000; guard++) {
      const target = yield* this.ui.partyMenu({ type: 'item', battle: this });
      if (target < 0) {
        this.actionResult = 0;
        return undefined;
      }
      const mon = this.party[target];
      let moveIndex;
      if (it.effect.scope === 'oneMove') {
        yield* this.text(far('_RestorePPWhichTechniqueText'));
        this.side[PLAYER].moveListIndex = 0;
        const res = yield* this.ui.moveMenu({ type: 'relearn', moves: mon.moves.map((m) => this.gd.move(m.move).id), cursor: 0, battle: this, mon });
        this.side[PLAYER].moveListIndex = 0;
        if (res.action === 'cancel') continue;
        moveIndex = res.index;
      }
      const r = applyItem(this.state, it.const, { inBattle: true, battleType: this.itemBattleType(), target, moveIndex, activeIndex: this.playerMonNumber }, this.gd);
      if (!r.ok) {
        yield* this.itemUseNoEffect();
        return undefined;
      }
      if (target === this.playerMonNumber) {
        const P = this.side[PLAYER];
        P.pp = [0, 1, 2, 3].map((i) => (mon.moves[i] ? rawPP(mon.moves[i]) : 0));
      }
      this.ui.sfx('SFX_HEAL_AILMENT');
      yield* this.text(far('_PPRestoredText'));
      return undefined;
    }
    return undefined;
  },

  // ===================================================================== battle items

  /** ItemUseXStat: X Attack / Defend / Speed / Special through StatModifierUpEffect. */
  *itemUseXStat(it) {
    const P = this.side[PLAYER];
    const savedNum = P.move.num;
    const savedEffect = P.move.effect;
    const eff = { ATTACK: EFFECT.ATTACK_UP1_EFFECT, DEFENSE: EFFECT.DEFENSE_UP1_EFFECT, SPEED: EFFECT.SPEED_UP1_EFFECT, SPECIAL: EFFECT.SPECIAL_UP1_EFFECT }[it.effect.stat]
      ?? { X_ATTACK: EFFECT.ATTACK_UP1_EFFECT, X_DEFEND: EFFECT.DEFENSE_UP1_EFFECT, X_SPEED: EFFECT.SPEED_UP1_EFFECT, X_SPECIAL: EFFECT.SPECIAL_UP1_EFFECT }[it.const];
    P.move.effect = eff;
    yield* this.printItemUseTextAndRemoveItem(it);
    P.move.num = ANIM.XSTATITEM_ANIM;
    this.ui.restoreScreen();
    yield* this.ui.delay(3);
    this.turn = PLAYER;
    yield* this.statModifierUpEffect();
    P.move.effect = savedEffect;
    P.move.num = savedNum;
  },

  /** ItemUsePokeFlute in battle: wakes both parties (enemy's in trainer battles) and both battle mons. */
  *itemUsePokeFlute() {
    let any = false;
    const wake = (list) => {
      for (const m of list || []) {
        if (m.status & SLP_MASK) any = true;
        m.status &= ~SLP_MASK & 0xff;
      }
    };
    wake(this.party);
    if (this.isInBattle === TRAINER_BATTLE) wake(this.enemyParty);
    for (const S of this.side) S.status &= ~SLP_MASK & 0xff;
    this.ui.restoreScreen2();
    if (!any) {
      yield* this.text(far('_PlayedFluteNoEffectText'));
      return undefined;
    }
    yield* this.text([{ cmd: 'text_far', label: '_PlayedFluteHadEffectText' }, { cmd: 'text_promptbutton' }, { cmd: 'text_end' }]);
    if (!this.lowHealthAlarm) {
      yield* this.ui.waitSound();
      yield* this.ui.sfxWait('SFX_POKEFLUTE_IN_BATTLE');
    }
    yield* this.text(far('_FluteWokeUpText'));
    return undefined;
  },

  /** ItemUseBait / ItemUseRock (Safari Zone): catch rate x1/2 or x2, the eating/angry counters. */
  *itemUseBaitRock(bait) {
    const En = this.side[ENEMY];
    yield* this.text(far(bait ? '_ThrewBaitText' : '_ThrewRockText'));
    if (bait) En.actualCatchRate >>= 1;
    else En.actualCatchRate = Math.min(255, En.actualCatchRate * 2);
    this.animationType = 0;
    this.turn = PLAYER;
    if (bait) this.safariEscapeFactor = 0;
    else this.safariBaitFactor = 0;
    let n;
    do n = this.random() & 7; while (n >= 5);
    n += 1;
    if (bait) this.safariBaitFactor = Math.min(255, this.safariBaitFactor + n);
    else this.safariEscapeFactor = Math.min(255, this.safariEscapeFactor + n);
    yield* this.ui.anim(bait ? ANIM.BAIT_ANIM : ANIM.ROCK_ANIM, { attacker: PLAYER, animationType: 0, damageMultiplier: 0 });
    yield* this.ui.delay(70);
  },
};

function safeFlag(flags, name) {
  try { return !!flags.get(name); } catch { return false; }
}

export { moveDataById };
