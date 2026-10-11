// The battle engine: a port of engine/battle/core.asm (InitBattle, StartBattle,
// MainInBattleLoop, fainting, send-outs, running, the battle/party/bag menus' logic,
// TrainerBattleVictory, EndOfBattle) with the move execution (moves.js), the move effects
// (effects.js), the trainer AI (ai.js), item use (items.js), experience/learning moves
// (experience.js) and evolution (evolution.js) installed as mixins.
//
// The engine never draws or waits by itself: everything visible goes through `this.ui`
// (scene_ui.js for the real screen, headless_ui.js for tests/soak), every routine that may
// print or animate is a generator, so a battle is one coroutine:
//
//   const battle = new Battle({ state, params, rng, ui, text });
//   const result = yield* battle.run();

import { getGameData } from '../pokemon/data.js';
import { buildTrainerParty, trainerAI as classAI } from '../pokemon/trainer.js';
import { makeWildMon } from '../pokemon/mon.js';
import {
  PLAYER, ENEMY, CANNOT_MOVE, WILD_BATTLE, TRAINER_BATTLE, BATTLE_TYPE_NORMAL, BATTLE_TYPE_OLD_MAN,
  BATTLE_TYPE_SAFARI, EFFECTIVE, MOVE, MUSIC, PERCENT,
  ATTACKING_MULTIPLE_TIMES, FLINCHED, CHARGING_UP, THRASHING_ABOUT, STORING_ENERGY,
  USING_TRAPPING_MOVE, NEEDS_TO_RECHARGE, USING_RAGE, FRZ, SLP_MASK, PP_MASK,
  POKEMON_TOWER_MAPS, POKEMON_TOWER_GHOST_TEXT_MAPS,
} from './constants.js';
import { BattleSide, loadBattleMonFromParty, loadEnemyMonData, rawPP, setRawPP } from './battle_mon.js';
import { movesMixin } from './moves.js';
import { effectsMixin } from './effects.js';
import { aiMixin } from './ai.js';
import { itemsMixin } from './items.js';
import { experienceMixin } from './experience.js';
import { evolutionMixin } from './evolution.js';
import { far, TextLibrary } from './text.js';

/** Flow results of the battle-menu sub-routines. */
const REDISPLAY = 'redisplay';
const TURN = 'turn';
const END = 'end';
const CONTINUE = 'continue';

/** Safari Zone areas (InitBattleVariables: SAFARI_ZONE_EAST <= map < SAFARI_ZONE_CENTER_REST_HOUSE). */
const SAFARI_MAPS = Object.freeze(['SAFARI_ZONE_EAST', 'SAFARI_ZONE_NORTH', 'SAFARI_ZONE_WEST', 'SAFARI_ZONE_CENTER']);
const RIVAL_CLASSES = Object.freeze(['RIVAL1', 'RIVAL2', 'RIVAL3']);

/**
 * @typedef {object} BattleParams
 * @property {'wild'|'trainer'|'safari'|'oldman'|'ghost'} [kind] derived when omitted
 * @property {any} [species] wild / static encounter species (dex, const or name)
 * @property {number} [level]
 * @property {{atk:number,def:number,spd:number,spc:number}} [dvs] fixed wild DVs
 * @property {string[]} [moves] wild moves override
 * @property {string} [trainerClass] 'BROCK', 'OPP_BROCK' or a class id
 * @property {number} [partyIndex] 1-based party number (wTrainerNo)
 * @property {Array} [party] custom enemy trainer party (Mon objects)
 * @property {number|boolean} [gymLeader] wGymLeaderNo (gym leader battle/victory music)
 * @property {string} [map] current map const (ghost checks, transitions, Oak's lab rival)
 * @property {boolean} [restlessSoul] the Pokémon Tower Marowak (wCurOpponent = RESTLESS_SOUL)
 * @property {boolean} [fishing] "The hooked X attacked!"
 * @property {any} [endBattleText] text label or commands printed after beating a trainer
 * @property {number} [transition] force a battle transition id 0-7
 * @property {boolean} [noTransition]
 */

export class Battle {
  /**
   * @param {object} o
   * @param {import('../game/state.js').GameState} o.state
   * @param {BattleParams} [o.params]
   * @param {{randByte:()=>number}} o.rng
   * @param {object} o.ui     UI implementation (scene_ui.js / headless_ui.js)
   * @param {TextLibrary} [o.text]
   * @param {object} [o.gd]   GameData
   */
  constructor({ state, params = {}, rng, ui, text, gd }) {
    this.state = state;
    this.params = params;
    this.rng = rng;
    this.ui = ui;
    this.gd = gd || getGameData();
    this.texts = text || new TextLibrary();
    this.side = [new BattleSide(PLAYER), new BattleSide(ENEMY)];
    this.party = state.party;
    this.link = false;
    // ---- shared battle RAM
    this.turn = PLAYER; // hWhoseTurn
    this.damage = 0;
    this.moveMissed = 0;
    this.moveDidntMiss = 0;
    this.criticalHitOrOHKO = 0;
    this.damageMultipliers = EFFECTIVE;
    this.animationType = 0;
    this.actionResult = 0; // wActionResultOrTookBattleTurn
    this.escapedFromBattle = 0;
    this.battleResult = 0; // 0 win, 1 lose, 2 draw/ran/caught
    this.numRunAttempts = 0;
    this.firstMonsNotOutYet = 0;
    this.gainExpFlags = 0;
    this.foughtFlags = 0;
    this.aiCount = 0;
    this.aiLayer2Encouragement = 0;
    this.totalPayDayMoney = 0;
    this.lowHealthAlarm = false;
    this.lowHealthAlarmDisabled = false;
    this.playerMonNumber = 0;
    this.whichPokemon = 0;
    this.canEvolveFlags = 0;
    this.forceEvolution = 0;
    this.monIsDisobedient = 0;
    this.forcePlayerToChooseMon = 0;
    this.lastSwitchInEnemyMonHP = 0;
    this.stringBuffer = '';
    this.nameBuffer = '';
    this.learnMoveMonName = '';
    this.chargeMoveNum = 0;
    this.safariEscapeFactor = 0;
    this.safariBaitFactor = 0;
    this.capturedMon = null;
    this.transformedEnemyMonOriginalDVs = null;
    this.inHandlePlayerMonFainted = 0;
    this.moveMenuType = 0;
    this.menuItemToSwap = 0;
    this.currentMenuItem = 0;
    this.maxMenuItem = 0;
    this.battleMenuCursor = 0; // wBattleAndStartSavedMenuItem
    this.bagCursor = 0; // wBagSavedMenuItem
    this.bagScroll = 0; // wListScrollOffset
    this.partyMenuCursor = 0; // wPartyAndBillsPCSavedMenuItem
    this.boostExpByExpAll = 0;
    this.expAmountGained = 0;
    this.gainBoostedExp = 0;
    this.curEnemyLevel = 0;
    this.isInBattle = WILD_BATTLE;
    this.battleType = BATTLE_TYPE_NORMAL;
    this.trainerClass = null; // const
    this.trainerName = '';
    this.trainerAI = null;
    this.enemyParty = null;
    this.prizeMoney = 0;
    this.gymLeader = 0;
    this.restlessSoul = false;
    this.playerNameInBattle = state.playerName;
    this.aiActions = [];
    this.lastAIAction = null;
    // ---- bookkeeping for the result / tests
    this.turnCount = 0;
    this.blackedOut = false;
    this.escapeReason = null;
    this.evolutions = [];
    this.caughtTo = null;
    this.firstCatch = false;
    this.outcomeOverride = null;
    this.log = [];
  }

  get gdTypes() { return this.gd.typeMatchups; }

  /** One battle random byte (BattleRandom = Random outside link battles). */
  random() {
    return this.rng.randByte() & 0xff;
  }

  /** wObtainedBadges */
  badges() {
    return this.state.badges | 0;
  }

  // ===================================================================== text helpers

  /** Text substitutions for the current state (<USER>/<TARGET> follow hWhoseTurn). */
  subs() {
    const P = this.side[PLAYER];
    const En = this.side[ENEMY];
    const enemy = `Enemy ${En.nick}`;
    return {
      PLAYER: this.playerNameInBattle,
      RIVAL: this.state.rivalName,
      USER: this.turn === PLAYER ? P.nick : enemy,
      TARGET: this.turn === PLAYER ? enemy : P.nick,
      wBattleMonNick: P.nick,
      wEnemyMonNick: En.nick,
      wTrainerName: this.trainerName,
      wStringBuffer: this.stringBuffer,
      wNameBuffer: this.nameBuffer,
      wPlayerNumHits: P.numHits,
      wEnemyNumHits: En.numHits,
      wExpAmountGained: this.expAmountGained,
      wCurEnemyLevel: this.curEnemyLevel,
      wAmountMoneyWon: this.prizeMoney,
      wTotalPayDayMoney: this.totalPayDayMoney,
      wLearnMoveMonName: this.learnMoveMonName,
      wBoxMonNicks: this.boxMonNick || '',
      wHPBarHPDifference: this.hpBarHPDifference || 0,
      wPlayerName: this.playerNameInBattle,
      wRivalName: this.state.rivalName,
    };
  }

  /** PrintText (new message box, letter by letter, waits at prompts). */
  *text(cmds, opts = {}) {
    this.log.push({ turn: this.turnCount, cmds, subs: this.subs() });
    yield* this.ui.printText(cmds, this.subs(), opts);
  }

  /** PrintEmptyString: an empty message box. */
  *emptyText() {
    yield* this.ui.printText([], this.subs(), { empty: true });
  }

  // ===================================================================== small routines

  /** ReadPlayerMonCurHPAndStatus: battle HP/status -> party struct. */
  readPlayerMonCurHPAndStatus() {
    const mon = this.party[this.playerMonNumber];
    if (!mon) return;
    mon.hp = this.side[PLAYER].hp;
    mon.status = this.side[PLAYER].status;
  }

  /** AnyPartyAlive */
  anyPartyAlive() {
    return this.party.some((m) => m.hp > 0);
  }

  /** AnyEnemyPokemonAliveCheck */
  anyEnemyPokemonAlive() {
    return (this.enemyParty || []).some((m) => m.hp > 0);
  }

  /** IsGhostBattle: a wild battle in Pokémon Tower without the Silph Scope. */
  isGhostBattle() {
    if (this.isInBattle !== WILD_BATTLE) return false;
    if (!POKEMON_TOWER_MAPS.includes(this.map)) return false;
    return !this.state.bag.has('SILPH_SCOPE');
  }

  /** CheckNumAttacksLeft: a trapping move ends when its counter reached 0. */
  checkNumAttacksLeft() {
    for (const S of this.side) if (!S.numAttacksLeft) S.status1 &= ~USING_TRAPPING_MOVE;
  }

  /** wLowHealthAlarm off and disabled for the rest of the battle (EndLowHealthAlarm). */
  endLowHealthAlarm() {
    this.lowHealthAlarm = false;
    this.lowHealthAlarmDisabled = true;
    this.ui.setLowHealthAlarm(false);
  }

  /**
   * The low-health alarm part of DrawPlayerHUDAndHPBar: on when the bar is red (< 10 px) and
   * the alarm hasn't been disabled by a win; off when fainted or not red.
   */
  updateLowHealthAlarm() {
    const P = this.side[PLAYER];
    if (P.hp && this.lowHealthAlarmDisabled) return;
    const px = hpBarPixels(P.hp, P.maxHP);
    const red = P.hp && px < 10;
    if (red) {
      if (!this.lowHealthAlarm) {
        this.lowHealthAlarm = true;
        this.ui.setLowHealthAlarm(true);
      }
    } else if (this.lowHealthAlarm) {
      this.lowHealthAlarm = false;
      this.ui.setLowHealthAlarm(false);
    }
  }

  // ===================================================================== entry

  /**
   * The whole battle: InitBattle (transition, intro), StartBattle (main loop), EndOfBattle.
   * @returns {Generator<any, object>} the result object
   */
  *run() {
    this.initBattleVariables();
    if (this.isTrainerBattleParams()) yield* this.initTrainerBattle();
    else yield* this.initWildBattle();
    yield* this.initBattleCommonTail();
    yield* this.startBattle();
    yield* this.endOfBattle();
    return this.makeResult();
  }

  isTrainerBattleParams() {
    const p = this.params;
    return !!(p.trainerClass || p.kind === 'trainer' || (Array.isArray(p.party) && p.party.length && p.kind !== 'wild'));
  }

  /** InitBattleVariables (+ PlayBattleMusic). */
  initBattleVariables() {
    const p = this.params;
    this.map = p.map || (this.state.pos && this.state.pos.map) || null;
    this.battleType = BATTLE_TYPE_NORMAL;
    if (p.kind === 'oldman') this.battleType = BATTLE_TYPE_OLD_MAN;
    // InitBattleVariables decides by the map: any wild battle in the four Safari Zone areas
    else if (p.kind === 'safari' || ((!p.kind || p.kind === 'wild') && SAFARI_MAPS.includes(this.map))) this.battleType = BATTLE_TYPE_SAFARI;
    if (p.kind === 'ghost') this.restlessSoul = !!p.restlessSoul;
    this.restlessSoul = !!p.restlessSoul;
    this.gymLeader = p.gymLeader ? (p.gymLeader === true ? 1 : p.gymLeader | 0) : 0;
    if (this.battleType === BATTLE_TYPE_OLD_MAN) this.playerNameInBattle = 'OLD MAN';
  }

  /** PlayBattleMusic */
  *playBattleMusic() {
    let music = MUSIC.WILD;
    if (this.params.music) music = this.params.music;
    else if (this.gymLeader) music = MUSIC.GYM_LEADER;
    else if (this.isInBattle === TRAINER_BATTLE) {
      const cls = this.gd.trainerClass(this.trainerClass);
      music = cls.battleMusic || MUSIC.TRAINER;
    }
    this.lowHealthAlarm = false;
    this.ui.stopMusic();
    yield* this.ui.delay(1);
    this.ui.music(music);
    this.battleMusic = music;
  }

  /** InitWildBattle (+ LoadEnemyMonData, the ghost check). */
  *initWildBattle() {
    const p = this.params;
    this.isInBattle = WILD_BATTLE;
    const sp = this.gd.species(p.species ?? 'RATTATA');
    this.curEnemyLevel = p.level ?? 5;
    const En = this.side[ENEMY];
    En.species2 = sp.dex;
    loadEnemyMonData(En, { species: sp.dex, level: this.curEnemyLevel, trainer: false, dvs: p.dvs, moves: p.moves }, this.rng, this.gd);
    this.state.pokedex.setSeen(sp.dex);
    yield* this.playBattleMusic();
    yield* this.doBattleTransition();
    let pic = { kind: 'mon', species: sp.dex };
    if (this.restlessSoul || this.isGhostBattle()) {
      En.nick = 'GHOST';
      pic = { kind: 'ghost' };
    }
    this.trainerClass = null;
    this.enemyPic = pic;
    this.ui.setEnemyPic(pic);
  }

  /** InitBattleCommon's trainer branch: GetTrainerInformation, ReadTrainer. */
  *initTrainerBattle() {
    const p = this.params;
    this.isInBattle = TRAINER_BATTLE;
    const cls = this.gd.trainerClass(p.trainerClass ?? 'YOUNGSTER');
    this.trainerClass = cls.const;
    this.trainerName = RIVAL_CLASSES.includes(cls.const) ? this.state.rivalName : cls.name;
    let party;
    if (Array.isArray(p.party) && p.party.length) {
      party = p.party.map((m) => (typeof m.clone === 'function' ? m.clone() : m));
      const last = party[party.length - 1];
      this.prizeMoney = Math.min(999999, cls.baseMoney * last.level);
    } else {
      const built = buildTrainerParty(cls.const, p.partyIndex ?? 1, {}, this.gd);
      party = built.mons;
      this.prizeMoney = built.prizeMoney;
    }
    this.enemyParty = party;
    // wGymLeaderNo is set by the gym scripts; without an explicit value the eight gym leader
    // classes count as gym leaders (Giovanni only in his gym)
    if (p.gymLeader === undefined && cls.gymBattleMusic && (cls.const !== 'GIOVANNI' || this.map === 'VIRIDIAN_GYM')) this.gymLeader = 1;
    this.trainerAI = classAI(cls.const, this.gd);
    this.curEnemyLevel = party[party.length - 1].level;
    yield* this.playBattleMusic();
    yield* this.doBattleTransition();
    this.enemyPic = { kind: 'trainer', trainerClass: cls.const };
    this.ui.setEnemyPic(this.enemyPic);
    this.side[ENEMY].species2 = 0;
    this.aiCount = 0xff;
    this.side[ENEMY].partyPos = 0xff;
  }

  /** DoBattleTransitionAndInitBattleVariables */
  *doBattleTransition() {
    if (!this.params.noTransition) {
      yield* this.ui.delay(1);
      yield* this.ui.battleTransition(this.transitionId());
    }
    this.ui.clearScreen();
    this.side[PLAYER].clearStatusBlock();
    this.side[PLAYER].disabledMove = 0;
  }

  /**
   * GetBattleTransitionID_*: bit 0 trainer, bit 1 enemy >= lead level + 3, bit 2 dungeon map.
   * 0 DoubleCircle, 1 Spiral, 2 Circle, 3 Spiral, 4 HorizontalStripes, 5 Shrink,
   * 6 VerticalStripes, 7 Split.
   */
  transitionId() {
    if (Number.isInteger(this.params.transition)) return this.params.transition & 7;
    let c = 0;
    if (this.isInBattle === TRAINER_BATTLE) c |= 1;
    const lead = this.party.find((m) => m.hp > 0) || this.party[0];
    const leadLevel = lead ? lead.level : 0;
    this.spiralDirection = 1;
    if (this.curEnemyLevel - (leadLevel + 3) >= 0 && ((leadLevel + 3) & 0xff) <= this.curEnemyLevel) {
      c |= 2;
      this.spiralDirection = 0;
    }
    if (isDungeonMap(this.map, this.gd)) c |= 4;
    return c;
  }

  /** _InitBattleCommon after the transition: the slide-in and the beginning text. */
  *initBattleCommonTail() {
    yield* this.slidePlayerAndEnemySilhouettesOnScreen();
    yield* this.emptyText();
    this.ui.saveScreen();
    this.ui.clearArea(9, 7, 10, 5);
    this.ui.clearArea(1, 0, 10, 4);
    this.ui.clearSprites();
    if (this.isInBattle === WILD_BATTLE) this.ui.drawHUD(ENEMY);
  }

  /** SlidePlayerAndEnemySilhouettesOnScreen + PrintBeginningBattleText. */
  *slidePlayerAndEnemySilhouettesOnScreen() {
    this.ui.setPlayerTrainerPic(this.battleType === BATTLE_TYPE_OLD_MAN ? 'oldman' : 'red');
    this.ui.drawEmptyMessageBox();
    yield* this.ui.sequence('SLIDE_SILHOUETTES', { attacker: PLAYER });
    yield* this.printBeginningBattleText();
  }

  /** PrintBeginningBattleText */
  *printBeginningBattleText() {
    const En = this.side[ENEMY];
    if (this.isInBattle === TRAINER_BATTLE) {
      yield* this.ui.sfxWait('SFX_TRAINER_APPEARED', { frequencyModifier: 0, tempoModifier: 0x80 });
      yield* this.ui.delay(20);
      this.drawAllPokeballs();
      yield* this.text(far('_TrainerWantsToFightText'));
      return;
    }
    if (POKEMON_TOWER_GHOST_TEXT_MAPS.includes(this.map)) {
      const scope = this.state.bag.has('SILPH_SCOPE');
      if (this.restlessSoul) {
        if (!scope) {
          yield* this.text(far('_EnemyAppearedText'));
          yield* this.text(far('_GhostCantBeIDdText'));
          return;
        }
        yield* this.text(far('_EnemyAppearedText'));
        yield* this.text(far('_UnveiledGhostText'));
        this.reloadEnemyMonData();
        this.enemyPic = { kind: 'mon', species: En.species };
        yield* this.ui.sequence('MAROWAK_UNVEIL', { attacker: ENEMY, enemyPic: this.enemyPic });
        yield* this.text(far('_WildMonAppearedText'));
        // falls through into .playSFX
        yield* this.ui.sfxWait('SFX_TRAINER_APPEARED', { frequencyModifier: 0, tempoModifier: 0x80 });
        return;
      }
      if (!scope) {
        yield* this.text(far('_EnemyAppearedText'));
        yield* this.text(far('_GhostCantBeIDdText'));
        return;
      }
      this.reloadEnemyMonData();
    }
    yield* this.ui.cryWait(En.species2 || En.species); // PlayCry waits for the cry
    this.drawAllPokeballs();
    yield* this.text(far(this.params.fishing ? '_HookedMonAttackedText' : '_WildMonAppearedText'));
  }

  /** LoadEnemyMonData again (ghost revealed by the Silph Scope): new random DVs, real name. */
  reloadEnemyMonData() {
    const En = this.side[ENEMY];
    loadEnemyMonData(En, { species: En.species2 || En.species, level: this.curEnemyLevel, trainer: false, dvs: this.params.dvs, moves: this.params.moves }, this.rng, this.gd);
    this.state.pokedex.setSeen(En.species);
    this.enemyPic = { kind: 'mon', species: En.species };
    this.ui.setEnemyPic(this.enemyPic);
  }

  /** DrawAllPokeballs: party balls (and the enemy's in trainer battles). */
  drawAllPokeballs() {
    this.ui.drawPartyBalls(PLAYER, this.party);
    if (this.isInBattle === TRAINER_BATTLE) this.ui.drawPartyBalls(ENEMY, this.enemyParty);
  }

  // ===================================================================== StartBattle

  *startBattle() {
    this.gainExpFlags = 0;
    this.foughtFlags = 0;
    this.actionResult = 0;
    this.firstMonsNotOutYet = 1;
    if (this.isInBattle === TRAINER_BATTLE) yield* this.enemySendOutFirstMon();
    yield* this.ui.delay(40);
    this.ui.saveScreen();
    for (;;) {
      if (!this.anyPartyAlive()) { // checked for Safari / old man battles too
        yield* this.handlePlayerBlackOut();
        return;
      }
      this.ui.restoreScreen();
      if (this.battleType === BATTLE_TYPE_NORMAL) {
        yield* this.playerSendOutFirstMon();
        yield* this.mainInBattleLoop();
        return;
      }
      // Safari Zone / old man: the battle menu only
      const ended = yield* this.displayBattleMenu();
      if (ended) return;
      if (!this.actionResult) continue;
      if (this.battleType === BATTLE_TYPE_OLD_MAN) continue;
      if (!this.state.safari.balls) {
        this.ui.restoreScreen();
        yield* this.text([{ cmd: 'text_far', label: '_OutOfSafariBallsText' }, { cmd: 'text_end' }]);
        this.outcomeOverride = 'forfeit';
        this.escapeReason = 'outOfSafariBalls';
        return;
      }
      yield* this.printSafariZoneBattleText();
      const lo = this.side[ENEMY].spd & 0xff;
      if (lo >= 128) {
        yield* this.enemyRan();
        return;
      }
      let b = (lo * 2) & 0xff;
      if (this.safariBaitFactor) b >>= 2;
      if (this.safariEscapeFactor) {
        b <<= 1;
        if (b > 255) b = 255;
      }
      if (this.random() < b) {
        yield* this.enemyRan();
        return;
      }
    }
  }

  /** PrintSafariZoneBattleText: "X is eating!" / "X is angry!" while the counters run. */
  *printSafariZoneBattleText() {
    let label = null;
    if (this.safariBaitFactor) {
      this.safariBaitFactor--;
      label = '_SafariZoneEatingText';
    } else if (this.safariEscapeFactor) {
      this.safariEscapeFactor--;
      label = '_SafariZoneAngryText';
      if (this.safariEscapeFactor === 0) this.side[ENEMY].actualCatchRate = this.gd.species(this.side[ENEMY].species).catchRate;
    }
    if (!label) return;
    this.ui.restoreScreen();
    yield* this.text(far(label));
  }

  /** EnemyRan: the wild mon fled (Safari Zone). */
  *enemyRan() {
    this.ui.restoreScreen();
    yield* this.text(far(this.link ? '_EnemyRanText' : '_WildRanText'));
    yield* this.ui.waitSound(); // PlaySoundWaitForCurrent
    this.ui.sfx('SFX_RUN');
    this.turn = PLAYER;
    yield* this.ui.sequence('ENEMY_RAN', { attacker: ENEMY });
    this.escapeReason = 'enemyFled';
    this.outcomeOverride = 'ran';
  }

  /** StartBattle.playerSendOutFirstMon */
  *playerSendOutFirstMon() {
    let i = 0;
    while (i < this.party.length && !(this.party[i].hp > 0)) i++;
    this.whichPokemon = i;
    this.playerMonNumber = i;
    this.ui.restoreScreen();
    yield* this.ui.sequence('SLIDE_TRAINER_OFF_PLAYER', { attacker: PLAYER });
    this.ui.saveScreen();
    this.gainExpFlags |= 1 << i;
    this.foughtFlags |= 1 << i;
    this.loadBattleMonFromParty();
    this.ui.restoreScreen();
    yield* this.sendOutMon();
  }

  loadBattleMonFromParty() {
    loadBattleMonFromParty(this.side[PLAYER], this.party[this.playerMonNumber], this.playerMonNumber, { badges: this.badges(), link: this.link }, this.gd);
  }

  // ===================================================================== MainInBattleLoop

  *mainInBattleLoop() {
    const P = this.side[PLAYER];
    const En = this.side[ENEMY];
    for (let guard = 0; guard < 100000; guard++) {
      this.readPlayerMonCurHPAndStatus();
      if (P.hp === 0) {
        if ((yield* this.handlePlayerMonFainted()) === END) return;
        continue;
      }
      if (En.hp === 0) {
        if ((yield* this.handleEnemyMonFainted()) === END) return;
        continue;
      }
      this.turnCount++;
      this.ui.saveScreen();
      this.firstMonsNotOutYet = 0;
      let skipToEnemy = false;
      if (P.status2 & (NEEDS_TO_RECHARGE | USING_RAGE)) skipToEnemy = true;
      else {
        En.status1 &= ~FLINCHED;
        P.status1 &= ~FLINCHED;
        if (P.status1 & (THRASHING_ABOUT | CHARGING_UP)) skipToEnemy = true;
      }
      if (!skipToEnemy) {
        const ended = yield* this.displayBattleMenu();
        if (ended) return;
        if (this.escapedFromBattle) return;
        if (P.status & (FRZ | SLP_MASK)) skipToEnemy = true;
        else if (P.status1 & (STORING_ENERGY | USING_TRAPPING_MOVE)) skipToEnemy = true;
        else if (En.status1 & USING_TRAPPING_MOVE) {
          P.selectedMove = CANNOT_MOVE;
          skipToEnemy = true;
        }
      }
      if (!skipToEnemy && !this.actionResult) {
        this.moveMenuType = 0;
        this.menuItemToSwap = 0;
        const chose = yield* this.moveSelectionMenu();
        this.ui.restoreScreen();
        this.ui.drawHUDs();
        if (!chose) continue;
      }
      // .selectEnemyMove
      this.selectEnemyMove();
      const r = yield* this.executeTurn();
      if (r === END) return;
    }
    throw new Error('MainInBattleLoop did not end');
  }

  /** Quick Attack / Counter priority, then Speed (ties: Random() < 128 -> player). */
  playerMovesFirst() {
    const ps = this.side[PLAYER].selectedMove;
    const es = this.side[ENEMY].selectedMove;
    let compare = false;
    if (ps === MOVE.QUICK_ATTACK) {
      if (es !== MOVE.QUICK_ATTACK) return true;
      compare = true;
    } else if (es === MOVE.QUICK_ATTACK) return false;
    if (!compare) {
      if (ps === MOVE.COUNTER) {
        if (es !== MOVE.COUNTER) return false;
      } else if (es === MOVE.COUNTER) return true;
    }
    const a = this.side[PLAYER].spd;
    const b = this.side[ENEMY].spd;
    if (a > b) return true;
    if (a < b) return false;
    return this.random() < PERCENT(50) + 1;
  }

  /** The two halves of a turn in speed order (the end of MainInBattleLoop). */
  *executeTurn() {
    if (this.playerMovesFirst()) {
      this.turnOrder = 'player';
      const b = yield* this.executeMove(PLAYER);
      if (this.escapedFromBattle) return END;
      if (!b) return yield* this.handleEnemyMonFainted();
      this.turn = PLAYER;
      if (!(yield* this.handlePoisonBurnLeechSeed())) return yield* this.handlePlayerMonFainted();
      this.ui.drawHUDs();
      this.turn = ENEMY;
      if (!(yield* this.trainerAIAction())) {
        const b2 = yield* this.executeMove(ENEMY);
        if (this.escapedFromBattle) return END;
        if (!b2) return yield* this.handlePlayerMonFainted();
      }
      this.turn = ENEMY;
      if (!(yield* this.handlePoisonBurnLeechSeed())) return yield* this.handleEnemyMonFainted();
      this.ui.drawHUDs();
      this.checkNumAttacksLeft();
      return CONTINUE;
    }
    this.turnOrder = 'enemy';
    this.turn = ENEMY;
    if (!(yield* this.trainerAIAction())) {
      const b = yield* this.executeMove(ENEMY);
      if (this.escapedFromBattle) return END;
      if (!b) return yield* this.handlePlayerMonFainted();
    }
    this.turn = ENEMY;
    if (!(yield* this.handlePoisonBurnLeechSeed())) return yield* this.handleEnemyMonFainted();
    this.ui.drawHUDs();
    const b2 = yield* this.executeMove(PLAYER);
    if (this.escapedFromBattle) return END;
    if (!b2) return yield* this.handleEnemyMonFainted();
    this.turn = PLAYER;
    if (!(yield* this.handlePoisonBurnLeechSeed())) return yield* this.handlePlayerMonFainted();
    this.ui.drawHUDs();
    this.checkNumAttacksLeft();
    return CONTINUE;
  }

  // ===================================================================== fainting

  /** HandleEnemyMonFainted. @returns {Generator<any, string>} END or CONTINUE */
  *handleEnemyMonFainted() {
    this.inHandlePlayerMonFainted = 0;
    yield* this.faintEnemyPokemon();
    if (!this.anyPartyAlive()) {
      yield* this.handlePlayerBlackOut();
      return END;
    }
    if (this.side[PLAYER].hp) this.ui.drawHUD(PLAYER);
    if (this.isInBattle === WILD_BATTLE) return END;
    if (!this.anyEnemyPokemonAlive()) {
      yield* this.trainerBattleVictory();
      return END;
    }
    if (!this.side[PLAYER].hp) {
      if (yield* this.doUseNextMonDialogue()) return END;
      yield* this.chooseNextMon();
    }
    this.actionResult = 1;
    yield* this.replaceFaintedEnemyMon();
    this.actionResult = 0;
    return CONTINUE;
  }

  /** HandlePlayerMonFainted. @returns {Generator<any, string>} END or CONTINUE */
  *handlePlayerMonFainted() {
    this.inHandlePlayerMonFainted = 1;
    yield* this.removeFaintedPlayerMon();
    if (!this.anyPartyAlive()) {
      yield* this.handlePlayerBlackOut();
      return END;
    }
    if (this.side[ENEMY].hp === 0) {
      yield* this.faintEnemyPokemon();
      if (this.isInBattle === WILD_BATTLE) return END;
      if (!this.anyEnemyPokemonAlive()) {
        yield* this.trainerBattleVictory();
        return END;
      }
    }
    if (yield* this.doUseNextMonDialogue()) return END;
    const enemyAlive = yield* this.chooseNextMon();
    if (enemyAlive) return CONTINUE;
    this.actionResult = 1;
    yield* this.replaceFaintedEnemyMon();
    this.actionResult = 0;
    return CONTINUE;
  }

  /** FaintEnemyPokemon (+ the exp it hands out). */
  *faintEnemyPokemon() {
    const P = this.side[PLAYER];
    const En = this.side[ENEMY];
    this.readPlayerMonCurHPAndStatus();
    if (this.isInBattle === TRAINER_BATTLE) {
      const pm = this.enemyParty[En.partyPos];
      if (pm) pm.hp = 0;
    }
    P.status1 &= ~ATTACKING_MULTIPLE_TIMES;
    P.bide &= 0x00ff; // bug: only the high byte (= wPlayerNumHits) is zeroed
    En.clearStatusBlock();
    En.disabledMove = 0;
    En.disabledMoveNumber = 0;
    En.minimized = 0;
    P.usedMove = 0;
    En.usedMove = 0;
    yield* this.ui.sequence('FAINT_ENEMY_MON', { attacker: ENEMY });
    this.ui.clearArea(0, 0, 11, 4);
    if (this.isInBattle === TRAINER_BATTLE) {
      yield* this.ui.sfxWait('SFX_FAINT_FALL', { frequencyModifier: 0, tempoModifier: 0 });
      yield* this.ui.sfxWait('SFX_FAINT_THUD');
    } else {
      this.endLowHealthAlarm();
      yield* this.playBattleVictoryMusic(MUSIC.DEFEATED_WILD);
    }
    if (P.hp === 0 && !this.inHandlePlayerMonFainted) yield* this.removeFaintedPlayerMon();
    if (!this.anyPartyAlive()) return;
    yield* this.text(far('_EnemyMonFaintedText'));
    yield* this.emptyText();
    this.ui.saveScreen();
    this.battleResult = 0;
    this.defeatedSpecies = this.defeatedSpecies || [];
    this.defeatedSpecies.push(En.species);
    yield* this.gainExperienceForFaint(this.state.bag.has('EXP_ALL'));
  }

  /** PlayBattleVictoryMusic */
  *playBattleVictoryMusic(music) {
    this.ui.stopMusic();
    this.ui.music(music);
    this.victoryMusic = music;
    yield* this.ui.delay(3);
  }

  /** RemoveFaintedPlayerMon: slide the pic down, cry and "fainted!" (unless called by the enemy faint). */
  *removeFaintedPlayerMon() {
    const P = this.side[PLAYER];
    const En = this.side[ENEMY];
    this.gainExpFlags &= ~(1 << this.playerMonNumber);
    En.status1 &= ~ATTACKING_MULTIPLE_TIMES;
    if (this.lowHealthAlarm) {
      this.lowHealthAlarm = false;
      this.ui.setLowHealthAlarm(false);
      yield* this.ui.waitSound();
    }
    En.bide = 0;
    P.status = 0;
    this.readPlayerMonCurHPAndStatus();
    this.ui.clearArea(9, 7, 11, 5);
    yield* this.ui.sequence('FAINT_PLAYER_MON', { attacker: PLAYER });
    this.battleResult = 1;
    if (!this.inHandlePlayerMonFainted) return;
    yield* this.ui.cryWait(P.species);
    yield* this.text(far('_PlayerMonFaintedText'));
  }

  /**
   * DoUseNextMonDialogue: wild battles only - "Use next POKéMON?" YES/NO; NO tries to run with
   * the FIRST party mon's Speed. @returns {Generator<any, boolean>} true = ran away
   */
  *doUseNextMonDialogue() {
    yield* this.emptyText();
    this.ui.saveScreen();
    if (this.isInBattle !== WILD_BATTLE) return false;
    yield* this.text(far('_UseNextMonText'));
    const yes = yield* this.ui.yesNo({ x: 13, y: 9, kind: 'useNextMon' });
    if (yes) return false;
    return yield* this.tryRunningFromBattle(this.party[0].stats.spd);
  }

  /**
   * ChooseNextMon: pick a non-fainted mon (B goes back to the party menu) and send it out.
   * @returns {Generator<any, boolean>} true when the enemy mon still has HP
   */
  *chooseNextMon() {
    let i;
    for (;;) {
      i = yield* this.ui.partyMenu({ type: 'battle', battle: this, cancelable: !this.forcePlayerToChooseMon });
      this.forcePlayerToChooseMon = 0;
      if (i < 0) continue;
      if (this.party[i].hp > 0) break;
      if (!this.firstMonsNotOutYet) yield* this.text(far('_NoWillText'));
    }
    this.whichPokemon = i;
    this.actionResult = 0;
    this.ui.clearSprites();
    this.playerMonNumber = i;
    this.gainExpFlags |= 1 << i;
    this.foughtFlags |= 1 << i;
    this.loadBattleMonFromParty();
    this.ui.restoreScreen();
    yield* this.sendOutMon();
    return this.side[ENEMY].hp !== 0;
  }

  /**
   * HandlePlayerBlackOut: the Oak's-lab rival battle ends without a blackout; otherwise "<PLAYER>
   * is out of useable POKéMON! <PLAYER> blacked out!".
   */
  *handlePlayerBlackOut() {
    this.battleResult = 1;
    if (!this.link && this.trainerClass === 'RIVAL1') {
      this.ui.clearArea(0, 0, 20, 8);
      yield* this.scrollTrainerPicAfterBattle();
      yield* this.ui.delay(40);
      yield* this.text(far('_Rival1WinText'));
      if (this.map === 'OAKS_LAB') {
        this.blackedOut = false;
        this.outcomeOverride = 'lose';
        return;
      }
    }
    yield* this.text(far(this.link ? '_LinkBattleLostText' : '_PlayerBlackedOutText2'));
    if (this.state.statusFlags && typeof this.state.statusFlags.clear === 'function') {
      try { this.state.statusFlags.clear('BIT_ALWAYS_ON_BIKE'); } catch { /* unknown flag name */ }
    }
    this.ui.clearScreen();
    this.blackedOut = true;
  }

  /** TrainerBattleVictory: victory music, "<PLAYER> defeated <TRAINER>!", end text, prize money. */
  *trainerBattleVictory() {
    this.endLowHealthAlarm();
    let music = this.gymLeader ? MUSIC.DEFEATED_GYM_LEADER : MUSIC.DEFEATED_TRAINER;
    if (this.trainerClass === 'RIVAL3') {
      music = MUSIC.DEFEATED_GYM_LEADER;
      this.noMapMusic = true;
      if (this.state.statusFlags && typeof this.state.statusFlags.set === 'function') {
        try { this.state.statusFlags.set('BIT_NO_MAP_MUSIC'); } catch { /* unknown flag name */ }
      }
    }
    yield* this.playBattleVictoryMusic(music);
    yield* this.text(far('_TrainerDefeatedText'));
    yield* this.scrollTrainerPicAfterBattle();
    yield* this.ui.delay(40);
    yield* this.printEndBattleText();
    yield* this.text(far('_MoneyForWinningText'));
    this.state.money = Math.min(999999, this.state.money + this.prizeMoney);
    this.moneyWon = this.prizeMoney;
  }

  /** PrintEndBattleText: "<TRAINER>: <defeated text>" (from the map's trainer header). */
  *printEndBattleText() {
    const t = this.params.endBattleText;
    if (!t) return;
    let cmds = t;
    if (typeof t === 'string') cmds = this.texts.get(t) || (this.params.resolveText && this.params.resolveText(t));
    if (!cmds) return;
    this.nameBuffer = this.trainerName;
    yield* this.text([{ cmd: 'text_far', label: '_TrainerNameText' }, ...(Array.isArray(cmds) ? cmds : cmds.commands || [])]);
    yield* this.ui.waitSound();
  }

  /** ScrollTrainerPicAfterBattle */
  *scrollTrainerPicAfterBattle() {
    if (!this.trainerClass) return;
    this.side[ENEMY].species2 = 0;
    this.ui.setEnemyPic({ kind: 'trainer', trainerClass: this.trainerClass });
    yield* this.ui.sequence('SCROLL_TRAINER_PIC_IN', { attacker: ENEMY });
  }

  // ===================================================================== send-outs

  /** EnemySendOut: clears the exp flags to the current mon, then EnemySendOutFirstMon. */
  *enemySendOut() {
    this.gainExpFlags = 1 << this.playerMonNumber;
    this.foughtFlags = 1 << this.playerMonNumber;
    yield* this.enemySendOutFirstMon();
  }

  /** EnemySendOutFirstMon (+ the Shift-mode "Will <PLAYER> change POKéMON?" prompt). */
  *enemySendOutFirstMon() {
    const P = this.side[PLAYER];
    const En = this.side[ENEMY];
    En.clearStatusBlock();
    En.disabledMove = 0;
    En.disabledMoveNumber = 0;
    En.minimized = 0;
    P.usedMove = 0;
    En.usedMove = 0;
    this.aiCount = 0xff;
    P.status1 &= ~USING_TRAPPING_MOVE;
    yield* this.ui.sequence('SLIDE_TRAINER_OFF_ENEMY', { attacker: ENEMY });
    yield* this.emptyText();
    this.ui.saveScreen();
    let b = -1;
    for (;;) {
      b++;
      if (b === En.partyPos) continue;
      if (b >= this.enemyParty.length) throw new Error('EnemySendOut: no enemy mon left');
      if (this.enemyParty[b].hp > 0) break;
    }
    this.whichPokemon = b;
    const pm = this.enemyParty[b];
    this.curEnemyLevel = pm.level;
    En.species2 = this.gd.species(pm.species).dex;
    loadEnemyMonData(En, { species: pm.species, level: pm.level, trainer: true, partyMon: pm, partyIndex: b }, this.rng, this.gd);
    this.state.pokedex.setSeen(En.species);
    this.lastSwitchInEnemyMonHP = En.hp;
    let shift = false;
    if (!this.firstMonsNotOutYet && this.party.length > 1 && !this.link && this.state.options.battleStyle !== 'set') {
      yield* this.text(far('_TrainerAboutToUseText'));
      const yes = yield* this.ui.yesNo({ x: 0, y: 7, kind: 'shift' });
      if (yes) {
        let i = yield* this.ui.partyMenu({ type: 'battle', battle: this });
        for (;;) {
          if (i < 0) break;
          if (i === this.playerMonNumber) {
            yield* this.text(far('_AlreadyOutText'));
          } else if (!(this.party[i].hp > 0)) {
            if (!this.firstMonsNotOutYet) yield* this.text(far('_NoWillText'));
          } else {
            shift = true;
            this.whichPokemon = i;
            break;
          }
          i = yield* this.ui.partyMenu({ type: 'battle', battle: this, goBack: true });
        }
        this.ui.restoreScreen();
      }
    }
    this.ui.clearSprites();
    this.ui.clearArea(0, 0, 11, 4);
    yield* this.text(far('_TrainerSentOutText'));
    this.enemyPic = { kind: 'mon', species: En.species2 };
    this.ui.setEnemyPic(this.enemyPic);
    yield* this.ui.sequence('SEND_OUT_ENEMY_MON', { attacker: ENEMY });
    yield* this.ui.cryWait(En.species2);
    this.ui.drawHUD(ENEMY);
    if (!shift) return;
    this.gainExpFlags = 0;
    this.foughtFlags = 0;
    this.ui.saveScreen();
    yield* this.switchPlayerMon();
  }

  /** ReplaceFaintedEnemyMon (not link): the next trainer mon. */
  *replaceFaintedEnemyMon() {
    this.ui.drawPartyBalls(ENEMY, this.enemyParty);
    yield* this.enemySendOut();
    this.side[ENEMY].move.num = 0;
    this.actionResult = 0;
    this.aiLayer2Encouragement = 0;
    return true;
  }

  /** SendOutMon: "Go! <MON>!", HUDs, the ball poof + grow, cry. */
  *sendOutMon() {
    const P = this.side[PLAYER];
    const En = this.side[ENEMY];
    yield* this.printSendOutMonMessage();
    if (En.hp) this.ui.drawHUD(ENEMY);
    this.ui.drawHUD(PLAYER);
    this.ui.setPlayerMonPic(P.species);
    this.battleMenuCursor = 0;
    this.boostExpByExpAll = 0;
    this.damageMultipliers = 0;
    P.move.num = 0;
    P.usedMove = 0;
    En.usedMove = 0;
    P.clearStatusBlock();
    P.disabledMove = 0;
    P.disabledMoveNumber = 0;
    P.minimized = 0;
    En.status1 &= ~USING_TRAPPING_MOVE;
    this.turn = ENEMY;
    yield* this.ui.sequence('SEND_OUT_PLAYER_MON', { attacker: ENEMY, preDelay: 3 });
    yield* this.ui.cryWait(this.party[this.playerMonNumber].species);
    yield* this.emptyText();
    this.ui.saveScreen();
  }

  /** PrintSendOutMonMessage: "Go!" / "Do it!" / "Get'm!" / "The enemy's weak! Get'm!" by enemy HP. */
  *printSendOutMonMessage() {
    const En = this.side[ENEMY];
    let label = '_GoText';
    if (En.hp) {
      this.lastSwitchInEnemyMonHP = En.hp;
      const div = (En.maxHP >> 2) & 0xff;
      const pct = div ? Math.floor((En.hp * 25) / div) & 0xff : 0;
      if (pct >= 70) label = '_GoText';
      else if (pct >= 40) label = '_DoItText';
      else if (pct >= 10) label = '_GetmText';
      else label = '_EnemysWeakText';
    }
    yield* this.text([{ cmd: 'text_far', label }, { cmd: 'text_far', label: '_PlayerMon1Text' }, { cmd: 'done' }]);
  }

  /** RetreatMon: "<MON> enough!/OK!/good! Come back!" by the enemy's HP lost since the switch-in. */
  *retreatMon() {
    const En = this.side[ENEMY];
    const diff = (this.lastSwitchInEnemyMonHP - En.hp) & 0xffff;
    const div = (En.maxHP >> 2) & 0xff;
    const pct = div ? Math.floor((diff * 25) / div) & 0xff : 0;
    const cmds = [{ cmd: 'text_far', label: '_PlayerMon2Text' }];
    if (pct === 0) cmds.push({ cmd: 'text_far', label: '_EnoughText' });
    else if (pct >= 30 && pct < 70) cmds.push({ cmd: 'text_far', label: '_OKExclamationText' });
    else if (pct >= 70) cmds.push({ cmd: 'text_far', label: '_GoodText' });
    cmds.push({ cmd: 'text_far', label: '_ComeBackText' }, { cmd: 'done' });
    yield* this.text(cmds);
  }

  /** SwitchPlayerMon */
  *switchPlayerMon() {
    yield* this.retreatMon();
    yield* this.ui.delay(50);
    yield* this.ui.sequence('RETREAT_PLAYER_MON', { attacker: PLAYER });
    this.playerMonNumber = this.whichPokemon;
    this.gainExpFlags |= 1 << this.playerMonNumber;
    this.foughtFlags |= 1 << this.playerMonNumber;
    this.loadBattleMonFromParty();
    yield* this.sendOutMon();
    this.ui.saveScreen();
    this.currentMenuItem = 2;
  }

  // ===================================================================== running

  /**
   * TryRunningFromBattle. @returns {Generator<any, boolean>} true = escaped
   * @param {number} playerSpeed the Speed the caller passes (battle Speed, or the first party
   *   mon's Speed after a faint)
   */
  *tryRunningFromBattle(playerSpeed) {
    let escape = false;
    if (this.isGhostBattle() || this.battleType === BATTLE_TYPE_SAFARI || this.link) escape = true;
    else if (this.isInBattle === TRAINER_BATTLE) {
      yield* this.text(far('_NoRunningText'));
      this.forcePlayerToChooseMon = 1;
      this.ui.saveScreen();
      return false;
    } else {
      this.numRunAttempts = (this.numRunAttempts + 1) & 0xff;
      this.ui.restoreScreen();
      const enemySpeed = this.side[ENEMY].spd;
      if (playerSpeed >= enemySpeed) escape = true;
      else {
        const divisor = (enemySpeed >> 2) & 0xff;
        if (divisor === 0) escape = true;
        else {
          let q = Math.floor(((playerSpeed * 32) & 0xffff) / divisor);
          if (q > 255) escape = true;
          else {
            for (let c = this.numRunAttempts - 1; c > 0; c--) {
              q += 30;
              if (q > 255) { escape = true; break; }
            }
            if (!escape && this.random() <= q) escape = true;
          }
        }
      }
      if (!escape) {
        this.actionResult = 1;
        yield* this.text(far('_CantEscapeText'));
        this.forcePlayerToChooseMon = 1;
        this.ui.saveScreen();
        return false;
      }
    }
    this.battleResult = 2;
    // PlaySoundWaitForCurrent: wait for the current sound, then start SFX_RUN under the text
    yield* this.ui.waitSound();
    this.ui.sfx('SFX_RUN');
    yield* this.text(far('_GotAwayText'));
    yield* this.ui.waitSound();
    this.ui.saveScreen();
    this.escapeReason = 'ran';
    return true;
  }

  // ===================================================================== battle menu

  /**
   * DisplayBattleMenu (+ its sub-menus). @returns {Generator<any, boolean>} true when the
   * battle ended (ran, caught), false when the turn goes on (FIGHT, or an action used the turn)
   */
  *displayBattleMenu() {
    for (let guard = 0; guard < 100000; guard++) {
      this.ui.restoreScreen();
      if (this.battleType === BATTLE_TYPE_NORMAL) {
        this.ui.drawHUDs();
        yield* this.emptyText();
        this.ui.saveScreen();
      }
      const safari = this.battleType === BATTLE_TYPE_SAFARI;
      let a;
      if (this.battleType === BATTLE_TYPE_OLD_MAN) {
        yield* this.ui.oldManBattleMenu();
        a = 2;
      } else {
        const pos = yield* this.ui.battleMenu({ safari, cursor: this.battleMenuCursor, balls: this.state.safari.balls, battle: this });
        this.battleMenuCursor = pos;
        a = pos;
        if (!safari) a = pos === 1 ? 2 : pos === 2 ? 1 : pos;
      }
      let r;
      if (a === 0) {
        if (!safari) {
          this.numRunAttempts = 0;
          this.ui.restoreScreen();
          return false;
        }
        r = yield* this.useBagItem('SAFARI_BALL');
      } else if (a === 2) {
        if (this.link) {
          yield* this.text(far('_ItemsCantBeUsedHereText'));
          continue;
        }
        this.ui.saveScreen2();
        if (safari) r = yield* this.useBagItem('BOULDERBADGE'); // SAFARI_BAIT
        else r = yield* this.bagWasSelected();
      } else if (a === 1) {
        this.ui.saveScreen2();
        if (safari) r = yield* this.useBagItem('CASCADEBADGE'); // SAFARI_ROCK
        else r = yield* this.partyMenuWasSelected();
      } else {
        r = yield* this.battleMenuRunWasSelected();
      }
      if (r === REDISPLAY) continue;
      return r === END;
    }
    throw new Error('DisplayBattleMenu loop');
  }

  /** BagWasSelected / DisplayBagMenu: the item list (the old man's is POKé BALL x50). */
  *bagWasSelected() {
    for (let guard = 0; guard < 10000; guard++) {
      this.ui.restoreScreen();
      if (this.battleType === BATTLE_TYPE_NORMAL) this.ui.drawHUDs();
      const oldMan = this.battleType === BATTLE_TYPE_OLD_MAN;
      const items = oldMan ? [{ item: 'POKE_BALL', qty: 50 }] : this.state.bag.items;
      const res = yield* this.ui.bagMenu({ items, cursor: this.bagCursor, scroll: this.bagScroll, oldMan, bag: oldMan ? null : this.state.bag, battle: this });
      this.bagCursor = res.cursor ?? this.bagCursor;
      this.bagScroll = res.scroll ?? this.bagScroll;
      if (res.index < 0 || res.index >= items.length) return REDISPLAY;
      const r = yield* this.useBagItem(items[res.index].item);
      if (r === 'bag') continue;
      return r;
    }
    throw new Error('bag loop');
  }

  /** UseBagItem: UseItem, then the trapping-move counter, capture or redraw. */
  *useBagItem(item) {
    const P = this.side[PLAYER];
    const name = this.gd.item(item).name;
    this.nameBuffer = name;
    this.stringBuffer = name;
    this.pseudoItemID = 0;
    yield* this.useItem(item);
    this.ui.clearSprites();
    this.currentMenuItem = 0;
    const safari = this.battleType === BATTLE_TYPE_SAFARI;
    if (!safari) {
      if (!this.actionResult) return 'bag';
      if (P.status1 & USING_TRAPPING_MOVE) {
        P.numAttacksLeft = (P.numAttacksLeft - 1) & 0xff;
        if (!P.numAttacksLeft) P.status1 &= ~USING_TRAPPING_MOVE;
      }
    }
    if (this.capturedMon) {
      this.battleResult = 2;
      return END;
    }
    if (!safari) {
      this.ui.restoreScreen();
      this.ui.drawHUDs();
      yield* this.ui.delay(3);
    }
    return TURN;
  }

  /** PartyMenuOrRockOrRun's party branch: SWITCH / STATS / CANCEL. */
  *partyMenuWasSelected() {
    this.ui.restoreScreen();
    this.menuItemToSwap = 0;
    let i = yield* this.ui.partyMenu({ type: 'normal', battle: this });
    for (let guard = 0; guard < 10000; guard++) {
      if (i < 0) {
        this.ui.clearSprites();
        this.ui.restoreScreen2();
        return REDISPLAY;
      }
      const sub = yield* this.ui.switchStatsCancel();
      if (sub < 0) {
        i = yield* this.ui.partyMenu({ type: 'normal', battle: this, goBack: true });
        continue;
      }
      if (sub === 2) {
        this.ui.clearSprites();
        this.ui.restoreScreen2();
        return REDISPLAY;
      }
      if (sub === 1) {
        yield* this.ui.statusScreen(this.party[i], this);
        this.ui.restoreScreen();
        i = yield* this.ui.partyMenu({ type: 'normal', battle: this });
        continue;
      }
      if (i === this.playerMonNumber) {
        yield* this.text(far('_AlreadyOutText'));
        i = yield* this.ui.partyMenu({ type: 'normal', battle: this, goBack: true });
        continue;
      }
      if (!(this.party[i].hp > 0)) {
        if (!this.firstMonsNotOutYet) yield* this.text(far('_NoWillText'));
        i = yield* this.ui.partyMenu({ type: 'normal', battle: this, goBack: true });
        continue;
      }
      this.actionResult = 1;
      this.ui.clearSprites();
      this.ui.restoreScreen();
      this.whichPokemon = i;
      yield* this.switchPlayerMon();
      return TURN;
    }
    throw new Error('party menu loop');
  }

  /** BattleMenu_RunWasSelected */
  *battleMenuRunWasSelected() {
    this.ui.restoreScreen();
    this.currentMenuItem = 3;
    const escaped = yield* this.tryRunningFromBattle(this.side[PLAYER].spd);
    this.forcePlayerToChooseMon = 0;
    if (escaped) return END;
    if (this.actionResult) return TURN;
    return REDISPLAY;
  }

  // ===================================================================== move menu

  /**
   * MoveSelectionMenu (regular): @returns {Generator<any, boolean>} true when a move was
   * chosen (or Struggle forced), false when the player backed out with B.
   */
  *moveSelectionMenu() {
    const P = this.side[PLAYER];
    for (let guard = 0; guard < 10000; guard++) {
      if (!(yield* this.anyMoveToSelect())) return true;
      this.maxMenuItem = P.numMoves + 1;
      const res = yield* this.ui.moveMenu({
        moves: P.moves.slice(),
        cursor: P.moveListIndex & 3,
        swap: this.menuItemToSwap ? this.menuItemToSwap - 1 : -1,
        battle: this,
      });
      const idx = res.index;
      this.currentMenuItem = idx;
      if (res.action === 'swap') {
        this.swapMovesInMenu(idx);
        continue;
      }
      this.menuItemToSwap = 0;
      P.moveListIndex = idx;
      if (res.action === 'cancel') return false;
      if (!(P.pp[idx] & PP_MASK)) {
        yield* this.text(far('_MoveNoPPText'));
        this.ui.restoreScreen();
        continue;
      }
      if ((((P.disabledMove >> 4) & 0xf) - 1) === idx) {
        yield* this.text(far('_MoveDisabledText'));
        this.ui.restoreScreen();
        continue;
      }
      P.selectedMove = P.moves[idx];
      return true;
    }
    throw new Error('move menu loop');
  }

  /**
   * PrintMenuItem's side effect: the hovered move becomes wPlayerSelectedMove and its data is
   * loaded (GetCurrentMove) - unless it is the disabled move. Counter reads these.
   * @returns {{disabled:boolean, type:string, pp:number, maxPP:number}} what the TYPE/PP box shows
   */
  moveMenuHover(idx) {
    const P = this.side[PLAYER];
    const dis = (P.disabledMove >> 4) & 0xf;
    if (dis && dis - 1 === idx) return { disabled: true };
    const id = P.moves[idx];
    P.selectedMove = id;
    this.turn = PLAYER;
    this.getCurrentMove(PLAYER);
    const base = id ? this.gd.move(id).pp : 0;
    const ups = (P.pp[idx] >> 6) & 3;
    return { disabled: false, type: this.gd.typeName ? this.gd.typeName(P.move.type) : P.move.type, pp: P.pp[idx] & PP_MASK, maxPP: base + ups * Math.min(7, Math.floor(base / 5)) };
  }

  /** AnyMoveToSelect: Struggle when no usable PP. @returns {Generator<any, boolean>} false = Struggle */
  *anyMoveToSelect() {
    const P = this.side[PLAYER];
    P.selectedMove = MOVE.STRUGGLE;
    if (!P.disabledMove) {
      if ((P.pp[0] | P.pp[1] | P.pp[2] | P.pp[3]) & PP_MASK) return true;
    } else {
      const dis = (P.disabledMove >> 4) & 0xf;
      let a = 0;
      for (let k = 0; k < 4; k++) if (k + 1 !== dis) a |= P.pp[k]; // raw bytes: PP Ups count (bug)
      if (a) return true;
    }
    yield* this.text(far('_NoMovesLeftText'));
    yield* this.ui.delay(60);
    return false;
  }

  /** SwapMovesInMenu: SELECT once marks a move, twice swaps (battle and party copies). */
  swapMovesInMenu(idx) {
    const P = this.side[PLAYER];
    if (!this.menuItemToSwap) {
      this.menuItemToSwap = idx + 1;
      return;
    }
    const a = this.menuItemToSwap - 1;
    const b = idx;
    [P.moves[a], P.moves[b]] = [P.moves[b], P.moves[a]];
    [P.pp[a], P.pp[b]] = [P.pp[b], P.pp[a]];
    const dis = (P.disabledMove >> 4) & 0xf;
    const cur = b + 1;
    if (cur === dis) P.disabledMove = ((this.menuItemToSwap << 4) + (P.disabledMove & 0xf)) & 0xff;
    else if (this.menuItemToSwap === dis) P.disabledMove = ((cur << 4) + (P.disabledMove & 0xf)) & 0xff;
    const mon = this.party[this.playerMonNumber];
    const ms = mon.moves;
    const ra = ms[a] ? rawPP(ms[a]) : 0;
    const rb = ms[b] ? rawPP(ms[b]) : 0;
    [ms[a], ms[b]] = [ms[b], ms[a]];
    if (ms[a]) setRawPP(ms[a], rb);
    if (ms[b]) setRawPP(ms[b], ra);
    mon.moves = ms.filter(Boolean);
    this.menuItemToSwap = 0;
  }

  // ===================================================================== end of battle

  /** EndOfBattle: Pay Day money and evolutions after a win, then reset. */
  *endOfBattle() {
    if (this.battleResult === 0 && !this.blackedOut) {
      if (this.totalPayDayMoney) {
        this.state.money = Math.min(999999, this.state.money + this.totalPayDayMoney);
        yield* this.text(far('_PickUpPayDayMoneyText'));
      }
      this.forceEvolution = 0;
      yield* this.evolutionAfterBattle();
    }
    this.lowHealthAlarm = false;
    this.ui.setLowHealthAlarm(false);
    yield* this.ui.waitSound();
    this.ui.endOfBattle();
  }

  /** The result object startBattle() resolves to. */
  makeResult() {
    let outcome;
    if (this.outcomeOverride) outcome = this.outcomeOverride;
    else if (this.capturedMon || this.oldManCaught) outcome = 'caught';
    else if (this.blackedOut || this.battleResult === 1) outcome = 'lose';
    else if (this.escapedFromBattle || this.battleResult === 2) outcome = 'ran';
    else outcome = 'win';
    const En = this.side[ENEMY];
    return {
      outcome,
      kind: this.isInBattle === TRAINER_BATTLE ? 'trainer' : this.battleType === BATTLE_TYPE_SAFARI ? 'safari'
        : this.battleType === BATTLE_TYPE_OLD_MAN ? 'oldman' : 'wild',
      blackout: this.blackedOut,
      prizeMoney: outcome === 'win' && this.isInBattle === TRAINER_BATTLE ? this.prizeMoney : 0,
      payDay: this.battleResult === 0 && !this.blackedOut ? this.totalPayDayMoney : 0,
      caughtMon: this.capturedMonOldMan ? null : this.capturedMon || null,
      caughtTo: this.caughtTo,
      firstCatch: this.firstCatch,
      escapeReason: this.escapeReason,
      escapedBy: this.escapeMove ? this.gd.move(this.escapeMove).const : null,
      trainerClass: this.trainerClass,
      enemySpecies: En.species,
      enemyLevel: En.level,
      turns: this.turnCount,
      evolutions: this.evolutions,
      victoryMusic: this.victoryMusic || null,
      noMapMusic: !!this.noMapMusic,
      safariBallsLeft: this.battleType === BATTLE_TYPE_SAFARI ? this.state.safari.balls : undefined,
      aiActions: this.aiActions.slice(),
      // the old man's catch copies the player's name over wGrassRate/wGrassMons (the
      // MissingNo. glitch setup) - reported so the overworld can reproduce it if it wants
      oldManNameInGrassData: this.battleType === BATTLE_TYPE_OLD_MAN && this.oldManCaught ? this.state.playerName : null,
      levelUps: (this.levelUps || []).slice(),
      learnedMoves: (this.learnLog || []).slice(),
    };
  }
}

/** GetHPBarLength-style pixels (0..48) for the low-health alarm / HUD colour. */
export function hpBarPixels(hp, maxHP) {
  if (!hp) return 0;
  let num = (hp * 48) & 0xffff;
  let den = maxHP;
  if (den > 255) {
    num >>= 2;
    den = (den >> 2) & 0xff;
  }
  if (!den) return 48;
  const px = Math.floor(num / den) & 0xff;
  return px || 1;
}

/** GetBattleTransitionID_IsDungeonMap (data/maps/dungeon_maps.asm), by map id. */
export function isDungeonMap(map, gd = getGameData()) {
  if (!map) return false;
  const m = gd.findMap(map);
  if (!m) return false;
  const id = m.id;
  const idOf = (c) => { const x = gd.findMap(c); return x ? x.id : -1; };
  if (['VIRIDIAN_FOREST', 'ROCK_TUNNEL_1F', 'SEAFOAM_ISLANDS_1F', 'ROCK_TUNNEL_B1F'].some((c) => idOf(c) === id)) return true;
  const ranges = [['MT_MOON_1F', 'MT_MOON_B2F'], ['SS_ANNE_1F', 'HALL_OF_FAME'], ['LAVENDER_POKECENTER', 'LAVENDER_CUBONE_HOUSE'], ['SILPH_CO_2F', 'CERULEAN_CAVE_1F']];
  for (const [a, b] of ranges) {
    const lo = idOf(a);
    const hi = idOf(b);
    if (lo >= 0 && hi >= 0 && id >= lo && id <= hi) return true;
  }
  return false;
}

Object.assign(Battle.prototype, movesMixin, effectsMixin, aiMixin, itemsMixin, experienceMixin, evolutionMixin);

export { REDISPLAY, TURN, END, CONTINUE, makeWildMon };
