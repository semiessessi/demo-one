import * as THREE from 'three';
import { createFlyCam } from '../flycam.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
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
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import libGlsl from '../shaders/lib.glsl?raw';
import cloudsGlsl from '../shaders/clouds.glsl?raw';
import cloudPassFrag from '../shaders/cloud.pass.glsl?raw';
import { buildStarfield, bakeStarCubemap } from '../starfield.js';
import { buildMoon } from '../moon.js';

// Fullscreen pass: composite the volumetric clouds over the rendered scene using its depth, so the
// clouds sit IN FRONT of geometry (march stops at the scene distance). The scene target is set each
// frame via setScene(); camera matrices (for per-pixel ray reconstruction) via setCamera().
class CloudPass extends Pass {
  constructor(shared) {
    super();
    const u = {
      tColor: { value: null }, tDepth: { value: null },
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() }, uCamNear: { value: 0.1 }, uCamFar: { value: 300 },
      uTime: shared.uTime, uCloudsOn: shared.uCloudsOn, uCoverage: shared.uCoverage,
      uCloudDensity: shared.uCloudDensity, uCloudBase: shared.uCloudBase, uCloudThick: shared.uCloudThick,
      uCloudNoiseScale: shared.uCloudNoiseScale, uCloudWind: shared.uCloudWind,
      uCloudSteps: shared.uCloudSteps,
      uSunDir: shared.uSunDir, uSunColor: shared.uSunColor, uCloudAmbient: shared.uCloudAmbient,
      uCloudHG: shared.uCloudHG, uCloudPowder: shared.uCloudPowder, uFrame: shared.uFrame,
      uCloudLightStrength: shared.uCloudLightStrength, uCloudLightCount: shared.uCloudLightCount,
      uCloudLightPos: shared.uCloudLightPos, uCloudLightColor: shared.uCloudLightColor,
    };
    this.u = u;
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: u,
      vertexShader: 'in vec3 position;\nin vec2 uv;\nout vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `${libGlsl}\n${cloudsGlsl}\n${cloudPassFrag}`,
      depthTest: false, depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }
  setScene(rt) { this.u.tColor.value = rt.texture; this.u.tDepth.value = rt.depthTexture; }
  setCamera(cam) {
    this.u.uInvProj.value.copy(cam.projectionMatrixInverse);
    this.u.uCamWorld.value.copy(cam.matrixWorld);
    this.u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
    this.u.uCamNear.value = cam.near; this.u.uCamFar.value = cam.far;
  }
  render(renderer, writeBuffer) {
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);
  }
  setSize() {}
  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}

// The original WebGL2 path (RawShaderMaterials + DataTextures + EffectComposer),
// behind the common backend interface: { name, domElement, camera, setTime,
// setSize, render }.
export function createWebGLBackend({
  objects, lights, lightIndices, occluderIndices, reflectionIndices, test, capture, introTarget, sphereR,
  onError, forceLdr = false, lowGfx = false,
}) {
  const renderer = new THREE.WebGLRenderer(); // antialias off: EffectComposer renders to its own non-MSAA targets, so default-buffer MSAA is unused
  // iOS Safari often lacks EXT_color_buffer_float, so RGBA16F FBOs are framebuffer-incomplete -> a
  // SILENT black screen. Probe both extensions; getExtension('EXT_color_buffer_half_float') also
  // ENABLES the cap three omits on the RT path. Fall back to 8-bit (LDR) targets so it renders at all.
  const gl = renderer.getContext();
  const halfFloatRenderable = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  const rtType = (halfFloatRenderable && !forceLdr) ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const starCubeRT = new THREE.WebGLCubeRenderTarget(1024, { type: rtType }); // baked starfield -> stars in reflections
  renderer.setPixelRatio(Math.min(lowGfx ? 1.0 : 1.5, window.devicePixelRatio)); // cap fill-rate (tighter on mobile)
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
    cloudsOn: true, coverage: 0.55, density: 2.0, base: 24, thick: 32,
    noiseScale: 0.05, windX: 2.5, windZ: -2.9, quality: 64,
  };
  // Lighting "look" defaults (debug-tunable): lightScale 0.4 = lights at 40% (the -60%).
  const lookDefaults = { lightScale: 0.4, ampGain: 20.0, bloom: test ? 0.25 : 0.2 };
  // Cloud moonlight defaults (the rich-lighting key light); colour is a cool pale moon.
  // sunAzim 270 + low sunElev put the risen moon on the horizon in the finale's look direction (it
  // settles looking out at ~azimuth 272). moonSize larger so the disc reads.
  const cloudLightDefaults = { sunElev: 12, sunAzim: 270, sunIntensity: 0.5, ambient: 0.5, hg: 0.5, powder: 0.7, moonStrength: 0.5, lightScatter: 2.0, moonSize: 10.0 };
  const MOON_BASE = new THREE.Color(0.75, 0.82, 1.0);
  const starDefaults = { size: 2.0, twinkle: 0.4 };

  // Topmost, spatially-distinct lights that scatter into the cloud volume (static orbit centres,
  // since objects don't translate). Highest y first, deduped to >5u apart so the budget spreads.
  const CLOUD_LIGHTS_MAX = 16;
  const cloudLightSel = (() => {
    const order = lights.map((_, i) => i).sort((a, b) => lights[b].pos[1] - lights[a].pos[1]);
    const sel = [], picked = [];
    for (const i of order) {
      const p = lights[i].pos;
      if (picked.some((q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2 < 25)) continue;
      sel.push(i); picked.push(p);
      if (sel.length >= CLOUD_LIGHTS_MAX) break;
    }
    return sel;
  })();
  const cloudLightPos = new Float32Array(CLOUD_LIGHTS_MAX * 4);
  const cloudLightCol = new Float32Array(CLOUD_LIGHTS_MAX * 3);
  cloudLightSel.forEach((li, k) => {
    const l = lights[li];
    cloudLightPos[k * 4] = l.pos[0]; cloudLightPos[k * 4 + 1] = l.pos[1];
    cloudLightPos[k * 4 + 2] = l.pos[2]; cloudLightPos[k * 4 + 3] = 3.0; // per-light brightness
    cloudLightCol[k * 3] = l.color[0]; cloudLightCol[k * 3 + 1] = l.color[1]; cloudLightCol[k * 3 + 2] = l.color[2];
  });
  let cloudLightBase = cloudLightDefaults.lightScatter; // GUI base; * music pulse -> uCloudLightStrength

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
    uCloudSteps: { value: cloudDefaults.quality },
    // Lighting look: global brightness + amplitude-reactive subset (used by the sprites;
    // uLightScale also dims the morph lighting/specular).
    uLightScale: { value: lookDefaults.lightScale },
    uAmplitude: { value: 0 },
    uAmpGain: { value: lookDefaults.ampGain },
    // Cloud moonlight (rich lighting) — populated by setCloudLight() below.
    uSunDir: { value: new THREE.Vector3() },
    uSunColor: { value: new THREE.Vector3() },
    uCloudAmbient: { value: cloudLightDefaults.ambient },
    uCloudHG: { value: cloudLightDefaults.hg },
    uCloudPowder: { value: cloudLightDefaults.powder },
    uMoonStrength: { value: cloudLightDefaults.moonStrength },
    uReflCloudSteps: { value: 10 },
    uFrame: { value: 0 }, // frame counter for the per-frame cloud dither
    uStarSize: { value: starDefaults.size },
    uStarTwinkle: { value: starDefaults.twinkle },
    uMoonSize: { value: cloudLightDefaults.moonSize }, // moon disc half-size (billboard at uSunDir)
    uShadowCap: { value: 16 }, uReflCap: { value: 64 }, uLightCap: { value: 128 }, // FPS-autoscale caps
    uStarCube: { value: starCubeRT.texture }, // baked real stars, sampled by direction in reflections
    uCloudLightStrength: { value: cloudLightBase * 0.15 }, // base * music pulse (updated in setAmplitude)
    uCloudLightCount: { value: cloudLightSel.length },
    uCloudLightPos: { value: cloudLightPos },
    uCloudLightColor: { value: cloudLightCol },
  };

  // Moon direction = elevation + azimuth -> uSunDir (shared by the moonlight + the moon disc).
  let moonTargetElev = cloudLightDefaults.sunElev, moonAzim = cloudLightDefaults.sunAzim;
  let liveMoonElev = cloudLightDefaults.sunElev; // the CURRENT (animated) elevation — drives the disc + cloud light; read by the debug GUI
  const moonrise = { on: true, dur: 150 }; // elevation eases from -10deg to the target over `dur` demo-seconds (uTime) -> a slow ~2.5min rise
  function applySunDir(elevDeg) {
    liveMoonElev = elevDeg; // single source: the moon disc AND the cloud moonlight both read uSunDir, set from this
    const el = elevDeg * Math.PI / 180, az = moonAzim * Math.PI / 180;
    uniforms.uSunDir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
  }
  function setCloudLight(p) {
    moonTargetElev = p.sunElev; moonAzim = p.sunAzim;
    if (!moonrise.on) applySunDir(moonTargetElev); // when the rise is on, render() animates uSunDir instead
    uniforms.uSunColor.value.set(MOON_BASE.r * p.sunIntensity, MOON_BASE.g * p.sunIntensity, MOON_BASE.b * p.sunIntensity);
    uniforms.uCloudAmbient.value = p.ambient;
    uniforms.uCloudHG.value = p.hg;
    uniforms.uCloudPowder.value = p.powder;
    uniforms.uMoonStrength.value = p.moonStrength;
    cloudLightBase = p.lightScatter;
    uniforms.uMoonSize.value = p.moonSize;
  }
  setCloudLight(cloudLightDefaults);

  const geometry = buildUnifiedGeometry();
  setInstanceAttributes(geometry, objects);
  let culler = createInstanceCuller(geometry, objects); // CPU frustum cull + compact
  const mesh = new THREE.Mesh(geometry, buildMorphMaterial(uniforms));
  mesh.frustumCulled = false; // we cull per-instance ourselves
  scene.add(mesh);
  // Async shader compile: the morph material is by far the heaviest shader (reflections + analytic
  // traces + per-light shading). Compile it SYNCHRONOUSLY (the default — on the first render) so the
  // geometry, especially the hero dodecahedron, is in the FIRST rendered frame, not popped in later.
  // An async compile here hid the objects until the shader finished, which on slower/live devices
  // made the geometry appear long after the sky — the fade covers the compile (black) instead.
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
  // Gradient backdrop dome (clouds are now the fullscreen CloudPass, composited over this + scene).
  // Kept centred on the camera each frame (render()) so the gradient sky is at infinity.
  const sky = buildSky();
  scene.add(sky);
  // Real-star background (async: the catalogue is code-split out of the main bundle). Added when it
  // resolves; the CloudPass then dims the stars where the cloud is thick.
  let starPoints = null;
  buildStarfield({ uTime: uniforms.uTime, uStarSize: uniforms.uStarSize, uStarTwinkle: uniforms.uStarTwinkle })
    .then((m) => { bakeStarCubemap(renderer, m, starCubeRT); scene.add(m); starPoints = m; }).catch(() => {});
  buildMoon(uniforms).then((m) => scene.add(m)).catch(() => {}); // additive moon billboard at uSunDir

  // The scene renders into our own target so the CloudPass can read its depth and composite the
  // clouds IN FRONT of geometry (the march stops at that depth). Rebuilt on resize.
  const makeSceneRT = (w, h) => new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: rtType,
    depthTexture: new THREE.DepthTexture(Math.max(1, w | 0), Math.max(1, h | 0)),
  });
  let sceneRT = makeSceneRT(window.innerWidth * renderer.getPixelRatio(), window.innerHeight * renderer.getPixelRatio());

  const cloudPass = new CloudPass(uniforms); // composites clouds over the scene (reads sceneRT each frame)
  const composer = new EffectComposer(renderer); // half-float render targets
  composer.addPass(cloudPass);
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
      uniforms.uCloudSteps.value = p.quality;
    },
    lookDefaults,
    setAmplitude(a) {
      uniforms.uAmplitude.value = a;
      uniforms.uCloudLightStrength.value = cloudLightBase * (0.15 + a * 1.5); // cloud light-glow pulses with volume
    },
    setLook(p) {
      uniforms.uLightScale.value = p.lightScale;
      uniforms.uAmpGain.value = p.ampGain;
      bloomPass.strength = p.bloom;
    },
    cloudLightDefaults,
    setCloudLight,
    setMoonrise(on) { moonrise.on = on; if (!on) applySunDir(moonTargetElev); },
    sunElevDeg: () => liveMoonElev, // current (animated) moon elevation in degrees, for the debug readout
    starDefaults,
    setStars(p) { uniforms.uStarSize.value = p.size; uniforms.uStarTwinkle.value = p.twinkle; },
    setQualityScale(s) {
      uniforms.uCloudSteps.value = Math.max(12, Math.round(64 * s));
      uniforms.uReflCloudSteps.value = Math.max(4, Math.round(12 * s));
      uniforms.uShadowCap.value = Math.max(2, Math.round(16 * s));
      uniforms.uReflCap.value = Math.max(4, Math.round(64 * s));
      uniforms.uLightCap.value = Math.max(8, Math.round(128 * s));
      uniforms.uCloudLightCount.value = Math.min(cloudLightSel.length, Math.round(CLOUD_LIGHTS_MAX * s));
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
      bloomPass.setSize(w * 0.5, h * 0.5); // keep bloom half-res after composer.setSize resets it
      const p = renderer.getPixelRatio();
      sceneRT.dispose();
      sceneRT = makeSceneRT(w * p, h * p);
    },
    render() {
      if (flycam) flycam.update(camera);
      culler.cull(camera); // frustum-cull + compact the instances for this view
      if (starPoints) starPoints.position.copy(camera.position); // keep the starfield centred on the camera -> infinity
      sky.position.copy(camera.position); // dome follows the camera too -> the gradient sky is at infinity
      if (moonrise.on) applySunDir(-10.0 + (moonTargetElev + 10.0) * THREE.MathUtils.smoothstep(uniforms.uTime.value, 0, moonrise.dur)); // moonrise tracks the demo clock
      uniforms.uFrame.value = (uniforms.uFrame.value + 1) % 1024; // advance the per-frame cloud dither
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera); // scene (objects + sprites + gradient dome) -> colour + depth
      cloudPass.setScene(sceneRT);
      cloudPass.setCamera(camera); // matrixWorld is current after the render above
      composer.render(); // CloudPass (clouds over the scene) -> bloom -> output
    },
    debugInfo: () => ({ pixelRatio: renderer.getPixelRatio(), rtType: rtType === THREE.HalfFloatType ? 'half-float' : '8-bit', halfFloatRenderable, cloudsOn: !!uniforms.uCloudsOn.value, objects: objects.length }),
    // Hot-swap the progressively-gathered full light/occluder/reflection lists in: rebuild the index
    // + instance textures and re-upload the per-object offsets/counts. The lights themselves are
    // unchanged, so uLightsTex is kept (only the index into it grows).
    updateScene(data) {
      const lt = buildLightTextures(data.lights, data.lightIndices);
      lt.lightsTex.dispose(); // lights are unchanged — keep the original uLightsTex; only the index grows
      uniforms.uLightIndexTex.value.dispose(); uniforms.uLightIndexTex.value = lt.lightIndexTex; uniforms.uIndexTexW.value = lt.indexTexW;
      const ot = buildOccluderTextures(data.objects, data.occluderIndices);
      uniforms.uOccluderTex.value.dispose(); uniforms.uOccluderTex.value = ot.occluderTex; uniforms.uOccluderTexW.value = ot.occluderTexW;
      uniforms.uShadowIndexTex.value.dispose(); uniforms.uShadowIndexTex.value = ot.shadowIndexTex; uniforms.uShadowIndexW.value = ot.shadowIndexW;
      const rt = buildReflectionData(data.objects, data.reflectionIndices);
      uniforms.uReflIndexTex.value.dispose(); uniforms.uReflIndexTex.value = rt.reflIndexTex; uniforms.uReflIndexW.value = rt.reflIndexW;
      uniforms.uInstanceTex.value.dispose(); uniforms.uInstanceTex.value = rt.instanceTex; uniforms.uInstanceTexW.value = rt.instanceTexW;
      setInstanceAttributes(geometry, data.objects);
      culler = createInstanceCuller(geometry, data.objects); // re-sync the culler: setInstanceAttributes rewrote the instance buffers full-order, so the culler's cached src + aOrigIndex must be rebuilt (else slots desync -> objects spin on every camera move)
    },
    dispose() { flycam?.dispose(); composer.dispose?.(); renderer.dispose(); }, // free input listeners + GPU resources (e.g. on bfcache pagehide)
  };
}
