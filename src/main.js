import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MorphSegment } from './morph.js';
import { Timeline } from './timeline.js';
import {
  tetraOctaSegment,
  octaToMidSegment,
  midToCubeSegment,
} from './solids.js';
import {
  octaIcosaSegment,
  icosaToMidSegment,
  midToDodecaSegment,
} from './icosa.js';

// --- Scene ----------------------------------------------------------------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x050505, 1);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
// Pulled back so the cube (which expands out past the octahedron via the
// stellation, circumradius ~1.73) sits comfortably in frame.
camera.position.set(3.4, 2.4, 4.6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 2;
controls.maxDistance = 12;

// --- Lighting -------------------------------------------------------------
const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
keyLight.position.set(4, 6, 5);
scene.add(keyLight);
scene.add(new THREE.AmbientLight(0xffffff, 0.18));

// --- Material & mesh group ------------------------------------------------
const material = new THREE.MeshStandardMaterial({
  color: 0x9a9a9a,
  roughness: 0.55,
  metalness: 0.0,
  flatShading: true,
  side: THREE.DoubleSide, // tolerate collapsed/degenerate faces during morphs
});

const group = new THREE.Group();
scene.add(group);

// --- Segments & timeline --------------------------------------------------
// Full forward journey:
//   tetra -> octa -> cube -> octa -> icosa -> dodeca
// Each stellation (octa<->cube, icosa<->dodeca) is split into two sub-segments
// that meet at a planar "rhombic" midpoint, where the triangulation flips
// invisibly so both ends stay flat-faced. Yo-yo playback runs it in reverse.
const reversed = (d) => ({
  name: d.endName,
  endName: d.name,
  start: d.end,
  end: d.start,
});

const segmentData = [
  tetraOctaSegment(), // 0: tetra -> octa
  octaToMidSegment(), // 1: octa -> rhombic-dodec midpoint
  midToCubeSegment(), // 2: midpoint -> cube
  reversed(midToCubeSegment()), // 3: cube -> midpoint
  reversed(octaToMidSegment()), // 4: midpoint -> octa
  octaIcosaSegment(), // 5: octa -> icosa
  icosaToMidSegment(), // 6: icosa -> rhombic-triacontahedron midpoint
  midToDodecaSegment(), // 7: midpoint -> dodeca
  reversed(midToDodecaSegment()), // 8: dodeca -> midpoint
  reversed(icosaToMidSegment()), // 9: midpoint -> icosa (final shape)
];
const segments = segmentData.map((d) => new MorphSegment(d));

const meshes = segments.map((seg) => {
  const mesh = new THREE.Mesh(seg.geometry, material);
  mesh.visible = false;
  group.add(mesh);
  return mesh;
});

// Named stops for the label (the rhombic midpoints at p=2, 4, 7, 9 are
// intentionally not stops — they're transitional). Playback yo-yos between the
// two extremes: tetrahedron and icosahedron.
const stops = [
  { p: 0, name: 'tetrahedron' },
  { p: 1, name: 'octahedron' },
  { p: 3, name: 'cube' },
  { p: 5, name: 'octahedron' },
  { p: 6, name: 'icosahedron' },
  { p: 8, name: 'dodecahedron' },
  { p: 10, name: 'icosahedron' },
];

const timeline = new Timeline(segments, { secondsPerSegment: 2.8, stops });

// --- UI -------------------------------------------------------------------
const scrub = document.getElementById('scrub');
const label = document.getElementById('label');
const playToggle = document.getElementById('playToggle');

scrub.addEventListener('input', () => {
  timeline.playing = false;
  playToggle.textContent = '▶';
  timeline.setNormalized(scrub.value / 1000);
});

playToggle.addEventListener('click', () => {
  timeline.playing = !timeline.playing;
  playToggle.textContent = timeline.playing ? '❚❚' : '▶';
});

// --- Resize ---------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Size normalization ---------------------------------------------------
// Scale so the mean of the inscribed- and circumscribed-sphere radii is held
// constant: circumradius = farthest vertex from the origin, inradius =
// nearest face plane to the origin (face-centre distance). Computed live from
// the current triangle soup so the apparent size stays steady through every
// morph instead of ballooning when a solid stellates outward.
const TARGET_MEAN_RADIUS = 1.1;

function meanRadius(pos) {
  const N = pos.length;
  let circum = 0;
  for (let i = 0; i < N; i += 3) {
    const d = Math.hypot(pos[i], pos[i + 1], pos[i + 2]);
    if (d > circum) circum = d;
  }
  const eps = circum * 1e-3 + 1e-6;
  let inr = Infinity;
  for (let i = 0; i < N; i += 9) {
    const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
    const ux = pos[i + 3] - ax, uy = pos[i + 4] - ay, uz = pos[i + 5] - az;
    const vx = pos[i + 6] - ax, vy = pos[i + 7] - ay, vz = pos[i + 8] - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-9) continue; // skip collapsed/degenerate triangles
    nx /= L; ny /= L; nz /= L;
    let pd = ax * nx + ay * ny + az * nz; // signed origin -> plane distance
    if (pd < 0) { pd = -pd; nx = -nx; ny = -ny; nz = -nz; } // orient outward
    if (pd >= inr) continue; // can't lower the running minimum
    // Only count true hull faces: a supporting plane has every vertex on its
    // inner side. This rejects interior/folded triangles from vertex collapses,
    // which would otherwise read a bogus near-zero inradius.
    let supporting = true;
    for (let j = 0; j < N; j += 3) {
      if (pos[j] * nx + pos[j + 1] * ny + pos[j + 2] * nz > pd + eps) {
        supporting = false;
        break;
      }
    }
    if (supporting) inr = pd;
  }
  if (!isFinite(inr)) inr = circum;
  return (circum + inr) / 2;
}

// --- Render loop ----------------------------------------------------------
const clock = new THREE.Clock();

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);

  if (timeline.advance(dt)) {
    scrub.value = String(Math.round(timeline.normalized() * 1000));
  }

  const { idx, t } = timeline.resolve();
  segments.forEach((seg, i) => {
    meshes[i].visible = i === idx;
  });
  segments[idx].apply(t);
  label.textContent = timeline.label();

  group.scale.setScalar(TARGET_MEAN_RADIUS / meanRadius(segments[idx].current));
  group.rotation.y += dt * 0.25; // gentle idle spin

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

frame();
