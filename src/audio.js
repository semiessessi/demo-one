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

  return {
    prefetch,
    play,
    pause,
    setVolume,
    setMuted,
    toggleMute,
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
