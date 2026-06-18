// WebGPU backend (Three.js WebGPURenderer + TSL/WGSL + storage buffers).
// Built up phase by phase. Imports from 'three/webgpu' (a separate module
// instance from core 'three'); everything renderer-facing lives here so the two
// never mix.
import * as THREE from 'three/webgpu';
import { createFlyCam } from '../flycam.js';
import { wgslFn, positionLocal, normalize, uniform, uniformArray, pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { buildMorphMesh } from '../gpu/morphMaterial.js';
import { buildLightSprites } from '../gpu/spriteMaterial.js';
import { createOrderCuller } from '../gpu/orderCull.js';
import { createComputeCuller } from '../gpu/computeCull.js';

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

  // Shared fly camera (three-instance-agnostic). Null in capture mode; main scene runs
  // the orbit intro; test scene starts in free flight from its setView preset.
  const flycam = data.capture ? null : createFlyCam(renderer.domElement, data.test ? null : data.introTarget);

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
  const uLightTime = uniform(0); // separate clock for the orbiting lights (toggleable)
  const uSpawn = uniform(0); // spawn-in intro clock (object scale + light reveal)
  const beatTimeArr = new Float32Array(8);  // per-band last-beat time, set in setMusic
  const beatStrengthArr = new Float32Array(8); // per-band last-beat strength, set in setMusic
  const uBeatTime = uniformArray(beatTimeArr, 'float');   // auto-uploads each render
  const uBeatStrength = uniformArray(beatStrengthArr, 'float');
  const uMusicTime = uniform(0);
  const morph = buildMorphMesh(data, uTime, uLightTime, uBeatTime, uBeatStrength, uMusicTime, uSpawn);
  scene.add(morph.mesh);
  scene.add(buildLightSprites(data.lights, uLightTime, uBeatTime, uBeatStrength, uMusicTime, uSpawn));

  // Per-frame frustum cull. Default: CPU order-buffer culler (reliable; same result
  // + same perf as compute at these scales). ?computecull opts into the WIP fully
  // GPU-driven compute cull + indirect draw (see gpu/computeCull.js — atomic compute
  // pipeline currently fails to compile on three r171).
  let cull;
  if (params.has('computecull')) {
    const cc = createComputeCuller(data.objects, morph.orderAttr);
    cc.attach(morph.geometry);
    cull = () => cc.update(renderer, camera);
  } else {
    const oc = createOrderCuller(data.objects, morph.orderArr, morph.orderAttr, morph.geometry);
    cull = () => oc.cull(camera);
  }

  if (params.has('debug')) {
    window.__wgpu = { renderer, scene, camera, morphMesh: morph.mesh, cull };
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
    setLightTime(t) { uLightTime.value = t; },
    setSpawn(s) { uSpawn.value = s; },
    setMusic(now, beatTime, strength) { uMusicTime.value = now; beatTimeArr.set(beatTime); beatStrengthArr.set(strength); },
    setView({ position, target }) {
      if (flycam) {
        flycam.setPose(position, target);
      } else {
        if (position) camera.position.set(...position);
        if (target) camera.lookAt(...target);
      }
    },
    startIntro() { flycam?.startIntro(); },
    setSize(w, h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h); // the scene pass tracks renderer size each frame
    },
    render() {
      if (flycam) flycam.update(camera);
      cull(); // frustum-cull + compact the instances for this view
      postProcessing.render();
    },
  };
}
