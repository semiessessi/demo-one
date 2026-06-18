// --- Background music (chiptune3 / libopenmpt AudioWorklet) -----------------
// Plays the tracker module x-engage.it ("Engage" by djduck). chiptune3 renders
// the module on the AudioWorklet thread, so synthesis never competes with the
// render loop in main.js. The chiptune3 runtime is vendored under
// /public/chiptune/ and imported from there at runtime (kept out of the Vite
// bundle so its relative worklet imports resolve cleanly in dev and prod).

import { ChiptuneJsPlayer } from './vendor/chiptune3.js';

const MODULE_URL = '/x-engage.it';
const DEFAULT_VOLUME = 0.7;
const FADE_IN = 1.0; // s, eases in the first time playback starts
const RAMP = 0.15; // s, smooths pause / resume / volume / mute

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function createAudioManager() {
  let modulePromise = null; // Promise<ArrayBuffer | null>
  let player = null;
  let started = false; // start() has been called (player is being/has been built)
  let wantPlaying = false; // user intent, honoured once the worklet is ready
  let paused = false; // worklet synthesis is currently suspended
  let muted = false;
  let failed = false; // audio unavailable — degrade silently
  let volume = DEFAULT_VOLUME;
  const N_SLOTS = 32; // light "bands": tracker channels are folded into this many slots
  const noteFlags = new Uint8Array(N_SLOTS); // pending note-ons per slot (set on note, cleared on consume)
  const notePitch = new Uint8Array(N_SLOTS); // last note pitch (1..120) per slot -> drives pulse decay
  const noteInst = new Uint8Array(N_SLOTS);  // last note instrument per slot -> sample-length decay
  let noteShift = 0; // rotates the channel->slot map each row so every slot cycles even with few tracks

  // Fetch the ~3.9 MB module up front (while the info pane is on screen) so the
  // first play starts immediately rather than waiting on the download.
  function prefetch() {
    if (!modulePromise) {
      modulePromise = fetch(MODULE_URL)
        .then((r) => {
          if (!r.ok) throw new Error(`fetch ${MODULE_URL} -> ${r.status}`);
          return r.arrayBuffer();
        })
        .catch((e) => {
          console.warn('[audio] module prefetch failed', e);
          return null;
        });
    }
    return modulePromise;
  }

  function rampTo(target, time) {
    if (!player) return;
    const g = player.gain.gain;
    const t = player.context.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(target, t + time);
  }

  // Build the player lazily, INSIDE the user gesture that first calls play() —
  // constructing the AudioContext here is what unlocks audio under the browser
  // autoplay policy.
  function start() {
    try {
      player = new ChiptuneJsPlayer({ repeatCount: -1 }); // -1 = loop forever
      player.gain.gain.value = 0; // silent until we fade in
      // Flash on real tracker note-ons (no FFT): the worklet reads the .it note column
      // per channel on each row and posts it here; fold those channels into N_SLOTS slots.
      player.onRow((d) => {
        if (muted || paused) return;
        noteShift = (noteShift + 1) % N_SLOTS; // advance the rotation each row
        const notes = d.notes;
        const insts = d.instruments;
        for (let c = 0; c < notes.length; c++) {
          const note = notes[c];
          if (note > 0 && note < 254) { const s = (c + noteShift) % N_SLOTS; noteFlags[s] = 1; notePitch[s] = note; if (insts) noteInst[s] = insts[c]; } // real note-on
        }
      });
      player.onError((err) => console.warn('[audio] chiptune error', err));
      player.onInitialized(async () => {
        try {
          if (player.context.state === 'suspended') await player.context.resume();
        } catch (_) {
          /* ignore */
        }
        const data = await prefetch();
        if (data) player.play(data); // play from the prefetched bytes
        else player.load(MODULE_URL); // fallback: let chiptune fetch it itself
        if (wantPlaying) {
          paused = false;
          rampTo(muted ? 0 : volume, FADE_IN);
        } else {
          // user paused again before the worklet finished initialising
          player.pause();
          paused = true;
          player.gain.gain.value = 0;
        }
      });
    } catch (e) {
      console.warn('[audio] unavailable; continuing without music', e);
      failed = true;
      player = null;
    }
  }

  function play() {
    if (failed) return;
    wantPlaying = true;
    if (!started) {
      started = true;
      start();
      return;
    }
    if (paused) {
      paused = false;
      player.unpause();
      rampTo(muted ? 0 : volume, RAMP);
    }
  }

  // Restart the module from the very beginning (used when the demo sequence is
  // restarted). On the first call this is just a normal start; afterwards it
  // replays the module from row 0.
  function restart() {
    if (failed) return;
    wantPlaying = true;
    paused = false;
    if (!started) { // first time: build the player (it plays from the top once ready)
      started = true;
      start();
      return;
    }
    if (!player) return; // still initialising; onInitialized will honour wantPlaying
    if (player.context.state === 'suspended') player.context.resume().catch(() => {});
    prefetch().then((data) => {
      if (!player || !wantPlaying) return;
      if (data) player.play(data); // reload + play from the start
      else player.load(MODULE_URL);
      rampTo(muted ? 0 : volume, RAMP);
    });
  }

  function pause() {
    wantPlaying = false;
    if (!player || paused) return; // player may still be initialising
    paused = true;
    rampTo(0, RAMP); // fade out first so we don't click
    setTimeout(() => {
      if (paused && player) player.pause();
    }, RAMP * 1000 + 20);
  }

  function setVolume(v) {
    volume = clamp01(v);
    if (player && !muted && !paused) rampTo(volume, RAMP);
  }

  function setMuted(m) {
    muted = m;
    if (!player) return;
    if (muted) rampTo(0, RAMP);
    else if (!paused) rampTo(volume, RAMP);
  }

  function toggleMute() {
    setMuted(!muted);
    return muted;
  }

  // Copy the pending per-slot note-on flags into `out` (1 = a note fired in that slot
  // since the last call) and clear them, so each note-on triggers exactly one flash.
  function consumeNotes(out, outPitch, outInst) {
    for (let i = 0; i < out.length; i++) {
      out[i] = i < noteFlags.length ? noteFlags[i] : 0;
      if (outPitch) outPitch[i] = i < notePitch.length ? notePitch[i] : 0;
      if (outInst) outInst[i] = i < noteInst.length ? noteInst[i] : 0;
      if (i < noteFlags.length) noteFlags[i] = 0;
    }
    return out;
  }

  return {
    prefetch,
    play,
    restart,
    pause,
    setVolume,
    setMuted,
    toggleMute,
    consumeNotes,
    get isRunning() {
      return !!(player && player.context && player.context.state === 'running');
    },
    get isStarted() {
      return started;
    },
    get isPaused() {
      return paused;
    },
    get isMuted() {
      return muted;
    },
    get volume() {
      return volume;
    },
  };
}
