// Offline rendering: sequencer + software APU -> PCM, in node (tests, verification, WAV
// export). The rendering functions are environment-neutral; only loadAudioDataFromDisk and
// the CLI touch node: modules (imported dynamically).
//
// CLI (from the project root):
//   node src/audio/offline.js --music PALLET_TOWN --seconds 30 --out pallet.wav
//   node src/audio/offline.js --sfx SFX_LEVEL_UP --out levelup.wav
//   node src/audio/offline.js --cry 25 --out pikachu.wav
//   node src/audio/offline.js --list

import { AudioPlayer } from './player.js';
import { FRAME_RATE } from './apu.js';

/** Read index/waves/notes and (by default) every sound file from data/audio on disk. */
export async function loadAudioDataFromDisk(dataDir = 'data/audio', { allSounds = true } = {}) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const read = async (rel) => JSON.parse(await fs.readFile(path.join(dataDir, rel), 'utf8'));
  const [index, waves, notes] = await Promise.all([read('index.json'), read('waves.json'), read('notes.json')]);
  let sounds = [];
  if (allSounds) {
    const files = new Set([...index.music.map((e) => e.file), ...index.sfx.map((e) => e.file)]);
    sounds = await Promise.all([...files].map((f) => read(f)));
  }
  return { index, waves, notes, sounds, read };
}

/** An AudioPlayer with all of data/audio loaded (node). */
export async function createOfflinePlayer({ dataDir = 'data/audio', sampleRate = 48000 } = {}) {
  const data = await loadAudioDataFromDisk(dataDir);
  const player = new AudioPlayer({ sampleRate });
  player.loadData(data);
  return player;
}

/** Render `seconds` of audio from the player's current state. */
export function renderSeconds(player, seconds) {
  const n = Math.round(seconds * player.sampleRate);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const block = 1024;
  for (let i = 0; i < n; i += block) {
    const k = Math.min(block, n - i);
    player.render(left.subarray(i, i + k), right.subarray(i, i + k), k);
  }
  return { left, right, sampleRate: player.sampleRate };
}

/** Render until `done()` is true (checked every block) or `maxSeconds` elapse. */
export function renderUntil(player, done, maxSeconds = 30) {
  const chunks = [];
  const block = 1024;
  const maxN = Math.round(maxSeconds * player.sampleRate);
  let total = 0;
  while (total < maxN) {
    const l = new Float32Array(block);
    const r = new Float32Array(block);
    player.render(l, r, block);
    chunks.push([l, r]);
    total += block;
    if (done()) break;
  }
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  chunks.forEach(([l, r], i) => { left.set(l, i * block); right.set(r, i * block); });
  return { left, right, sampleRate: player.sampleRate };
}

/** 16-bit PCM stereo WAV bytes. */
export function encodeWav(left, right, sampleRate) {
  const n = left.length;
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true); v.setUint16(32, 4, true);
  v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    v.setInt16(o, Math.round(l * 32767), true);
    v.setInt16(o + 2, Math.round(r * 32767), true);
    o += 4;
  }
  return new Uint8Array(buf);
}

/**
 * Wraps a registers object and records every write with the frame it happened in.
 * `new RegisterRecorder(apu)` forwards to a real APU; `new RegisterRecorder()` is standalone.
 */
export class RegisterRecorder {
  constructor(target = null) {
    this.target = target;
    this.mem = new Uint8Array(0x40);
    this.mem[0x24] = 0x77;
    this.writes = [];
    this.frame = 0;
  }
  read(addr) { return this.target ? this.target.read(addr) : this.mem[addr & 0x3f]; }
  write(addr, value) {
    this.writes.push({ frame: this.frame, addr: addr & 0x3f, value: value & 0xff });
    this.mem[addr & 0x3f] = value & 0xff;
    if (this.target) this.target.write(addr, value);
  }
}

export { FRAME_RATE };

// --------------------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------------------

async function cli(argv) {
  const args = { seconds: null, out: null, dataDir: 'data/audio', rate: 48000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--music') args.music = next();
    else if (a === '--sfx') args.sfx = next();
    else if (a === '--cry') args.cry = next();
    else if (a === '--seconds') args.seconds = Number(next());
    else if (a === '--out') args.out = next();
    else if (a === '--data') args.dataDir = next();
    else if (a === '--rate') args.rate = Number(next());
    else if (a === '--no-loop') args.noLoop = true;
    else if (a === '--list') args.list = true;
    else throw new Error(`unknown argument ${a}`);
  }
  const player = await createOfflinePlayer({ dataDir: args.dataDir, sampleRate: args.rate });
  if (args.list) {
    for (const e of player.library.index.music) console.log(`music  bank ${e.bank}  ${String(e.id).padStart(4)}  ${e.name}`);
    for (const e of player.library.index.sfx) console.log(`sfx    bank ${e.bank}  ${String(e.id).padStart(4)}  ${e.name}`);
    return;
  }
  let result;
  let done = false;
  player.onEvent = (ev) => { if (ev.type === 'ended') done = true; };
  if (args.music) {
    player.playMusic(isNaN(+args.music) ? args.music : +args.music, { loop: !args.noLoop, token: 1 });
    result = args.seconds ? renderSeconds(player, args.seconds) : renderUntil(player, () => done, 120);
  } else if (args.sfx) {
    player.playSfx(args.sfx, { token: 1 });
    result = args.seconds ? renderSeconds(player, args.seconds) : renderUntil(player, () => done, 30);
  } else if (args.cry) {
    player.playCry(isNaN(+args.cry) ? args.cry : +args.cry, { token: 1 });
    result = args.seconds ? renderSeconds(player, args.seconds) : renderUntil(player, () => done, 10);
  } else {
    throw new Error('nothing to render: use --music, --sfx, --cry or --list');
  }
  for (const w of player.warnings) console.error(`warning: ${w}`);
  const { left, right, sampleRate } = result;
  let peak = 0;
  for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  console.log(`rendered ${(left.length / sampleRate).toFixed(2)} s (${player.frame} frames), peak ${peak.toFixed(3)}`);
  if (args.out) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(args.out, encodeWav(left, right, sampleRate));
    console.log(`wrote ${args.out}`);
  }
}

if (typeof process !== 'undefined' && process.argv && process.argv[1] && /offline\.js$/.test(process.argv[1])) {
  const { pathToFileURL } = await import('node:url');
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    cli(process.argv.slice(2)).catch((e) => {
      console.error(e.stack || String(e));
      process.exit(1);
    });
  }
}
