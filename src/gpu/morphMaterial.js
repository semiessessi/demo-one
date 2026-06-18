// WebGPU morph material: per-object phase morph in the vertex node + GGX direct
// lighting with convex-hull shadows + reflections in the fragment node. Storage
// access + control flow are TSL (Fn/Loop/If closing over the storage nodes); the
// leaf math is raw WGSL (wgslFn). Ported ~1:1 from shaders/morph.vert/frag.glsl.
import * as THREE from 'three/webgpu';
import {
  Fn, wgslFn, attribute, instanceIndex, varying, storage,
  positionGeometry, positionWorld, cameraPosition,
  Loop, If, Break, and,
  float, int, vec3, vec4, mix, max, length, normalize, dot, abs, pow, reflect,
} from 'three/tsl';
import { buildJourneySegments, NUM_SEGMENTS, MAX_NORM_CIRCUMRADIUS } from '../journey.js';
import { buildNormScaleLUT } from '../normalize.js';
import { buildPlaneData } from '../occluderData.js';
import {
  packInstanceBuffer, packIndices, packLights, packInstanceMaterial,
  packOccluderTransforms, INSTANCE_STRIDE,
} from './data.js';
import { roVec4, roFloat } from './storage.js';
import { wgAnimDir, wgLightEmission, wgSpawnScale, wgMusicScale } from './orbit.js';

const REFL_ROUGHNESS_MAX = 0.35;
const SHADOW_LIGHTS = 16; // nearest N lights cast shadows

// --- WGSL leaf math (no storage) ---------------------------------------------
const wgQrot = wgslFn(`
  fn wgQrot(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }
`);
const wgQconj = wgslFn(`fn wgQconj(q: vec4<f32>) -> vec4<f32> { return vec4<f32>(-q.xyz, q.w); }`);
const wgQuatAxisAngle = wgslFn(`
  fn wgQuatAxisAngle(axis: vec3<f32>, angle: f32) -> vec4<f32> {
    let h = angle * 0.5;
    return vec4<f32>(normalize(axis) * sin(h), cos(h));
  }
`);
const wgQmul = wgslFn(`
  fn wgQmul(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
  }
`);
const wgPhase = wgslFn(`
  fn wgPhase(t: f32, ms: f32, ph: f32, n: f32) -> f32 {
    let x = t * ms + ph;
    let m = x % (2.0 * n);
    if (m <= n) { return m; }
    return 2.0 * n - m;
  }
`);
const wgEnvironment = wgslFn(`
  fn wgEnvironment(d: vec3<f32>) -> vec3<f32> {
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

const wgMorphWorld = wgslFn(`
  fn wgMorphWorld(start: vec3<f32>, end: vec3<f32>, segId: f32, p: f32, ns: f32,
                  ps: vec4<f32>, q: vec4<f32>, sp: vec4<f32>, t: f32, n: f32) -> vec3<f32> {
    var seg = floor(p);
    var localT = fract(p);
    if (seg >= n - 0.5) { seg = n - 1.0; localT = 1.0; }
    var local = vec3<f32>(0.0);
    if (abs(segId - seg) < 0.5) { local = mix(start, end, localT); }
    local = local * ns;
    let h = 0.5 * t * sp.w;
    let axis = normalize(sp.xyz);
    let spin = vec4<f32>(axis * sin(h), cos(h));
    let rot = vec4<f32>(spin.w * q.xyz + q.w * spin.xyz + cross(spin.xyz, q.xyz),
                        spin.w * q.w - dot(spin.xyz, q.xyz));
    let v = local * ps.w;
    return ps.xyz + (v + 2.0 * cross(rot.xyz, cross(rot.xyz, v) + rot.w * v));
  }
`);

const wgFlatNormal = wgslFn(`
  fn wgFlatNormal(p: vec3<f32>, viewDir: vec3<f32>) -> vec3<f32> {
    var nrm = normalize(cross(dpdx(p), dpdy(p)));
    if (dot(nrm, viewDir) < 0.0) { nrm = -nrm; }
    return nrm;
  }
`);

const wgBrdf = wgslFn(`
  fn wgBrdf(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, diffuseAlbedo: vec3<f32>,
            F0: vec3<f32>, roughness: f32, dist: f32) -> vec3<f32> {
    let H = normalize(V + L);
    let NdotL = max(dot(N, L), 0.0);
    let NdotV = max(dot(N, V), 1e-4);
    let NdotH = max(dot(N, H), 0.0);
    let LdotH = max(dot(L, H), 0.0);
    let alpha = roughness * roughness;
    let wAlpha = clamp(alpha + 0.12 / (3.0 * dist), 0.0, 1.0);
    let wAlpha2 = wAlpha * wAlpha;
    let energy = (alpha / wAlpha) * (alpha / wAlpha);
    let dDen = NdotH * NdotH * (wAlpha2 - 1.0) + 1.0;
    let D = energy * wAlpha2 / (dDen * dDen);
    let a2 = alpha * alpha;
    let smithV = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2);
    let smithL = NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
    let Vis = 0.5 / max(smithV + smithL, 1e-5);
    let F = F0 + (vec3<f32>(1.0) - F0) * pow(1.0 - LdotH, 5.0);
    return (diffuseAlbedo + D * Vis * F) * NdotL;
  }
`);
const wgFalloff = wgslFn(`
  fn wgFalloff(dist: f32, radius: f32) -> f32 {
    let a = clamp(1.0 - pow(dist / radius, 4.0), 0.0, 1.0);
    return a * a / (dist * dist + 1.0);
  }
`);

function buildGeometry() {
  const segments = buildJourneySegments();
  let total = 0;
  for (const s of segments) total += s.start.length / 3;

  const start = new Float32Array(total * 3);
  const end = new Float32Array(total * 3);
  const segId = new Float32Array(total);
  let v = 0;
  segments.forEach((s, si) => {
    const n = s.start.length / 3;
    start.set(s.start, v * 3);
    end.set(s.end, v * 3);
    for (let i = 0; i < n; i++) segId[v + i] = si;
    v += n;
  });

  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(start, 3));
  g.setAttribute('aEnd', new THREE.BufferAttribute(end, 3));
  g.setAttribute('aSegment', new THREE.BufferAttribute(segId, 1));
  return g;
}

// Builds the instanced morph mesh. `uTime` drives the morph clock; `uLightTime` is a
// separate clock for the orbiting lights (toggleable); `uBeatTime`/`uBeatStrength` +
// `uMusicTime` drive the beat flares; `uSpawn` is the spawn-in intro clock. TSL nodes.
export function buildMorphMesh(data, uTime, uLightTime, uBeatTime, uBeatStrength, uBeatSeed, uMusicTime, uSpawn, uScaleNotes) {
  const { objects, lights, lightIndices, occluderIndices, reflectionIndices } = data;
  const LPO = lights.length / objects.length; // lights per object -> a light's host spawn rank

  const geometry = buildGeometry();
  geometry.instanceCount = objects.length;

  // --- storage buffers (consolidated to stay within 8 per shader stage) ---
  // Per-instance: one interleaved buffer (vertex stage; fragment reads via varyings).
  const uInst = roVec4(packInstanceBuffer(objects));
  const ST = INSTANCE_STRIDE;
  // Frustum-cull order buffer: maps each draw slot -> global object index. The CPU
  // culler (backends/webgpu.js) rewrites it + shrinks instanceCount each frame;
  // identity by default so an un-culled draw still renders everything.
  const orderArr = new Uint32Array(objects.length);
  for (let i = 0; i < objects.length; i++) orderArr[i] = i;
  const orderAttr = new THREE.StorageBufferAttribute(orderArr, 1);
  const gid = storage(orderAttr, 'uint', objects.length).toReadOnly().element(instanceIndex);
  // CPU note-stepped morph position per object, uploaded each frame; indexed by the ORIGINAL
  // object id (gid in the vertex, the occluder index in traceHull).
  const morphPArr = new Float32Array(objects.length);
  const morphPAttr = new THREE.StorageBufferAttribute(morphPArr, 1);
  const morphP = storage(morphPAttr, 'float', objects.length).toReadOnly();
  const instSlot = (k) => uInst.element(gid.mul(ST).add(k));

  // Index lists (light / shadow / reflection) merged into one buffer + bases.
  const idx = packIndices(lightIndices, occluderIndices, reflectionIndices);
  const uIndices = roFloat(idx.combined);
  const SHADOW_BASE = int(idx.shadowBase);
  const REFL_BASE = int(idx.reflBase);

  const uLights = roVec4(packLights(lights));
  const uInstanceMat = roVec4(packInstanceMaterial(objects));
  const uOccXf = roVec4(packOccluderTransforms(objects));

  const plane = buildPlaneData();
  const uPlanes = roVec4(plane.planes);
  // segTriStart [0..N) then segTriCount [N..2N) in one buffer.
  const SEG_N = plane.segTriStart.length;
  const segInfo = new Float32Array(SEG_N * 2);
  segInfo.set(plane.segTriStart, 0);
  segInfo.set(plane.segTriCount, SEG_N);
  const uSegInfo = roFloat(segInfo);

  const uNormLUT = roFloat(buildNormScaleLUT());
  const N_SEG = float(NUM_SEGMENTS);

  // phase -> mean-radius normalization scale (128-sample LUT)
  const lookupNorm = (p) => {
    const fp = p.div(N_SEG).mul(127.0);
    const i0 = fp.floor();
    const i1 = i0.add(1.0).min(127.0);
    return mix(uNormLUT.element(i0.toInt()), uNormLUT.element(i1.toInt()), fp.sub(i0));
  };

  // --- convex-hull trace of occluder `oi` against a world ray ---
  // returns vec4(entryNormal.xyz, tHit); tHit < 0 means miss.
  const traceHull = Fn(([oi, roW, rdW]) => {
    const b = oi.mul(4);
    const t0 = uOccXf.element(b);
    const baseQ = uOccXf.element(b.add(1));
    const t2 = uOccXf.element(b.add(2));
    const t3 = uOccXf.element(b.add(3));
    const center = t0.xyz;
    const scale = t0.w;

    const p = morphP.element(oi);
    const localT = p.fract().toVar();
    const seg = p.floor().toVar();
    If(seg.greaterThanEqual(N_SEG.sub(0.5)), () => {
      seg.assign(N_SEG.sub(1.0));
      localT.assign(1.0);
    });
    const segI = seg.toInt();

    const q = wgQmul(wgQuatAxisAngle(t2.xyz, uTime.mul(t2.w)), baseQ);
    const S = scale.mul(lookupNorm(p)).mul(wgMusicScale(float(oi), uScaleNotes));
    const roL = wgQrot(wgQconj(q), roW.sub(center)).div(S);
    const rdL = wgQrot(wgQconj(q), rdW).div(S);

    const triBase = uSegInfo.element(segI).add(0.5).floor().toInt();
    const tcount = uSegInfo.element(int(SEG_N).add(segI)).add(0.5).floor().toInt();
    const tEnter = float(-1e9).toVar();
    const tExit = float(1e9).toVar();
    const enterN = vec3(0).toVar();
    const valid = float(1).toVar();

    Loop(tcount, ({ i }) => {
      const gi = triBase.add(int(i)).mul(2);
      const p0 = uPlanes.element(gi);
      If(dot(p0.xyz, p0.xyz).greaterThanEqual(0.25), () => {
        const p1 = uPlanes.element(gi.add(1));
        const n = normalize(mix(p0.xyz, p1.xyz, localT));
        const d = mix(p0.w, p1.w, localT);
        const denom = dot(n, rdL);
        const num = d.sub(dot(n, roL));
        If(abs(denom).lessThan(1e-9), () => {
          If(num.lessThan(0), () => { valid.assign(0); });
        }).Else(() => {
          const th = num.div(denom);
          If(denom.lessThan(0), () => {
            If(th.greaterThan(tEnter), () => { tEnter.assign(th); enterN.assign(n); });
          }).Else(() => {
            If(th.lessThan(tExit), () => { tExit.assign(th); });
          });
        });
      });
    });

    const out = vec4(0, 0, 0, -1).toVar();
    If(and(and(tEnter.lessThanEqual(tExit), tExit.greaterThan(1e-4)), valid.greaterThan(0.5)), () => {
      out.assign(vec4(wgQrot(q, enterN), tEnter));
    });
    return out;
  }).setLayout({
    name: 'traceHull',
    type: 'vec4',
    inputs: [
      { name: 'oi', type: 'int' },
      { name: 'roW', type: 'vec3' },
      { name: 'rdW', type: 'vec3' },
    ],
  });

  // 0 if any occluder in the object's shadow list blocks the light, else 1.
  // Cheap ray-sphere reject per occluder (bounding radius = scale * max circumradius)
  // skips the full hull trace for occluders the shadow ray can't reach.
  const traceShadow = Fn(([p, L, distToLight, shadowOff, shadowCount]) => {
    const sh = float(1).toVar();
    Loop(shadowCount, ({ i }) => {
      const oi = uIndices.element(SHADOW_BASE.add(shadowOff).add(int(i))).add(0.5).floor().toInt();
      const D = uOccXf.element(oi.mul(4)); // center.xyz, scale
      const r = D.w.mul(MAX_NORM_CIRCUMRADIUS);
      const dc = D.xyz.sub(p);
      const t = dot(dc, L);
      const perp2 = dot(dc, dc).sub(t.mul(t));
      // behind P, beyond the light, or the ray misses the bounding sphere -> skip
      If(and(and(t.greaterThan(r.negate()), t.lessThan(distToLight.add(r))), perp2.lessThan(r.mul(r))), () => {
        const h = traceHull(oi, p, L);
        If(and(h.w.greaterThan(1e-3), h.w.lessThan(distToLight)), () => {
          sh.assign(0);
          Break();
        });
      });
    });
    return sh;
  }).setLayout({
    name: 'traceShadow',
    type: 'float',
    inputs: [
      { name: 'p', type: 'vec3' },
      { name: 'L', type: 'vec3' },
      { name: 'distToLight', type: 'float' },
      { name: 'shadowOff', type: 'int' },
      { name: 'shadowCount', type: 'int' },
    ],
  });

  // GGX direct lighting over the object's light list (with optional shadows).
  const shadeDirect = Fn(([p, N, V, albedo, rough, metal, lo, lc, doShadow, shadowOff, shadowCount]) => {
    const diffuseAlbedo = albedo.mul(float(1).sub(metal));
    const F0 = mix(vec3(0.04), albedo, metal);
    const lit = vec3(0).toVar();
    Loop(lc, ({ i }) => {
      const liF = uIndices.element(lo.add(int(i))).add(0.5).floor();
      const li = liF.toInt();
      const l0 = uLights.element(li.mul(2)); // center.xyz, orbitRadius
      const colRad = uLights.element(li.mul(2).add(1));
      const lpos = l0.xyz.add(wgAnimDir(liF, uLightTime).mul(l0.w)); // orbit around the host centre
      const Lv = lpos.sub(p);
      const dist = length(Lv);
      const L = Lv.div(max(dist, 1e-4));
      const fall = wgFalloff(dist, colRad.w);
      const lum = max(colRad.x, max(colRad.y, colRad.z));
      // skip lights that can't contribute: back-facing, out of radius, or dark
      If(and(and(dot(N, L).greaterThan(0), fall.greaterThan(1e-6)), lum.greaterThan(0)), () => {
        const shadow = float(1).toVar();
        If(and(doShadow.greaterThan(0.5), int(i).lessThan(SHADOW_LIGHTS)), () => {
          shadow.assign(traceShadow(p.add(N.mul(0.02)), L, dist, shadowOff, shadowCount));
        });
        const band = liF.div(32).fract().mul(32).add(0.5).floor().toInt(); // li % 32 (light's slot)
        const hostSlot = liF.div(LPO).floor(); // light's host object spawn rank
        const emission = wgLightEmission(liF, hostSlot, uSpawn, uBeatTime.element(band), uBeatStrength.element(band), uBeatSeed.element(band), uMusicTime);
        lit.addAssign(
          wgBrdf(N, V, L, diffuseAlbedo, F0, rough, dist).mul(colRad.xyz).mul(fall).mul(shadow).mul(emission),
        );
      });
    });
    return lit;
  }).setLayout({
    name: 'shadeDirect',
    type: 'vec3',
    inputs: [
      { name: 'p', type: 'vec3' },
      { name: 'N', type: 'vec3' },
      { name: 'V', type: 'vec3' },
      { name: 'albedo', type: 'vec3' },
      { name: 'rough', type: 'float' },
      { name: 'metal', type: 'float' },
      { name: 'lo', type: 'int' },
      { name: 'lc', type: 'int' },
      { name: 'doShadow', type: 'float' },
      { name: 'shadowOff', type: 'int' },
      { name: 'shadowCount', type: 'int' },
    ],
  });

  // --- per-instance values for the fragment (constant per instance) ---
  const vColorRough = varying(instSlot(4));
  const vMatLists = varying(instSlot(5));
  const vShadowRefl = varying(instSlot(6));

  const material = new THREE.MeshBasicNodeMaterial();
  material.side = THREE.DoubleSide;
  material.name = 'morph';

  // --- vertex: phase morph to world space ---
  material.positionNode = Fn(() => {
    const ps = instSlot(0);
    const q = instSlot(1);
    const sp = instSlot(2);
    const tm = instSlot(3);

    const start = positionGeometry;
    const end = attribute('aEnd', 'vec3');
    const segId = attribute('aSegment', 'float');

    const p = morphP.element(gid);
    const ns = lookupNorm(p);
    const world = wgMorphWorld(start, end, segId, p, ns, ps, q, sp, uTime, N_SEG);
    // Scale the object in around its centre over the spawn intro.
    return ps.xyz.add(world.sub(ps.xyz).mul(wgSpawnScale(float(gid), uSpawn)).mul(wgMusicScale(float(gid), uScaleNotes)));
  })();

  // --- fragment: GGX direct + shadows + reflections ---
  material.colorNode = Fn(() => {
    const albedo = vColorRough.xyz;
    const rough = vColorRough.w;
    const metal = vMatLists.x;
    const lo = vMatLists.y.add(0.5).floor().toInt();
    const lc = vMatLists.z.add(0.5).floor().toInt();
    const shadowOff = vShadowRefl.x.add(0.5).floor().toInt();
    const shadowCount = vShadowRefl.y.add(0.5).floor().toInt();
    const reflOff = vShadowRefl.z.add(0.5).floor().toInt();
    const reflCount = vShadowRefl.w.add(0.5).floor().toInt();

    const P = positionWorld;
    const V = normalize(cameraPosition.sub(P));
    const N = wgFlatNormal(P, V);

    const lit = shadeDirect(P, N, V, albedo, rough, metal, lo, lc, float(1), shadowOff, shadowCount).toVar();

    const diffuseAlbedo = albedo.mul(float(1).sub(metal));
    lit.addAssign(diffuseAlbedo.mul(mix(vec3(0.02, 0.02, 0.03), vec3(0.05, 0.05, 0.06), N.y.mul(0.5).add(0.5))));

    If(rough.lessThan(REFL_ROUGHNESS_MAX), () => {
      const F0 = mix(vec3(0.04), albedo, metal);
      const Rdir = reflect(V.negate(), N);
      const NdotV = max(dot(N, V), 0.0);
      const oneMinusRough = vec3(float(1).sub(rough));
      const envF = F0.add(max(oneMinusRough, F0).sub(F0).mul(pow(float(1).sub(NdotV), 5.0)));

      const bestT = float(1e9).toVar();
      const bestN = vec3(0).toVar();
      const bestObj = int(0).toVar();
      const hit = float(0).toVar();
      const ro = P.add(N.mul(0.02));
      Loop(reflCount, ({ i }) => {
        const oi = uIndices.element(REFL_BASE.add(reflOff).add(int(i))).add(0.5).floor().toInt();
        const D = uOccXf.element(oi.mul(4)); // center.xyz, scale
        const r = D.w.mul(MAX_NORM_CIRCUMRADIUS);
        const dc = D.xyz.sub(ro);
        const t = dot(dc, Rdir);
        const perp2 = dot(dc, dc).sub(t.mul(t));
        // behind the surface, behind the reflection ray, or the ray misses -> skip
        If(and(and(dot(dc, N).greaterThan(r.negate()), t.greaterThan(r.negate())), perp2.lessThan(r.mul(r))), () => {
          const h = traceHull(oi, ro, Rdir);
          If(and(h.w.greaterThan(1e-3), h.w.lessThan(bestT)), () => {
            bestT.assign(h.w);
            bestN.assign(h.xyz);
            bestObj.assign(oi);
            hit.assign(1);
          });
        });
      });

      const refl = vec3(0).toVar();
      If(hit.greaterThan(0.5), () => {
        const hp = P.add(Rdir.mul(bestT));
        const m0 = uInstanceMat.element(bestObj.mul(2));
        const m1 = uInstanceMat.element(bestObj.mul(2).add(1));
        refl.assign(shadeDirect(
          hp, bestN, Rdir.negate(), m0.xyz, m0.w, m1.z,
          m1.x.add(0.5).floor().toInt(), m1.y.add(0.5).floor().toInt(),
          float(0), int(0), int(0),
        ));
        refl.addAssign(m0.xyz.mul(wgEnvironment(bestN)).mul(0.3));
      }).Else(() => {
        refl.assign(wgEnvironment(Rdir));
      });
      lit.addAssign(refl.mul(envF));
    });

    return lit;
  })();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return { mesh, geometry, orderArr, orderAttr, morphPArr, morphPAttr };
}
