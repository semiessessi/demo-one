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

  group.rotation.y += dt * 0.25; // gentle idle spin

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

frame();
