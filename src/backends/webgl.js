import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
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

// The original WebGL2 path (RawShaderMaterials + DataTextures + EffectComposer),
// behind the common backend interface: { name, domElement, camera, setTime,
// setSize, render }.
export function createWebGLBackend({
  objects, lights, lightIndices, occluderIndices, reflectionIndices, test,
}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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

  // Each backend owns its OrbitControls (its own three instance) to avoid
  // cross-module-instance issues between 'three' and 'three/webgpu'.
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 5;
  controls.maxDistance = 120;

  const lightTex = buildLightTextures(lights, lightIndices);
  const occTex = buildOccluderTextures(objects, occluderIndices);
  const reflTex = buildReflectionData(objects, reflectionIndices);
  const geo = buildPlaneTexture();
  const occXf = buildOccluderTransforms(objects);

  const uniforms = {
    uTime: { value: 0 },
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
  const mesh = new THREE.Mesh(geometry, buildMorphMaterial(uniforms));
  mesh.frustumCulled = false; // instances span the whole volume
  scene.add(mesh);
  scene.add(buildLightSprites(lights, { uSpriteSize: { value: 0.16 } }));

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
    setView({ position, target, damping = true }) {
      if (position) camera.position.set(...position);
      if (target) controls.target.set(...target);
      controls.enableDamping = damping;
      controls.update();
    },
    setSize(w, h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      composer.setSize(w, h);
    },
    render() {
      controls.update();
      composer.render();
    },
  };
}
