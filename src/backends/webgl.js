import * as THREE from 'three';
import { createFlyCam } from '../flycam.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildSky } from '../sky.js';
import {
  buildLightTextures,
  buildOccluderTextures,
  buildReflectionData,
} from '../lightData.js';
import {
  buildUnifiedGeometry,
  setInstanceAttributes,
  buildMorphMaterial,
  NUM_SEGMENTS,
} from '../instancedMorph.js';
import { buildLightSprites } from '../lightSprites.js';
import { buildNormScaleLUT } from '../normalize.js';
import { MAX_NORM_CIRCUMRADIUS } from '../journey.js';
import { buildPlaneTexture, buildOccluderTransforms } from '../occluderData.js';
import { floatTexture } from '../textures.js';
import { createInstanceCuller } from '../cpuCull.js';

// The original WebGL2 path (RawShaderMaterials + DataTextures + EffectComposer),
// behind the common backend interface: { name, domElement, camera, setTime,
// setSize, render }.
export function createWebGLBackend({
  objects, lights, lightIndices, occluderIndices, reflectionIndices, test, capture, introTarget, sphereR,
}) {
  const renderer = new THREE.WebGLRenderer(); // antialias off: EffectComposer renders to its own non-MSAA targets, so default-buffer MSAA is unused
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio)); // cap at 1.5x — big fill-rate win on hi-DPI
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x050505, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; // applied by the OutputPass
  renderer.toneMappingExposure = 0.85;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    50, window.innerWidth / window.innerHeight, 0.1, 300,
  );
  camera.position.set(24, 17, 31);

  // Shared fly camera (three-instance-agnostic). Null in capture mode, where setView
  // pins the camera for deterministic frames. Main scene runs the orbit intro; the
  // test scene starts in free flight from its setView preset (introTarget = null).
  const flycam = capture ? null : createFlyCam(renderer.domElement, test ? null : introTarget, sphereR);

  const lightTex = buildLightTextures(lights, lightIndices);
  const occTex = buildOccluderTextures(objects, occluderIndices);
  const reflTex = buildReflectionData(objects, reflectionIndices);
  const geo = buildPlaneTexture();
  const occXf = buildOccluderTransforms(objects);
  // Per-object morph position (CPU note-stepped), uploaded each frame via setMorph.
  const morphPTex = floatTexture(new Float32Array(objects.length), objects.length, 1);

  // Volumetric-cloud defaults: single source for both the uniforms below and the
  // localhost debug GUI (main.js reads backend.cloudDefaults to seed its sliders).
  const cloudDefaults = {
    cloudsOn: true, coverage: 0.5, density: 0.9, base: 50, thick: 12,
    noiseScale: 0.05, windX: 0.4, windZ: 0.15, vortex: 0, twist: 0.06, quality: 48,
  };
  // Lighting "look" defaults (debug-tunable): lightScale 0.4 = lights at 40% (the -60%).
  const lookDefaults = { lightScale: 0.4, ampGain: 6.0, bloom: test ? 0.25 : 0.35 };

  const uniforms = {
    uTime: { value: 0 },
    uLightTime: { value: 0 },
    uSpawn: { value: 0 },
    uLightsPerObject: { value: lights.length / objects.length },
    uBeatTime: { value: new Float32Array(32) },
    uBeatStrength: { value: new Float32Array(32) },
    uBeatSeed: { value: new Float32Array(32) },
    uBeatDecay: { value: new Float32Array(32).fill(1) },
    uScaleNotes: { value: 0 },
    uMusicTime: { value: 0 },
    uNumSegments: { value: NUM_SEGMENTS },
    uNormScale: { value: buildNormScaleLUT() },
    uMaxCircumradius: { value: MAX_NORM_CIRCUMRADIUS },
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
    uMorphPTex: { value: morphPTex.tex },
    uMorphPTexW: { value: morphPTex.width },
    uRipple: { value: new Float32Array(16) }, // 4 ripples x (centre.xyz, startTime)
    uThudTime: { value: -1000 }, // last beat time, for the early "thud" pulse
    // Volumetric clouds (shared by the sky dome + the reflection sky-miss path).
    uCloudsOn: { value: cloudDefaults.cloudsOn ? 1 : 0 },
    uCoverage: { value: cloudDefaults.coverage },
    uCloudDensity: { value: cloudDefaults.density },
    uCloudBase: { value: cloudDefaults.base },
    uCloudThick: { value: cloudDefaults.thick },
    uCloudNoiseScale: { value: cloudDefaults.noiseScale },
    uCloudWind: { value: new THREE.Vector3(cloudDefaults.windX, 0, cloudDefaults.windZ) },
    uVortex: { value: cloudDefaults.vortex },
    uVortexTwist: { value: cloudDefaults.twist },
    uCloudSteps: { value: cloudDefaults.quality },
    // Lighting look: global brightness + amplitude-reactive subset (used by the sprites;
    // uLightScale also dims the morph lighting/specular).
    uLightScale: { value: lookDefaults.lightScale },
    uAmplitude: { value: 0 },
    uAmpGain: { value: lookDefaults.ampGain },
  };

  const geometry = buildUnifiedGeometry();
  setInstanceAttributes(geometry, objects);
  const culler = createInstanceCuller(geometry, objects); // CPU frustum cull + compact
  const mesh = new THREE.Mesh(geometry, buildMorphMaterial(uniforms));
  mesh.frustumCulled = false; // we cull per-instance ourselves
  scene.add(mesh);
  // Share the light-orbit clock + music bands so the sprites orbit and pulse in
  // lockstep with the lighting.
  const spritesMesh = buildLightSprites(lights, {
    uSpriteSize: { value: 0.0375 }, // 75% of 0.05 (smaller sprites again)
    uLightTime: uniforms.uLightTime,
    uSpawn: uniforms.uSpawn,
    uLightsPerObject: uniforms.uLightsPerObject,
    uBeatTime: uniforms.uBeatTime,
    uBeatStrength: uniforms.uBeatStrength,
    uBeatSeed: uniforms.uBeatSeed,
    uBeatDecay: uniforms.uBeatDecay,
    uMusicTime: uniforms.uMusicTime,
    uRipple: uniforms.uRipple,
    uThudTime: uniforms.uThudTime,
    uLightScale: uniforms.uLightScale,
    uAmplitude: uniforms.uAmplitude,
    uAmpGain: uniforms.uAmpGain,
  });
  scene.add(spritesMesh);
  // Skydome (+ raymarched clouds). Shares uTime + the cloud uniforms with the morph
  // material so the sky and the clouds reflected by objects stay identical.
  scene.add(buildSky({
    uTime: uniforms.uTime,
    uCloudsOn: uniforms.uCloudsOn,
    uCoverage: uniforms.uCoverage,
    uCloudDensity: uniforms.uCloudDensity,
    uCloudBase: uniforms.uCloudBase,
    uCloudThick: uniforms.uCloudThick,
    uCloudNoiseScale: uniforms.uCloudNoiseScale,
    uCloudWind: uniforms.uCloudWind,
    uVortex: uniforms.uVortex,
    uVortexTwist: uniforms.uVortexTwist,
    uCloudSteps: uniforms.uCloudSteps,
  }));

  const composer = new EffectComposer(renderer); // half-float render targets
  composer.addPass(new RenderPass(scene, camera));
  // Bloom at half resolution — it's a blur, so half-res looks the same and costs ~4x less.
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth * 0.5, window.innerHeight * 0.5),
    lookDefaults.bloom, 0.6, 1.0, // tamed strength (lookDefaults) + softer radius
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  return {
    name: 'webgl',
    domElement: renderer.domElement,
    camera,
    setTime(t) { uniforms.uTime.value = t; },
    setLightTime(t) { uniforms.uLightTime.value = t; },
    setSpawn(s) { uniforms.uSpawn.value = s; },
    setMusic(now, beatTime, strength, seed, scaleNotes, decay, thudTime) {
      uniforms.uMusicTime.value = now;
      uniforms.uBeatTime.value.set(beatTime);
      uniforms.uBeatStrength.value.set(strength);
      uniforms.uBeatSeed.value.set(seed);
      uniforms.uScaleNotes.value = scaleNotes;
      uniforms.uBeatDecay.value.set(decay);
      uniforms.uThudTime.value = thudTime;
    },
    setMorph(p) { morphPTex.tex.image.data.set(p); morphPTex.tex.needsUpdate = true; },
    setMusicLevel(level) { flycam?.setMusicLevel(level); },
    setRipples(data) { uniforms.uRipple.value.set(data); },
    setGeometryVisible(v) { mesh.visible = v; },       // localhost debug toggle
    setSpritesVisible(v) { spritesMesh.visible = v; }, // localhost debug toggle
    cloudDefaults,
    setClouds(p) {
      uniforms.uCloudsOn.value = p.cloudsOn ? 1 : 0;
      uniforms.uCoverage.value = p.coverage;
      uniforms.uCloudDensity.value = p.density;
      uniforms.uCloudBase.value = p.base;
      uniforms.uCloudThick.value = p.thick;
      uniforms.uCloudNoiseScale.value = p.noiseScale;
      uniforms.uCloudWind.value.set(p.windX, 0, p.windZ);
      uniforms.uVortex.value = p.vortex;
      uniforms.uVortexTwist.value = p.twist;
      uniforms.uCloudSteps.value = p.quality;
    },
    lookDefaults,
    setAmplitude(a) { uniforms.uAmplitude.value = a; },
    setLook(p) {
      uniforms.uLightScale.value = p.lightScale;
      uniforms.uAmpGain.value = p.ampGain;
      bloomPass.strength = p.bloom;
    },
    setView({ position, target }) {
      if (flycam) {
        flycam.setPose(position, target); // start free flight from this pose
      } else {
        if (position) camera.position.set(...position);
        if (target) camera.lookAt(...target);
      }
    },
    startIntro() { flycam?.startIntro(); },
    setSize(w, h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      composer.setSize(w, h);
      bloom.setSize(w * 0.5, h * 0.5); // keep bloom half-res after composer.setSize resets it
    },
    render() {
      if (flycam) flycam.update(camera);
      culler.cull(camera); // frustum-cull + compact the instances for this view
      composer.render();
    },
    dispose() { flycam?.dispose(); composer.dispose?.(); renderer.dispose(); }, // free input listeners + GPU resources (e.g. on bfcache pagehide)
  };
}
