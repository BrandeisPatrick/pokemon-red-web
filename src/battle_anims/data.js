// Loads data/battle_anims/*.json (tools/extract_battle_anims.py) and the graphics the
// animations draw with, and indexes them for the player.
//
//   const data = await loadBattleAnimData(game.assets);   // Assets-like: json(url), image(url)
//   const data = buildBattleAnimData(jsonByName, gfx);      // pure (node tests)

/** @typedef {import('../engine/gfx.js').IndexedImage} IndexedImage */

export const DATA_DIR = 'data/battle_anims/';
export const DATA_FILES = Object.freeze(['base_coords', 'frame_blocks', 'subanimations', 'special_effects', 'move_scripts']);
export const GFX_FILES = Object.freeze({
  anim0: 'assets/battle/move_anim_0.png',
  anim1: 'assets/battle/move_anim_1.png',
  monster: 'assets/sprites/monster.png',          // MonsterSprite (substitute doll)
  battleTiles: 'assets/battle/battle_tiles_60_7f.png', // BG tiles $60-$7F in battle
});

/**
 * @typedef {Object} AnimCommand
 * @property {'subanim'|'special'} op
 * @property {number} [subanim] @property {number} [tileset] @property {number} [delay]
 * @property {number} [effect] @property {string} [effectConst] @property {string} [routine]
 * @property {{move:string, moveId:number, sfx:string, pitch:number, tempo:number}|null} sound
 */
/**
 * @typedef {Object} BattleAnimData
 * @property {{y:number,x:number}[]} baseCoords
 * @property {{y:number,x:number,tile:number,flags:number}[][]} frameBlocks
 * @property {{id:number,const:string,type:number,entries:{frameBlock:number,baseCoord:number,mode:number}[]}[]} subanims
 * @property {{id:number,const:string,kind:string,script:string,commands:AnimCommand[]}[]} animations  index = id - 1
 * @property {Record<string, number>} ids          constant -> animation id
 * @property {Record<number, string>} seNames      SE id -> SE_* name
 * @property {Record<number, string>} hooks        animation id -> AnimationIdSpecialEffects routine
 * @property {object} tables  @property {object} bgPalettes  @property {object} constants
 * @property {object} picTilemaps @property {object[]} animationTypes @property {object[]} moveSounds
 * @property {Record<string, number>} ballItems
 * @property {{tiles:number, sheet:string}[]} tilesets
 * @property {{anim: IndexedImage[], monster: IndexedImage|null, battleTiles: IndexedImage|null}} gfx
 * @property {number} firstSpecialEffectId
 */

/**
 * Build the indexed data from the five parsed JSON documents and the graphics.
 * @param {Record<string, any>} json  keyed by file name without .json
 * @param {{anim0?: IndexedImage, anim1?: IndexedImage, monster?: IndexedImage, battleTiles?: IndexedImage}} [gfx]
 * @returns {BattleAnimData}
 */
export function buildBattleAnimData(json, gfx = {}) {
  for (const f of DATA_FILES) if (!json[f]) throw new Error(`battle_anims: missing ${f}.json`);
  const se = json.special_effects, ms = json.move_scripts;
  const seNames = {};
  for (const e of se.specialEffects) seNames[e.id] = e.const;
  const hooks = {};
  for (const h of se.animationIdSpecialEffects) hooks[h.animationId] = h.routine;
  const tilesets = se.moveAnimationTilesets.map((t) => ({ id: t.id, tiles: t.tiles, sheet: t.sheet }));
  const sheetFor = (t) => (t.sheet && t.sheet.endsWith('move_anim_1.png') ? gfx.anim1 : gfx.anim0) || null;
  return {
    baseCoords: json.base_coords.baseCoords.map((b) => ({ y: b.y, x: b.x })),
    frameBlocks: json.frame_blocks.frameBlocks.map((b) => b.tiles),
    frameBlockTileBase: json.frame_blocks.tileBase,
    subanims: json.subanimations.subanimations,
    animations: ms.animations,
    ids: ms.ids,
    numAttacks: ms.numAttacks,
    numAttackAnims: ms.numAttackAnims,
    moveSounds: ms.moveSounds,
    seNames,
    hooks,
    firstSpecialEffectId: se.firstSpecialEffectId,
    animationTypes: se.animationTypes,
    bgPalettes: se.bgPalettes,
    constants: se.constants,
    tables: se.tables,
    picTilemaps: se.picTilemaps,
    ballItems: se.ballItems,
    tilesets,
    gfx: {
      anim: tilesets.map(sheetFor),
      monster: gfx.monster || null,
      battleTiles: gfx.battleTiles || null,
    },
  };
}

/**
 * Fetch everything through an Assets-like loader (src/engine/assets.js).
 * @param {{json: (url:string) => Promise<any>, image: (url:string) => Promise<IndexedImage>}} assets
 * @param {{base?: string}} [opts]  prefix for the URLs (default '')
 * @returns {Promise<BattleAnimData>}
 */
export async function loadBattleAnimData(assets, { base = '' } = {}) {
  const jsonEntries = await Promise.all(DATA_FILES.map(async (f) => [f, await assets.json(`${base}${DATA_DIR}${f}.json`)]));
  const gfxEntries = await Promise.all(Object.entries(GFX_FILES).map(async ([k, url]) => [k, await assets.image(`${base}${url}`)]));
  return buildBattleAnimData(Object.fromEntries(jsonEntries), Object.fromEntries(gfxEntries));
}
