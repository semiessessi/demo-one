import { generateScene, generateTestScene } from './scene.js';
import { NUM_SEGMENTS } from './journey.js';
import { createBackend } from './backends/index.js';
import { createAudioManager } from './audio.js';

// --- Generate the static volume -------------------------------------------
const params = new URLSearchParams(location.search);
const TEST = params.has('test');
// Deterministic capture mode for renderer-comparison baselines: fixed time +
// camera, no UI. e.g. ?capture&cam=main-overview&t=8  or  ?test&capture&t=3.75
const CAPTURE = params.has('capture');

// Scale knobs for stress testing: ?objects=N (&lpo=N for lights per object).
const objectsParam = parseInt(params.get('objects'), 10);
const lpoParam = parseInt(params.get('lpo'), 10);
const sceneData = TEST ? generateTestScene() : generateScene({
  targetObjects: Number.isFinite(objectsParam) ? objectsParam : undefined,
  lightsPerObject: Number.isFinite(lpoParam) ? lpoParam : undefined,
});
const { objects, lights } = sceneData;

// Focus the intro camera on the object that spawns first (lowest spawn slot), so it's
// on screen from the first frame of the orbit. Mirrors spawnSlot() in shaders/lib.glsl.
const spawnSlot = (i) => {
  let s = ((Math.imul(i, 2654435761) >>> 0) + 12345) >>> 0;
  s = (s ^ 2747636419) >>> 0;
  s = Math.imul(s, 2654435769) >>> 0; s = (s ^ (s >>> 16)) >>> 0;
  s = Math.imul(s, 2654435769) >>> 0; s = (s ^ (s >>> 16)) >>> 0;
  s = Math.imul(s, 2654435769) >>> 0;
  return (s & 0x00ffffff) / 16777215;
};
let introIdx = 0;
for (let i = 1; i < objects.length; i++) if (spawnSlot(i) < spawnSlot(introIdx)) introIdx = i;
const introTarget = objects[introIdx].pos;

// --- Backend (WebGPU if available, else WebGL2; ?force-webgl to force) ------
const app = document.getElementById('app');
const backend = await createBackend({ ...sceneData, test: TEST, capture: CAPTURE, introTarget });
app.appendChild(backend.domElement);

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
let morphTime = 0;
let lightTime = 0; // separate clock for the orbiting lights (advances when lightsMoving)
let lightsMoving = true; // light orbit on by default; toggle with the ✦ button or L
let spawnTime = 0; // intro clock (real time): objects scale in + lights ignite over it
const SPAWN_RATE = 0.15; // spawn-clock units/s (objects in over ~8 s; lights lag + slower)
// Music-reactive light flares: sample the spectrum, detect a beat per band (spectral
// flux clearly above a running average), flare that band's envelope and re-roll its
// subset seed, then decay the envelope toward zero so the lights blink with the music
// and go dark when it's silent.
const N_BANDS = 8;
const bandLevel = new Float32Array(N_BANDS); // raw FFT energy per band
const bandPrev = new Float32Array(N_BANDS); // previous level (for flux)
const bandAvg = new Float32Array(N_BANDS); // slow running average
const beatGap = new Float32Array(N_BANDS); // seconds since last beat (refractory)
const beatTime = new Float32Array(N_BANDS); // musicClock time of each band's last beat
const beatStrength = new Float32Array(N_BANDS); // strength of each band's last beat
let musicClock = 0; // ever-increasing music clock; beat timestamps live in these units
// A beat in a band re-triggers ALL of its lights at beatStrength; the shader then fades
// each light at its own (1-of-8) rate, so they linger by different amounts. Detection is
// per-band spectral flux relative to that band's OWN running average, so every band fires
// regardless of absolute loudness -> every light (idx % 8) is reached over the track.
function updateMusic(dt) {
  musicClock += dt;
  audio.sampleBands(bandLevel);
  for (let b = 0; b < N_BANDS; b++) {
    const e = bandLevel[b];
    const flux = Math.max(0, e - bandPrev[b]);
    bandPrev[b] = e;
    bandAvg[b] += (e - bandAvg[b]) * 0.1;
    beatGap[b] += dt;
    if (flux > 0.012 && e > bandAvg[b] * 1.2 + 0.006 && beatGap[b] > 0.07) {
      beatTime[b] = musicClock;
      beatStrength[b] = Math.min(2.5, 0.9 + e * 3.5); // flare scales with the onset's loudness
      beatGap[b] = 0;
    }
  }
  backend.setMusic(musicClock, beatTime, beatStrength);
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
    spawnTime = 0; // restart the spawn-in intro (objects scale in, lights ignite) on play
    backend.startIntro(); // replay the orbit-and-pull-back camera intro
    audio.play();
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

// --- FPS / frame-time overlay (off by default, toggle with 'f') ------------
const statsEl = document.getElementById('stats');
let statsOn = false;
let emaMs = 16.7;
let lastNow = performance.now();
let statsAcc = 0;
window.addEventListener('keydown', (e) => {
  if (e.key === 'p' || e.key === 'P') {
    setPlaying(!playing);
  }
  if (e.key === 'Tab') {
    e.preventDefault(); // don't shift focus between the on-screen controls
    togglePane();
  }
  if (e.key === 'f' || e.key === 'F') {
    statsOn = !statsOn;
    statsEl.style.display = statsOn ? 'block' : 'none';
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
  backend.setView({ position: preset[0], target: preset[1], damping: false });
  morphTime = parseFloat(params.get('t') || '0');
  backend.setTime(morphTime);
  lightTime = morphTime; // pin the orbit to t for deterministic captures
  backend.setLightTime(lightTime);
  playing = false;
  lightsMoving = false; // freeze the orbit so captures stay reproducible
  backend.setSpawn(100); // fully spawned-in for deterministic captures
  beatStrength.fill(1.0); // all lights fully lit (age 0) for deterministic captures
  beatTime.fill(0.0);
  backend.setMusic(0, beatTime, beatStrength);
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
  if (!CAPTURE) updateMusic(dt);
  spawnTime += dt;
  backend.setTime(morphTime);
  backend.setLightTime(lightTime);
  if (!CAPTURE) backend.setSpawn(spawnTime * SPAWN_RATE);
  backend.render();

  // Measure real frame time.
  emaMs = emaMs * 0.9 + (t - lastNow) * 0.1;
  lastNow = t;
  if (statsOn) {
    statsAcc += 1;
    if (statsAcc >= 8) {
      statsEl.textContent = `${(1000 / emaMs).toFixed(0)} fps\n${emaMs.toFixed(2)} ms`;
      statsAcc = 0;
    }
  }

  requestAnimationFrame(frame);
}
frame();
