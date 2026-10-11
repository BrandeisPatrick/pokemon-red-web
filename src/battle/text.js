// Battle text: the local text labels of engine/battle/*.asm (which text_far into
// data/text/text_*.asm, extracted to data/text/common.json) and helpers to turn text command
// lists into plain strings (headless logs, tests).

/**
 * Text documents (data/text/common.json, optional map texts) indexed by label.
 * @param {...{texts?: Record<string, {commands?: object[]}>}} docs
 */
export class TextLibrary {
  constructor(...docs) {
    /** @type {Map<string, object[]>} */
    this.map = new Map();
    for (const d of docs) this.add(d);
  }

  /** Add a document (later documents win). */
  add(doc) {
    for (const [label, t] of Object.entries((doc && doc.texts) || {})) {
      if (t && Array.isArray(t.commands)) this.map.set(label, t.commands);
    }
    return this;
  }

  has(label) { return this.map.has(label); }

  /** Commands of a label, or undefined. */
  get(label) { return this.map.get(label); }

  /** Resolver for TextBox / flattenText. */
  resolver() {
    const f = (label) => this.map.get(label);
    f.labels = this.map;
    return f;
  }
}

/** A text that is just `text_far <label>` (+ text_end), like the battle engine's wrappers. */
export function far(label) {
  return [{ cmd: 'text_far', label }, { cmd: 'text_end' }];
}

const NUM_CMDS = new Set(['text_decimal', 'decimal', 'num', 'text_bcd', 'bcd']);

/**
 * Flatten text commands to a plain string (no font needed): `line`/`cont`/`para`/`next`/
 * `scroll`/`page` start a new line ("\n"), `para`/`page` a blank line ("\n\n"), `{KEY}`
 * placeholders and text_ram/text_decimal/text_bcd come from `subs`, `#` -> POKé, text_far is
 * resolved. Terminators of a text_far'd text end only that text (like TextBox).
 * @param {any} input commands, a string or {commands}
 * @param {Record<string, any>} [subs]
 * @param {(label:string) => object[]|undefined} [resolveFar]
 * @returns {string}
 */
export function flattenText(input, subs = {}, resolveFar = null, depth = 0) {
  const cmds = typeof input === 'string' ? [{ cmd: 'text', str: input }]
    : Array.isArray(input) ? input : (input && input.commands) || [];
  let out = '';
  const str = (s) => expand(String(s ?? ''), subs);
  for (const c of cmds) {
    const name = c.cmd || 'text';
    switch (name) {
      case 'text': case 'str': case 'start': case 'text_start':
        out += str(c.str);
        break;
      case 'line': case 'next': case 'cont': case 'scroll': case 'text_scroll': case 'low': case 'text_low':
        out += '\n' + str(c.str);
        break;
      case 'para': case 'page':
        out += '\n\n' + str(c.str);
        break;
      case 'text_ram': case 'ram': {
        const key = c.ram ?? c.var;
        out += String(lookup(subs, key) ?? `{${key}}`);
        break;
      }
      case 'text_far': case 'far': {
        if (depth > 8) break;
        const inner = c.commands || (resolveFar && c.label ? resolveFar(c.label) : null);
        if (inner) out += flattenText(inner, subs, resolveFar, depth + 1);
        else out += `{${c.label}}`;
        break;
      }
      case 'text_dots': case 'dots':
        out += '…'.repeat(Number(c.n ?? c.count ?? 1));
        break;
      case 'done': case 'prompt': case 'text_end': case 'end': case 'dex':
        if (name === 'dex') out += '.';
        return out;
      default:
        if (NUM_CMDS.has(name)) {
          const key = c.ram ?? c.var;
          const v = c.value ?? lookup(subs, key);
          let s = v === undefined ? `{${key}}` : String(v);
          if (name.endsWith('bcd') && c.bytes && v !== undefined) {
            // PrintBCDNumber: LEADING_ZEROES (bit 7) means "do not print leading zeroes"
            const flags = c.flags || [];
            const money = flags.includes('MONEY_SIGN') ? '¥' : '';
            if (!flags.includes('LEADING_ZEROES')) s = money + s.padStart(c.bytes * 2, '0');
            else s = flags.includes('LEFT_ALIGN') ? money + s : (money + s).padStart(c.bytes * 2 + money.length, ' ');
          }
          out += s;
        }
        break;
    }
  }
  return out;
}

const RAM_ALIASES = { wPlayerName: 'PLAYER', wRivalName: 'RIVAL' };

function lookup(subs, key) {
  if (!key) return undefined;
  if (subs[key] !== undefined) return subs[key];
  const a = RAM_ALIASES[key];
  return a && subs[a] !== undefined ? subs[a] : undefined;
}

function expand(s, subs) {
  return s.replace(/\{([A-Za-z0-9_]+)\}/g, (m, k) => (lookup(subs, k) !== undefined ? String(lookup(subs, k)) : m))
    .replace(/#/g, 'POKé')
    .replace(/<PKMN>/g, 'PKMN')
    .replace(/<USER>/g, subs.USER ?? '<USER>')
    .replace(/<TARGET>/g, subs.TARGET ?? '<TARGET>')
    .replace(/<PLAYER>/g, subs.PLAYER ?? 'RED')
    .replace(/<RIVAL>/g, subs.RIVAL ?? 'BLUE');
}

/** Single-line version (newlines -> spaces) for compact logs. */
export function oneLine(s) {
  return String(s).replace(/\s*\n+\s*/g, ' ').trim();
}
