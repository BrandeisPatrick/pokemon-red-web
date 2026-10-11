import { GYM_NAMES } from "./special_data.js";
// Generic hidden-event routines (engine/events/hidden_events/*.asm, engine/events/
// hidden_items.asm): the ones that only print a text predef, check the facing, the badges or
// the hidden-item flags. Story / UI routines (PCs, slot machines, gym trash cans, the
// Cinnabar quiz, Mansion switches, cable club ...) go to the map script's onHiddenObject or
// hooks.onHiddenObject. Returns null for routines that are not generic.

const FACING = { SPRITE_FACING_DOWN: 'down', SPRITE_FACING_UP: 'up', SPRITE_FACING_LEFT: 'left', SPRITE_FACING_RIGHT: 'right' };

/** Routine -> [required facing or null, text predef label]. */
const SIMPLE_TEXT = {
  PrintBookcaseText: [null, 'BookcaseText'],
  PrintMagazinesText: [null, 'MagazinesText'],
  PrintRedSNESText: [null, 'RedBedroomSNESText'],
  DisplayOakLabEmailText: ['up', 'OakLabEmailText'],
  DisplayOakLabLeftPoster: [null, 'PushStartText'],
  PrintFightingDojoText: [null, 'FightingDojoText'],
  PrintFightingDojoText2: [null, 'EnemiesOnEverySideText'],
  PrintFightingDojoText3: [null, 'WhatGoesAroundComesAroundText'],
  PrintIndigoPlateauHQText: ['up', 'IndigoPlateauHQText'],
  PrintNewBikeText: [null, 'NewBicycleText'],
  PrintTrashText: [null, 'VermilionGymTrashText'],
  AerodactylFossil: [null, 'AerodactylFossilText'],
  KabutopsFossil: [null, 'KabutopsFossilText'],
};

/**
 * @param {any} ov OverworldScene
 * @param {any} h entry of map.hiddenObjects
 * @returns {Generator|null}
 */
export function genericHiddenEventGen(ov, h) {
  const simple = SIMPLE_TEXT[h.routine];
  if (simple) return simpleTextGen(ov, simple[0], simple[1]);
  switch (h.routine) {
    case 'HiddenItems': return hiddenItemGen(ov, h);
    case 'HiddenCoins': return hiddenCoinsGen(ov, h);
    case 'PrintBenchGuyText': return benchGuyGen(ov);
    case 'GymStatues': return gymStatueGen(ov);
    case 'DisplayOakLabRightPoster': return oakRightPosterGen(ov);
    case 'PrintBlackboardLinkCableText':
    case 'PrintNotebookText':
      return h.textPredef ? predefGen(ov, h.textPredef, true) : null;
    default: return null;
  }
}

function* simpleTextGen(ov, facing, label) {
  if (facing && ov.player.facing !== facing) return;
  yield* ov.textGen(label);
}

function* predefGen(ov, label, holdOnly) {
  yield* ov.textGen(label, holdOnly ? { holdOnly: true } : {});
}

/** HiddenItems: "{PLAYER} found X!" once (state.hiddenItems key 'item:<flagIndex>'). */
function* hiddenItemGen(ov, h) {
  const key = `item:${h.flagIndex}`;
  if (ov.state.hiddenItems.has(key)) return;
  const name = ov.data.itemName(h.item);
  yield* ov.textGen([{ cmd: 'text_far', label: '_FoundHiddenItemText' }, { cmd: 'text_end' }],
    { subs: { wNameBuffer: name }, wait: false, close: false });
  let given = ov.callGameHook('giveItem', [h.item, 1], true);
  if (given && typeof given.then === 'function') given = yield given;
  if (given) {
    ov.state.hiddenItems.add(key);
    ov.emit('hiddenItem', { item: h.item, key });
    const r = ov.playSfx('SFX_GET_ITEM_2');
    if (r && typeof r.then === 'function') yield r.catch(() => {});
    while (ov.input.held.a) yield 1; // HoldTextDisplayOpen
    ov.textBox.close();
  } else {
    yield* ov.textBox.waitForButton();
    yield* ov.textGen([{ cmd: 'text_far', label: '_HiddenItemBagFullText' }, { cmd: 'text_end' }]);
  }
}

/** HiddenCoins: needs the COIN CASE (hooks.hasItem); 'COIN + 40' gives 20 (pokered typo). */
function* hiddenCoinsGen(ov, h) {
  if (!ov.callGameHook('hasItem', ['COIN_CASE'], false)) return;
  const key = `coin:${h.flagIndex}`; // src/game/flags.js hiddenItemKey('coin', n)
  if (ov.state.hiddenItems.has(key)) return;
  const amount = h.coins === 40 ? 20 : h.coins;
  const room = ov.callGameHook('giveCoins', [amount], true);
  ov.state.hiddenItems.add(key);
  yield* ov.textGen(room === false ? 'DroppedHiddenCoinsText' : 'FoundHiddenCoinsText',
    { subs: { wStringBuffer: String(amount) } });
}

/** PrintBenchGuyText: the map's bench guy text when facing the stored direction. */
function* benchGuyGen(ov) {
  const g = ov.data.meta.benchGuys.find((b) => b.map === ov.map.json.const);
  if (!g || FACING[g.facing] !== ov.player.facing) return;
  yield* ov.textGen(g.text);
}

/** GymStatues: facing up; the badge of this gym decides the text. */
function* gymStatueGen(ov) {
  if (ov.player.facing !== 'up') return;
  const m = ov.data.meta.badgeMaps.find((b) => b.map === ov.map.json.const);
  if (!m) return;
  const have = ((ov.state.badges || 0) & m.badgeMask) === m.badgeMask;
  yield* ov.textGen(have ? 'GymStatueText2' : 'GymStatueText1', { subs: gymSubs(ov) });
}

function gymSubs(ov) {
  return GYM_NAMES[ov.map.json.const] || {};
}

/** DisplayOakLabRightPoster: depends on the number of owned Pokémon (hooks.getPokedexOwnedCount). */
function* oakRightPosterGen(ov) {
  const owned = ov.callGameHook('getPokedexOwnedCount', [], 0);
  yield* ov.textGen(owned >= 2 ? 'StrengthsAndWeaknessesText' : 'SaveOptionText');
}
