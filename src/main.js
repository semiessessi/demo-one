import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { generateScene, generateTestScene } from './scene.js';
import {
  buildLightTextures,
  buildOccluderTextures,
  buildReflectionData,
} from './lightData.js';
import {
  buildUnifiedGeometry,
  setInstanceAttributes,
  buildMorphMaterial,
  NUM_SEGMENTS,
} from './instancedMorph.js';
import { buildLightSprites } from './lightSprites.js';
import { buildNormScaleLUT } from './normalize.js';
import { buildSky } from './sky.js';
import { buildPlaneTexture, buildOccluderTransforms } from './occluderData.js';
import { createAudioManager } from './audio.js';

// --- Renderer / scene / camera --------------------------------------------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x050505, 1);
renderer.toneMapping = THREE.ACESFilmicToneMapping; // applied by the OutputPass
renderer.toneMappingExposure = 0.85;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.add(buildSky());
const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.1,
  300,
);
camera.position.set(24, 17, 31);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 5;
controls.maxDistance = 120;

// --- Generate the static volume -------------------------------------------
const TEST = new URLSearchParams(location.search).has('test');
const { objects, lights, lightIndices, occluderIndices, reflectionIndices } =
  TEST ? generateTestScene() : generateScene();
const lightTex = buildLightTextures(lights, lightIndices);
const occTex = buildOccluderTextures(objects, occluderIndices);
const reflTex = buildReflectionData(objects, reflectionIndices);
const geo = buildPlaneTexture();
const occXf = buildOccluderTransforms(objects);
if (TEST) {
  camera.position.set(4, 3.5, 9);
  controls.target.set(0, -1, 0);
}

const uniforms = {
  uTime: { value: 0 },
  uNumSegments: { value: NUM_SEGMENTS },
  uNormScale: { value: buildNormScaleLUT() },
  uLightsTex: { value: lightTex.lightsTex },
  uLightsTexW: { value: lightTex.lightsTexW },
  uLightIndexTex: { value: lightTex.lightIndexTex },
  uIndexTexW: { value: lightTex.indexTexW },
  uOccluderTex: { value: occTex.occluderTex },
  uOccluderTexW: { value: occTex.occluderTexW },
  uShadowIndexTex: { value: occTex.shadowIndexTex },
  uShadowIndexW: { value: occTex.shadowIndexW },
  uReflIndexTex: { value: reflTex.reflIndexTex },
  uReflIndexW: { value: reflTex.reflIndexW },
  uInstanceTex: { value: reflTex.instanceTex },
  uInstanceTexW: { value: reflTex.instanceTexW },
  uPlaneTex: { value: geo.planeTex },
  uPlaneTexW: { value: geo.planeTexW },
  uSegTriStart: { value: geo.segTriStart },
  uSegTriCount: { value: geo.segTriCount },
  uOccTransformTex: { value: occXf.transformTex },
  uOccTransformTexW: { value: occXf.transformTexW },
};
const spriteUniforms = { uSpriteSize: { value: 0.16 } };

const geometry = buildUnifiedGeometry();
setInstanceAttributes(geometry, objects);
const material = buildMorphMaterial(uniforms);
const mesh = new THREE.Mesh(geometry, material);
mesh.frustumCulled = false; // instances span the whole volume
scene.add(mesh);

// --- Light sprites (glowing billboards) ------------------------------------
const lightSprites = buildLightSprites(lights, spriteUniforms);
scene.add(lightSprites);

// --- HDR post-processing (half-float target -> bloom -> tone map) ----------
const composer = new EffectComposer(renderer); // half-float render targets
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  TEST ? 0.25 : 0.5, // strength
  0.5, // radius
  1.0, // luminance threshold: only HDR > 1 blooms (bright sprite cores), not lit objects
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// --- UI -------------------------------------------------------------------
const scrub = document.getElementById('scrub');
const label = document.getElementById('label');
const playToggle = document.getElementById('playToggle');
const muteToggle = document.getElementById('muteToggle');
const volume = document.getElementById('volume');
const info = document.getElementById('info');
const toast = document.getElementById('toast');
let playing = false; // demo loads paused, with the controls pane open
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
  uniforms.uTime.value = (scrub.value / 1000) * SCRUB_SPAN;
});
playToggle.addEventListener('click', () => setPlaying(!playing));
muteToggle.addEventListener('click', () => {
  muteToggle.textContent = audio.toggleMute() ? '🔇' : '🔊';
});
volume.addEventListener('input', () => audio.setVolume(volume.value / 100));

// Reveal the controls pane shortly after load so it animates in.
setTimeout(() => info.classList.add('open'), 80);

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
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// --- Render loop ----------------------------------------------------------
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (playing) {
    uniforms.uTime.value += dt;
    scrub.value = String(Math.round(((uniforms.uTime.value % SCRUB_SPAN) / SCRUB_SPAN) * 1000));
  }
  controls.update();
  composer.render();

  // Measure real frame time (not the clamped animation dt).
  const now = performance.now();
  emaMs = emaMs * 0.9 + (now - lastNow) * 0.1;
  lastNow = now;
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
