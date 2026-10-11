// What items (and field moves) do, as pure functions over the game state — no UI. Transcribed
// from ItemUsePtrTable (engine/items/item_effects.asm) and StartMenu_Pokemon's field moves
// (engine/menus/start_sub_menus.asm).
//
//   const r = useItem(state, 'POTION', { target: 0 });
//   // r = { ok, consumed, text, message, vars, needs?, request?, ... }
//
// * `text` is a label (or list of labels) of data/text/common.json, `vars` the text_ram values
//   it needs (wNameBuffer = mon nickname, wStringBuffer = item/move/stat name, ...). `message`
//   is a plain-English fallback.
// * `needs` asks the caller for more input and to call again: 'target' (party index →
//   ctx.target), 'move' (ctx.moveIndex), 'replaceMove' (ctx.replaceSlot, or null to give up).
// * `request` is work for the overworld / battle engine (open the Town Map, warp, throw the
//   ball, fish, ...): {kind, ...}.
// * `consumed`: one unit was used up; it is removed from state.bag unless ctx.removeFromBag
//   is false.

import { getGameData } from './data.js';
import { maxPP, ppUpBonus } from './mon.js';
import { recalcStats } from './stats.js';
import { expForLevel, MAX_LEVEL } from './exp.js';
import { canLearnTM, knowsMove, learnMove, itemEvolution, evolve, levelEvolution, moveLearnedOnLevelUp } from './learnset.js';
import { cureMask, STATUS_SLP_MASK } from './status.js';
import { noRoomForMon } from './party.js';

const T = Object.freeze({
  NOT_TIME: '_ItemUseNotTimeText',
  NO_EFFECT: '_ItemUseNoEffectText',
  NOT_YOURS: '_ItemUseNotYoursToUseText',
  USED: ['_ItemUseText001', '_ItemUseText002'],
});

const CURE_TEXT = Object.freeze({
  ANTIDOTE: '_AntidoteText', BURN_HEAL: '_BurnHealText', ICE_HEAL: '_IceHealText',
  AWAKENING: '_AwakeningText', PARLYZ_HEAL: '_ParlyzHealText', FULL_HEAL: '_FullHealText',
});

/** Vitamin → stat-exp key and the VitaminStats name printed. */
export const VITAMIN_STATS = Object.freeze({
  HP_UP: { stat: 'hp', name: 'HEALTH' },
  PROTEIN: { stat: 'atk', name: 'ATTACK' },
  IRON: { stat: 'def', name: 'DEFENSE' },
  CARBOS: { stat: 'spd', name: 'SPEED' },
  CALCIUM: { stat: 'spc', name: 'SPECIAL' },
});
export const VITAMIN_STAT_EXP = 2560;
/** Refused when the stat exp's high byte is >= 100 (stat exp >= 25600). */
export const VITAMIN_STAT_EXP_LIMIT = 25600;

/** Poké Flute spots next to the sleeping Snorlax (Route12/16SnorlaxFluteCoords, x/y). */
export const SNORLAX_FLUTE_SPOTS = Object.freeze({
  ROUTE_12: { beaten: 'EVENT_BEAT_ROUTE12_SNORLAX', fight: 'EVENT_FIGHT_ROUTE12_SNORLAX',
    coords: [[9, 62], [10, 61], [10, 63], [11, 62]] },
  ROUTE_16: { beaten: 'EVENT_BEAT_ROUTE16_SNORLAX', fight: 'EVENT_FIGHT_ROUTE16_SNORLAX',
    coords: [[27, 10], [25, 10]] },
});

/** Badge needed by each HM field move (data/items.json fieldMoves). */
export const FIELD_MOVE_BADGES = Object.freeze({
  CUT: 'CASCADEBADGE', FLY: 'THUNDERBADGE', SURF: 'SOULBADGE', STRENGTH: 'RAINBOWBADGE', FLASH: 'BOULDERBADGE',
});

/**
 * @typedef {object} ItemContext
 * @property {boolean} [inBattle]
 * @property {'wild'|'trainer'|'safari'|'oldMan'} [battleType] (wild includes ghost battles)
 * @property {number} [target]       party index the item is used on
 * @property {number} [moveIndex]    move slot (PP Up, Ether, Max Ether)
 * @property {number|null} [replaceSlot] TM/HM with 4 moves: slot to forget (null = give up)
 * @property {number} [activeIndex]  party index of the mon in battle (wPlayerMonNumber)
 * @property {string} [map]          current map const (default state.pos.map)
 * @property {string} [tileset]      current tileset const (default: from data/map_index.json)
 * @property {boolean} [facingWater] the tile in front is water/shore (rods, Surf)
 * @property {{x:number, y:number}} [coords] player position (default state.pos)
 * @property {boolean} [removeFromBag=true]
 *
 * @typedef {object} ItemResult
 * @property {boolean} ok
 * @property {boolean} consumed
 * @property {string|string[]|null} text
 * @property {string} message
 * @property {Record<string, string|number>} [vars]
 * @property {'target'|'move'|'replaceMove'} [needs]
 * @property {{kind:string}} [request]
 */

function result(ok, consumed, text, message, extra = {}) {
  return { ok, consumed, text, message, vars: {}, ...extra };
}
const notTime = () => result(false, false, T.NOT_TIME, "OAK: This isn't the time to use that!");
const noEffect = () => result(false, false, T.NO_EFFECT, "It won't have any effect.");
const used = (state, itemName, extra = {}) => result(true, true, T.USED, `${state.playerName} used ${itemName}!`,
  { vars: { wStringBuffer: itemName }, ...extra });

function tilesetOf(state, ctx, gd) {
  if (ctx.tileset) return ctx.tileset;
  const map = gd.findMap(ctx.map || (state.pos && state.pos.map));
  return map ? map.tileset : null;
}

function mapOf(state, ctx) {
  return ctx.map || (state.pos && state.pos.map) || null;
}

/** CheckIfInOutsideMap: OVERWORLD or PLATEAU tileset (Fly and Teleport need it). */
export function isOutsideMap(state, ctx = {}, gd = getGameData()) {
  const ts = tilesetOf(state, ctx, gd);
  return (gd.tilesets.outsideTilesets || ['OVERWORLD', 'PLATEAU']).includes(ts);
}

/** IsBikeRidingAllowed: Route 23, Indigo Plateau, or a BikeRidingTilesets tileset. */
export function isBikeRidingAllowed(state, ctx = {}, gd = getGameData()) {
  const map = mapOf(state, ctx);
  if ((gd.mapsMeta.bikeAlsoAllowedMaps || []).includes(map)) return true;
  return (gd.tilesets.bikeRidingTilesets || []).includes(tilesetOf(state, ctx, gd));
}

/** Escape Rope / Dig: EscapeRopeTilesets and not Agatha's room. */
export function canEscapeRope(state, ctx = {}, gd = getGameData()) {
  if (mapOf(state, ctx) === 'AGATHAS_ROOM') return false;
  return (gd.tilesets.escapeRopeTilesets || []).includes(tilesetOf(state, ctx, gd));
}

function hasBadge(state, badge, gd) {
  const b = gd.eventFlags.badges.find((x) => x.name === badge);
  return !!b && (state.badges & b.mask) !== 0;
}

function targetMon(state, ctx) {
  if (ctx.target === undefined || ctx.target === null) return null;
  const mon = state.party[ctx.target];
  if (!mon) throw new RangeError(`no party mon ${ctx.target}`);
  return mon;
}

const needs = (what, text = null, message = '') => result(false, false, text, message, { needs: what });

// ------------------------------------------------------------------------------------ entry

/**
 * Use an item from the bag.
 * @param {object} state GameState
 * @param {string} item item const
 * @param {ItemContext} [ctx]
 * @returns {ItemResult}
 */
export function useItem(state, item, ctx = {}, gd = getGameData()) {
  const it = gd.item(item);
  const r = dispatch(state, it, ctx, gd);
  if (r.consumed && ctx.removeFromBag !== false && state.bag && state.bag.has(it.const, 1, gd)) state.bag.remove(it.const, 1, gd);
  r.item = it.const;
  return r;
}

function dispatch(state, it, ctx, gd) {
  const e = it.effect || { kind: 'none' };
  const inBattle = !!ctx.inBattle;
  switch (e.kind) {
    case 'ball': return useBall(state, it, ctx, gd);
    case 'townMap': return inBattle ? notTime() : result(true, false, null, '', { request: { kind: 'townMap' } });
    case 'bicycle': return useBicycle(state, it, ctx, gd);
    case 'surfboard': return useSurfboard(state, ctx);
    case 'pokedex': return result(true, false, null, '', { request: { kind: 'pokedex' } });
    case 'evolutionStone': return useStone(state, it, ctx, gd);
    case 'cureStatus':
    case 'heal':
    case 'revive': return useMedicine(state, it, ctx, gd);
    case 'vitamin': return inBattle ? notTime() : useVitamin(state, it, ctx, gd);
    case 'rareCandy': return inBattle ? notTime() : useRareCandy(state, it, ctx, gd);
    case 'repel': {
      if (inBattle) return notTime();
      state.repelSteps = e.steps;
      return used(state, it.name);
    }
    case 'escapeRope': return inBattle ? notTime() : useEscapeRope(state, ctx, gd, { pseudo: false, itemName: it.name });
    case 'xAccuracy':
    case 'guardSpec':
    case 'direHit':
    case 'xStat':
      if (!inBattle) return notTime();
      return used(state, it.name, { request: { kind: 'battleEffect', effect: e.kind, stat: e.stat || null, moveEffect: e.effect || null } });
    case 'pokeDoll':
      if (!inBattle || ctx.battleType !== 'wild') return notTime();
      return used(state, it.name, { request: { kind: 'escapeBattle' } });
    case 'pokeFlute': return usePokeFlute(state, ctx, gd);
    case 'coinCase':
      if (inBattle) return notTime();
      return result(true, false, '_CoinCaseNumCoinsText', `Coins ${state.coins}`, { vars: { wPlayerCoins: state.coins } });
    case 'rod':
      if (inBattle || !ctx.facingWater || state.surfing) return notTime();
      return result(true, false, T.USED, `${state.playerName} used ${it.name}!`, { vars: { wStringBuffer: it.name }, request: { kind: 'fish', rod: e.rod } });
    case 'oaksParcel': return result(false, false, T.NOT_YOURS, "This isn't yours to use!");
    case 'itemfinder': return inBattle ? notTime() : result(true, false, null, '', { request: { kind: 'itemfinder' } });
    case 'ppUp': return inBattle ? notTime() : usePPUp(state, it, ctx, gd);
    case 'ppRestore': return usePPRestore(state, it, ctx, gd);
    case 'teachMove': return inBattle ? notTime() : useMachine(state, it, ctx, gd);
    case 'safariBait':
    case 'safariRock':
      return inBattle && ctx.battleType === 'safari' ? result(true, false, null, '', { request: { kind: e.kind } }) : notTime();
    case 'cardKey': // ItemUseCardKey is bugged and always ends in ItemUseNotTime
    case 'none':
    default:
      return notTime();
  }
}

// ------------------------------------------------------------------------------------ balls

function useBall(state, it, ctx) {
  if (!ctx.inBattle) return notTime();
  if (ctx.battleType === 'trainer') {
    // ThrowBallAtTrainerMon: the ball is still used up
    return result(false, true, ['_ThrowBallAtTrainerMonText1', '_ThrowBallAtTrainerMonText2'],
      "The trainer blocked the BALL! Don't be a thief!", { request: { kind: 'blockedBall' } });
  }
  if (ctx.battleType !== 'oldMan' && noRoomForMon(state)) {
    return result(false, false, '_BoxFullCannotThrowBallText', "The POKéMON BOX is full! Can't use that item!");
  }
  return result(true, true, T.USED, `${state.playerName} used ${it.name}!`, { vars: { wStringBuffer: it.name },
    request: { kind: 'throwBall', ball: it.const } });
}

// ---------------------------------------------------------------------------------- vehicles

function useBicycle(state, it, ctx, gd) {
  if (ctx.inBattle || state.surfing) return notTime();
  if (state.bike) {
    state.bike = false;
    return result(true, false, ['_GotOffBicycleText1', '_GotOffBicycleText2'], `${state.playerName} got off the ${it.name}.`,
      { vars: { wStringBuffer: it.name }, request: { kind: 'bike', on: false } });
  }
  if (!isBikeRidingAllowed(state, ctx, gd)) return result(false, false, '_NoCyclingAllowedHereText', 'No cycling allowed here.');
  state.bike = true;
  return result(true, false, ['_GotOnBicycleText1', '_GotOnBicycleText2'], `${state.playerName} got on the ${it.name}!`,
    { vars: { wStringBuffer: it.name }, request: { kind: 'bike', on: true } });
}

function useSurfboard(state, ctx) {
  if (state.surfing) return result(true, false, null, '', { request: { kind: 'stopSurfing' } });
  if (ctx.facingWater === false) return result(false, false, '_NoSurfingHereText', 'No SURFing here!');
  return result(true, false, '_SurfingGotOnText', `${state.playerName} got on it!`, { request: { kind: 'surf' } });
}

// ---------------------------------------------------------------------------------- medicine

/**
 * ItemUseMedicine for HP / revive / status items. Fainted mons only take Revive/Max Revive
 * (and Revives only fainted mons); a full-HP mon only takes Full Restore if it has a status
 * (it then acts as Full Heal). Heal: Fresh Water 50, Soda Pop 60, Lemonade 80, Potion 20,
 * Super Potion 50, Hyper Potion 200, Max Potion / Full Restore / Max Revive to full, Revive to
 * half (it also adds 20 first, irrelevant).
 */
function useMedicine(state, it, ctx, gd) {
  if (!state.party.length) return result(false, false, null, "You don't have any POKéMON!");
  const mon = targetMon(state, ctx);
  if (!mon) return needs('target', '_PartyMenuItemUseText', 'Use item on which POKéMON?');
  const e = it.effect;
  const vars = { wNameBuffer: mon.nickname };
  const inBattleActive = !!ctx.inBattle && ctx.activeIndex === ctx.target;
  const cure = (mask, textKey) => {
    if (!(mon.status & mask)) return noEffect();
    mon.status = 0;
    return result(true, true, CURE_TEXT[textKey] || '_FullHealText', `${mon.nickname}'s status was cured!`, { vars,
      battleUpdate: inBattleActive ? { status: 0, clearToxic: true, recopyStats: true } : undefined });
  };
  if (e.kind === 'cureStatus') return cure(cureMask(e.cures), it.const);

  const max = mon.maxHP;
  const isRevive = e.kind === 'revive';
  if (mon.hp === 0 && !isRevive) return noEffect();
  if (mon.hp !== 0 && isRevive) return noEffect();
  if (mon.hp === max) {
    if (it.const === 'FULL_RESTORE' && mon.status) return cure(0xff, 'FULL_HEAL');
    return noEffect();
  }
  const old = mon.hp;
  if (isRevive && e.hp === 'half') mon.hp = max >> 1;
  else if (e.hp === 'full') mon.hp = max;
  else mon.hp = Math.min(max, old + e.hp);
  if (it.const === 'FULL_RESTORE') mon.status = 0;
  const healed = mon.hp - old;
  const extra = { vars: { ...vars, wHPBarHPDifference: healed }, healed,
    battleUpdate: inBattleActive ? { hp: mon.hp, status: it.const === 'FULL_RESTORE' ? 0 : undefined } : undefined,
    revived: isRevive };
  if (isRevive) return result(true, true, '_ReviveText', `${mon.nickname} is revitalized!`, extra);
  return result(true, true, '_PotionText', `${mon.nickname} recovered by ${healed}!`, extra);
}

/**
 * Softboiled from the party menu: the user needs HP > maxHP/5; it gives maxHP/5 of its own HP
 * to another, non-fainted, not-full mon (the POTION pseudo-item path).
 * @param {number} user party index of the Softboiled user
 * @param {number} target party index
 */
export function useSoftboiled(state, user, target) {
  const u = state.party[user];
  const t = state.party[target];
  if (!u || !t) throw new RangeError('useSoftboiled: bad party index');
  const amount = Math.floor(u.maxHP / 5);
  if (u.hp <= amount) return result(false, false, '_NotHealthyEnoughText', 'Not healthy enough.');
  if (user === target) return needs('target');
  if (t.hp === 0 || t.hp === t.maxHP) return noEffect();
  u.hp -= amount;
  const old = t.hp;
  t.hp = Math.min(t.maxHP, t.hp + amount);
  const healed = t.hp - old;
  return result(true, false, '_PotionText', `${t.nickname} recovered by ${healed}!`,
    { vars: { wNameBuffer: t.nickname, wHPBarHPDifference: healed }, healed, userHpLost: amount });
}

// ------------------------------------------------------------------------- vitamins, candy

function useVitamin(state, it, ctx, gd) {
  const mon = targetMon(state, ctx);
  if (!mon) return needs('target', '_PartyMenuItemUseText', 'Use item on which POKéMON?');
  const v = VITAMIN_STATS[it.const];
  if (!v) return notTime();
  const cur = mon.statExp[v.stat] || 0;
  if ((cur >> 8) >= 100) return result(false, false, '_VitaminNoEffectText', "It won't have any effect.");
  mon.statExp = { ...mon.statExp, [v.stat]: cur + VITAMIN_STAT_EXP };
  recalcStats(mon, { keepHpDifference: false }, gd);
  return result(true, true, '_VitaminStatRoseText', `${mon.nickname}'s ${v.name} rose.`,
    { vars: { wNameBuffer: mon.nickname, wStringBuffer: v.name }, stat: v.stat });
}

function useRareCandy(state, it, ctx, gd) {
  const mon = targetMon(state, ctx);
  if (!mon) return needs('target', '_PartyMenuItemUseText', 'Use item on which POKéMON?');
  if (mon.level >= MAX_LEVEL) return result(false, false, '_VitaminNoEffectText', "It won't have any effect.");
  const sp = gd.species(mon.species);
  const oldLevel = mon.level;
  mon.level += 1;
  mon.exp = expForLevel(sp.growthRate, mon.level, gd);
  const { oldStats, stats, hpGain } = recalcStats(mon, { keepHpDifference: true }, gd);
  const move = moveLearnedOnLevelUp(mon.species, mon.level, gd);
  return result(true, true, '_RareCandyText', `${mon.nickname} grew to level ${mon.level}!`, {
    vars: { wNameBuffer: mon.nickname, wCurEnemyLevel: mon.level },
    levelUp: { oldLevel, newLevel: mon.level, oldStats, stats, hpGain },
    moveToLearn: move && !knowsMove(mon, move) ? move : null,
    // TryEvolvingMon: a level evolution the player may cancel with B — apply with evolve()
    evolution: levelEvolution(mon, gd),
  });
}

// ---------------------------------------------------------------------------------- stones

function useStone(state, it, ctx, gd) {
  if (ctx.inBattle) return notTime();
  const mon = targetMon(state, ctx);
  if (!mon) return needs('target', '_PartyMenuItemUseText', 'Use item on which POKéMON?');
  const evo = itemEvolution(mon, it.const, gd);
  if (!evo) return noEffect();
  const res = evolve(mon, evo, gd);
  if (state.pokedex) state.pokedex.setOwned(res.into);
  const into = gd.species(res.into);
  return result(true, true, ['_EvolvedText', '_IntoText'], `${mon.nickname} evolved into ${into.name}!`,
    { vars: { wNameBuffer: mon.nickname, wStringBuffer: into.name }, evolution: res, moveToLearn: res.moveToLearn });
}

// --------------------------------------------------------------------------------- PP items

function usePPUp(state, it, ctx, gd) {
  const mon = targetMon(state, ctx);
  if (!mon) return needs('target', '_PartyMenuItemUseText', 'Use item on which POKéMON?');
  if (ctx.moveIndex === undefined || ctx.moveIndex === null) return needs('move', '_RaisePPWhichTechniqueText', 'Raise PP of which technique?');
  const slot = mon.moves[ctx.moveIndex];
  if (!slot) throw new RangeError(`no move ${ctx.moveIndex}`);
  const name = gd.move(slot.move).name;
  if (slot.ppUps >= 3) return result(false, false, '_PPMaxedOutText', `${name}'s PP is maxed out.`, { vars: { wStringBuffer: name }, needs: 'move' });
  slot.ppUps += 1;
  slot.pp += ppUpBonus(slot.move, gd);
  return result(true, true, '_PPIncreasedText', `${name}'s PP increased.`, { vars: { wStringBuffer: name } });
}

/** One move's PP restore (ItemUsePPRestore .restorePP) incl. the Max Ether raw-byte bug. */
function restoreOne(slot, full, gd) {
  const max = maxPP(slot, gd);
  if (full) {
    // Bug kept: the raw byte (PP Ups in bits 6-7) is compared, so with PP Ups the move never
    // counts as already full.
    const raw = (slot.ppUps << 6) | slot.pp;
    if (raw === max) return false;
    slot.pp = max;
    return true;
  }
  if (slot.pp === max) return false;
  slot.pp = Math.min(max, slot.pp + 10);
  return true;
}

function usePPRestore(state, it, ctx, gd) {
  const mon = targetMon(state, ctx);
  if (!mon) return needs('target', '_PartyMenuItemUseText', 'Use item on which POKéMON?');
  const e = it.effect;
  const full = e.amount === 'full';
  let restored = false;
  if (e.scope === 'oneMove') {
    if (ctx.moveIndex === undefined || ctx.moveIndex === null) return needs('move', '_RestorePPWhichTechniqueText', 'Restore PP of which technique?');
    const slot = mon.moves[ctx.moveIndex];
    if (!slot) throw new RangeError(`no move ${ctx.moveIndex}`);
    restored = restoreOne(slot, full, gd);
  } else {
    for (const slot of mon.moves) if (restoreOne(slot, full, gd)) restored = true;
  }
  if (!restored) return noEffect();
  return result(true, true, '_PPRestoredText', 'PP was restored.', {
    battleUpdate: ctx.inBattle && ctx.activeIndex === ctx.target ? { pp: mon.moves.map((m) => m.pp) } : undefined,
  });
}

// --------------------------------------------------------------------------------- TMs / HMs

/**
 * ItemUseTMHM after "Booted up a TM/HM! It contained X! Teach X to a POKéMON?" (YES):
 * incompatible / already known → choose another mon; 4 moves → needs 'replaceMove'
 * (replaceSlot null = abandon: nothing used); learned → TMs are used up, HMs never.
 */
function useMachine(state, it, ctx, gd) {
  const move = gd.move(it.move);
  const mon = targetMon(state, ctx);
  if (!mon) {
    return result(false, false, [it.hm ? '_BootedUpHMText' : '_BootedUpTMText', '_TeachMachineMoveText'],
      `It contained ${move.name}! Teach ${move.name} to a POKéMON?`, { vars: { wStringBuffer: move.name }, needs: 'target' });
  }
  const vars = { wNameBuffer: mon.nickname, wStringBuffer: move.name };
  if (!canLearnTM(mon.species, it.const, gd)) {
    return result(false, false, '_MonCannotLearnMachineMoveText', `${mon.nickname} is not compatible with ${move.name}.`, { vars, needs: 'target' });
  }
  if (knowsMove(mon, move.const)) {
    return result(false, false, '_AlreadyKnowsText', `${mon.nickname} knows ${move.name}!`, { vars, needs: 'target' });
  }
  if (mon.moves.length >= 4) {
    if (ctx.replaceSlot === undefined) {
      return result(false, false, '_TryingToLearnText', `${mon.nickname} is trying to learn ${move.name}!`, { vars, needs: 'replaceMove' });
    }
    if (ctx.replaceSlot === null || ctx.replaceSlot < 0) {
      return result(false, false, '_DidNotLearnText', `${mon.nickname} did not learn ${move.name}!`, { vars });
    }
  }
  const r = learnMove(mon, move.const, { replaceSlot: ctx.replaceSlot ?? undefined }, gd);
  if (r.result === 'cannotForgetHM') return result(false, false, '_HMCantDeleteText', "HM techniques can't be deleted!", { vars, needs: 'replaceMove' });
  if (r.result !== 'learned' && r.result !== 'replaced') return result(false, false, null, '', { vars, learn: r });
  return result(true, !it.hm, '_LearnedMove1Text', `${mon.nickname} learned ${move.name}!`, { vars, learn: r });
}

// ----------------------------------------------------------------------- escape rope / flute

function useEscapeRope(state, ctx, gd, { pseudo, itemName }) {
  if (!canEscapeRope(state, ctx, gd)) return notTime();
  // fly warp + escape warp to wLastBlackoutMap; leaving ends a Safari game
  if (state.flags) state.flags.clear('EVENT_IN_SAFARI_ZONE');
  if (state.safari) state.safari.balls = 0;
  if (state.currentMapScriptIndices) state.currentMapScriptIndices.SafariZoneGate = 0;
  if (state.statusFlags) state.statusFlags.clear('BIT_NO_BATTLES');
  const request = { kind: 'escapeRope', destination: state.lastBlackoutMap, viaDig: pseudo };
  return pseudo
    ? result(true, false, null, '', { request })
    : result(true, true, T.USED, `${state.playerName} used ${itemName}!`, { vars: { wStringBuffer: itemName }, request });
}

function usePokeFlute(state, ctx, gd) {
  if (ctx.inBattle) {
    const woke = [];
    state.party.forEach((m, i) => {
      if (m.status & STATUS_SLP_MASK) {
        woke.push(i);
        m.status &= ~STATUS_SLP_MASK & 0xff;
      }
    });
    // the battle engine also wakes both battle mons and, in trainer battles, the enemy party,
    // and shows "had effect" if ANY of them slept
    return result(true, false, woke.length ? ['_PlayedFluteHadEffectText', '_FluteWokeUpText'] : '_PlayedFluteNoEffectText',
      woke.length ? 'All sleeping POKéMON woke up.' : "Played the POKé FLUTE. Now, that's a catchy tune!",
      { wokeParty: woke, request: { kind: 'pokeFluteBattle' } });
  }
  const map = mapOf(state, ctx);
  const spot = SNORLAX_FLUTE_SPOTS[map];
  const pos = ctx.coords || state.pos || {};
  if (spot && !state.flags.get(spot.beaten) && spot.coords.some(([x, y]) => x === pos.x && y === pos.y)) {
    state.flags.set(spot.fight);
    return result(true, false, '_PlayedFluteHadEffectText', `${state.playerName} played the POKé FLUTE.`,
      { request: { kind: 'wakeSnorlax', map, event: spot.fight } });
  }
  return result(true, false, '_PlayedFluteNoEffectText', "Played the POKé FLUTE. Now, that's a catchy tune!");
}

// ------------------------------------------------------------------------------- field moves

/**
 * Field moves from the party menu (StartMenu_Pokemon): HM moves need their badge
 * ("No! A new BADGE is required."); FLY and TELEPORT only outside (OVERWORLD/PLATEAU tilesets);
 * DIG works like an Escape Rope (nothing used up); FLASH lights the map (mapPalOffset = 0);
 * STRENGTH sets BIT_STRENGTH_ACTIVE; SOFTBOILED → useSoftboiled.
 * @param {object} state
 * @param {string} move move const
 * @param {ItemContext & {user?:number}} [ctx] user = party index of the mon using the move
 * @returns {ItemResult}
 */
export function useFieldMove(state, move, ctx = {}, gd = getGameData()) {
  const m = gd.move(move).const;
  const user = ctx.user !== undefined ? state.party[ctx.user] : null;
  const vars = { wNameBuffer: user ? user.nickname : '' };
  const badge = FIELD_MOVE_BADGES[m];
  if (badge && !hasBadge(state, badge, gd)) return result(false, false, '_NewBadgeRequiredText', 'No! A new BADGE is required.');
  switch (m) {
    case 'CUT':
      return result(true, false, null, '', { vars, request: { kind: 'cut' } });
    case 'FLY':
      if (!isOutsideMap(state, ctx, gd)) return result(false, false, '_CannotFlyHereText', `${vars.wNameBuffer} can't FLY here.`, { vars });
      return result(true, false, null, '', { vars, request: { kind: 'fly', destinations: visitedFlyDestinations(state, gd) } });
    case 'SURF':
      return useSurfboard(state, ctx);
    case 'STRENGTH':
      if (state.statusFlags) state.statusFlags.set('BIT_STRENGTH_ACTIVE');
      return result(true, false, '_UsedStrengthText', `${vars.wNameBuffer} used STRENGTH.`, { vars, request: { kind: 'strength' } });
    case 'FLASH':
      state.mapPalOffset = 0;
      return result(true, false, '_FlashLightsAreaText', 'A blinding FLASH lights the area!', { request: { kind: 'flash' } });
    case 'DIG':
      return useEscapeRope(state, ctx, gd, { pseudo: true });
    case 'TELEPORT':
      if (!isOutsideMap(state, ctx, gd)) return result(false, false, '_CannotUseTeleportNowText', `${vars.wNameBuffer} can't use TELEPORT now.`, { vars });
      if (state.statusFlags) state.statusFlags.clear('BIT_NO_BATTLES');
      return result(true, false, '_WarpToLastPokemonCenterText', 'Return to the last POKéMON CENTER.',
        { request: { kind: 'teleport', destination: state.lastBlackoutMap } });
    case 'SOFTBOILED':
      if (ctx.target === undefined) return needs('target', '_PartyMenuItemUseText', 'Use on which POKéMON?');
      return useSoftboiled(state, ctx.user, ctx.target);
    default:
      throw new Error(`${m} is not a field move`);
  }
}

/** Fly destinations the player has visited, in the Town Map's fly order (FlyWarpDataPtr). */
export function visitedFlyDestinations(state, gd = getGameData()) {
  const out = [];
  for (const w of gd.mapsMeta.flyWarps) {
    const map = gd.findMap(w.map);
    if (map && map.id < gd.mapIndex.numCityMaps && (state.flyUnlocked & (1 << map.id))) out.push(w);
  }
  return out;
}

// ------------------------------------------------------------------------------------ fishing

/**
 * Roll a rod (ItemUseOldRod/GoodRod/SuperRod + ReadSuperRodData). Old Rod: always Magikarp L5.
 * Good/Super Rod: r = Random(); bit 0 → no bite; else slot = (r >> 1) & 3, rerolled while
 * slot >= count (Good Rod has 2 mons). Super Rod on a map without a group → nothing here.
 * @param {'old'|'good'|'super'} rod
 * @param {string} map map const
 * @returns {{bite:boolean, nothingHere?:boolean, species?:number, level?:number}}
 */
export function fish(rod, map, rng, gd = getGameData()) {
  const f = gd.fishing;
  if (rod === 'old') {
    const m = f.oldRod.mons[0];
    return { bite: true, species: m.species, level: m.level };
  }
  let mons;
  if (rod === 'good') mons = f.goodRod.mons;
  else {
    const g = gd.superRodGroup(map);
    if (!g) return { bite: false, nothingHere: true };
    mons = g.mons;
  }
  for (;;) {
    const r = rng.randByte() & 0xff;
    if (r & 1) return { bite: false };
    const slot = (r >> 1) & 3;
    if (slot < mons.length) return { bite: true, species: mons[slot].species, level: mons[slot].level };
  }
}
