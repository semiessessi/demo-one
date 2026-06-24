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
  buildMorphMaterial,
  NUM_SEGMENTS,
} from '../instancedMorph.js';
import { buildLightSprites } from '../lightSprites.js';
import { buildNormScaleLUT } from '../normalize.js';
import { MAX_NORM_CIRCUMRADIUS } from '../journey.js';
import { buildPlaneTexture, buildOccluderTransforms } from '../occluderData.js';
import { floatTexture } from '../textures.js';
import { createCloudLights } from '../cloudLights.js';
import { createInstanceCuller } from '../cpuCull.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import libGlsl from '../shaders/lib.glsl?raw';
import cloudsGlsl from '../shaders/clouds.glsl?raw';
import cloudPassFrag from '../shaders/cloud.pass.glsl?raw';
import oceanGlsl from '../shaders/ocean.glsl?raw';
import { createOceanFFT } from '../oceanFFT.js';
import { buildStarfield, bakeStarCubemap } from '../starfield.js';
import { buildMoon } from '../moon.js';
import { parseBSP } from '../bsp.js';
import { buildBspMesh, buildBspMaterial, buildGlowMaterial } from '../bspMesh.js';
import { streamBspTextures } from '../bspTextures.js';
import { buildBspLights } from '../bspLights.js';
import { buildBspOccluders } from '../bspOccluders.js';

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
      uCloudHG: shared.uCloudHG, uCloudHGBack: shared.uCloudHGBack, uCloudBackMix: shared.uCloudBackMix,
      uCloudPowder: shared.uCloudPowder, uFrame: shared.uFrame,
      uFarDeckOn: shared.uFarDeckOn,
      uCloudLightsTex: shared.uCloudLightsTex, uCloudLightsTexW: shared.uCloudLightsTexW,
      uCloudLightCount: shared.uCloudLightCount, uCloudLightCap: shared.uCloudLightCap,
      uCloudLightGain: shared.uCloudLightGain, uMoonStrength: shared.uMoonStrength,
      uOceanOn: shared.uOceanOn, uOceanY: shared.uOceanY, uOceanColor: shared.uOceanColor,
      uOceanScatter: shared.uOceanScatter, uOceanScatterAmt: shared.uOceanScatterAmt,
      uOceanFog: shared.uOceanFog, uOceanWave: shared.uOceanWave, uOceanFreq: shared.uOceanFreq,
      uOceanFoam: shared.uOceanFoam, uOceanFoamThresh: shared.uOceanFoamThresh, uOceanOctaves: shared.uOceanOctaves,
      uStarCube: shared.uStarCube, uReflCloudSteps: shared.uReflCloudSteps,
      uOceanReflTex: shared.uOceanReflTex, uOceanReflOn: shared.uOceanReflOn,
      uOceanReflDistort: shared.uOceanReflDistort,
      uOceanFFTDisp: shared.uOceanFFTDisp, uOceanFFTFoam: shared.uOceanFFTFoam,
      uOceanFFTOn: shared.uOceanFFTOn, uOceanFFTL: shared.uOceanFFTL,
    };
    this.u = u;
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: u,
      vertexShader: 'in vec3 position;\nin vec2 uv;\nout vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `${libGlsl}\n${cloudsGlsl}\n${oceanGlsl}\n${cloudPassFrag}`,
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
  lowGfx = false,
}) {
  const renderer = new THREE.WebGLRenderer(); // antialias off: EffectComposer renders to its own non-MSAA targets, so default-buffer MSAA is unused
  // iOS Safari often lacks EXT_color_buffer_float, so RGBA16F FBOs are framebuffer-incomplete -> a
  // SILENT black screen. Probe both extensions; getExtension('EXT_color_buffer_half_float') also
  // ENABLES the cap three omits on the RT path. Fall back to 8-bit targets so it renders at all.
  const gl = renderer.getContext();
  const halfFloatRenderable = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  const rtType = halfFloatRenderable ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const starCubeRT = new THREE.WebGLCubeRenderTarget(1024, { type: rtType }); // baked starfield -> stars in reflections
  // Allocate + clear all 6 faces now so the cube is a valid (black) sampler before the starfield bakes
  // it — otherwise sampling the unrendered cube RT (ocean/morph reflections) throws on the first frames.
  for (let f = 0; f < 6; f++) { renderer.setRenderTarget(starCubeRT, f); renderer.clear(); }
  renderer.setRenderTarget(null);
  // GPU FFT ocean — needs full-float render targets (EXT_color_buffer_float) + float linear filtering.
  // Off on mobile; the analytic ocean is the fallback. dispTexture holds (dx, dy, dz) per FFT texel.
  const fftCapable = !lowGfx && !!gl.getExtension('EXT_color_buffer_float') && !!gl.getExtension('OES_texture_float_linear');
  // windDir matches the cloud wind (cloudDefaults windX/windZ = 2.5 / -2.9) so the swell travels with
  // the clouds; setClouds re-syncs it. Choppier/bigger: stronger wind + choppiness + displacement scale.
  const oceanFFT = fftCapable ? createOceanFFT(renderer, { N: 256, L: 130, choppy: 1.4, windSpeed: 18, windDir: [2.5, -2.9], fetch: 18000, amplitude: 1.0, scale: 0.55, foamDecay: 0.95, foamInject: 0.06, foamThresh: 0.2 }) : null;
  const fftPlaceholder = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  fftPlaceholder.needsUpdate = true;
  let fftWanted = !!oceanFFT; // user/GUI intent; the autoscaler may still shed it under load
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
  camera.layers.enable(1); // layer 1 = sky dome / stars / moon — excluded from the planar ocean reflection

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
    noiseScale: 0.05, windX: 2.5, windZ: -2.9, quality: 64, farDeck: true,
  };
  // Lighting "look" defaults (debug-tunable): lightScale 0.4 = lights at 40% (the -60%).
  const lookDefaults = { lightScale: 0.4, ampGain: 20.0, bloom: test ? 0.25 : 0.2 };
  // Object material look: specular punch at the mirror end (low roughness) -> matte end (high
  // roughness). `detail` drives the per-class procedural texturing (0 off; autoscaled, off on mobile).
  const materialDefaults = { specBoostHi: 20.0, specBoostLo: 6.0, detail: lowGfx ? 0 : 1 };
  // Cloud moonlight defaults (the rich-lighting key light); colour is a cool pale moon.
  // sunAzim 270 + low sunElev put the risen moon on the horizon in the finale's look direction (it
  // settles looking out at ~azimuth 272). moonSize larger so the disc reads.
  const cloudLightDefaults = { sunElev: 12, sunAzim: 270, sunIntensity: 0.5, ambient: 0.5, hg: 0.5, hgBack: 0.2, backMix: 0.35, powder: 0.7, moonStrength: 0.5, lightScatter: 2.0, moonSize: 10.0 };
  const MOON_BASE = new THREE.Color(0.75, 0.82, 1.0);
  const starDefaults = { size: 2.0, twinkle: 0.4 };
  // Ocean ground: a wavy reflective sea well below the world (object field bottoms at ~-34).
  // Mobile LOD: fewer wave octaves + no planar reflection (a 2nd scene render) on lowGfx devices.
  const oceanDefaults = { on: true, y: -62, color: 0x05161e, scatter: 0x1a5a4a, fog: 0.006, wave: 1.0, freq: 0.04, foam: 0.16, foamThresh: 0.65, distort: 0.35, scatterAmt: 1.0, octaves: lowGfx ? 4 : 11, fft: !!oceanFFT };

  // The N cloud-relevant lights, re-picked + re-packed each frame for the cloud march's coloured
  // in-scatter: each frame the nearest/brightest band lights are packed with their orbiting position
  // and CURRENT per-light emission (steady "bath" fill -> always lit; amplitude subset dark when
  // quiet). See cloudLights.js / lightEmission.js.
  const cloudLights = createCloudLights(lights, lights.length / objects.length);
  // wrackdm17 level (streamed in after the first frame; transform shared with the brush occluders).
  let bspMeshes = null, bspTransform = null; // the level's render-pass meshes (opaque/transparent/glow)
  let mapShadowsOn = true; // debug toggle (setQualityScale forces uMapShadowCap to 0 when off)
  const mapDefaults = { lightScale: 1.0, glowScale: 1.0, shadows: true };
  // 1-texel placeholder so the bsp materials' map-light/occluder samplers are valid before the level loads.
  const mapPlaceholder = floatTexture(new Float32Array(4), 1, 4);

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
    uCloudHGBack: { value: cloudLightDefaults.hgBack },
    uCloudBackMix: { value: cloudLightDefaults.backMix },
    uCloudPowder: { value: cloudLightDefaults.powder },
    uFarDeckOn: { value: 1 }, // analytic far cloud deck (infinite cloud top to the horizon)
    uMoonStrength: { value: cloudLightDefaults.moonStrength },
    uReflCloudSteps: { value: 10 },
    uFrame: { value: 0 }, // frame counter for the per-frame cloud dither
    uStarSize: { value: starDefaults.size },
    uStarTwinkle: { value: starDefaults.twinkle },
    uMoonSize: { value: cloudLightDefaults.moonSize }, // moon disc half-size (billboard at uSunDir)
    uShadowCap: { value: 16 }, uReflCap: { value: 64 }, uLightCap: { value: 128 }, // FPS-autoscale caps
    // Object materials: roughness-aware specular punch + procedural-detail strength (autoscaled).
    uSpecBoostHi: { value: materialDefaults.specBoostHi },
    uSpecBoostLo: { value: materialDefaults.specBoostLo },
    uMaterialDetail: { value: materialDefaults.detail },
    uStarCube: { value: starCubeRT.texture }, // baked real stars, sampled by direction in reflections
    uCloudLightsTex: { value: cloudLights.tex },
    uCloudLightsTexW: { value: cloudLights.width },
    uCloudLightCount: { value: 0 }, // packed per-frame by cloudLights.update()
    uCloudLightCap: { value: 48 }, // FPS-autoscaled per-step cloud-light budget
    uCloudLightGain: { value: cloudLightDefaults.lightScatter }, // GUI "lights -> cloud"
    // wrackdm17 raytraced lighting (P7): point lights at the level's fixtures + convex brush shadow
    // occluders. Filled in loadBspMap; placeholders + zero counts keep the materials valid until then.
    uMapLightsTex: { value: mapPlaceholder.tex }, uMapLightsW: { value: mapPlaceholder.width },
    uMapLightCount: { value: 0 }, uMapLightCap: { value: 80 }, uMapLightScale: { value: 1.0 },
    uMapPlaneTex: { value: mapPlaceholder.tex }, uMapPlaneW: { value: mapPlaceholder.width },
    uMapBrushTex: { value: mapPlaceholder.tex }, uMapBrushW: { value: mapPlaceholder.width },
    uMapBrushCount: { value: 0 }, uMapShadowCap: { value: 64 },
    uMapGlowScale: { value: 1.0 }, // additive-glow stage brightness (lamps/jump-pads/flares)
    // Ocean "ground" for the skybox: a wavy reflective sea below the world (cloud.pass / ocean.glsl).
    uOceanOn: { value: oceanDefaults.on ? 1 : 0 },
    uOceanY: { value: oceanDefaults.y },
    uOceanColor: { value: new THREE.Color(oceanDefaults.color) },
    uOceanScatter: { value: new THREE.Color(oceanDefaults.scatter) },
    uOceanScatterAmt: { value: oceanDefaults.scatterAmt },
    uOceanFog: { value: oceanDefaults.fog },
    uOceanWave: { value: oceanDefaults.wave },
    uOceanFreq: { value: oceanDefaults.freq },
    uOceanFoam: { value: oceanDefaults.foam },
    uOceanFoamThresh: { value: oceanDefaults.foamThresh },
    uOceanOctaves: { value: oceanDefaults.octaves },
    uOceanReflTex: { value: mapPlaceholder.tex }, // planar reflection (objects+level mirrored on the water)
    uOceanReflOn: { value: 0 },                    // 1 when the planar reflection rendered this frame
    uOceanReflDistort: { value: oceanDefaults.distort }, // wave ripple on the planar reflection
    // GPU FFT ocean: (dx, dy, dz) displacement texture + tile size; 0/1/2 = analytic / FFT / FFT-debug.
    uOceanFFTDisp: { value: oceanFFT ? oceanFFT.dispTexture : fftPlaceholder },
    uOceanFFTFoam: { value: oceanFFT ? oceanFFT.foamTexture() : fftPlaceholder },
    uOceanFFTOn: { value: oceanFFT ? 1 : 0 },
    uOceanFFTL: { value: oceanFFT ? oceanFFT.L : 200 },
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
    uniforms.uCloudHGBack.value = p.hgBack;
    uniforms.uCloudBackMix.value = p.backMix;
    uniforms.uCloudPowder.value = p.powder;
    uniforms.uMoonStrength.value = p.moonStrength;
    uniforms.uCloudLightGain.value = p.lightScatter;
    uniforms.uMoonSize.value = p.moonSize;
  }
  setCloudLight(cloudLightDefaults);

  const geometry = buildUnifiedGeometry();
  let culler = createInstanceCuller(geometry, objects); // CPU frustum cull + near→far sort (writes aOrigIndex)
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
  sky.layers.set(1); // sky/stars/moon on layer 1 -> the planar reflection (the ocean does sky analytically)
  scene.add(sky);
  // Real-star background (async: the catalogue is code-split out of the main bundle). Added when it
  // resolves; the CloudPass then dims the stars where the cloud is thick.
  let starPoints = null;
  buildStarfield({ uTime: uniforms.uTime, uStarSize: uniforms.uStarSize, uStarTwinkle: uniforms.uStarTwinkle })
    .then((m) => { bakeStarCubemap(renderer, m, starCubeRT); m.layers.set(1); scene.add(m); starPoints = m; }).catch(() => {});
  buildMoon(uniforms).then((m) => { m.layers.set(1); scene.add(m); }).catch(() => {}); // additive moon billboard at uSunDir

  // The scene renders into our own target so the CloudPass can read its depth and composite the
  // clouds IN FRONT of geometry (the march stops at that depth). Rebuilt on resize.
  const makeSceneRT = (w, h) => new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: rtType,
    depthTexture: new THREE.DepthTexture(Math.max(1, w | 0), Math.max(1, h | 0)),
  });
  let sceneRT = makeSceneRT(window.innerWidth * renderer.getPixelRatio(), window.innerHeight * renderer.getPixelRatio());

  // Planar ocean reflection: render the scene (objects + sprites + level — layer 0; the sky/stars are
  // done analytically in the ocean shader) mirrored about the sea plane into a HALF-res target with
  // alpha (object coverage), which the ocean samples. FPS-autoscaled: skipped under load.
  const makeReflRT = (w, h) => new THREE.WebGLRenderTarget(Math.max(1, (w / 2) | 0), Math.max(1, (h / 2) | 0), { type: rtType });
  let reflRT = makeReflRT(window.innerWidth * renderer.getPixelRatio(), window.innerHeight * renderer.getPixelRatio());
  const reflCam = new THREE.PerspectiveCamera();
  reflCam.matrixAutoUpdate = false;
  const reflMat = new THREE.Matrix4();
  let oceanReflQuality = !lowGfx; // gated by setQualityScale; off on mobile (a 2nd scene render)
  // uOceanReflTex stays the placeholder until render() points it at reflRT.texture AFTER first drawing it.

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
      if (p.farDeck !== undefined) uniforms.uFarDeckOn.value = p.farDeck ? 1 : 0;
      if (oceanFFT) oceanFFT.rebuildSpectrum({ windDir: [p.windX, p.windZ] }); // keep the swell aligned with the clouds
    },
    lookDefaults,
    setAmplitude(a) {
      uniforms.uAmplitude.value = a; // cloud-light glow tracks each light's own emission (cloudLights.update)
    },
    setLook(p) {
      uniforms.uLightScale.value = p.lightScale;
      uniforms.uAmpGain.value = p.ampGain;
      bloomPass.strength = p.bloom;
    },
    materialDefaults,
    setMaterials(p) {
      uniforms.uSpecBoostHi.value = p.specBoostHi;
      uniforms.uSpecBoostLo.value = p.specBoostLo;
      if (p.detail !== undefined) uniforms.uMaterialDetail.value = p.detail;
    },
    cloudLightDefaults,
    setCloudLight,
    setMoonrise(on) { moonrise.on = on; if (!on) applySunDir(moonTargetElev); },
    sunElevDeg: () => liveMoonElev, // current (animated) moon elevation in degrees, for the debug readout
    starDefaults,
    setStars(p) { uniforms.uStarSize.value = p.size; uniforms.uStarTwinkle.value = p.twinkle; },
    oceanDefaults,
    setOcean(p) {
      uniforms.uOceanOn.value = p.on ? 1 : 0;
      uniforms.uOceanY.value = p.y;
      uniforms.uOceanColor.value.set(p.color);
      uniforms.uOceanScatter.value.set(p.scatter);
      if (p.scatterAmt !== undefined) uniforms.uOceanScatterAmt.value = p.scatterAmt;
      uniforms.uOceanFog.value = p.fog;
      uniforms.uOceanWave.value = p.wave;
      if (p.freq !== undefined) uniforms.uOceanFreq.value = p.freq;
      uniforms.uOceanFoam.value = p.foam;
      if (p.foamThresh !== undefined) uniforms.uOceanFoamThresh.value = p.foamThresh;
      if (p.distort !== undefined) uniforms.uOceanReflDistort.value = p.distort;
      if (p.fft !== undefined && oceanFFT) { fftWanted = !!p.fft; uniforms.uOceanFFTOn.value = fftWanted ? 1 : 0; }
    },
    setFFTMode(m) { if (oceanFFT) uniforms.uOceanFFTOn.value = m; }, // 0 analytic, 1 FFT, 2 debug height
    setFFTScale(v) { if (oceanFFT) oceanFFT.setScale(v); },
    setFFTChoppy(v) { if (oceanFFT) oceanFFT.setChoppy(v); },
    setFFTSpectrum(o) { if (oceanFFT) oceanFFT.rebuildSpectrum(o); },
    setFFTFoam(o) { if (oceanFFT) oceanFFT.setFoam(o); }, // {decay, inject, thresh}
    hasFFT: !!oceanFFT,
    // Stream the wrackdm17 level in after the first frame (mirrors the starfield/scene hot-swaps),
    // so it never blocks first paint. Builds the mesh, shades it with the demo's lighting, adds it.
    async loadBspMap(url) {
      const [buf, manifest] = await Promise.all([
        fetch(url).then((r) => r.arrayBuffer()),
        fetch(url.replace(/\.bsp$/, '.textures.json')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      const parsed = parseBSP(buf);
      const built = buildBspMesh(parsed, manifest); // { opaque, transparent, glow, transform }
      bspTransform = built.transform;
      // Synthesise the level's point lights (from emissive faces) + convex brush shadow occluders.
      const mapLights = buildBspLights(parsed, built.transform);
      const ld = new Float32Array(Math.max(1, mapLights.length) * 2 * 4);
      mapLights.forEach((l, i) => {
        const o = i * 8;
        ld[o] = l.pos[0]; ld[o + 1] = l.pos[1]; ld[o + 2] = l.pos[2]; ld[o + 3] = l.band;
        ld[o + 4] = l.color[0]; ld[o + 5] = l.color[1]; ld[o + 6] = l.color[2]; ld[o + 7] = l.radius;
      });
      const ltex = floatTexture(ld, Math.max(1, mapLights.length * 2), 4);
      uniforms.uMapLightsTex.value = ltex.tex; uniforms.uMapLightsW.value = ltex.width;
      uniforms.uMapLightCount.value = mapLights.length;
      const occ = buildBspOccluders(parsed, built.transform);
      const ptex = floatTexture(occ.planeData, Math.max(1, occ.planeCount), 4);
      const btex = floatTexture(occ.brushData, Math.max(1, occ.brushCount * 2), 4);
      uniforms.uMapPlaneTex.value = ptex.tex; uniforms.uMapPlaneW.value = ptex.width;
      uniforms.uMapBrushTex.value = btex.tex; uniforms.uMapBrushW.value = btex.width;
      uniforms.uMapBrushCount.value = occ.brushCount;

      // Build a mesh per render pass (opaque lit, transparent lit, additive glow), each with a
      // material array parallel to its draw-groups. Collect texture-load tasks for streaming.
      const tasks = []; // { material, file }
      bspMeshes = [];
      const passMesh = (pass, kind, order) => {
        if (!pass) return;
        const mats = pass.slots.map((s) => {
          if (kind === 'glow') {
            const m = buildGlowMaterial(uniforms, s.mat && s.mat.glowWave);
            const file = (s.mat && s.mat.glow) || (s.mat && s.mat.mode === 'add' ? s.mat.diffuse : null);
            if (file) tasks.push({ material: m, file });
            return m;
          }
          const m = buildBspMaterial(uniforms, cloudsGlsl, (s.mat && s.mat.mode) || 'opaque', (s.mat && s.mat.cull) || 'back');
          if (s.mat && s.mat.diffuse) tasks.push({ material: m, file: s.mat.diffuse });
          return m;
        });
        const mesh = new THREE.Mesh(pass.geometry, mats);
        mesh.frustumCulled = false; mesh.renderOrder = order;
        scene.add(mesh); bspMeshes.push(mesh);
      };
      passMesh(built.opaque, 'opaque', 0);
      passMesh(built.transparent, 'trans', 2);
      passMesh(built.glow, 'glow', 3);
      streamBspTextures(tasks); // hot-swap the authentic Q3 textures + glows onto the materials
      const tris = (built.opaque && built.opaque.geometry.index.count || 0) / 3;
      return { triangles: tris, mapLights: mapLights.length, occluders: occ.brushCount, glows: built.glow ? built.glow.slots.length : 0 };
    },
    setMapVisible(v) { for (const m of bspMeshes || []) m.visible = v; }, // localhost debug toggle
    setQualityScale(s) {
      // The ocean is the hero now, so PROTECT it: shed the map shadows/lights + cloud-light in-scatter
      // FIRST (low), keep object/cloud quality in the middle, and degrade the ocean (FFT + its cloud
      // reflection + planar) only at the very bottom of the range -> the sea stays detailed under load.
      const low = Math.max(0.0, (s - 0.45) / 0.55); // hits 0 by s=0.45 (first to go)
      uniforms.uCloudSteps.value = Math.max(12, Math.round(64 * s));
      uniforms.uReflCloudSteps.value = Math.max(8, Math.round(12 * (0.6 + 0.4 * s))); // ocean cloud reflection — kept high
      uniforms.uShadowCap.value = Math.max(2, Math.round(16 * s));
      uniforms.uReflCap.value = Math.max(4, Math.round(64 * s));
      uniforms.uLightCap.value = Math.max(8, Math.round(128 * s));
      uniforms.uMaterialDetail.value = lowGfx ? 0 : Math.min(1, Math.max(0, (s - 0.35) / 0.3)); // procedural material detail — off on mobile/low, full by s~0.65
      uniforms.uCloudLightCap.value = Math.max(4, Math.round(48 * low));   // cloud-light in-scatter — shed first
      uniforms.uMapShadowCap.value = mapShadowsOn ? Math.max(4, Math.round(uniforms.uMapBrushCount.value * low)) : 0; // raytraced map shadows — shed first
      uniforms.uMapLightCap.value = Math.max(8, Math.round(80 * low));     // map lights — shed first
      oceanReflQuality = !lowGfx && s > 0.4;  // planar ocean reflection — protected (was 0.6)
      if (oceanFFT) uniforms.uOceanFFTOn.value = (fftWanted && s > 0.2) ? 1 : 0; // FFT shed only at the very bottom (was 0.5)
    },
    mapDefaults,
    setMap(p) { mapShadowsOn = p.shadows; uniforms.uMapLightScale.value = p.lightScale; uniforms.uMapGlowScale.value = p.glowScale; uniforms.uMapShadowCap.value = p.shadows ? uniforms.uMapBrushCount.value : 0; },
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
      reflRT.dispose();
      reflRT = makeReflRT(w * p, h * p);
      uniforms.uOceanReflTex.value = reflRT.texture;
    },
    render() {
      if (flycam) flycam.update(camera);
      culler.cull(camera); // frustum-cull + compact the instances for this view
      cloudLights.update(uniforms, camera.position); // re-pick the lights that colour the cloud band
      if (starPoints) starPoints.position.copy(camera.position); // keep the starfield centred on the camera -> infinity
      sky.position.copy(camera.position); // dome follows the camera too -> the gradient sky is at infinity
      if (moonrise.on) applySunDir(-10.0 + (moonTargetElev + 10.0) * THREE.MathUtils.smoothstep(uniforms.uTime.value, 0, moonrise.dur)); // moonrise tracks the demo clock
      if (!capture) uniforms.uFrame.value = (uniforms.uFrame.value + 1) % 1024; // advance the per-frame cloud dither (frozen in capture -> reproducible)
      if (oceanFFT && uniforms.uOceanFFTOn.value > 0.5) {
        oceanFFT.update(uniforms.uTime.value);         // evolve + IFFT the wave field, accumulate foam
        uniforms.uOceanFFTFoam.value = oceanFFT.foamTexture(); // ping-pong: rebind the latest foam buffer
      }
      // Planar ocean reflection: render layer-0 geometry (objects + sprites + level) from the camera
      // mirrored about the sea plane into reflRT. Gated by the FPS autoscaler (oceanReflQuality).
      if (oceanReflQuality && uniforms.uOceanOn.value > 0.5) {
        const h = uniforms.uOceanY.value;
        reflMat.set(1, 0, 0, 0, 0, -1, 0, 2 * h, 0, 0, 1, 0, 0, 0, 0, 1); // mirror about y = h
        reflCam.matrixWorld.multiplyMatrices(reflMat, camera.matrixWorld);
        reflCam.matrixWorldInverse.copy(reflCam.matrixWorld).invert();
        reflCam.projectionMatrix.copy(camera.projectionMatrix);
        reflCam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
        renderer.setRenderTarget(reflRT);
        renderer.setClearColor(0x000000, 0); renderer.clear();
        renderer.render(scene, reflCam); // layer 0 only (sky/stars/moon are layer 1 -> skipped)
        renderer.setClearColor(0x050505, 1);
        uniforms.uOceanReflTex.value = reflRT.texture; // bind only AFTER it's been rendered this frame
        uniforms.uOceanReflOn.value = 1;
      } else {
        uniforms.uOceanReflTex.value = mapPlaceholder.tex; // a valid placeholder when not reflecting
        uniforms.uOceanReflOn.value = 0;
      }
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
      // The morph vertex reads all per-instance state from the textures above by aOrigIndex, so the
      // progressive swap is just these texture reassignments — no instanced-attribute rebuild, and
      // the culler stays valid (object positions/radii are unchanged by the gather).
    },
    dispose() { flycam?.dispose(); composer.dispose?.(); renderer.dispose(); }, // free input listeners + GPU resources (e.g. on bfcache pagehide)
  };
}
