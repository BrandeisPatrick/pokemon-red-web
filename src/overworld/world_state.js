// Minimal default implementation of the shared game state the overworld codes against.
// The real one lives in src/game/state.js (game-model agent); this one exists so the
// overworld can run standalone (overworld-test.html, node tests). Same members:
//
//   state.pos          { map: 'PalletTown', x, y, facing: 'down'|'up'|'left'|'right' } (steps)
//   state.lastOutdoor  { map, x, y, warpIndex } - see warps.js (wLastMap semantics)
//   state.flags        { get(name), set(name, value = true), clear(name) } - EVENT_* names
//   state.missables    { isHidden(i), hide(i), show(i) } - index into toggleable_objects.json
//   state.hiddenItems  { has(key), add(key) } - keys 'item:<flagIndex>' / 'coin:<flagIndex>' (= src/game/flags.js hiddenItemKey)
//   state.playerName, state.rivalName, state.options.textSpeed ('fast'|'mid'|'slow'),
//   state.repelSteps, state.surfing, state.bike, state.badges (bitfield), state.stepCounter

export class FlagSet {
  constructor(initial = []) {
    /** @type {Set<string>} */
    this.set_ = new Set(initial);
  }
  get(name) { return this.set_.has(name); }
  set(name, value = true) { if (value) this.set_.add(name); else this.set_.delete(name); }
  clear(name) { this.set_.delete(name); }
  toJSON() { return [...this.set_].sort(); }
}

export class MissableSet {
  /**
   * @param {{objects: {index:number, initiallyVisible:boolean}[]}|null} toggleables
   *        data/toggleable_objects.json (new game: hidden = !initiallyVisible)
   * @param {number[]} [hidden] explicit list of hidden indices (overrides the new-game default)
   */
  constructor(toggleables, hidden) {
    /** @type {Set<number>} */
    this.hidden = new Set(hidden || (toggleables ? toggleables.objects.filter((o) => !o.initiallyVisible).map((o) => o.index) : []));
  }
  isHidden(i) { return this.hidden.has(i); }
  hide(i) { this.hidden.add(i); }
  show(i) { this.hidden.delete(i); }
  toJSON() { return [...this.hidden].sort((a, b) => a - b); }
}

export class KeySet {
  constructor(initial = []) { this.keys = new Set(initial); }
  has(key) { return this.keys.has(key); }
  add(key) { this.keys.add(key); }
  toJSON() { return [...this.keys].sort(); }
}

export class WorldState {
  /**
   * @param {object} [o]
   * @param {any} [o.toggleables] data/toggleable_objects.json
   * @param {{map:string,x:number,y:number,facing?:string}} [o.pos]
   * @param {{map:string,x?:number|null,y?:number|null,warpIndex?:number|null}} [o.lastOutdoor]
   */
  constructor(o = {}) {
    this.pos = { map: 'PalletTown', x: 5, y: 6, facing: 'down', ...(o.pos || {}) };
    this.lastOutdoor = { map: 'PalletTown', x: null, y: null, warpIndex: null, ...(o.lastOutdoor || {}) };
    this.flags = new FlagSet(o.flags);
    this.missables = new MissableSet(o.toggleables || null, o.hiddenMissables);
    this.hiddenItems = new KeySet(o.hiddenItems);
    this.playerName = o.playerName || 'RED';
    this.rivalName = o.rivalName || 'BLUE';
    this.options = { textSpeed: 'mid', ...(o.options || {}) };
    this.repelSteps = o.repelSteps || 0;
    this.surfing = !!o.surfing;
    this.bike = !!o.bike;
    this.badges = o.badges || 0;
    this.stepCounter = o.stepCounter || 0;
  }

  /**
   * New game: the player starts in Red's room (data/maps_meta.json newGame) and wLastMap is
   * PALLET_TOWN (PrepareForSpecialWarp).
   * @param {any} meta data/maps_meta.json
   * @param {any} toggleables data/toggleable_objects.json
   * @param {(constName:string) => string} mapName map const -> map name
   */
  static newGame(meta, toggleables, mapName) {
    const ng = meta.newGame;
    return new WorldState({
      toggleables,
      pos: { map: mapName(ng.map), x: ng.x, y: ng.y, facing: 'down' },
      lastOutdoor: { map: 'PalletTown', x: null, y: null, warpIndex: null },
    });
  }

  toJSON() {
    return {
      pos: this.pos, lastOutdoor: this.lastOutdoor, flags: this.flags.toJSON(),
      hiddenMissables: this.missables.toJSON(), hiddenItems: this.hiddenItems.toJSON(),
      playerName: this.playerName, rivalName: this.rivalName, options: this.options,
      repelSteps: this.repelSteps, surfing: this.surfing, bike: this.bike, badges: this.badges,
      stepCounter: this.stepCounter,
    };
  }

  static fromJSON(j, toggleables) {
    return new WorldState({ ...j, toggleables });
  }
}
