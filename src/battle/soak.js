// Headless soak runner: random parties, bags and battle kinds played by RandomController
// through the real engine (HeadlessUI). Used by battle-test.html ("Soak") and the node tests.
//
//   const report = soakBattles({ n: 300, seed: 1234, texts });
//   report.errors -> [{ index, seed, message, stack, setup }]

import { Rng } from '../engine/rng.js';
import { GameState } from '../game/state.js';
import { makeMon } from '../pokemon/mon.js';
import { getGameData } from '../pokemon/data.js';
import { Battle } from './core.js';
import { HeadlessUI, RandomController } from './headless_ui.js';
import { SLP_MASK, PSN, BRN, FRZ, PAR } from './constants.js';

/** Items a random bag draws from (battle items, medicine, and things that can't be used). */
export const SOAK_ITEMS = Object.freeze([
  'POKE_BALL', 'GREAT_BALL', 'ULTRA_BALL', 'MASTER_BALL', 'POTION', 'SUPER_POTION', 'HYPER_POTION',
  'MAX_POTION', 'FULL_RESTORE', 'REVIVE', 'MAX_REVIVE', 'ANTIDOTE', 'BURN_HEAL', 'ICE_HEAL',
  'AWAKENING', 'PARLYZ_HEAL', 'FULL_HEAL', 'FRESH_WATER', 'SODA_POP', 'LEMONADE', 'ETHER',
  'MAX_ETHER', 'ELIXER', 'MAX_ELIXER', 'X_ATTACK', 'X_DEFEND', 'X_SPEED', 'X_SPECIAL',
  'X_ACCURACY', 'GUARD_SPEC', 'DIRE_HIT', 'POKE_DOLL', 'POKE_FLUTE', 'ESCAPE_ROPE', 'REPEL',
  'RARE_CANDY', 'MOON_STONE', 'BICYCLE', 'TOWN_MAP', 'HP_UP', 'PP_UP', 'NUGGET', 'TM01', 'HM01',
  'OAKS_PARCEL', 'SILPH_SCOPE', 'EXP_ALL', 'OLD_ROD',
]);

const WILD_MAPS = Object.freeze(['ROUTE_1', 'VIRIDIAN_FOREST', 'MT_MOON_1F', 'ROCK_TUNNEL_1F', 'POKEMON_TOWER_3F', 'SEAFOAM_ISLANDS_1F', 'ROUTE_22']);

/** A random party mon (random species/level/moves; sometimes hurt, statused or out of PP). */
export function randomMon(rng, gd = getGameData(), { minLevel = 2, maxLevel = 70, otId = 12345, allMoves = false } = {}) {
  const species = 1 + rng.randInt(151);
  const level = minLevel + rng.randInt(maxLevel - minLevel + 1);
  let moves;
  if (allMoves || rng.randInt(100) < 45) {
    const n = 1 + rng.randInt(4);
    const set = new Set();
    while (set.size < n) set.add(gd.move(1 + rng.randInt(165)).const);
    moves = [...set];
  }
  const traded = rng.randInt(100) < 15;
  const mon = makeMon({
    species, level, otName: traded ? 'TRADER' : 'RED', otId: traded ? (otId + 1 + rng.randInt(1000)) & 0xffff : otId,
    dvs: { atk: rng.randInt(16), def: rng.randInt(16), spd: rng.randInt(16), spc: rng.randInt(16) }, moves,
  }, gd);
  if (rng.randInt(100) < 30) mon.hp = 1 + rng.randInt(mon.stats.hp);
  const st = rng.randInt(100);
  if (st < 4) mon.status = 1 + rng.randInt(7);
  else if (st < 7) mon.status = PSN;
  else if (st < 9) mon.status = BRN;
  else if (st < 11) mon.status = FRZ;
  else if (st < 14) mon.status = PAR;
  if (rng.randInt(100) < 10) for (const m of mon.moves) m.pp = rng.randInt(m.pp + 1);
  if (rng.randInt(100) < 10) for (const m of mon.moves) m.ppUps = rng.randInt(4);
  if (rng.randInt(100) < 20) {
    for (const k of Object.keys(mon.statExp)) mon.statExp[k] = rng.randInt(65536);
  }
  return mon;
}

/**
 * A random battle: {state, params, label}.
 * @param {Rng} rng
 */
export function randomBattleSetup(rng, gd = getGameData()) {
  const state = new GameState({
    playerName: 'RED', rivalName: 'BLUE', playerId: 12345, money: rng.randInt(100000), badges: rng.randInt(256),
    options: { battleAnimations: rng.randInt(2) === 0, battleStyle: rng.randInt(3) ? 'shift' : 'set', textSpeed: 'fast' },
  }, gd);
  const n = 1 + rng.randInt(6);
  const party = [];
  for (let i = 0; i < n; i++) party.push(randomMon(rng, gd));
  if (rng.randInt(100) < 25) for (const m of party) if (rng.randInt(3) === 0) m.hp = 0;
  if (!party.some((m) => m.hp > 0)) party[0].hp = party[0].stats.hp;
  state.party = party;
  const kinds = rng.randInt(20);
  for (let i = 0, k = rng.randInt(8); i < k; i++) {
    state.bag.add(SOAK_ITEMS[rng.randInt(SOAK_ITEMS.length)], 1 + rng.randInt(5), gd);
  }
  if (rng.randInt(100) < 20 && state.pcBoxes) {
    // a full box makes the ball throw refuse when the party is also full
    const box = state.pcBoxes[state.currentBox];
    while (box.length < 20) { const m = randomMon(rng, gd); m.stats = null; box.push(m); }
  }
  for (let d = 1; d <= 151; d++) if (rng.randInt(100) < 30) state.pokedex.setOwned(d);
  let params;
  let label;
  if (kinds < 9) {
    const sp = gd.species(1 + rng.randInt(151));
    params = { kind: 'wild', species: sp.dex, level: 2 + rng.randInt(60), map: WILD_MAPS[rng.randInt(WILD_MAPS.length)], fishing: rng.randInt(10) === 0 };
    state.pos.map = params.map;
    label = `wild ${sp.name} L${params.level} @${params.map}`;
  } else if (kinds < 16) {
    const classes = gd.trainerClasses.filter((c) => c.partyCount > 0);
    const cls = classes[rng.randInt(classes.length)];
    params = { kind: 'trainer', trainerClass: cls.const, partyIndex: 1 + rng.randInt(cls.partyCount), map: 'ROUTE_3' };
    if (cls.gymBattleMusic && rng.randInt(2)) params.gymLeader = 1;
    label = `trainer ${cls.const} #${params.partyIndex}`;
  } else if (kinds < 18) {
    const sp = gd.species(1 + rng.randInt(151));
    params = { kind: 'safari', species: sp.dex, level: 15 + rng.randInt(30), map: 'SAFARI_ZONE_CENTER' };
    state.safari.balls = 1 + rng.randInt(30);
    label = `safari ${sp.name}`;
  } else if (kinds < 19) {
    params = { kind: 'oldman', species: 'WEEDLE', level: 5, map: 'VIRIDIAN_CITY' };
    label = 'old man';
  } else {
    params = { kind: 'ghost', species: 'MAROWAK', level: 30, restlessSoul: true, map: 'POKEMON_TOWER_6F' };
    if (rng.randInt(2)) state.bag.add('SILPH_SCOPE', 1, gd);
    label = `ghost marowak${state.bag.has('SILPH_SCOPE') ? ' (scope)' : ''}`;
  }
  return { state, params, label };
}

/**
 * Run `n` random battles. Each battle i uses seed `seed + i` for the setup, the battle RNG and
 * the controller, so any failure is reproducible with runSoakBattle(seed + i).
 * @returns {{runs:number, errors:object[], stalls:object[], outcomes:Record<string, number>, turns:number, ms:number}}
 */
export function soakBattles({ n = 300, seed = 1, texts = null, gd = getGameData(), maxTurns = 1500, onBattle = null } = {}) {
  const t0 = Date.now();
  const report = { runs: 0, errors: [], stalls: [], outcomes: {}, kinds: {}, turns: 0, ms: 0 };
  for (let i = 0; i < n; i++) {
    const s = (seed + i) >>> 0;
    const r = runSoakBattle(s, { texts, gd, maxTurns });
    report.runs++;
    if (r.error) report.errors.push({ index: i, seed: s, message: r.error.message, stack: r.error.stack, label: r.label, lastMessages: r.lastMessages });
    else if (r.stalled) report.stalls.push({ index: i, seed: s, label: r.label, turns: r.turns });
    else {
      report.outcomes[r.result.outcome] = (report.outcomes[r.result.outcome] || 0) + 1;
      report.turns += r.result.turns;
    }
    report.kinds[r.kind] = (report.kinds[r.kind] || 0) + 1;
    if (onBattle) onBattle(i, r);
  }
  report.ms = Date.now() - t0;
  return report;
}

/** One soak battle from its seed. */
export function runSoakBattle(seed, { texts = null, gd = getGameData(), maxTurns = 1500, verbose = false } = {}) {
  const setupRng = new Rng(seed);
  const { state, params, label } = randomBattleSetup(setupRng, gd);
  const ui = new HeadlessUI({ controller: new RandomController(new Rng(seed ^ 0x5a5a5a)), text: texts, verbose });
  let battle = null;
  try {
    battle = new Battle({ state, params, rng: new Rng(seed * 31 + 7), ui, text: texts || undefined, gd });
    ui.attach(battle);
    const gen = battle.run();
    let step = gen.next();
    let steps = 0;
    while (!step.done) {
      if (battle.turnCount > maxTurns || ++steps > 5e6) {
        gen.return();
        return { seed, label, kind: params.kind, stalled: true, turns: battle.turnCount, battle, ui };
      }
      step = gen.next();
    }
    checkInvariants(state, gd);
    return { seed, label, kind: params.kind, result: step.value, battle, ui };
  } catch (error) {
    return { seed, label, kind: params.kind, error, battle, ui, lastMessages: ui.messages.slice(-8) };
  }
}

/** Party state after a battle must still be a valid save. */
function checkInvariants(state, gd) {
  if (state.party.length > 6) throw new Error(`party has ${state.party.length} mons`);
  for (const m of state.party) {
    gd.species(m.species);
    if (!(m.level >= 1 && m.level <= 100)) throw new Error(`bad level ${m.level}`);
    if (!(m.hp >= 0 && m.hp <= 0xffff)) throw new Error(`bad hp ${m.hp}`);
    if (!m.moves.length || m.moves.length > 4) throw new Error(`bad moves ${m.moves.length}`);
    for (const mv of m.moves) {
      gd.move(mv.move);
      if (!(mv.pp >= 0 && mv.pp <= 63)) throw new Error(`bad pp ${mv.pp}`);
    }
    if (m.status & ~0xff) throw new Error(`bad status ${m.status}`);
    if (m.status & SLP_MASK && m.status & ~SLP_MASK) throw new Error(`sleep + other status ${m.status}`);
  }
}
