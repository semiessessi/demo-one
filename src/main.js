import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { generateScene } from './scene.js';
import { buildLightTextures } from './lightData.js';
import {
  buildUnifiedGeometry,
  setInstanceAttributes,
  buildMorphMaterial,
  NUM_SEGMENTS,
} from './instancedMorph.js';

// --- Renderer / scene / camera --------------------------------------------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x050505, 1);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
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
const { objects, lights, lightIndices } = generateScene();
const lightTex = buildLightTextures(lights, lightIndices);

const uniforms = {
  uTime: { value: 0 },
  uSpeed: { value: 0.5 },
  uNumSegments: { value: NUM_SEGMENTS },
  uLightsTex: { value: lightTex.lightsTex },
  uLightsTexW: { value: lightTex.lightsTexW },
  uLightIndexTex: { value: lightTex.lightIndexTex },
  uIndexTexW: { value: lightTex.indexTexW },
};

const geometry = buildUnifiedGeometry();
setInstanceAttributes(geometry, objects);
const material = buildMorphMaterial(uniforms);
const mesh = new THREE.Mesh(geometry, material);
mesh.frustumCulled = false; // instances span the whole volume
scene.add(mesh);

// --- Light placeholders (plain points; replaced by sprites in step 3) ------
const lightPosArr = new Float32Array(lights.length * 3);
const lightColArr = new Float32Array(lights.length * 3);
lights.forEach((l, i) => {
  lightPosArr.set(l.pos, i * 3);
  const m = Math.max(l.color[0], l.color[1], l.color[2], 1e-3);
  lightColArr.set([l.color[0] / m, l.color[1] / m, l.color[2] / m], i * 3);
});
const lightGeo = new THREE.BufferGeometry();
lightGeo.setAttribute('position', new THREE.BufferAttribute(lightPosArr, 3));
lightGeo.setAttribute('color', new THREE.BufferAttribute(lightColArr, 3));
const lightPoints = new THREE.Points(
  lightGeo,
  new THREE.PointsMaterial({ size: 0.12, vertexColors: true, sizeAttenuation: true }),
);
lightPoints.frustumCulled = false;
scene.add(lightPoints);

// --- UI -------------------------------------------------------------------
const scrub = document.getElementById('scrub');
const label = document.getElementById('label');
const playToggle = document.getElementById('playToggle');
let playing = true;
const SCRUB_SPAN = (2 * NUM_SEGMENTS) / uniforms.uSpeed.value; // one ping-pong period (s)

label.textContent = `${objects.length} objects · ${lights.length} lights`;

scrub.addEventListener('input', () => {
  playing = false;
  playToggle.textContent = '▶';
  uniforms.uTime.value = (scrub.value / 1000) * SCRUB_SPAN;
});
playToggle.addEventListener('click', () => {
  playing = !playing;
  playToggle.textContent = playing ? '❚❚' : '▶';
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
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
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();
