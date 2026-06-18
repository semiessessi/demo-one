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
import { createInstanceCuller } from '../cpuCull.js';

// The original WebGL2 path (RawShaderMaterials + DataTextures + EffectComposer),
// behind the common backend interface: { name, domElement, camera, setTime,
// setSize, render }.
export function createWebGLBackend({
  objects, lights, lightIndices, occluderIndices, reflectionIndices, test, capture, introTarget,
}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio); // native resolution (no cap)
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x050505, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; // applied by the OutputPass
  renderer.toneMappingExposure = 0.85;

  const scene = new THREE.Scene();
  scene.add(buildSky());
  const camera = new THREE.PerspectiveCamera(
    50, window.innerWidth / window.innerHeight, 0.1, 300,
  );
  camera.position.set(24, 17, 31);

  // Shared fly camera (three-instance-agnostic). Null in capture mode, where setView
  // pins the camera for deterministic frames. Main scene runs the orbit intro; the
  // test scene starts in free flight from its setView preset (introTarget = null).
  const flycam = capture ? null : createFlyCam(renderer.domElement, test ? null : introTarget);

  const lightTex = buildLightTextures(lights, lightIndices);
  const occTex = buildOccluderTextures(objects, occluderIndices);
  const reflTex = buildReflectionData(objects, reflectionIndices);
  const geo = buildPlaneTexture();
  const occXf = buildOccluderTransforms(objects);

  const uniforms = {
    uTime: { value: 0 },
    uLightTime: { value: 0 },
    uSpawn: { value: 0 },
    uLightsPerObject: { value: lights.length / objects.length },
    uBeatTime: { value: new Float32Array(32) },
    uBeatStrength: { value: new Float32Array(32) },
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
  };

  const geometry = buildUnifiedGeometry();
  setInstanceAttributes(geometry, objects);
  const culler = createInstanceCuller(geometry, objects); // CPU frustum cull + compact
  const mesh = new THREE.Mesh(geometry, buildMorphMaterial(uniforms));
  mesh.frustumCulled = false; // we cull per-instance ourselves
  scene.add(mesh);
  // Share the light-orbit clock + music bands so the sprites orbit and pulse in
  // lockstep with the lighting.
  scene.add(buildLightSprites(lights, {
    uSpriteSize: { value: 0.16 },
    uLightTime: uniforms.uLightTime,
    uSpawn: uniforms.uSpawn,
    uLightsPerObject: uniforms.uLightsPerObject,
    uBeatTime: uniforms.uBeatTime,
    uBeatStrength: uniforms.uBeatStrength,
    uMusicTime: uniforms.uMusicTime,
  }));

  const composer = new EffectComposer(renderer); // half-float render targets
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    test ? 0.25 : 0.5, 0.5, 1.0,
  ));
  composer.addPass(new OutputPass());

  return {
    name: 'webgl',
    domElement: renderer.domElement,
    camera,
    setTime(t) { uniforms.uTime.value = t; },
    setLightTime(t) { uniforms.uLightTime.value = t; },
    setSpawn(s) { uniforms.uSpawn.value = s; },
    setMusic(now, beatTime, strength) {
      uniforms.uMusicTime.value = now;
      uniforms.uBeatTime.value.set(beatTime);
      uniforms.uBeatStrength.value.set(strength);
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
    },
    render() {
      if (flycam) flycam.update(camera);
      culler.cull(camera); // frustum-cull + compact the instances for this view
      composer.render();
    },
  };
}
