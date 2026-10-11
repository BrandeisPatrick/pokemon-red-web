// A-button interactions and the default behaviours behind them (docs/data-format-maps.md §9,
// §14, §19): hidden objects, bookshelves, card-key doors, signs, NPCs (also across counters),
// trainers (TalkToTrainer / EndTrainerBattle), item balls (PickUpItem), built-in text
// scripts, text_asm dispatch, Strength boulders and Cut. Functions take the OverworldScene.

import { DIR_DELTA, RIVAL_CLASSES, TILE, MODE } from './constants.js';
import { bookshelfAt, isCounterTile, isWalkable, isPairBlocked, isCuttable, cutBlockSwap } from './collision.js';
import { MOVE_STAY } from './npc.js';
import { genericHiddenEventGen } from './hidden_events.js';

function isIter(v) { return v && typeof v.next === 'function'; }
function isThen(v) { return v && typeof v.then === 'function'; }

/**
 * IsSpriteInFrontOfPlayer2: the first visible NPC whose cell box is exactly `dist` pixels in
 * front of the player (16, or 32 over a counter). Sets wPlayerDirection and, when `setFace`,
 * BIT_FACE_PLAYER on that NPC (it turns towards the player on its next update).
 */
export function spriteInFront(ov, dist, setFace = true) {
  const p = ov.player;
  const [dx, dy] = DIR_DELTA[p.facing];
  const tx = p.px + dx * dist, ty = p.py + dy * dist;
  p.direction = p.facing;
  for (const n of ov.npcs) {
    if (!n.visible) continue;
    if (n.px === tx && n.py === ty) {
      if (setFace) n.facePlayerPending = true;
      return n;
    }
  }
  return null;
}

/** CheckForHiddenEvent: the first hidden object on the step in front (any facing). */
export function hiddenObjectInFront(ov) {
  const f = ov.frontCell();
  return (ov.map.json.hiddenObjects || []).find((h) => h.x === f.x && h.y === f.y) || null;
}

/** IsSpriteOrSignInFrontOfPlayer (signs part): index into bgEvents, or -1. */
export function signInFront(ov) {
  const f = ov.frontCell();
  return (ov.map.json.bgEvents || []).findIndex((b) => b.x === f.x && b.y === f.y);
}

/**
 * OverworldLoop's A-button branch (the player is not being moved by the game): hidden
 * objects, bookshelves, card-key doors, then signs / NPCs. Starts the matching blocking
 * coroutine. @returns {boolean} something was found
 */
export function aButton(ov) {
  const p = ov.player;
  // 1. hidden objects (the routine decides; signs/NPCs are not checked afterwards)
  const h = hiddenObjectInFront(ov);
  if (h) {
    ov.emit('hidden', { routine: h.routine, x: h.x, y: h.y });
    ov.runScript(hiddenEventGen(ov, h));
    return true;
  }
  // 2. bookshelves: facing up, tile in front listed for the tileset
  if (p.facing === 'up') {
    const b = bookshelfAt(ov.map.tileset, ov.frontTile());
    if (b) {
      ov.emit('bookshelf', { text: b.text });
      ov.runScript(frozen(ov, ov.textGen(b.text)));
      return true;
    }
  }
  // 3. card-key doors (Silph Co.): prints, then the sign/NPC check still runs
  cardKeyDoor(ov);
  // 4. signs, then NPCs (two steps away over a counter tile)
  const si = signInFront(ov);
  if (si >= 0) {
    ov.updateSprites();
    if (p.turning) return true;
    const sign = ov.map.json.bgEvents[si];
    ov.emit('sign', { index: si, textIndex: sign.textIndex });
    ov.runScript(signGen(ov, si, sign));
    return true;
  }
  const counter = isCounterTile(ov.map.tileset, ov.frontTile());
  const npc = spriteInFront(ov, counter ? 32 : 16, true);
  if (!npc) return false;
  // .displayDialogue: UpdateSprites (the NPC turns), then DisplayTextID
  ov.updateSprites();
  if (p.turning) return true;
  ov.emit('talk', { objectIndex: npc.index, counter });
  ov.runScript(talkToNpcGen(ov, npc));
  return true;
}

/** Run a generator with the overworld frozen (DisplayTextID is a blocking call). */
export function* frozen(ov, gen) {
  ov.freeze++;
  try {
    return yield* gen;
  } finally {
    ov.freeze--;
  }
}

/** Text entry of the current text table for a 1-based text id. */
export function textEntry(ov, textIndex) {
  const entries = (ov.map.textTable && ov.map.textTable.entries) || [];
  return entries.find((e) => e.id === textIndex) || entries[textIndex - 1] || null;
}

// ===================================================================== signs & NPCs

export function* signGen(ov, index, sign) {
  const handled = yield* ov.callMapHookGen('onSign', [index, sign]);
  if (handled) return;
  yield* frozen(ov, textByIdGen(ov, sign.textIndex, null));
}

export function* talkToNpcGen(ov, npc) {
  const handled = yield* ov.callMapHookGen('onInteract', [npc.index, npc]);
  if (handled) return;
  yield* frozen(ov, textByIdGen(ov, npc.def.textIndex, npc));
}

/** DisplayTextID for a text id of the current table (NPC or sign). */
export function* textByIdGen(ov, textIndex, npc) {
  const entry = textEntry(ov, textIndex);
  if (!entry) {
    console.warn(`[overworld] ${ov.mapName}: no text ${textIndex}`);
    return;
  }
  switch (entry.handler) {
    case 'trainer': {
      const header = (ov.map.json.trainerHeaders || []).find((t) => t.header === entry.trainerHeader) || null;
      if (npc && header) { yield* talkToTrainerGen(ov, npc, header, { seen: false }); return; }
      yield* ov.textGen(entry.label);
      return;
    }
    case 'itemBall':
      if (npc) { yield* pickUpItemGen(ov, npc); return; }
      return;
    case 'text':
    case 'asm':
      yield* ov.textGen(entry.label);
      return;
    default:
      if (entry.handler && entry.handler.startsWith('script_')) {
        yield* builtinScriptGen(ov, entry.handler, { npc, entry });
        return;
      }
      yield* ov.textGen(entry.label);
  }
}

// ===================================================================== trainers

/**
 * TalkToTrainer (+ the battle + EndTrainerBattle). `seen`: the trainer engaged the player by
 * sight (the "!" and walk-up already happened).
 */
export function* talkToTrainerGen(ov, npc, header, { seen = false } = {}) {
  const flag = header.eventFlag;
  if (ov.state.flags.get(flag)) {
    yield* frozen(ov, ov.textGen(header.textAfter));
    return;
  }
  yield* frozen(ov, ov.textGen(header.textBefore));
  const t = npc.def.trainer;
  const mon = npc.def.pokemon;
  const texts = { before: header.textBefore, end: header.textEnd, after: header.textAfter };
  let result;
  if (t) {
    if (!seen) {
      const tc = ov.data.trainerClassByConst.get(t.trainerClass);
      if (tc && tc.encounterMusic && !RIVAL_CLASSES.includes(t.trainerClass)) ov.playMusic(tc.encounterMusic);
    }
    result = yield* ov.battleGen({
      trainerClass: t.trainerClass, partyIndex: t.trainerPartyIndex, objectIndex: npc.index,
      texts, header: header.header, eventFlag: flag,
    });
  } else if (mon) {
    const m = ov.data.mon(mon.species);
    result = yield* ov.battleGen({
      species: m ? m.dex : null, speciesConst: mon.species, level: mon.level, static: true,
      objectIndex: npc.index, texts, eventFlag: flag,
    });
  } else {
    return;
  }
  if (result === 'lose' || result === 'blackout') return;
  // EndTrainerBattle
  ov.state.flags.set(flag);
  ov.emit('trainerBeaten', { objectIndex: npc.index, flag });
  if (mon) {
    ov.setObjectHidden(npc.index, true);
  } else if (!RIVAL_CLASSES.includes(t.trainerClass) && ov.map.json.const !== 'POKEMON_TOWER_7F') {
    // SetEnemyTrainerToStayAndFaceAnyDirection
    npc.movement = MOVE_STAY;
    npc.byte2 = 0xff;
  }
}

// ===================================================================== item balls

/** PickUpItem: give the item (hooks), hide the ball, "{PLAYER} found X!". */
export function* pickUpItemGen(ov, npc) {
  const item = npc.def.item;
  const info = { map: ov.mapName, objectIndex: npc.index, item, itemId: npc.def.itemId, toggleIndex: npc.def.toggleIndex };
  let given;
  if (ov.hooks.onItemBall) {
    given = ov.hooks.onItemBall(ov.ctx, info);
    if (isIter(given)) given = yield* given;
    else if (isThen(given)) given = yield given;
    if (given === undefined) given = true;
  } else {
    given = ov.callGameHook('giveItem', [item, 1], true);
    if (isThen(given)) given = yield given;
  }
  ov.emit('itemBall', { ...info, given: !!given });
  if (given) {
    ov.setObjectHidden(npc.index, true);
    yield* ov.textGen(
      [{ cmd: 'text_far', label: '_FoundItemText' }, { cmd: 'sound', sound: 'sound_get_item_1' }, { cmd: 'text_end' }],
      { subs: { wStringBuffer: ov.data.itemName(item) }, holdOnly: true },
    );
  } else {
    yield* ov.textGen([{ cmd: 'text_far', label: '_NoMoreRoomForItemText' }, { cmd: 'text_end' }]);
  }
}

// ===================================================================== hidden objects

/** CheckForHiddenEvent's routine call: map script, generic routines, hooks. */
export function* hiddenEventGen(ov, h) {
  const handled = yield* ov.callMapHookGen('onHiddenObject', [h.routine, h]);
  if (handled) return;
  const generic = genericHiddenEventGen(ov, h);
  if (generic) { yield* frozen(ov, generic); return; }
  if (ov.hooks.onHiddenObject) {
    const r = ov.hooks.onHiddenObject(h.routine, h, ov.ctx);
    if (isIter(r)) { yield* r; return; }
    if (isThen(r)) { yield r; return; }
  }
}

// ===================================================================== card keys

/** PrintCardKeyText (Silph Co. doors): Bingo! + open the door, or "locked". */
export function cardKeyDoor(ov) {
  const j = ov.map.json;
  if (!ov.data.meta.silphCoMaps.includes(j.const)) return false;
  const tile = ov.frontTile();
  if (!(tile === 0x18 || tile === 0x24 || (j.const === 'SILPH_CO_11F' && tile === 0x5e))) return false;
  const has = ov.callGameHook('hasItem', ['CARD_KEY'], false);
  const f = ov.frontCell();
  ov.runScript(frozen(ov, (function* cardKey() {
    if (has) {
      yield* ov.textGen('CardKeySuccessText');
      const bx = Math.floor(f.x / 2), by = Math.floor(f.y / 2);
      ov.setBlock(bx, by, j.const === 'SILPH_CO_11F' ? 0x03 : 0x0e);
      ov.playSfx('SFX_GO_INSIDE');
      ov.startHook('onCardKeyDoor', [bx, by]);
    } else {
      yield* ov.textGen('CardKeyFailText');
    }
  })()));
  return true;
}

// ===================================================================== built-in text scripts

/**
 * Built-in UIs (TX_SCRIPT_*): marts, the nurse, PCs, cable club, vending machines, prize
 * vendors. hooks.onBuiltinScript(handler, info, ctx) implements them; the defaults below only
 * keep the overworld usable without a game layer.
 */
export function* builtinScriptGen(ov, handler, info = {}) {
  const name = handler && handler.startsWith('script_') ? handler : `script_${handler}`;
  ov.emit('builtinScript', { handler: name });
  if (ov.hooks.onBuiltinScript) {
    const r = ov.hooks.onBuiltinScript(name, info, ov.ctx);
    if (isIter(r)) { yield* r; return; }
    if (isThen(r)) { yield r; return; }
    if (r) return;
  }
  switch (name) {
    case 'script_pokecenter_nurse':
      yield* nurseGen(ov, info);
      return;
    case 'script_mart':
      yield* ov.textGen('PokemartGreetingText');
      return;
    case 'script_pokecenter_pc':
    case 'script_players_pc':
      yield* ov.textGen([{ cmd: 'text_far', label: '_TurnedOnPC1Text' }, { cmd: 'text_end' }], { wait: false });
      return;
    case 'script_bills_pc':
      yield* ov.textGen([{ cmd: 'text_far', label: '_AccessedBillsPCText' }, { cmd: 'text_end' }], { wait: false });
      return;
    default:
      return;
  }
}

/** DisplayPokemonCenterDialogue_ (healing via hooks.healParty). */
function* nurseGen(ov, info) {
  const t = (label) => [{ cmd: 'text_far', label }, { cmd: 'text_end' }];
  yield* ov.textGen(t('_PokemonCenterWelcomeText'), { wait: false, close: false });
  if (!ov.usedPokecenter) {
    ov.usedPokecenter = true;
    yield* ov.textGen([{ cmd: 'text_pause' }, ...t('_ShallWeHealYourPokemonText')], { wait: false, close: false });
  }
  // YesNoChoicePokeCenter: HEAL_CANCEL_MENU, box at (11,6) 9x6, cursor (12,8), items 2 rows apart
  const tm = (ov.font.textbox && ov.font.textbox.twoOptionMenus && ov.font.textbox.twoOptionMenus.HEAL_CANCEL_MENU) || { w: 9, h: 6 };
  const choice = yield* ov.menuGen(['HEAL', 'CANCEL'], {
    x: 11, y: 6, width: tm.w, height: tm.h, top: 2, spacing: 2, wrap: false, exitDelay: 15,
  });
  const yes = choice === 0;
  const nurse = info.npc || null;
  if (yes) {
    ov.callGameHook('setLastBlackoutMap', [ov.state.lastOutdoor && ov.state.lastOutdoor.map], null);
    yield* ov.textGen(t('_NeedYourPokemonText'), { wait: false, close: false });
    if (nurse) nurse.face('left'); // image $18: turned to the machine
    yield 3;
    const r = ov.callGameHook('healParty', [], null);
    if (isThen(r)) yield r;
    ov.playSfx('SFX_HEALING_MACHINE');
    yield 60;
    yield* ov.textGen(t('_PokemonFightingFitText'), { wait: false, close: false });
    if (nurse) nurse.face('down');
    yield 20;
  }
  yield* ov.textGen([{ cmd: 'text_pause' }, ...t('_PokemonCenterFarewellText')]);
}

// ===================================================================== text_asm

const activeAsm = new Set();

/** text_asm reached in a displayed text: map script, hooks, then the default. */
export function* textAsmGen(ov, label) {
  const handled = yield* ov.callMapHookGen('onTextAsm', [label]);
  if (handled) return;
  if (ov.hooks.onTextAsm) {
    const r = ov.hooks.onTextAsm(ov.mapName, label, ov.ctx);
    if (isIter(r)) { yield* r; return; }
    if (isThen(r)) { yield r; return; }
    if (r) return;
  }
  yield* defaultTextAsmGen(ov, label);
}

/** Engine-level text_asm routines that only depend on the map (not on story state). */
const ENGINE_TEXT_ASM = {
  // BookOrSculptureText: the Celadon Mansion sculpture ($38 above the shelf) or books
  * BookOrSculptureText(ov) {
    const p = ov.player;
    const sculpture = ov.map.tileset.const === 'MANSION' && ov.map.grid.cellTileTL(p.x, p.y - 1) === 0x38;
    yield* ov.textGen(sculpture ? 'DiglettSculptureText' : 'PokemonBooksText');
  },
  // IndigoPlateauStatues: text 1, then 2 or 3 by the parity of X
  * IndigoPlateauStatues(ov) {
    yield* ov.textGen('IndigoPlateauStatuesText1');
    yield* ov.textBox.promptButton();
    yield* ov.textGen(ov.player.x & 1 ? 'IndigoPlateauStatuesText2' : 'IndigoPlateauStatuesText3');
  },
};

/**
 * Default text_asm: show the sub-texts the routine references (`refs` in data/text), in
 * order, so most NPCs still talk before the story layer implements their logic.
 */
export function* defaultTextAsmGen(ov, label) {
  if (!label || activeAsm.has(label)) return;
  const eng = ENGINE_TEXT_ASM[label];
  activeAsm.add(label);
  try {
    if (eng) { yield* eng(ov); return; }
    const lookup = (l) => (ov.map.text && ov.map.text.texts[l]) || ov.data.commonText.texts[l];
    const t = lookup(label);
    const refs = ((t && t.refs) || []).filter((r) => { const x = lookup(r); return x && x.kind === 'text'; });
    for (let i = 0; i < refs.length; i++) {
      yield* ov.textGen(refs[i]);
      if (i < refs.length - 1) yield* ov.textBox.promptButton();
    }
  } finally {
    activeAsm.delete(label);
  }
}

// ===================================================================== default battles

/** No battle system: announce the wild Pokémon and carry on. */
export function* defaultWildBattleGen(ov, opts) {
  const mon = opts.species != null ? ov.data.monsByDex.get(opts.species) : null;
  yield* ov.textGen([{ cmd: 'text_far', label: '_WildMonAppearedText' }, { cmd: 'text_end' }], {
    subs: { wEnemyMonNick: mon ? mon.name : String(opts.speciesConst || opts.species) }, wait: false,
  });
  return 'win';
}

/** No battle system: "<CLASS> wants to fight!" and count it as won. */
export function* defaultTrainerBattleGen(ov, opts) {
  const tc = ov.data.trainerClassByConst.get(opts.trainerClass);
  yield* ov.textGen([{ cmd: 'text_far', label: '_TrainerWantsToFightText' }, { cmd: 'text_end' }], {
    subs: { wTrainerName: tc ? tc.name : String(opts.trainerClass).replace(/^OPP_/, '') }, wait: false,
  });
  return 'win';
}

// ===================================================================== Strength

/**
 * TryPushingBoulder (runs from RunMapScript every iteration while Strength is active): two
 * consecutive attempts facing a boulder with the direction held push it one step if the cell
 * two steps ahead is walkable, not stairs, not a tile-pair edge and free of sprites.
 */
export function tryPushingBoulder(ov) {
  const b = ov.boulder;
  if (b.pushing) {
    // DoBoulderDustAnimation once the boulder stopped
    const n = b.pushing;
    if (n.scripted || n.moving) return;
    b.pushing = null;
    b.tried = false;
    n.movement = MOVE_STAY;
    ov.playSfx('SFX_CUT');
    ov.run(dustGen(ov, n));
    ov.startHook('onBoulderPushed', [n.index, n.x, n.y]);
    return;
  }
  const n = spriteInFront(ov, 16, false);
  if (!n || n.def.rangeOrDirectionValue !== 0x10) { b.tried = false; return; }
  if (!b.tried) { b.tried = true; return; } // the player must try twice
  const held = ov.lastJoy.held;
  const p = ov.player;
  const bit = { up: 0x40, down: 0x80, left: 0x20, right: 0x10 }[p.facing];
  if (!(held & bit)) return;
  if (!canPushBoulder(ov, n)) { b.tried = false; return; }
  n.startScript([p.facing]);
  ov.playSfx('SFX_PUSH_BOULDER');
  b.pushing = n;
  ov.emit('boulder', { objectIndex: n.index, dir: p.facing });
}

/** CheckForCollisionWhenPushingBoulder */
export function canPushBoulder(ov, boulder) {
  const p = ov.player, g = ov.map.grid, ts = ov.map.tileset;
  const [dx, dy] = DIR_DELTA[p.facing];
  const tx = p.x + 2 * dx, ty = p.y + 2 * dy;
  const tile = g.cellTile(tx, ty);
  if (!isWalkable(ts, tile)) return false;
  if (isPairBlocked(ts, g.cellTile(p.x, p.y), tile, false)) return false;
  if (tile === TILE.STAIRS) return false;
  const bx = boulder.x + dx, by = boulder.y + dy;
  return !ov.npcs.some((o) => o !== boulder && !ov.isObjectHidden(o) && o.x === bx && o.y === by);
}

/** Boulder dust puff (AnimateBoulderDust, simplified to the smoke sprite for 8 frames). */
function* dustGen(ov, n) {
  const fx = { img: ov.data.gfx.smoke, worldX: n.px, worldY: n.py, frames: 8 };
  ov.effects.push(fx);
  try { yield 8; } finally { ov.effects = ov.effects.filter((e) => e !== fx); }
}

// ===================================================================== Cut

/** Can the tree / grass in front be cut? */
export function canCut(ov) {
  return !!ov.map && isCuttable(ov.map.tileset, ov.frontTile());
}

/**
 * UsedCut: replace the block holding the tree in front with its cut version
 * (CutTreeBlockSwaps). Returns false when there is nothing to cut.
 */
export function doCut(ov) {
  if (!canCut(ov)) return false;
  const f = ov.frontCell();
  const bx = Math.floor(f.x / 2), by = Math.floor(f.y / 2);
  const block = ov.map.grid.blockAt(bx, by);
  const swap = cutBlockSwap(ov.map.tileset, block);
  if (swap === undefined) return false;
  ov.setBlock(bx, by, swap);
  ov.playSfx('SFX_CUT');
  ov.emit('cut', { bx, by, from: block, to: swap });
  return true;
}

export { MODE };
