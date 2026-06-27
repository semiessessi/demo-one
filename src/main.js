import { generateScene, generateTestScene, generateBase, gatherChunk } from './scene.js';
import { NUM_SEGMENTS } from './journey.js';
import { createBackend } from './backends/index.js';
import { createAudioManager } from './audio.js';
import { createMorphState } from './morphState.js';
import { N_BANDS } from './constants.js';
import { detectDevice } from './device.js';

// --- Generate the static volume -------------------------------------------
const params = new URLSearchParams(location.search);
const TEST = params.has('test');
// Deterministic capture mode for renderer-comparison baselines: fixed time +
// camera, no UI. e.g. ?capture&cam=main-overview&t=8  or  ?test&capture&t=3.75
const CAPTURE = params.has('capture');

// Mobile gets a lighter scene. Modern iPadOS Safari reports a *desktop* UA, so detectDevice() keys
// off navigator.maxTouchPoints to spot touch devices.
const { isMobile } = detectDevice();
// Scale knobs: ?objects=N (&lpo=N). Mobile defaults to a smaller field (the volume auto-scales with
// the count, so the look holds) to cut data-texture size + GPU fill.
const objectsParam = parseInt(params.get('objects'), 10);
const lpoParam = parseInt(params.get('lpo'), 10);
const genOpts = {
  targetObjects: Number.isFinite(objectsParam) ? objectsParam : isMobile ? 1000 : undefined,
  lightsPerObject: Number.isFinite(lpoParam) ? lpoParam : isMobile ? 18 : undefined,
};
// Heavy scene generation runs off the main thread (mirrors sampleDurations.worker.js) so the
// fade-up stays smooth and the tab never locks while ~5000 objects + their light/occluder/
// reflection lists are built. TEST/CAPTURE stay synchronous (small / deterministic baselines).
function gatherInWorkers(opts, chunks) {
  return Promise.all(Array.from({ length: chunks }, (_, c) => new Promise((resolve) => {
    const w = new Worker(new URL('./sceneGen.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { w.terminate(); resolve(e.data); };
    w.postMessage({ opts, chunk: c, chunks });
  })));
}
// (scene generation is staged below: a first batch synchronously on main for a fast first frame,
// then the rest gathered in background workers and hot-swapped via backend.updateScene.)

// Concatenate the per-worker object slices and re-derive the global offsets onto the base objects
// (regenerated identically by every worker; chunk 0 returned the canonical set). Verified
// bit-identical to single-threaded generateScene().
function mergeSceneParts(base, parts) {
  parts.sort((a, b) => a.start - b.start);
  const { objects, lights, sphereR } = base;
  for (const o of objects) { o.lightOffset = o.lightCount = o.shadowOffset = o.shadowCount = o.reflOffset = o.reflCount = 0; } // objects outside the gathered slices stay empty (progressive: not yet gathered)
  const merge = (idxKey, cntKey, offP, cntP) => {
    let total = 0; for (const p of parts) total += p[idxKey].length;
    const out = new Float32Array(total); let off = 0;
    for (const p of parts) {
      out.set(p[idxKey], off);
      let local = off;
      for (let i = 0; i < p[cntKey].length; i++) {
        const o = objects[p.start + i];
        o[offP] = local; o[cntP] = p[cntKey][i]; local += p[cntKey][i];
      }
      off += p[idxKey].length;
    }
    return out;
  };
  const lightIndices = merge('lightIndices', 'lightCounts', 'lightOffset', 'lightCount');
  const occluderIndices = merge('occluderIndices', 'shadowCounts', 'shadowOffset', 'shadowCount');
  const reflectionIndices = merge('reflectionIndices', 'reflCounts', 'reflOffset', 'reflCount');
  return { objects, lights, lightIndices, occluderIndices, reflectionIndices, sphereR };
}
// Progressive load: regenerate the (deterministic) base, then gather only a first batch of objects
// on the main thread so the FIRST FRAME lands fast (clouds + the first objects + their lights). The
// rest is gathered in background workers and hot-swapped in below — objects spawn in gradually, so
// the full lighting arrives long before most are visible.
const progressiveBase = (TEST || CAPTURE) ? null : generateBase(genOpts);
const FIRST_BATCH = 200; // objects lit before the first frame (well ahead of the early spawn-in)
const WORKERS = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8));
const sceneData = TEST ? generateTestScene()
  : CAPTURE ? generateScene(genOpts)
  : mergeSceneParts(progressiveBase, [gatherChunk(progressiveBase, 0, Math.min(FIRST_BATCH, progressiveBase.objects.length))]);
const { objects, lights } = sceneData;
// Note-stepped morph: per-object position walks the journey sequence on the music (CPU
// state); the current p per object is uploaded to the shaders each frame via setMorph.
const morphState = createMorphState(objects.length);

// Objects are distance-sorted (closest to the origin first), so the instance index is
// the spawn rank: index 0 spawns first and is the intro camera's focal object.
const introTarget = objects[0].pos;

// --- Backend (WebGL2) -----------------------------------------------------
const app = document.getElementById('app');
const backend = await createBackend({ ...sceneData, test: TEST, capture: CAPTURE, introTarget, lowGfx: isMobile });
app.appendChild(backend.domElement);
window.addEventListener('pagehide', () => backend.dispose?.(), { once: true }); // free GPU + input listeners if the page is bfcached / unloaded
if (isMobile) backend.setClouds({ ...backend.cloudDefaults, cloudsOn: false }); // the fullscreen cloud raymarcher is the big mobile fill-rate cost -> off on mobile

// Stream the wrackdm17 level in after the first frame (never blocks first paint): it floats above
// the cloud deck and is revealed as the camera rises out of the clouds.
if (!TEST && !CAPTURE) {
  backend.loadBspMap('/wrackdm17.bsp')
    .then((info) => console.log(`[map] wrackdm17: ${info.triangles | 0} tris, ${info.mapLights} lamps, ${info.occluders} shadow brushes, ${info.glows} glows`))
    .catch((e) => console.warn('[map] load failed', e));
}

// Finish the scene in the background: gather every object's lists across workers, then hot-swap the
// light/occluder/reflection buffers in. Until this lands only the first batch is lit (which is all
// that has spawned yet).
if (progressiveBase) {
  gatherInWorkers(genOpts, WORKERS)
    .then((parts) => backend.updateScene(mergeSceneParts(progressiveBase, parts)))
    .catch((e) => console.warn('[scene] background gather failed; first batch stays', e));
}

// Fade up from black once the first frame is on screen — covers the bundle load + scene
// build + first render. The demo autostarts visually, so this just reveals it cleanly.
const fadeEl = document.getElementById('fade');
let revealed = false;
function reveal() { if (revealed) return; revealed = true; fadeEl?.classList.add('gone'); }
if (CAPTURE) { fadeEl?.style.setProperty('transition', 'none'); reveal(); } // no fade for deterministic captures
else setTimeout(reveal, 6000); // safety fallback if a frame never lands

if (TEST) backend.setView({ position: [4, 3.5, 9], target: [0, -1, 0] });

// --- UI -------------------------------------------------------------------
const scrub = document.getElementById('scrub');
const label = document.getElementById('label');
const playToggle = document.getElementById('playToggle');
const orbitToggle = document.getElementById('orbitToggle');
const muteToggle = document.getElementById('muteToggle');
const volume = document.getElementById('volume');
const info = document.getElementById('info');
const toast = document.getElementById('toast');
let playing = false; // demo loads paused, with the controls pane open
// "Click for sound" is shown only after audio has been *trying* to start for this long and
// still isn't running — so sessions where the browser permits autoplay never flash the prompt.
const AUDIO_PROMPT_GRACE_MS = 900;
let audioAttemptAt = Infinity; // performance.now() of the last audio (re)start attempt
let morphTime = 0;
let lightTime = 0; // separate clock for the orbiting lights (advances when lightsMoving)
let lightsMoving = true; // light orbit on by default; toggle with the ✦ button or L
// pdx-gfx spawn-count curve: a slow intro (5*(t/5)^1.3) then exponential DOUBLING
// (5*2^(t-5)), fed to the shader as uSpawn — so the visible count doubles. Driven by the
// NOTE count (scalePhase) so objects + their light clouds come in ON THE MUSIC, not a timer;
// SPAWN_NOTE_SCALE tunes the fill rate (≈ full field by the end of the ~45s orbit).
const SPAWN_NOTE_SCALE = 0.03; // 5x slower fill — objects + lights trickle in gradually
function demoSpawnCount(t) {
  const D = 5.0, C = 5.0;
  return t < D ? C * Math.pow(t / D, 1.3) : C * Math.pow(2.0, (t - D) / 1.0);
}
// Music-reactive light flares: sample the spectrum, detect a beat per band (spectral
// flux clearly above a running average), flare that band's envelope and re-roll its
// subset seed, then decay the envelope toward zero so the lights blink with the music
// and go dark when it's silent.
const slotNote = new Uint8Array(N_BANDS); // per-slot note-on flags, consumed each frame
const slotPitch = new Uint8Array(N_BANDS); // per-slot note pitch (1..120), consumed each frame
const slotInst = new Uint8Array(N_BANDS);  // per-slot note instrument, consumed each frame
const beatDecay = new Float32Array(N_BANDS).fill(1); // per-slot pulse-decay factor (1 = neutral)
const beatTime = new Float32Array(N_BANDS).fill(-1000); // last note-on time; far-negative = no flare yet
const beatStrength = new Float32Array(N_BANDS); // flare strength of each slot's last note-on
const beatSeed = new Float32Array(N_BANDS); // per-slot note seed; re-rolled each note -> a fresh light subset
let noteCounter = 0; // ever-increasing; stamped into beatSeed[slot] on each note-on
let scaleNotes = 0; // total note-ons; drives the pdx music-scale
let scalePhase = 0; // exp-smoothed scaleNotes (NoteChase=12) -> uScaleNotes
let musicLevel = 0; // 0..1 note-density "amplitude" driving the fly-camera speed
// Brightness ripples: a few spherical waves emanate from random world points on loud beats.
const N_RIPPLES = 4;
const rippleData = new Float32Array(N_RIPPLES * 4); // (centre.xyz, startTime) per ripple
let rippleHead = 0;
let lastRippleTime = -1;
const rippleR = objects.reduce((m, o) => Math.max(m, Math.abs(o.pos[0]), Math.abs(o.pos[2])), 0) * 0.6;
let musicClock = 0; // ever-increasing music clock; beat timestamps live in these units
let synthBeat = 0; // accumulator for the synthetic beat that drives the no-audio autostart
let lastBeatTime = -1000; // time of the last note-on (any slot) -> the early beat "thud"
let beatTickCounter = 0; // marches beat-sample pulses (basstick/thumper) through the light slots
// Real sample-length decay (off the main thread): a worker parses the .it's sample/instrument
// tables for each instrument's C-5 sample length; once ready, each slot's decay eases from the
// pitch proxy toward the sample-length factor over the first DECAY_FADE_SECS of play.
let instrumentDur = null;
let instrumentNames = null;
let instrumentBoost = null; // per-instrument beat-pulse kind: 0 none, 1 basstick (early), 2 thumper (later)
const DECAY_FADE_SECS = 30;
try {
  const sdWorker = new Worker(new URL('./sampleDurations.worker.js', import.meta.url), { type: 'module' });
  sdWorker.onmessage = (e) => {
    instrumentDur = e.data.dur;
    instrumentNames = e.data.names;
    // Classify each instrument once (was a per-beat label.includes() in the hot updateMusic loop).
    instrumentBoost = instrumentNames.map((n) => (n.includes('basstick') ? 1 : n.includes('thumper') ? 2 : 0));
    sdWorker.terminate(); // one-shot: free the worker once it has posted the durations
  };
} catch (e) { /* enhancement only — stays on the pitch proxy */ }
// Flash on REAL tracker note-ons (no FFT): audio.js reads the .it's note column per
// channel and folds the channels into N_BANDS slots. A note-on stamps that slot's beat;
// the shader then fades each light at its own rate. A light maps to a slot via idx % N_BANDS.
function updateMusic(dt) {
  musicClock += dt;
  audio.consumeNotes(slotNote, slotPitch, slotInst);
  if (playing && !audio.isRunning) {
    // Autostart before a user gesture (audio can't play yet): synthesise a beat so the demo
    // plays visually — shapes spawn, morph + lights flash — until the user clicks for sound.
    synthBeat += dt;
    if (synthBeat >= 0.3) { synthBeat = 0; for (let n = 0; n < 3; n++) slotNote[(Math.random() * N_BANDS) | 0] = 1; }
  }
  let notes = 0;
  for (let b = 0; b < N_BANDS; b++) {
    if (slotNote[b]) {
      beatTime[b] = musicClock;
      beatStrength[b] = 2.5; // strong beat->brightness flare (was 1.3 — wasn't punching enough)
      beatSeed[b] = ++noteCounter; // fresh seed -> a different ~12% subset of this slot flares
      let decay = 0.3 + slotPitch[b] / 120.0 * 1.4; // pitch proxy: low pitch (bass) -> slower decay
      if (instrumentDur) {
        const dur = instrumentDur[slotInst[b]] || 0; // this note's instrument's C-5 sample length (s)
        if (dur > 0) {
          const sampleDecay = 1.8 - Math.min(1, dur / 2.5) * 1.55; // long sample -> slower decay
          const fadeIn = Math.min(1, musicClock / DECAY_FADE_SECS); // ease the effect in over ~30s
          decay = decay * (1 - fadeIn) + sampleDecay * fadeIn;
        }
      }
      beatDecay[b] = decay;
      notes++;
    }
  }
  scaleNotes += notes;
  // Beat samples drive a marching light pulse: "basstick" is emphasised early (fades by ~15s),
  // "thumper" is an important later beat. Each hit pulses a different slot (scrambled %32 march)
  // with a fresh light subset, so a long, non-repeating set of lights reacts to the beat.
  const tickBoost = musicClock < 12 ? 1 : (musicClock > 15 ? 0 : 1 - (musicClock - 12) / 3);
  if (instrumentBoost) {
    for (let b = 0; b < N_BANDS; b++) {
      if (!slotNote[b]) continue;
      const kind = instrumentBoost[slotInst[b]] || 0; // 1 basstick (early-focused), 2 thumper (throughout)
      const boost = kind === 1 ? tickBoost : kind === 2 ? 1.0 : 0;
      if (boost > 0) {
        const target = (beatTickCounter * 13) % N_BANDS; // scrambled march through the slots
        beatTickCounter++;
        beatTime[target] = musicClock;
        beatStrength[target] = 2.5 + boost * 5.0;        // boosted pulse on a fresh slot
        beatSeed[target] = ++noteCounter;                // a fresh light subset each hit
      }
    }
  }
  scalePhase += (scaleNotes - scalePhase) * (1 - Math.exp(-12 * dt)); // pdx NoteChase = 12
  for (let n = 0; n < notes; n++) morphState.onNote(musicClock); // each note steps ~5% of shapes
  if (notes > 0) lastBeatTime = musicClock; // last beat (any slot) drives the early thud
  backend.setMusic(musicClock, beatTime, beatStrength, beatSeed, scalePhase, beatDecay, lastBeatTime);
  musicLevel = Math.min(1, musicLevel * Math.exp(-dt / 0.4) + notes * 0.25); // busy = loud, calm ~ 0
  backend.setMusicLevel(musicLevel);
  // Loud beat (high note density), throttled to ~the beat rate -> a new ripple. Off in calm patches.
  if (musicClock >= 35.0 && musicLevel > 0.5 && notes > 0 && musicClock - lastRippleTime > 0.35) { // hold the expanding-sphere waves until 35s in
    rippleData[rippleHead * 4 + 0] = (Math.random() * 2 - 1) * rippleR;
    rippleData[rippleHead * 4 + 1] = (Math.random() * 2 - 1) * rippleR * 0.5;
    rippleData[rippleHead * 4 + 2] = (Math.random() * 2 - 1) * rippleR;
    rippleData[rippleHead * 4 + 3] = musicClock;
    rippleHead = (rippleHead + 1) % N_RIPPLES;
    lastRippleTime = musicClock;
  }
  backend.setRipples(rippleData);
}
const SCRUB_SPAN = (2 * NUM_SEGMENTS) / 0.5; // nominal ping-pong period (s)

label.textContent = `${objects.length} objects · ${lights.length} lights`;

// Background music. The module is fetched now (while the controls pane is on
// screen) so the first play starts without a download wait; audio can only
// begin inside the user gesture that calls audio.play() (autoplay policy).
const audio = createAudioManager();
audio.prefetch();
audio.setVolume(volume.value / 100);

const togglePane = () => info.classList.toggle('open');
let firstPlay = true;
let toastTimer = 0;
function showControlsToast() {
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 6000);
}

// Single entry point for play/pause (used by the button and the P key). The
// first time the demo starts, the pane slides away and a toast reminds the
// user that Tab brings it back.
function setPlaying(next) {
  playing = next;
  playToggle.textContent = next ? '❚❚' : '▶';
  if (next) {
    // Restart the whole sequence from the top: every clock, the camera intro, the music.
    morphTime = 0;
    lightTime = 0;
    musicClock = 0;
    beatTime.fill(-1000); // far in the past so nothing flares at musicClock 0 (no weird startup lights)
    beatStrength.fill(0);
    beatSeed.fill(0);
    noteCounter = 0;
    scaleNotes = 0;
    scalePhase = 0;
    musicLevel = 0;
    beatDecay.fill(1);
    rippleData.fill(0);
    lastRippleTime = -1;
    synthBeat = 0;
    beatTickCounter = 0;
    morphState.reset();
    scrub.value = '0';
    backend.setTime(0);
    backend.setLightTime(0);
    backend.startIntro(); // replay the orbit-and-pull-back camera intro
    audio.restart(); // restart the music from the beginning
    audioAttemptAt = performance.now(); // start the grace clock for the "click for sound" prompt
    if (firstPlay) {
      firstPlay = false;
      info.classList.remove('open');
      showControlsToast();
    }
  } else {
    audio.pause();
  }
}

scrub.addEventListener('input', () => {
  // Scrubbing nudges the morph clock only; the music keeps looping.
  playing = false;
  playToggle.textContent = '▶';
  morphTime = (scrub.value / 1000) * SCRUB_SPAN;
  backend.setTime(morphTime);
});
playToggle.addEventListener('click', () => setPlaying(!playing));
muteToggle.addEventListener('click', () => {
  muteToggle.textContent = audio.toggleMute() ? '🔇' : '🔊';
});
volume.addEventListener('input', () => audio.setVolume(volume.value / 100));

// Light-orbit movement toggle (independent of play/pause; pdx-gfx LightFlags style).
// When off, lightTime stops advancing so the lights freeze in place (still spread on
// their orbit spheres, outside their hosts) rather than collapsing.
function setLightsMoving(next) {
  lightsMoving = next;
  orbitToggle.textContent = next ? '✦' : '✧';
  orbitToggle.classList.toggle('off', !next);
  orbitToggle.setAttribute('aria-pressed', String(next));
}
orbitToggle.addEventListener('click', () => setLightsMoving(!lightsMoving));

// Reveal the controls pane shortly after load so it animates in.
if (!CAPTURE) setTimeout(() => info.classList.add('open'), 80);

// The demo plays on its own. It autostarts shortly after load (so it's already running by the
// time the opening fade clears) and the music comes with it WHEREVER the browser permits
// autoplay. Where audio is blocked until a user gesture, the demo still runs — silently — and
// the "click for sound" prompt asks for one; the first interaction of ANY kind (tap, click,
// key, scroll) then (re)starts it from the top WITH sound, so music and visuals stay in sync.
if (!CAPTURE && !TEST) {
  // Start playing on the first gesture, then resume the audio context on EVERY gesture until it's
  // actually running — iOS needs the resume() inside a tap, and a single autostart-created context
  // stays suspended, so one-shot handlers (and the prior `kicked` guard) left iPad silent on tap.
  // If the browser blocked autoplay, the demo has been running SILENTLY (synthetic beats) and is
  // already past its opening. The first gesture is what unlocks sound — so restart the whole demo
  // from the top WITH sound, so the music always lines up with the same parts of the visuals.
  // Once sound is actually playing (autoplay worked, or a gesture already unlocked it), later
  // gestures leave the running demo alone.
  let soundUnlocked = false;
  const kickoff = () => {
    audio.resumeContext(); // iOS: must run inside the gesture; no-op once the context is running
    if (soundUnlocked) return;
    if (audio.isRunning) { soundUnlocked = true; return; } // autoplay already gave us synced sound
    soundUnlocked = true;
    setPlaying(true); // restart from the top with sound -> music + visuals in sync
  };
  ['pointerdown', 'touchstart', 'click', 'keydown', 'wheel'].forEach((ev) =>
    window.addEventListener(ev, kickoff, { passive: true }));
  setTimeout(() => { if (!playing) setPlaying(true); }, 600); // autostart promptly, right behind the fade
}

// --- FPS / frame-time overlay (off by default, toggle with 'f') ------------
// "Click for sound" prompt: shown ONLY while the demo is playing but the browser is still
// blocking audio after the grace window (no gesture yet, and autoplay not permitted). Where
// autoplay is allowed the sound just starts and this never appears. Driven per-frame below.
const startEl = document.getElementById('start');

const statsEl = document.getElementById('stats');
const isLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname);
let statsOn = isLocalhost; // stats on by default on localhost
statsEl.style.display = statsOn ? 'block' : 'none';
// Off localhost: hide all the UI chrome — just let the demo run.
if (!isLocalhost) for (const id of ['controls', 'info', 'toast']) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}
// 'i' note overlay: shows the tracker note names currently sounding, to find a beat to sync to.
const notesEl = document.getElementById('notes');
let notesOn = false;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (v) => (v > 0 ? NOTE_NAMES[(v - 1) % 12] + '-' + Math.floor((v - 1) / 12) : '');
let emaMs = 16.7;
let lastNow = performance.now();
let statsAcc = 0;
// FPS autoscaler state (runs for everyone; the localhost GUI tunes target/auto).
let qualityScale = isMobile ? 0.4 : 1; // lower starting quality on mobile; the autoscaler ramps from here
let lastQAdjust = 0;
// Desktop can climb PAST 1.0 to ENRICH the scene when the GPU budget has room (more cloud-march steps,
// more per-object lights, richer cloud reflections — every round(N*s) lever scales up; god rays /
// displacement / shadows stay at their bounds). The self-limiting budget stops it before it overshoots.
const QUALITY_MAX = isMobile ? 1 : 2;
const perf = { auto: true, targetFps: isMobile ? 45 : 90 }; // desktop targets 90 via the GPU timer (vsync stays on; falls back to 60 if no timer)
if (qualityScale !== 1) backend.setQualityScale(qualityScale); // apply the mobile start now (the controller only adjusts every 500ms)

// --- Localhost-only debug controls: toggle the geometry + light sprites -----
// lil-gui is dynamically imported, so end users off localhost never download it.
const debugState = { geometry: true, sprites: true, map: true };
const cloudParams = { ...backend.cloudDefaults }; // seeded from the backend's defaults
let debugGui = null;
let debugFrameHook = null; // per-frame debug-only update (live moon-elevation readout)
const syncDebugGui = () => debugGui?.controllersRecursive().forEach((c) => c.updateDisplay());
if (isLocalhost) {
  window.__backend = backend; // dev hook: drive the camera + cloud params from the console
  const { GUI } = await import('lil-gui');
  debugGui = new GUI({ title: 'debug' });
  debugGui.domElement.style.left = '0px';
  debugGui.domElement.style.right = 'auto'; // top-left, clear of the top-right fps overlay
  debugGui.add(debugState, 'geometry').name('geometry (g)').onChange((v) => backend.setGeometryVisible(v));
  debugGui.add(debugState, 'sprites').name('light sprites (b)').onChange((v) => backend.setSpritesVisible(v));
  debugGui.add(debugState, 'map').name('wrackdm17 (m)').onChange((v) => backend.setMapVisible(v));
  const applyClouds = () => backend.setClouds(cloudParams);
  const cf = debugGui.addFolder('clouds');
  cf.add(cloudParams, 'cloudsOn').name('clouds (c)').onChange(applyClouds);
  cf.add(cloudParams, 'coverage', 0, 1, 0.01).onChange(applyClouds);
  cf.add(cloudParams, 'density', 0, 3, 0.01).onChange(applyClouds);
  cf.add(cloudParams, 'base', 0, 110, 1).name('base height').onChange(applyClouds);
  cf.add(cloudParams, 'thick', 1, 45, 1).name('thickness').onChange(applyClouds);
  cf.add(cloudParams, 'noiseScale', 0.01, 0.15, 0.001).name('noise scale').onChange(applyClouds);
  cf.add(cloudParams, 'windX', -3, 3, 0.05).name('wind x').onChange(applyClouds);
  cf.add(cloudParams, 'windZ', -3, 3, 0.05).name('wind z').onChange(applyClouds);
  cf.add(cloudParams, 'quality', 8, 120, 1).name('quality (steps)').onChange(applyClouds);
  cf.add(cloudParams, 'farDeck').name('far deck (horizon)').onChange(applyClouds);
  const lookParams = { ...backend.lookDefaults };
  const applyLook = () => backend.setLook(lookParams);
  const lf = debugGui.addFolder('look');
  lf.add(lookParams, 'lightScale', 0, 1, 0.01).name('light brightness').onChange(applyLook);
  lf.add(lookParams, 'ampGain', 0, 30, 0.1).name('amp drive (30%)').onChange(applyLook);
  lf.add(lookParams, 'bloom', 0, 1, 0.01).name('bloom').onChange(applyLook);
  const clParams = { ...backend.cloudLightDefaults };
  const applyCloudLight = () => backend.setCloudLight(clParams);
  const clf = debugGui.addFolder('cloud light');
  clf.add(clParams, 'sunElev', -10, 90, 1).name('moon elevation').onChange(applyCloudLight);
  clf.add(clParams, 'sunAzim', 0, 360, 1).name('moon azimuth').onChange(applyCloudLight);
  clf.add(clParams, 'sunIntensity', 0, 4, 0.05).name('moon intensity').onChange(applyCloudLight);
  clf.add(clParams, 'ambient', 0, 3, 0.05).onChange(applyCloudLight);
  clf.add(clParams, 'hg', 0, 0.95, 0.01).name('phase (silver)').onChange(applyCloudLight);
  clf.add(clParams, 'powder', 0, 1, 0.01).onChange(applyCloudLight);
  clf.add(clParams, 'moonStrength', 0, 3, 0.05).name('moon on scene').onChange(applyCloudLight);
  clf.add(clParams, 'lightScatter', 0, 6, 0.1).name('lights -> cloud').onChange(applyCloudLight);
  clf.add(clParams, 'moonSize', 0, 20, 0.5).name('moon size').onChange(applyCloudLight);
  // God rays + silver-lining + per-channel tint (mean ~1 -> R>B = warm thin edges, cool depth).
  const grf = clf.addFolder('god rays + tint');
  grf.add(clParams, 'godrays').name('god rays ON').onChange(applyCloudLight); // OFF by default (looked bad over the sea)
  grf.add(clParams, 'godrayStrength', 0, 0.3, 0.005).name('god rays').onChange(applyCloudLight);
  grf.add(clParams, 'godrayDecay', 0.005, 0.1, 0.005).name('god ray reach').onChange(applyCloudLight);
  grf.add(clParams, 'hgBack', 0, 0.9, 0.01).name('silver back').onChange(applyCloudLight);
  grf.add(clParams, 'backMix', 0, 1, 0.01).name('silver mix').onChange(applyCloudLight);
  grf.add(clParams, 'extR', 0.6, 1.4, 0.01).name('tint R').onChange(applyCloudLight);
  grf.add(clParams, 'extG', 0.6, 1.4, 0.01).name('tint G').onChange(applyCloudLight);
  grf.add(clParams, 'extB', 0.6, 1.4, 0.01).name('tint B').onChange(applyCloudLight);
  const mrParams = { moonrise: true };
  clf.add(mrParams, 'moonrise').name('moonrise (-10->elev)').onChange((v) => backend.setMoonrise(v));
  // Live readout of the CURRENT moon elevation (the rise animates it from -10 up to 'moon elevation').
  // Read-only; confirms the moon disc + cloud moonlight track the same rising uSunDir.
  const moonLive = { elev: clParams.sunElev };
  const moonLiveCtrl = clf.add(moonLive, 'elev', -10, 90, 0.1).name('elevation (live)').disable();
  debugFrameHook = () => { moonLive.elev = Math.round(backend.sunElevDeg() * 10) / 10; moonLiveCtrl.updateDisplay(); };
  // Object materials: procedural-detail strength + the specular punch at the mirror/matte ends.
  // 'detail' is also FPS-autoscaled, so turn off 'perf > fps autoscale' to pin it while tweaking.
  const matParams = { ...backend.materialDefaults };
  const applyMaterials = () => backend.setMaterials(matParams);
  const matf = debugGui.addFolder('materials');
  matf.add(matParams, 'detail', 0, 1, 0.01).name('procedural detail').onChange(applyMaterials);
  matf.add(matParams, 'specBoostHi', 0, 40, 0.5).name('spec (metal)').onChange(applyMaterials);
  matf.add(matParams, 'specBoostLo', 0, 20, 0.5).name('spec (matte)').onChange(applyMaterials);
  const mapParams = { ...backend.mapDefaults };
  const applyMap = () => backend.setMap(mapParams);
  const mf = debugGui.addFolder('wrackdm17 (m)');
  mf.add(mapParams, 'lightScale', 0, 4, 0.05).name('lamp brightness').onChange(applyMap);
  mf.add(mapParams, 'glowScale', 0, 4, 0.05).name('glow brightness').onChange(applyMap);
  mf.add(mapParams, 'shadows').name('raytraced shadows').onChange(applyMap);
  const oceanParams = { ...backend.oceanDefaults };
  const applyOcean = () => backend.setOcean(oceanParams);
  const of = debugGui.addFolder('ocean');
  of.add(oceanParams, 'on').name('ocean').onChange(applyOcean);
  if (backend.hasFFT) of.add(oceanParams, 'fft').name('FFT waves').onChange(applyOcean);
  // Per-feature toggles to isolate the ugly high-quality water effect (override the autoscaler).
  of.add(oceanParams, 'reflect').name('planar reflection').onChange(applyOcean);
  of.add(oceanParams, 'relief').name('wave displacement').onChange(applyOcean);
  of.add(oceanParams, 'cloudRefl').name('cloud reflections').onChange(applyOcean);
  of.add(oceanParams, 'y', -200, 20, 1).name('sea level').onChange(applyOcean);
  of.add(oceanParams, 'wave', 0, 4, 0.05).name('wave height').onChange(applyOcean);
  of.add(oceanParams, 'freq', 0.02, 0.4, 0.005).name('wave freq').onChange(applyOcean);
  of.add(oceanParams, 'foam', 0, 2, 0.05).name('foam').onChange(applyOcean);
  of.add(oceanParams, 'foamThresh', 0.2, 1.2, 0.01).name('foam fold').onChange(applyOcean);
  of.add(oceanParams, 'crestFoam', 0, 1, 0.01).name('crest foam').onChange(applyOcean);
  of.add(oceanParams, 'disp', 0, 24, 1).name('wave relief').onChange(applyOcean);
  of.add(oceanParams, 'distort', 0, 1, 0.01).name('refl ripple').onChange(applyOcean);
  of.add(oceanParams, 'fog', 0, 0.03, 0.0005).name('horizon fade').onChange(applyOcean);
  of.addColor(oceanParams, 'color').name('water colour').onChange(applyOcean);
  of.addColor(oceanParams, 'scatter').name('scatter colour').onChange(applyOcean);
  of.add(oceanParams, 'scatterAmt', 0, 4, 0.05).name('scatter amt').onChange(applyOcean);
  const stParams = { ...backend.starDefaults };
  const applyStars = () => backend.setStars(stParams);
  const sf = debugGui.addFolder('stars');
  sf.add(stParams, 'size', 0, 6, 0.1).name('star size').onChange(applyStars);
  sf.add(stParams, 'twinkle', 0, 1, 0.01).onChange(applyStars);
  const pf = debugGui.addFolder('perf');
  pf.add(perf, 'auto').name('fps autoscale');
  pf.add(perf, 'targetFps', 30, 120, 1).name('target fps');
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'p' || e.key === 'P') {
    // Start/resume if the audio isn't actually running (e.g. a silent autoplay before a
    // gesture), otherwise toggle. Avoids the "press P twice" after the idle auto-play.
    if (!playing || !audio.isRunning) setPlaying(true); else setPlaying(false);
  }
  if (e.key === 'Tab') {
    e.preventDefault(); // don't shift focus between the on-screen controls
    togglePane();
  }
  if (e.key === 'f' || e.key === 'F') {
    statsOn = !statsOn;
    statsEl.style.display = statsOn ? 'block' : 'none';
  }
  if (e.key === 'i' || e.key === 'I') {
    notesOn = !notesOn;
    notesEl.style.display = notesOn ? 'block' : 'none';
  }
  if (e.key === 't' || e.key === 'T') {
    const u = new URL(location.href);
    if (u.searchParams.has('test')) u.searchParams.delete('test');
    else u.searchParams.set('test', '');
    location.href = u.toString(); // reload into/out of the test scene
  }
  if (e.key === 'l' || e.key === 'L') {
    setLightsMoving(!lightsMoving);
  }
  if (isLocalhost && (e.key === 'g' || e.key === 'G')) {
    debugState.geometry = !debugState.geometry;
    backend.setGeometryVisible(debugState.geometry);
    syncDebugGui();
  }
  if (isLocalhost && (e.key === 'b' || e.key === 'B')) {
    debugState.sprites = !debugState.sprites;
    backend.setSpritesVisible(debugState.sprites);
    syncDebugGui();
  }
  if (isLocalhost && (e.key === 'm' || e.key === 'M')) {
    debugState.map = !debugState.map;
    backend.setMapVisible(debugState.map);
    syncDebugGui();
  }
  if (isLocalhost && (e.key === 'c' || e.key === 'C')) {
    cloudParams.cloudsOn = !cloudParams.cloudsOn;
    backend.setClouds(cloudParams);
    syncDebugGui();
  }
});

window.addEventListener('resize', () => {
  backend.setSize(window.innerWidth, window.innerHeight);
});

// --- Capture mode: pin time + camera, hide UI for reproducible screenshots ---
if (CAPTURE) {
  const camPresets = {
    'main-overview': [[24, 17, 31], [0, 0, 0]],
    'main-close': [[11, 7, 15], [0, 0, 0]],
    test: [[4, 3.5, 9], [0, -1, 0]],
  };
  const preset = camPresets[params.get('cam')] || (TEST ? camPresets.test : camPresets['main-overview']);
  perf.auto = false; // pin quality at full for reproducible, machine-independent captures (no autoscaler drift)
  backend.setView({ position: preset[0], target: preset[1], damping: false });
  morphTime = parseFloat(params.get('t') || '0');
  backend.setTime(morphTime);
  lightTime = morphTime; // pin the orbit to t for deterministic captures
  backend.setLightTime(lightTime);
  playing = false;
  lightsMoving = false; // freeze the orbit so captures stay reproducible
  backend.setSpawn(objects.length + 5); // fully spawned-in for deterministic captures
  beatStrength.fill(1.0); // age 0 (lit); the per-note subset (fixed seed 0) stays deterministic
  beatTime.fill(0.0);
  beatSeed.fill(0.0);
  backend.setMusic(0, beatTime, beatStrength, beatSeed, 0, beatDecay, -1000); // scaleNotes=0 -> static scale; no thud
  for (const id of ['controls', 'info', 'toast', 'stats']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
}

// --- Render loop ----------------------------------------------------------
let lastFrame = performance.now();
function frame() {
  const t = performance.now();
  const dt = Math.min((t - lastFrame) / 1000, 0.05);
  lastFrame = t;
  if (playing) {
    morphTime += dt;
    scrub.value = String(Math.round(((morphTime % SCRUB_SPAN) / SCRUB_SPAN) * 1000));
  }
  if (lightsMoving) lightTime += dt;
  if (!CAPTURE) updateMusic(dt); // advances scalePhase (note count) used by the spawn below
  const morphP = morphState.step(musicClock); // CPU note-stepped morph -> per-object p
  if (morphState.dirty) { backend.setMorph(morphP); morphState.clearDirty(); } // skip the upload on calm frames

  backend.setTime(morphTime);
  backend.setLightTime(lightTime);
  // Spawn-in count from the music, then SHRINK the whole field back out over the finale climb
  // (fieldFade 0->1 ramps uSpawn back to 0 — the inverse of the spawn-in), so dm17 stands alone.
  if (!CAPTURE) {
    const spawnN = Math.min(objects.length + 2, demoSpawnCount(scalePhase * SPAWN_NOTE_SCALE));
    backend.setSpawn(spawnN * (1 - backend.fieldFade()));
  }
  const amp = audio.getAmplitude(); // measured RMS, once per frame (reused by the notes overlay below)
  if (!CAPTURE) backend.setAmplitude(amp); // -> amplitude-reactive lights
  // Prompt for a click ONLY if audio is genuinely blocked: we're playing, the context still
  // isn't running, and it's had its grace window to autostart — so allowed-autoplay sessions
  // (where the music just starts) never flash the prompt.
  if (startEl) {
    const audioBlocked = playing && !audio.isRunning && performance.now() - audioAttemptAt > AUDIO_PROMPT_GRACE_MS;
    startEl.classList.toggle('hidden', !audioBlocked);
  }
  backend.render();
  reveal(); // first frame is on screen — start the fade-up from black
  // TEMP (demo ending): once the finale has done its first 5 jump-pad bounces, fade the music down
  // and the screen to black over 7s (flycam.endFade is the 0..1 ramp). Remove to restore the loop.
  if (!CAPTURE) {
    const ef = backend.endFade ? backend.endFade() : 0;
    if (ef > 0) {
      audio.setVolume((volume.value / 100) * (1 - ef));
      if (fadeEl) { fadeEl.style.transition = 'none'; fadeEl.style.opacity = String(ef); }
    }
  }
  debugFrameHook?.(); // live moon-elevation readout (localhost debug GUI only)

  // Measure real frame time.
  emaMs = emaMs * 0.9 + (t - lastNow) * 0.1;
  lastNow = t;
  // FPS autoscaler: hold the target fps by shedding the heaviest work (cloud steps + shadow/
  // reflection/light caps) when slow, restoring it when there's headroom.
  if (perf.auto && t - lastQAdjust > 100) {
    lastQAdjust = t;
    // Prefer the GPU timer (finer than vsync) so we can target >60 with vsync on; otherwise fall back
    // to the wall clock, whose target is capped at 60 (it can never read higher than the refresh rate).
    const gpuMs = backend.gpuFrameMs ? backend.gpuFrameMs() : 0;
    const useGpu = gpuMs > 0.05;
    const fps = 1000 / (useGpu ? gpuMs : emaMs);
    const target = useGpu ? perf.targetFps : Math.min(perf.targetFps, 60);
    // Sampled at ~100ms (was 500ms) for snappier response, with the per-tick step cut ~5x so the slew
    // rate is unchanged — finer granularity means it settles smoothly instead of stepping in big jumps.
    // The target-6 .. target+8 dead-zone is the hysteresis that stops it oscillating; only re-apply the
    // uniforms when the scale actually moved so the 10Hz tick is otherwise free.
    const prev = qualityScale;
    if (fps < target - 6) qualityScale = Math.max(isMobile ? 0.12 : 0.3, qualityScale - (isMobile ? 0.036 : 0.024));
    else if (fps > target + 8) qualityScale = Math.min(QUALITY_MAX, qualityScale + 0.012); // climb past 1.0 to enrich when there's headroom
    if (qualityScale !== prev) backend.setQualityScale(qualityScale);
  }
  if (statsOn) {
    statsAcc += 1;
    if (statsAcc >= 8) {
      const gMs = backend.gpuFrameMs ? backend.gpuFrameMs() : 0; // GPU render time (finer than vsync)
      const gpuLine = gMs > 0.05 ? `\n${gMs.toFixed(2)} ms gpu (${(1000 / gMs).toFixed(0)})` : '';
      statsEl.textContent = `${(1000 / emaMs).toFixed(0)} fps\n${emaMs.toFixed(2)} ms${gpuLine}\n♪ ${musicClock.toFixed(1)}s`;
      statsAcc = 0;
    }
  }
  if (notesOn) {
    const bars = Math.min(28, Math.round(amp * 90)); // output RMS -> a level bar (reuses the cached amp)
    let s = `♪ ${musicClock.toFixed(2)}s\namp ${'█'.repeat(bars)}${'░'.repeat(28 - bars)}\n`;
    for (let b = 0; b < N_BANDS; b++) {
      if (musicClock - beatTime[b] < 0.4 && slotPitch[b] > 0) {
        const label = (instrumentNames && instrumentNames[slotInst[b]]) || `inst ${slotInst[b]}`;
        s += `${noteName(slotPitch[b]).padEnd(5)} ${label}\n`; // note + instrument/sample name
      }
    }
    notesEl.textContent = s;
  }

  requestAnimationFrame(frame);
}
frame();
