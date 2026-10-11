// A rich fake save for menus-test.html and tests/menus: a party of 6 showing every printed
// status (PSN, PAR, SLP, FRZ, BRN, FNT) with field moves (CUT, FLY, SURF, STRENGTH, FLASH,
// TELEPORT, SOFTBOILED, DIG), a full bag (medicine, candy, stones, PP items, TMs, an HM, key
// items), PC items, boxes (one full), badges, Pokédex entries, visited towns, play time and a
// Hall of Fame team.

import { GameState } from '../game/state.js';
import { makeMon } from '../pokemon/mon.js';
import { Rng } from '../engine/rng.js';
import { statusFromCode } from '../pokemon/status.js';

const OT = 'RED';
const OT_ID = 25000;

function mon(gd, rng, species, level, o = {}) {
  const m = makeMon({ species, level, otName: OT, otId: OT_ID, rng, moves: o.moves, nickname: o.nickname }, gd);
  if (o.status) m.status = statusFromCode(o.status, 3);
  if (o.hp !== undefined) m.hp = o.hp === 'half' ? Math.floor(m.stats.hp / 2) : o.hp === 'low' ? Math.max(1, Math.floor(m.stats.hp / 6)) : o.hp;
  if (o.pp) m.moves.forEach((s, i) => { if (o.pp[i] !== undefined) s.pp = o.pp[i]; });
  return m;
}

/**
 * @param {import('../pokemon/data.js').GameData} gd
 * @param {{seed?:number}} [o]
 * @returns {GameState}
 */
export function makeDemoState(gd, { seed = 1996 } = {}) {
  const rng = new Rng(seed);
  const party = [
    mon(gd, rng, 'CHARIZARD', 50, { moves: ['SLASH', 'FLY', 'CUT', 'FLAMETHROWER'], status: 'PSN', hp: 'half' }),
    mon(gd, rng, 'PIKACHU', 25, { moves: ['THUNDERSHOCK', 'FLASH', 'QUICK_ATTACK', 'THUNDER_WAVE'], status: 'PAR', hp: 'low', nickname: 'SPARKY' }),
    mon(gd, rng, 'LAPRAS', 30, { moves: ['SURF', 'STRENGTH', 'ICE_BEAM', 'BODY_SLAM'], status: 'SLP' }),
    mon(gd, rng, 'ALAKAZAM', 40, { moves: ['TELEPORT', 'PSYCHIC_M', 'RECOVER', 'REFLECT'], status: 'FRZ', pp: [3, 0, 5] }),
    mon(gd, rng, 'CHANSEY', 38, { moves: ['SOFTBOILED', 'DOUBLESLAP', 'MINIMIZE'], status: 'BRN' }),
    mon(gd, rng, 'DUGTRIO', 31, { moves: ['DIG', 'SLASH', 'SAND_ATTACK'], hp: 0 }),
  ];
  const box1 = [
    mon(gd, rng, 'BULBASAUR', 8),
    mon(gd, rng, 'MEW', 5, { nickname: 'MEW' }),
    mon(gd, rng, 'ONIX', 14, { status: 'PSN' }),
    mon(gd, rng, 'EEVEE', 25),
    mon(gd, rng, 'NIDORINO', 22, { nickname: 'NIDO' }),
    mon(gd, rng, 'ODDISH', 12),
  ];
  const box2 = [];
  for (let i = 0; i < 20; i++) box2.push(mon(gd, rng, ['RATTATA', 'PIDGEY', 'ZUBAT', 'GEODUDE'][i % 4], 3 + i));
  const pcBoxes = Array.from({ length: 12 }, () => []);
  pcBoxes[0] = box1.map((m) => ({ ...m.toJSON(), stats: null }));
  pcBoxes[1] = box2.map((m) => ({ ...m.toJSON(), stats: null }));

  const bag = [
    ['POTION', 5], ['SUPER_POTION', 3], ['FULL_RESTORE', 2], ['REVIVE', 1], ['ANTIDOTE', 2],
    ['RARE_CANDY', 10], ['FIRE_STONE', 1], ['THUNDER_STONE', 1], ['PP_UP', 2], ['ETHER', 3],
    ['ESCAPE_ROPE', 4], ['REPEL', 6], ['TM_MEGA_PUNCH', 1], ['TM_THUNDERBOLT', 2], ['HM_SURF', 1],
    ['BICYCLE', 1], ['TOWN_MAP', 1], ['COIN_CASE', 1], ['OLD_ROD', 1], ['POKE_FLUTE', 1],
  ].map(([item, qty]) => ({ item, qty }));
  const pcItems = [['POTION', 1], ['NUGGET', 3], ['MAX_REVIVE', 2], ['HP_UP', 4], ['ITEMFINDER', 1]]
    .map(([item, qty]) => ({ item, qty }));

  const seen = [];
  const owned = [];
  for (let d = 1; d <= 151; d++) {
    if (d <= 40 || [52, 54, 63, 65, 74, 95, 113, 131, 133, 143, 147, 150, 151].includes(d)) owned.push(d);
    if (d <= 70 || d % 3 === 0) seen.push(d);
  }
  for (const m of [...party, ...box1, ...box2]) { if (!owned.includes(m.species)) owned.push(m.species); }

  const state = new GameState({
    playerName: 'RED', rivalName: 'BLUE', playerId: OT_ID,
    money: 123456, coins: 777,
    badges: 0xff,
    party: party.map((m) => m.toJSON()),
    pcBoxes, currentBox: 0, boxesChanged: true,
    pokedex: { seen: [...new Set([...seen, ...owned])].sort((a, b) => a - b), owned: owned.sort((a, b) => a - b) },
    bag, pcItems,
    pos: { map: 'CELADON_CITY', x: 20, y: 18, facing: 'down' },
    lastBlackoutMap: 'CELADON_CITY',
    flyUnlocked: 0b11111101111, // every town but LAVENDER_TOWN (bit 4)
    playTime: ((12 * 60 + 34) * 60 + 56) * 60,
    hallOfFame: [party.slice(0, 3).map((m) => ({ species: m.species, level: m.level, nickname: m.nickname }))],
    hallOfFameCount: 1,
  }, gd);
  for (const f of ['EVENT_GOT_POKEDEX', 'EVENT_MET_BILL', 'EVENT_GOT_TOWN_MAP']) {
    try { state.flags.set(f); } catch { /* unknown flag in this data version */ }
  }
  return state;
}
