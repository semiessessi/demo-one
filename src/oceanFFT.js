// GPU FFT ocean (Tessendorf). A Phillips-spectrum initial field h0(k) is built once on the CPU; each
// frame it's evolved by the deep-water dispersion relation and inverse-FFT'd on the GPU (Cooley-Tukey
// butterfly, ping-pong render targets) into a spatial displacement texture (dx, dy, dz). The ocean
// shader samples that texture (tiled over world XZ with period L) and derives normals + the foam
// Jacobian by finite differences. Two complex fields ride in one RGBA target (RG + BA), so one set of
// butterfly passes transforms two fields at once.
//
// Refs: Tessendorf "Simulating Ocean Water"; the GPU butterfly layout follows the common
// Flügge/Jump-Trajectory formulation (a precomputed twiddle+index texture drives each stage).

import * as THREE from 'three';

const FFT_VERT = 'in vec3 position;\nin vec2 uv;\nout vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

// Per-frame spectrum evolution: h(k,t) = h0(k)·e^{iωt} + conj(h0(-k))·e^{-iωt}, plus the horizontal
// displacement spectra i·(k/|k|)·h. uField 0 -> packs (height, dispX); uField 1 -> (dispZ, 0).
const EVOLVE_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 oCol;
uniform sampler2D uH0;   // RG = h0(k), BA = conj(h0(-k))
uniform float uTime, uN, uL, uField;
const float G = 9.81;
const float PI = 3.14159265;
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
void main(){
  vec2 x = floor(vUv * uN) - uN * 0.5;        // centered wave index (-N/2 .. N/2)
  vec2 k = x * (2.0 * PI / uL);                // angular wavenumber
  float kl = max(length(k), 1e-4);
  float w = sqrt(G * kl);                       // deep-water dispersion
  vec4 h0 = texture(uH0, vUv);
  float c = cos(w * uTime), s = sin(w * uTime);
  vec2 h = cmul(h0.xy, vec2(c, s)) + cmul(h0.zw, vec2(c, -s));
  vec2 ih = vec2(-h.y, h.x);                    // i*h
  vec2 kn = k / kl;
  oCol = (uField < 0.5) ? vec4(h, ih * kn.x) : vec4(ih * kn.y, 0.0, 0.0);
}`;

// One butterfly stage. uDir picks horizontal (0) or vertical (1). The butterfly texture holds the
// twiddle factor (RG) and the two source indices (BA). Processes both packed complex fields (RG, BA).
const BUTTERFLY_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 oCol;
uniform sampler2D uButterfly, uData;
uniform float uStage, uN, uDir, uBits;
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
void main(){
  vec2 px = floor(vUv * uN);
  float idx = (uDir < 0.5) ? px.x : px.y;
  vec4 bf = texture(uButterfly, vec2((uStage + 0.5) / uBits, (idx + 0.5) / uN));
  vec2 tw = bf.xy;
  vec2 pA = (uDir < 0.5) ? vec2(bf.z, px.y) : vec2(px.x, bf.z);
  vec2 pB = (uDir < 0.5) ? vec2(bf.w, px.y) : vec2(px.x, bf.w);
  vec4 a = texture(uData, (pA + 0.5) / uN);
  vec4 b = texture(uData, (pB + 0.5) / uN);
  oCol = vec4(a.xy + cmul(tw, b.xy), a.zw + cmul(tw, b.zw));
}`;

// After the butterfly passes: real parts, (-1)^(x+y) un-shift, and pack the spatial displacement
// (dx, dy, dz) into RGB. dy = height. uScale calibrates the IFFT normalization + wave amplitude.
const COMBINE_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 oCol;
uniform sampler2D uHDx, uDz;
uniform float uN, uChoppy, uScale;
void main(){
  vec2 px = floor(vUv * uN);
  float sgn = (mod(px.x + px.y, 2.0) == 0.0) ? 1.0 : -1.0;
  float norm = sgn * uScale;
  vec4 hdx = texture(uHDx, vUv);
  float dz = texture(uDz, vUv).x;
  oCol = vec4(hdx.z * norm * uChoppy, hdx.x * norm, dz * norm * uChoppy, 1.0);
}`;

// Persistent foam: where the displacement folds (Jacobian determinant < threshold) inject foam, then
// carry the previous frame's foam forward with an exponential decay -> whitecaps that build on breaking
// crests and dissipate over the next seconds (the GodotOceanWaves "grow linearly, decay exponentially").
const FOAM_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 oCol;
uniform sampler2D uDisp, uPrevFoam;
uniform float uN, uTexel, uDecay, uInject, uThresh;
void main(){
  float tx = 1.0 / uN;
  vec3 d0 = texture(uDisp, vUv).xyz;
  vec3 dXp = texture(uDisp, vUv + vec2(tx, 0.0)).xyz;
  vec3 dZp = texture(uDisp, vUv + vec2(0.0, tx)).xyz;
  float jxx = 1.0 + (dXp.x - d0.x) / uTexel, jzz = 1.0 + (dZp.z - d0.z) / uTexel;
  float jxz = (dZp.x - d0.x) / uTexel, jzx = (dXp.z - d0.z) / uTexel;
  float jac = jxx * jzz - jxz * jzx;
  float fold = smoothstep(uThresh, uThresh - 0.3, jac) * uInject; // injected only where it strongly folds
  float prev = texture(uPrevFoam, vUv).r;
  oCol = vec4(min(prev * uDecay + fold, 1.0));
}`;

function bitReverse(i, bits) {
  let r = 0;
  for (let b = 0; b < bits; b++) { r = (r << 1) | (i & 1); i >>= 1; }
  return r >>> 0;
}

// Twiddle-factor + input-index texture: width = log2(N) stages, height = N indices.
function buildButterflyTexture(N) {
  const bits = Math.log2(N);
  const data = new Float32Array(bits * N * 4);
  for (let stage = 0; stage < bits; stage++) {
    for (let y = 0; y < N; y++) {
      const span = 1 << stage;
      const k = ((y * N) / (span * 2)) % N;
      const ang = (2 * Math.PI * k) / N;
      const inTop = (y % (span * 2)) < span;
      let a, b;
      if (stage === 0) {
        a = bitReverse(inTop ? y : y - span, bits);
        b = bitReverse(inTop ? y + span : y, bits);
      } else {
        a = inTop ? y : y - span;
        b = inTop ? y + span : y;
      }
      const o = (stage + y * bits) * 4;
      data[o] = Math.cos(ang); data[o + 1] = Math.sin(ang); data[o + 2] = a; data[o + 3] = b;
    }
  }
  const tex = new THREE.DataTexture(data, bits, N, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

// JONSWAP directional spectrum -> initial field h0(k) and conj(h0(-k)) (baked on the CPU). JONSWAP is
// a peaked, fetch-limited empirical spectrum (no low-frequency blow-up, unlike Phillips), so it gives
// a realistic textured wind-sea. Converted from S(ω) to the 2D k-spectrum via the dispersion Jacobian.
function fillH0Data(data, N, L, opts) {
  const { windSpeed = 11, windDir = [1, 0.7], fetch = 12000, amplitude = 1.0, gamma = 3.3, seed = 1234, spread = 1.0 } = opts;
  const g = 9.81;
  const wn = Math.hypot(windDir[0], windDir[1]) || 1;
  const wd = [windDir[0] / wn, windDir[1] / wn];
  const wp = 22 * Math.pow((g * g) / (windSpeed * fetch), 1 / 3); // JONSWAP peak angular frequency
  const alpha = 0.076 * Math.pow((windSpeed * windSpeed) / (fetch * g), 0.22);
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const gauss = () => { const u = Math.max(rnd(), 1e-6), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const jonswap = (w) => {
    if (w < 1e-3) return 0;
    const sig = w <= wp ? 0.07 : 0.09;
    const r = Math.exp(-((w - wp) * (w - wp)) / (2 * sig * sig * wp * wp));
    return alpha * g * g / Math.pow(w, 5) * Math.exp(-1.25 * Math.pow(wp / w, 4)) * Math.pow(gamma, r);
  };
  const spectrum = (kx, kz) => {
    const k2 = kx * kx + kz * kz;
    if (k2 < 1e-10) return 0;
    const k = Math.sqrt(k2);
    const w = Math.sqrt(g * k);
    const dwdk = g / (2 * w);
    // directional spreading ~ cos^(2s) about the wind, damped against it
    const ct = (kx / k) * wd[0] + (kz / k) * wd[1];
    const dir = Math.pow(Math.max(0.5 + 0.5 * ct, 0.0), 2.0 * spread + 1.0);
    return amplitude * jonswap(w) * (dwdk / k) * dir;
  };
  const h0 = (kx, kz) => { const p = Math.sqrt(Math.max(spectrum(kx, kz), 0) / 2); return [gauss() * p, gauss() * p]; };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const kx = (x - N / 2) * (2 * Math.PI / L);
      const kz = (y - N / 2) * (2 * Math.PI / L);
      const a = h0(kx, kz);
      const b = h0(-kx, -kz);
      const o = (x + y * N) * 4;
      data[o] = a[0]; data[o + 1] = a[1];      // h0(k)
      data[o + 2] = b[0]; data[o + 3] = -b[1]; // conj(h0(-k))
    }
  }
}
function buildH0Texture(N, L, opts) {
  const data = new Float32Array(N * N * 4);
  fillH0Data(data, N, L, opts);
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

export function createOceanFFT(renderer, opts = {}) {
  const N = opts.N || 256;
  const L = opts.L || 256;
  const bits = Math.log2(N);
  const rtOpts = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, stencilBuffer: false };

  const h0 = buildH0Texture(N, L, opts);
  const butterfly = buildButterflyTexture(N);
  const evolve0 = new THREE.WebGLRenderTarget(N, N, rtOpts);
  const evolve1 = new THREE.WebGLRenderTarget(N, N, rtOpts);
  const ping = [new THREE.WebGLRenderTarget(N, N, rtOpts), new THREE.WebGLRenderTarget(N, N, rtOpts)];
  const ping2 = [new THREE.WebGLRenderTarget(N, N, rtOpts), new THREE.WebGLRenderTarget(N, N, rtOpts)];
  const dispRT = new THREE.WebGLRenderTarget(N, N, { ...rtOpts, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  dispRT.texture.wrapS = dispRT.texture.wrapT = THREE.RepeatWrapping;
  const foam = [0, 1].map(() => { const r = new THREE.WebGLRenderTarget(N, N, { ...rtOpts, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }); r.texture.wrapS = r.texture.wrapT = THREE.RepeatWrapping; return r; });
  let foamRead = 0;

  const scene = new THREE.Scene();
  const cam = new THREE.Camera();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  scene.add(quad);

  const evolveMat = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FFT_VERT, fragmentShader: EVOLVE_FRAG,
    uniforms: { uH0: { value: h0 }, uTime: { value: 0 }, uN: { value: N }, uL: { value: L }, uField: { value: 0 } } });
  const bflyMat = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FFT_VERT, fragmentShader: BUTTERFLY_FRAG,
    uniforms: { uButterfly: { value: butterfly }, uData: { value: null }, uStage: { value: 0 }, uN: { value: N }, uDir: { value: 0 }, uBits: { value: bits } } });
  const combineMat = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FFT_VERT, fragmentShader: COMBINE_FRAG,
    uniforms: { uHDx: { value: null }, uDz: { value: null }, uN: { value: N }, uChoppy: { value: opts.choppy ?? 1.1 }, uScale: { value: opts.scale ?? (1.0 / N) } } });
  const foamMat = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FFT_VERT, fragmentShader: FOAM_FRAG,
    uniforms: { uDisp: { value: dispRT.texture }, uPrevFoam: { value: null }, uN: { value: N }, uTexel: { value: L / N },
      uDecay: { value: opts.foamDecay ?? 0.97 }, uInject: { value: opts.foamInject ?? 1.0 }, uThresh: { value: opts.foamThresh ?? 0.9 } } });

  const draw = (mat, target) => { quad.material = mat; renderer.setRenderTarget(target); renderer.render(scene, cam); };
  for (const f of foam) { renderer.setRenderTarget(f); renderer.clear(); } // start with no foam
  renderer.setRenderTarget(null);

  // One 2D IFFT: log2(N) horizontal then log2(N) vertical butterfly stages, ping-ponging two buffers.
  const ifft2d = (srcTex, buf) => {
    let inputTex = srcTex, target = 0;
    for (let dir = 0; dir < 2; dir++) {
      bflyMat.uniforms.uDir.value = dir;
      for (let stage = 0; stage < bits; stage++) {
        bflyMat.uniforms.uStage.value = stage;
        bflyMat.uniforms.uData.value = inputTex;
        draw(bflyMat, buf[target]);
        inputTex = buf[target].texture;
        target = 1 - target;
      }
    }
    return inputTex;
  };

  return {
    dispTexture: dispRT.texture,
    N, L,
    update(time) {
      const prev = renderer.getRenderTarget();
      evolveMat.uniforms.uTime.value = time;
      evolveMat.uniforms.uField.value = 0; draw(evolveMat, evolve0);
      evolveMat.uniforms.uField.value = 1; draw(evolveMat, evolve1);
      combineMat.uniforms.uHDx.value = ifft2d(evolve0.texture, ping);
      combineMat.uniforms.uDz.value = ifft2d(evolve1.texture, ping2);
      draw(combineMat, dispRT);
      foamMat.uniforms.uPrevFoam.value = foam[foamRead].texture; // accumulate + decay foam from last frame
      draw(foamMat, foam[1 - foamRead]);
      foamRead = 1 - foamRead;
      renderer.setRenderTarget(prev);
    },
    foamTexture() { return foam[foamRead].texture; },
    setChoppy(c) { combineMat.uniforms.uChoppy.value = c; },
    setScale(v) { combineMat.uniforms.uScale.value = v; },
    setFoam(p) { if (p.decay !== undefined) foamMat.uniforms.uDecay.value = p.decay; if (p.inject !== undefined) foamMat.uniforms.uInject.value = p.inject; if (p.thresh !== undefined) foamMat.uniforms.uThresh.value = p.thresh; },
    rebuildSpectrum(newOpts) { Object.assign(opts, newOpts); fillH0Data(h0.image.data, N, L, opts); h0.needsUpdate = true; },
    dispose() {
      [evolve0, evolve1, ...ping, ...ping2, dispRT, ...foam].forEach((r) => r.dispose());
      [h0, butterfly].forEach((t) => t.dispose());
      quad.geometry.dispose();
    },
  };
}
