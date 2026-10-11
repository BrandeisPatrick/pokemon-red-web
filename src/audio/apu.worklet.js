// AudioWorkletProcessor hosting the Game Boy sound engine + APU.
//
// Everything time-critical runs here: the sound engine ticks on a 59.7275 Hz frame clock
// derived from this processor's sample counter (player.js), and the APU synthesises every
// output sample at the context's sample rate (apu.js). The main thread (audio.js) only
// sends commands over the port:
//
//   {type:'loadData', index?, waves?, notes?, sounds?: [soundJson...]}
//   {type:'playMusic', name? | bank+id, loop?, fade?, token?}
//   {type:'stopMusic'}                         SFX_STOP_ALL_MUSIC
//   {type:'fadeOutMusic', frames?}             fade out (one NR50 step every frames+1) and stop
//   {type:'playSfx', name? | bank+id, bank?, frequencyModifier?, tempoModifier?, token?}
//   {type:'playCry', species | dex | index, token?}
//   {type:'waitForSfx', token}                 'ended' once CHAN5/6/8 are idle
//   {type:'setMasterVolume', value}            0..1
//   {type:'pause'} / {type:'resume'}           freeze / continue engine and output
//   {type:'setLowHealthAlarm', on}  {type:'duck', on}  {type:'pauseMusic', on}
//   {type:'mute', channels:[bool x4]}          debug: silence hardware channels
//   {type:'stateInterval', frames}             periodic {type:'state'} events (0 = off)
//
// and receives {type:'ready'}, {type:'ended', token, played}, {type:'state', ...},
// {type:'warn', message}, {type:'error', message}.

import { AudioPlayer } from './player.js';

class GbApuProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global of AudioWorkletGlobalScope
    this.player = new AudioPlayer({
      sampleRate,
      warn: (message) => this.port.postMessage({ type: 'warn', message }),
    });
    this.player.onEvent = (ev) => this.port.postMessage(ev);
    this.player.stateInterval = 0;
    this.scratchL = new Float32Array(128);
    this.scratchR = new Float32Array(128);
    this.port.onmessage = (e) => this.handle(e.data);
    this.port.postMessage({ type: 'ready', sampleRate });
  }

  handle(msg) {
    const p = this.player;
    try {
      switch (msg.type) {
        case 'loadData':
          p.loadData(msg);
          if (msg.token != null) this.port.postMessage({ type: 'loaded', token: msg.token });
          break;
        case 'playMusic':
          p.playMusic(msg.name != null ? msg.name : { bank: msg.bank, id: msg.id }, msg);
          break;
        case 'stopMusic':
          p.stopMusic();
          break;
        case 'fadeOutMusic':
          p.fadeOutMusic(msg.frames != null ? msg.frames : 10);
          break;
        case 'playSfx':
          p.playSfx(msg.name != null ? msg.name : { bank: msg.bank, id: msg.id }, msg);
          break;
        case 'playCry':
          p.playCry(msg.species != null ? msg.species : msg.index != null ? { index: msg.index } : msg.dex, msg);
          break;
        case 'waitForSfx':
          p.waitForSfx(msg.token);
          break;
        case 'setMasterVolume':
          p.setMasterVolume(msg.value);
          break;
        case 'pause':
          p.pause();
          break;
        case 'resume':
          p.resume();
          break;
        case 'setLowHealthAlarm':
          p.setLowHealthAlarm(msg.on);
          break;
        case 'duck':
          p.duck(msg.on);
          break;
        case 'pauseMusic':
          p.pauseMusic(msg.on);
          break;
        case 'mute':
          p.apu.muted = (msg.channels || [false, false, false, false]).map(Boolean);
          break;
        case 'stateInterval':
          p.stateInterval = msg.frames | 0;
          break;
        case 'getState':
          this.port.postMessage({ ...p.state(), token: msg.token });
          break;
        default:
          this.port.postMessage({ type: 'warn', message: `unknown message ${msg.type}` });
      }
    } catch (err) {
      this.port.postMessage({ type: 'error', message: String((err && err.stack) || err) });
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const n = out[0].length;
    if (this.scratchL.length < n) {
      this.scratchL = new Float32Array(n);
      this.scratchR = new Float32Array(n);
    }
    const L = out[0];
    const R = out.length > 1 ? out[1] : this.scratchR;
    try {
      this.player.render(L, R, n);
    } catch (err) {
      L.fill(0);
      R.fill(0);
      if (!this.crashed) {
        this.crashed = true;
        this.port.postMessage({ type: 'error', message: String((err && err.stack) || err) });
      }
    }
    if (out.length === 1) for (let i = 0; i < n; i++) L[i] = 0.5 * (L[i] + R[i]);
    return true;
  }
}

registerProcessor('gb-apu', GbApuProcessor);
