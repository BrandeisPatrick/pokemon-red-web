// installScripts(): load the six region files of story scripts and register every map
// script with the overworld (docs/scripting.md). A region file that is missing or fails to
// load is skipped with a warning, so the game runs while regions are still being written.
//
//   import { installScripts } from './game/scripts/index.js';
//   const maps = await installScripts();          // ['PalletTown', 'OaksLab', ...]

import { registerMapScript } from '../../overworld/scripts.js';

/** Region files, in story order (src/game/scripts/regions/<name>.js). */
export const REGIONS = Object.freeze(['kanto1', 'kanto2', 'kanto3', 'kanto4', 'kanto5', 'kanto6']);

/** Keys a map script object may have (anything else is probably a typo). */
export const SCRIPT_KEYS = Object.freeze(['onEnter', 'onFrame', 'onStep', 'onInteract', 'onSign', 'onHiddenObject',
  'onTextAsm', 'onWarpAttempt', 'onCardKeyDoor', 'onBoulderPushed', 'trainers', 'spinners', 'holes']);

/**
 * @param {object} [o]
 * @param {string[]} [o.regions] region names to load (default REGIONS)
 * @param {(name:string) => Promise<any>} [o.importer] module loader (tests); default dynamic import
 * @param {(map:string, script:object) => any} [o.register] default registerMapScript
 * @param {Set<string>|string[]} [o.mapNames] known map names: unknown keys are warned about
 * @returns {Promise<string[]>} the map names that got a script, in load order
 */
export async function installScripts({ regions = REGIONS, importer, register = registerMapScript, mapNames } = {}) {
  const load = importer || ((name) => import(`./regions/${name}.js`));
  const known = mapNames ? new Set(mapNames) : null;
  const installed = [];
  const owner = new Map();
  const results = await Promise.all(regions.map(async (name) => {
    try {
      return { name, mod: await load(name) };
    } catch (err) {
      return { name, err };
    }
  }));
  for (const { name, mod, err } of results) {
    if (err) {
      console.warn(`[scripts] region ${name} not loaded (${err && err.message ? err.message : err}) - its maps use the engine defaults`);
      continue;
    }
    const table = mod && (mod.default || mod.scripts);
    if (!table || typeof table !== 'object') {
      console.warn(`[scripts] region ${name} has no default export`);
      continue;
    }
    for (const [map, script] of Object.entries(table)) {
      if (!script || typeof script !== 'object') {
        console.warn(`[scripts] ${name}: ${map} is not a script object`);
        continue;
      }
      if (known && !known.has(map)) console.warn(`[scripts] ${name}: unknown map name ${map}`);
      const odd = Object.keys(script).filter((k) => !SCRIPT_KEYS.includes(k) && typeof script[k] === 'function' && k.startsWith('on'));
      if (odd.length) console.warn(`[scripts] ${name}.${map}: unknown hook(s) ${odd.join(', ')}`);
      if (owner.has(map)) console.warn(`[scripts] ${map} is defined by both ${owner.get(map)} and ${name}; ${name} wins`);
      owner.set(map, name);
      register(map, script);
      if (!installed.includes(map)) installed.push(map);
    }
  }
  return installed;
}
