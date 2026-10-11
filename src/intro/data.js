// Everything the start sequence loads: the extracted PNG sheets (assets/intro, assets/title,
// assets/trainers, ...) as indexed images and the JSON tables it reads.
//
// `assets` is anything with json(url) and image(url) -> IndexedImage (the engine Assets
// loader in the browser, a disk loader in node tests).

import { textResolver } from '../engine/text.js';

export const IMAGE_URLS = Object.freeze({
  copyright: 'assets/intro/splash/copyright.png',        // gfx/splash/copyright.png (19 tiles)
  gamefreakInc: 'assets/title/gamefreak_inc.png',         // gfx/title/gamefreak_inc.png (9 tiles)
  presents: 'assets/intro/splash/gamefreak_presents.png', // "GAME FREAK presents" (13 tiles)
  gfLogo: 'assets/intro/splash/gamefreak_logo.png',       // 2x3-tile logo
  fallingStar: 'assets/intro/splash/falling_star.png',
  moveAnim1: 'assets/battle/move_anim_1.png',             // MoveAnimationTiles1 (star = tiles 3, 19)
  gengarTiles: 'assets/intro/gengar_tiles.png',           // gengar.2bpp in VRAM order
  nidorino1: 'assets/intro/red_nidorino_1.png',
  nidorino2: 'assets/intro/red_nidorino_2.png',
  nidorino3: 'assets/intro/red_nidorino_3.png',
  pokemonLogo: 'assets/title/pokemon_logo.png',
  version: 'assets/title/red_version.png',
  titlePlayer: 'assets/title/player.png',
  profOak: 'assets/trainers/prof_oak.png',
  red: 'assets/trainers/red.png',
  shrink1: 'assets/trainers/red_shrink1.png',
  shrink2: 'assets/trainers/red_shrink2.png',
  rival1: 'assets/trainers/rival1.png',
  redSprite: 'assets/sprites/red.png',                    // overworld sprite (end of Oak's speech)
});

export const JSON_URLS = Object.freeze({
  uiGfx: 'data/ui_gfx.json',
  pokedex: 'data/pokedex.json',
  pokemon: 'data/pokemon.json',
  common: 'data/text/common.json',
});

/** Pokédex numbers used outside the title list. */
export const DEX = Object.freeze({ BULBASAUR: 1, CHARMANDER: 4, SQUIRTLE: 7, NIDORINA: 30, NIDORINO: 33 });

/**
 * @typedef {import('../engine/gfx.js').IndexedImage} IndexedImage
 * @typedef {Object} IntroData
 * @property {Record<keyof typeof IMAGE_URLS, IndexedImage>} img
 * @property {number[][]} gengarMaps   3 x 49 tile ids (TILEMAP_GENGAR_INTRO_1..3, 7x7 row-major)
 * @property {{species:number, const:string}[]} titleMons  data/pokemon/title_mons.asm (Red)
 * @property {Map<number, any>} mons     dex -> data/pokemon.json entry
 * @property {Map<number, IndexedImage>} front  dex -> front pic (title mons + Nidorino)
 * @property {(label:string) => any} texts     text_far resolver over data/text/common.json
 * @property {Record<string, {path:string, animation:string}>} icons  ICON_* -> party icon sheet
 * @property {{json:Function, image:Function}} assets
 */

/**
 * Load everything (in parallel). Pokémon front pics are limited to the title list and
 * Nidorino; other species are loaded on demand with frontPic().
 * @returns {Promise<IntroData>}
 */
export async function loadIntroData(assets) {
  const [uiGfx, pokedex, pokemon, common] = await Promise.all(Object.values(JSON_URLS).map((u) => assets.json(u)));
  const keys = Object.keys(IMAGE_URLS);
  const imgs = await Promise.all(keys.map((k) => assets.image(IMAGE_URLS[k])));
  const img = Object.fromEntries(keys.map((k, i) => [k, imgs[i]]));
  const mons = new Map(pokemon.map((p) => [p.dex, p]));
  const gengarMaps = [1, 2, 3].map((n) => {
    const sheet = uiGfx.sheets.find((s) => s.path === `assets/intro/gengar_${n}.png`);
    if (!sheet || !Array.isArray(sheet.tilemap) || sheet.tilemap.length !== 49) throw new Error(`intro: no tilemap for gengar_${n}`);
    return sheet.tilemap.slice();
  });
  const iconSheet = uiGfx.sheets.find((s) => s.path === 'assets/ui/icons/<icon>.png');
  const titleMons = pokedex.titleMons.map((m) => ({ species: m.species, const: m.const }));
  const data = {
    img, gengarMaps, titleMons, mons,
    front: new Map(),
    texts: textResolver(common),
    icons: (iconSheet && iconSheet.files) || {},
    assets,
  };
  await Promise.all([...new Set([...titleMons.map((m) => m.species), DEX.NIDORINO])].map((d) => frontPic(data, d)));
  return data;
}

/** Load (once) the front pic of a species. @returns {Promise<IndexedImage>} */
export async function frontPic(data, dex) {
  if (data.front.has(dex)) return data.front.get(dex);
  const mon = data.mons.get(dex);
  if (!mon) throw new Error(`intro: unknown species ${dex}`);
  const im = await data.assets.image(mon.sprites.front);
  data.front.set(dex, im);
  return im;
}

/** Party icon sheet (16x32: frame 1 on top, frame 2 below) of a species. */
export async function iconPic(data, dex) {
  const mon = data.mons.get(dex);
  const icon = (mon && mon.menuIcon) || 'ICON_MON';
  const entry = data.icons[icon] || data.icons.ICON_MON;
  if (!entry) return null;
  const im = await data.assets.image(entry.path);
  return { image: im, animation: entry.animation || 'swap', icon };
}

/** Commands of a text label in data/text/common.json. */
export function textCommands(data, label) {
  const cmds = data.texts(label);
  if (!cmds) throw new Error(`intro: missing text ${label}`);
  return cmds;
}
