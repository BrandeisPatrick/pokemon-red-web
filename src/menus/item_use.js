// UseItem from the ITEM menu (engine/items/item_effects.asm), split by where the game runs it:
//
//   * party-menu items (UsableItems_PartyMenu + TMs/HMs): flows that run inside a
//     PartyMenuScene — medicine (HP bar animation + message), vitamins, Rare Candy (level-up
//     stats box, new move, evolution), evolution stones, PP Up / Ethers / Elixers (move list),
//     TM/HM teaching (ABLE / NOT ABLE, compatibility, LearnMove prompts);
//   * the rest runs over the bag (texts) — see bag_menu.js.
//
// The game rules come from src/pokemon/items_effects.js useItem(); this file only adds the
// screens, texts, sounds and timings.

import { useItem } from '../pokemon/items_effects.js';
import { canLearnTM, knowsMove, itemEvolution } from '../pokemon/learnset.js';
import { PARTY_MENU, ITEM_MSG } from './party_menu.js';
import { learnMoveFlow, chooseMoveMenu } from './learn_move.js';
import { runEvolution } from './evolution.js';

/** Status-cure messages (they play SFX_HEAL_AILMENT and skip the HP bar). */
const CURE_TEXTS = new Set(['_AntidoteText', '_BurnHealText', '_IceHealText', '_AwakeningText', '_ParlyzHealText', '_FullHealText']);

/**
 * Which flow an item uses from the bag.
 * @returns {'party'|'tm'|'close'|'bicycle'|'other'}
 */
export function itemUseKind(gd, item) {
  const it = gd.item(item);
  if (it.const === 'BICYCLE') return 'bicycle';
  if (it.tm || it.hm) return 'tm';
  if (it.closesBagMenu) return 'close';
  if (it.opensPartyMenu) return 'party';
  return 'other';
}

/**
 * The party-menu half of UseItem for one item. Runs inside `p` (a PartyMenuScene).
 * @returns {Generator<any, {used:boolean, partyShown:boolean}>}
 */
export function* partyItemFlow(p, item) {
  const gd = p.gd;
  const it = gd.item(item);
  const kind = (it.effect && it.effect.kind) || 'none';
  switch (kind) {
    case 'heal': case 'revive': case 'cureStatus': return yield* medicineFlow(p, it);
    case 'vitamin': return yield* vitaminFlow(p, it);
    case 'rareCandy': return yield* rareCandyFlow(p, it);
    case 'evolutionStone': return yield* stoneFlow(p, it);
    case 'ppUp': case 'ppRestore': return yield* ppFlow(p, it);
    case 'teachMove': return yield* tmFlow(p, it);
    default: {
      // X items and anything else out of battle: "not the time", party menu never shown
      const r = useItem(p.state, it.const, {});
      if (r.text) yield* p.print(r.text, { subs: r.vars });
      return { used: false, partyShown: false };
    }
  }
}

/** ItemUseMedicine for HP / status / revive items. */
function* medicineFlow(p, it) {
  const state = p.state;
  if (!state.party.length) {
    yield* p.print([{ cmd: 'text', str: "You don't have" }, { cmd: 'line', str: 'any #MON!' }, { cmd: 'prompt' }]);
    return { used: false, partyShown: false };
  }
  yield* p.display(PARTY_MENU.USE_ITEM);
  const i = yield* p.choose();
  if (i < 0) return { used: false, partyShown: true };
  const mon = state.party[i];
  const before = mon.hp;
  const r = useItem(state, it.const, { target: i });
  if (!r.ok) {
    yield* p.print('_ItemUseNoEffectText');
    return { used: false, partyShown: true };
  }
  if (CURE_TEXTS.has(r.text)) {
    yield* p.sfxWait('SFX_HEAL_AILMENT');
  } else {
    p.sfx('SFX_HEAL_HP');
    yield* p.animateHP(i, before, mon.hp, mon.maxHP);
  }
  p.scr.clear();
  p.mode = PARTY_MENU.NORMAL;
  yield* p.redraw({ label: r.text, index: i, subs: r.vars });
  yield 50;
  yield* p.waitButton();
  return { used: true, partyShown: true };
}

/** .useVitamin (HP UP ... CALCIUM). */
function* vitaminFlow(p, it) {
  const state = p.state;
  yield* p.display(PARTY_MENU.USE_ITEM);
  const i = yield* p.choose();
  if (i < 0) return { used: false, partyShown: true };
  const r = useItem(state, it.const, { target: i });
  if (!r.ok) {
    yield* p.print('_VitaminNoEffectText', { subs: r.vars });
    return { used: false, partyShown: true };
  }
  p.sfx('SFX_HEAL_AILMENT');
  yield* p.print('_VitaminStatRoseText', { subs: r.vars });
  return { used: true, partyShown: true };
}

/** .useRareCandy: +1 level, "X grew to level N!", the stats box, new move, evolution. */
function* rareCandyFlow(p, it) {
  const state = p.state;
  yield* p.display(PARTY_MENU.USE_ITEM);
  const i = yield* p.choose();
  if (i < 0) return { used: false, partyShown: true };
  const mon = state.party[i];
  const name = mon.nickname;
  const from = mon.species;
  const r = useItem(state, it.const, { target: i });
  if (!r.ok) {
    yield* p.print('_VitaminNoEffectText', { subs: r.vars });
    return { used: false, partyShown: true };
  }
  p.mode = PARTY_MENU.NORMAL;
  yield* p.redraw({ label: ITEM_MSG.RARE_CANDY, index: i, subs: r.vars });
  p.levelUpStatsBox(r.levelUp.stats);
  yield* p.waitButton();
  if (r.moveToLearn) yield* learnMoveFlow(p, mon, r.moveToLearn);
  if (r.evolution) {
    yield* runEvolution(p, { mon, partyIndex: i, from, into: r.evolution.into, cancellable: true, applied: false, name });
  }
  return { used: true, partyShown: true };
}

/** ItemUseEvoStone. */
function* stoneFlow(p, it) {
  const state = p.state;
  yield* p.display(PARTY_MENU.EVO_STONE);
  const i = yield* p.choose();
  if (i < 0) return { used: false, partyShown: true };
  const mon = state.party[i];
  const evo = itemEvolution(mon, it.const, p.gd);
  yield* p.sfxWait('SFX_HEAL_AILMENT');
  if (!evo) {
    yield* p.print('_ItemUseNoEffectText');
    return { used: false, partyShown: true };
  }
  const from = mon.species, name = mon.nickname;
  useItem(state, it.const, { target: i });
  yield* runEvolution(p, { mon, partyIndex: i, from, into: evo.into, cancellable: false, applied: true, name });
  return { used: true, partyShown: true };
}

/** ItemUsePPUp / ItemUsePPRestore. */
function* ppFlow(p, it) {
  const state = p.state;
  const e = it.effect;
  for (;;) {
    // .chooseMon
    yield* p.display(PARTY_MENU.USE_ITEM);
    const i = yield* p.choose();
    if (i < 0) return { used: false, partyShown: true };
    const mon = state.party[i];
    if (e.kind === 'ppRestore' && e.scope === 'allMoves') {
      const r = useItem(state, it.const, { target: i });
      if (!r.ok) {
        yield* p.print('_ItemUseNoEffectText');
        return { used: false, partyShown: true };
      }
      p.sfx('SFX_HEAL_AILMENT');
      yield* p.print('_PPRestoredText');
      return { used: true, partyShown: true };
    }
    // .chooseMove
    for (;;) {
      yield* p.print(e.kind === 'ppUp' ? '_RaisePPWhichTechniqueText' : '_RestorePPWhichTechniqueText');
      const saved = p.scr.save();
      const slot = yield* chooseMoveMenu(p, mon);
      p.scr.restore(saved);
      if (slot < 0) break; // back to .chooseMon
      const r = useItem(state, it.const, { target: i, moveIndex: slot });
      if (e.kind === 'ppUp') {
        if (!r.ok) {
          yield* p.print('_PPMaxedOutText', { subs: r.vars });
          continue;
        }
        yield* p.print('_PPIncreasedText', { subs: r.vars });
        return { used: true, partyShown: true };
      }
      if (!r.ok) {
        yield* p.print('_ItemUseNoEffectText');
        return { used: false, partyShown: true };
      }
      p.sfx('SFX_HEAL_AILMENT');
      yield* p.print('_PPRestoredText');
      return { used: true, partyShown: true };
    }
  }
}

/** ItemUseTMHM after the YES: pick a mon (ABLE / NOT ABLE), check, LearnMove. */
function* tmFlow(p, it) {
  const state = p.state;
  const gd = p.gd;
  const move = gd.move(it.move);
  for (;;) {
    yield* p.display(PARTY_MENU.USE_TM);
    const i = yield* p.choose();
    if (i < 0) return { used: false, partyShown: true };
    const mon = state.party[i];
    const vars = { wNameBuffer: mon.nickname, wStringBuffer: move.name };
    if (!canLearnTM(mon.species, it.const, gd)) {
      yield* p.sfxWait('SFX_DENIED');
      yield* p.print('_MonCannotLearnMachineMoveText', { subs: vars });
      continue;
    }
    if (knowsMove(mon, move.const)) {
      yield* p.print('_AlreadyKnowsText', { subs: vars });
      continue;
    }
    const learned = yield* learnMoveFlow(p, mon, move.const);
    if (learned && !it.hm) state.bag.remove(it.const, 1, gd);
    return { used: learned, partyShown: true };
  }
}
