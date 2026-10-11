// Trainer parties (ReadTrainer, engine/battle/read_trainer_party.asm), prize money, the rival's
// starter-dependent teams and the trainer-AI tables for the battle engine.

import { getGameData } from './data.js';
import { makeTrainerMon } from './mon.js';
import { defaultMoveset } from './learnset.js';

/** wCurOpponent of trainer class id n is 200 + n (OPP_ID_OFFSET). */
export const OPP_ID_OFFSET = 200;

/** Starters (constants/pokemon_constants.asm): STARTER1 Charmander, STARTER2 Squirtle, STARTER3 Bulbasaur. */
export const STARTERS = Object.freeze({ STARTER1: 'CHARMANDER', STARTER2: 'SQUIRTLE', STARTER3: 'BULBASAUR' });

/**
 * The rival takes the starter strong against yours (OaksLab*PokeBallText):
 * Charmander → Squirtle, Squirtle → Bulbasaur, Bulbasaur → Charmander.
 */
export const RIVAL_STARTER_FOR = Object.freeze({ CHARMANDER: 'SQUIRTLE', SQUIRTLE: 'BULBASAUR', BULBASAUR: 'CHARMANDER' });

/**
 * Rival battles started by map scripts: class + party number for each rival starter
 * (OaksLab, Route22 Route22Rival1/2 tables, CeruleanCity, SSAnne2F, PokemonTower2F, SilphCo7F,
 * ChampionsRoom).
 */
export const RIVAL_BATTLES = Object.freeze({
  OAKS_LAB: { class: 'RIVAL1', parties: { SQUIRTLE: 1, BULBASAUR: 2, CHARMANDER: 3 } },
  ROUTE_22_1: { class: 'RIVAL1', parties: { SQUIRTLE: 4, BULBASAUR: 5, CHARMANDER: 6 } },
  CERULEAN_CITY: { class: 'RIVAL1', parties: { SQUIRTLE: 7, BULBASAUR: 8, CHARMANDER: 9 } },
  SS_ANNE: { class: 'RIVAL2', parties: { SQUIRTLE: 1, BULBASAUR: 2, CHARMANDER: 3 } },
  POKEMON_TOWER: { class: 'RIVAL2', parties: { SQUIRTLE: 4, BULBASAUR: 5, CHARMANDER: 6 } },
  SILPH_CO: { class: 'RIVAL2', parties: { SQUIRTLE: 7, BULBASAUR: 8, CHARMANDER: 9 } },
  ROUTE_22_2: { class: 'RIVAL2', parties: { SQUIRTLE: 10, BULBASAUR: 11, CHARMANDER: 12 } },
  CHAMPION: { class: 'RIVAL3', parties: { SQUIRTLE: 1, BULBASAUR: 2, CHARMANDER: 3 } },
});

/** Rival's starter (species const) for the player's starter (any species ref). */
export function rivalStarterFor(playerStarter, gd = getGameData()) {
  const c = gd.species(playerStarter).const;
  const r = RIVAL_STARTER_FOR[c];
  if (!r) throw new Error(`${c} is not a starter`);
  return r;
}

/**
 * Class and party number of a scripted rival battle.
 * @param {keyof typeof RIVAL_BATTLES} battle
 * @param {any} rivalStarter the rival's starter (state.rivalStarter)
 * @returns {{classConst:string, partyIndex:number}}
 */
export function rivalParty(battle, rivalStarter, gd = getGameData()) {
  const b = RIVAL_BATTLES[battle];
  if (!b) throw new Error(`unknown rival battle ${battle}`);
  const c = gd.species(rivalStarter).const;
  const partyIndex = b.parties[c];
  if (!partyIndex) throw new Error(`${c} is not a rival starter`);
  return { classConst: b.class, partyIndex };
}

/** Prize money: baseMoney × level of the LAST party mon (ReadTrainer adds the BCD per level). */
export function prizeMoney(classConst, lastLevel, gd = getGameData()) {
  return Math.min(999999, gd.trainerClass(classConst).baseMoney * lastLevel);
}

/**
 * Trainer AI data for the battle engine: the class routine interpreted as steps
 * (trainer_classes.json ai.behavior), uses per mon, the AIEnemyTrainerChooseMoves layers, and
 * the shared tables of data/battle/trainer_ai.json.
 */
export function trainerAI(classConst, gd = getGameData()) {
  const c = gd.trainerClass(classConst);
  return {
    routine: c.ai.routine,
    usesPerMon: c.ai.usesPerMon,
    behavior: c.ai.behavior,
    moveChoiceLayers: c.moveChoiceLayers,
    layerDescriptions: gd.trainers.aiMoveChoiceLayers,
    statusAilmentMoveEffects: gd.battle.trainerAi.statusAilmentMoveEffects,
    layer2PreferredEffects: gd.battle.trainerAi.layer2PreferredEffects,
    typeEffectivenessDefault: gd.battle.trainerAi.typeEffectivenessDefault,
  };
}

/**
 * Build an enemy trainer party like ReadTrainer: every mon gets the fixed trainer DVs, the
 * WriteMonMoves default moveset for its level, then the party's special moves (gym leaders'
 * LoneMoves, Elite Four TeamMoves, the champion's Sky Attack + starter move — move slot 3 =
 * index 2). Stats without stat exp, full HP. Prize = baseMoney × level of the last mon.
 * @param {string} classConst e.g. "BROCK" or "OPP_BROCK"
 * @param {number} partyIndex 1-based party number (wTrainerNo / map object argument)
 * @param {{applySpecialMoves?:boolean}} [o] special moves are part of the data's parties; pass
 *   false to get the raw default movesets (e.g. Giovanni's gym team outside the gym script)
 * @returns {{trainerClass:object, classConst:string, partyIndex:number, name:string,
 *   location:string|null, mons:import('./mon.js').Mon[], prizeMoney:number,
 *   ai:ReturnType<typeof trainerAI>, specialMoves:object[]}}
 */
export function buildTrainerParty(classConst, partyIndex, { applySpecialMoves = true } = {}, gd = getGameData()) {
  const cls = gd.trainerClass(classConst);
  const data = gd.trainerPartyData(cls.const, partyIndex);
  const mons = data.pokemon.map((p) => makeTrainerMon({ species: p.species, level: p.level, moves: defaultMoveset(p.species, p.level, gd) }, gd));
  const special = applySpecialMoves ? data.specialMoves || [] : [];
  for (const sm of special) {
    const mon = mons[sm.partySlot - 1];
    if (!mon) continue;
    const moveData = gd.move(sm.move);
    const slot = { move: moveData.const, pp: moveData.pp, ppUps: 0 };
    const i = sm.moveSlot - 1;
    // ReadTrainer writes the move byte into slot 3 whatever is there; LoadEnemyMonData later
    // reloads PP from the moves, so the PP is always the new move's.
    while (mon.moves.length < i) mon.moves.push(null);
    mon.moves[i] = slot;
    mon.moves = mon.moves.filter(Boolean);
  }
  const last = data.pokemon[data.pokemon.length - 1];
  return {
    trainerClass: cls,
    classConst: cls.const,
    partyIndex,
    name: cls.name,
    location: data.location,
    mons,
    prizeMoney: prizeMoney(cls.const, last.level, gd),
    ai: trainerAI(cls.const, gd),
    specialMoves: special,
  };
}
