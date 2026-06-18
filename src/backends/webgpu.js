// WebGPU backend (Three.js WebGPURenderer + TSL/WGSL + storage buffers).
// Built up phase by phase. Imports from 'three/webgpu' (a separate module
// instance from core 'three'); everything renderer-facing lives here so the two
// never mix.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { wgslFn, positionLocal, normalize, uniform, pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { buildMorphMesh } from '../gpu/morphMaterial.js';
import { buildLightSprites } from '../gpu/spriteMaterial.js';

// pdx night environment (kept identical to shaders/lib.glsl / morph env).
const envColor = wgslFn(`
  fn envColor(d: vec3<f32>) -> vec3<f32> {
    let Sky = vec3<f32>(0.008, 0.012, 0.035);
    let Horizon = vec3<f32>(0.06, 0.08, 0.14);
    let Glow = vec3<f32>(0.16, 0.20, 0.30);
    let GroundEdge = vec3<f32>(0.035, 0.035, 0.045);
    let Ground = vec3<f32>(0.02, 0.02, 0.028);
    let Up = d.y;
    var Base: vec3<f32>;
    if (Up >= 0.0) {
      Base = mix(Horizon, Sky, pow(clamp(Up, 0.0, 1.0), 0.20));
    } else {
      Base = mix(Horizon, mix(GroundEdge, Ground, clamp(-Up, 0.0, 1.0)), pow(clamp(-Up, 0.0, 1.0), 0.30));
    }
    let Band = pow(clamp(1.0 - abs(Up), 0.0, 1.0), 60.0);
    return mix(Base, Glow, Band);
  }
`);

export async function createWebGPUBackend(data) {
  const params = new URLSearchParams(location.search);
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio); // native resolution (no cap)
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Tone map matches the WebGL path (post pass / bloom arrives in P5).
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  await renderer.init();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    50, window.innerWidth / window.innerHeight, 0.1, 300,
  );
  camera.position.set(24, 17, 31);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 5;
  controls.maxDistance = 120;

  // Skydome.
  const skyMat = new THREE.MeshBasicNodeMaterial();
  skyMat.colorNode = envColor(normalize(positionLocal));
  skyMat.side = THREE.BackSide;
  skyMat.depthWrite = false;
  const sky = new THREE.Mesh(new THREE.SphereGeometry(140, 32, 16), skyMat);
  sky.frustumCulled = false;
  scene.add(sky);

  // Morphing instances (storage-buffer driven, GGX direct lighting).
  const uTime = uniform(0);
  const morphMesh = buildMorphMesh(data, uTime);
  scene.add(morphMesh);
  scene.add(buildLightSprites(data.lights));

  if (params.has('debug')) {
    window.__wgpu = { renderer, scene, camera, morphMesh };
  }

  // Post: bloom + ACES tone map (matches the WebGL EffectComposer chain).
  const postProcessing = new THREE.PostProcessing(renderer);
  const scenePass = pass(scene, camera);
  const bloomPass = bloom(scenePass, data.test ? 0.25 : 0.5, 0.5, 1.0);
  postProcessing.outputNode = scenePass.add(bloomPass);

  return {
    name: 'webgpu',
    domElement: renderer.domElement,
    camera,
    setTime(t) { uTime.value = t; },
    setView({ position, target, damping = true }) {
      if (position) camera.position.set(...position);
      if (target) controls.target.set(...target);
      controls.enableDamping = damping;
      controls.update();
    },
    setSize(w, h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h); // the scene pass tracks renderer size each frame
    },
    render() {
      controls.update();
      postProcessing.render();
    },
  };
}
