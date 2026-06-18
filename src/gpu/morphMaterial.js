// WebGPU morph material: per-object phase morph in the vertex node + GGX direct
// lighting over the storage-buffer light list in the fragment node. Data access
// and loops are TSL; the heavy math is raw WGSL (wgslFn), ported ~1:1 from
// shaders/morph.vert.glsl + morph.frag.glsl. Shadows/reflections land in P4.
import * as THREE from 'three/webgpu';
import {
  Fn, wgslFn, attribute, instanceIndex, varying,
  positionGeometry, positionWorld, cameraPosition,
  Loop, float, int, vec3, mix, max, length, normalize,
} from 'three/tsl';
import { buildJourneySegments, NUM_SEGMENTS } from '../journey.js';
import { buildNormScaleLUT } from '../normalize.js';
import { packInstances, packLights } from './data.js';
import { roVec4, roFloat } from './storage.js';

// --- WGSL math (no storage; pure functions ported from the GLSL) -------------
const wgPhase = wgslFn(`
  fn wgPhase(t: f32, ms: f32, ph: f32, n: f32) -> f32 {
    let x = t * ms + ph;
    let m = x % (2.0 * n);
    if (m <= n) { return m; }
    return 2.0 * n - m;
  }
`);

// Morph a vertex to world space: collapse inactive segments, normalize by phase,
// spin, orient, scale, translate. (matches morph.vert.glsl)
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

// Flat shading normal from screen-space derivatives, flipped to face the camera.
const wgFlatNormal = wgslFn(`
  fn wgFlatNormal(p: vec3<f32>, viewDir: vec3<f32>) -> vec3<f32> {
    var nrm = normalize(cross(dpdx(p), dpdy(p)));
    if (dot(nrm, viewDir) < 0.0) { nrm = -nrm; }
    return nrm;
  }
`);

// GGX (widened-alpha D, Smith joint Vis, Schlick F) + Unreal falloff.
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

// Builds the instanced morph mesh. `uTime` is a shared TSL uniform node so the
// backend can drive the morph clock.
export function buildMorphMesh({ objects, lights, lightIndices }, uTime) {
  const geometry = buildGeometry();
  geometry.instanceCount = objects.length;

  const inst = packInstances(objects);
  const uPosScale = roVec4(inst.posScale);
  const uQuat = roVec4(inst.quat);
  const uSpin = roVec4(inst.spin);
  const uTm = roVec4(inst.tm); // phaseOffset, morphSpeed, _, _
  const uColorRough = roVec4(inst.colorRough);
  const uMatLists = roVec4(inst.matLists); // metal, lightOffset, lightCount, _

  const uLights = roVec4(packLights(lights)); // 2 vec4 / light
  const uLightIndex = roFloat(new Float32Array(lightIndices));

  const uNormLUT = roFloat(buildNormScaleLUT());
  const N_SEG = float(NUM_SEGMENTS);

  // Per-instance values the fragment needs (constant across each instance, so a
  // plain varying is exact). Reading storage by instanceIndex happens in the
  // vertex stage where instanceIndex is valid.
  const vColorRough = varying(uColorRough.element(instanceIndex));
  const vMatLists = varying(uMatLists.element(instanceIndex));

  const material = new THREE.MeshBasicNodeMaterial();
  material.side = THREE.DoubleSide;
  material.name = 'morph';

  // --- vertex: phase morph to world space ---
  material.positionNode = Fn(() => {
    const ps = uPosScale.element(instanceIndex);
    const q = uQuat.element(instanceIndex);
    const sp = uSpin.element(instanceIndex);
    const tm = uTm.element(instanceIndex);

    const start = positionGeometry;
    const end = attribute('aEnd', 'vec3');
    const segId = attribute('aSegment', 'float');

    const p = wgPhase(uTime, tm.y, tm.x, N_SEG);

    // mean-radius normalization LUT (128 samples) by phase
    const fp = p.div(N_SEG).mul(127.0);
    const i0 = fp.floor();
    const i1 = i0.add(1.0).min(127.0);
    const ns = mix(uNormLUT.element(i0.toInt()), uNormLUT.element(i1.toInt()), fp.sub(i0));

    return wgMorphWorld(start, end, segId, p, ns, ps, q, sp, uTime, N_SEG);
  })();

  // --- fragment: GGX direct lighting over the light list ---
  material.colorNode = Fn(() => {
    const albedo = vColorRough.xyz;
    const rough = vColorRough.w;
    const metal = vMatLists.x;
    const lo = vMatLists.y.add(0.5).floor().toInt();
    const lc = vMatLists.z.add(0.5).floor().toInt();

    const P = positionWorld;
    const V = normalize(cameraPosition.sub(P));
    const N = wgFlatNormal(P, V);

    const diffuseAlbedo = albedo.mul(float(1.0).sub(metal));
    const F0 = mix(vec3(0.04), albedo, metal);

    const lit = vec3(0.0).toVar();
    Loop(lc, ({ i }) => {
      const idx = uLightIndex.element(lo.add(int(i))).add(0.5).floor().toInt();
      const lpos = uLights.element(idx.mul(2));
      const colRad = uLights.element(idx.mul(2).add(1));
      const Lv = lpos.xyz.sub(P);
      const dist = length(Lv);
      const L = Lv.div(max(dist, 1e-4));
      const contrib = wgBrdf(N, V, L, diffuseAlbedo, F0, rough, dist)
        .mul(colRad.xyz).mul(wgFalloff(dist, colRad.w));
      lit.addAssign(contrib);
    });

    // hemispheric ambient
    const amb = mix(vec3(0.02, 0.02, 0.03), vec3(0.05, 0.05, 0.06), N.y.mul(0.5).add(0.5));
    lit.addAssign(diffuseAlbedo.mul(amb));

    return lit;
  })();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}
