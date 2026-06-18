import * as THREE from 'three';
import { buildJourneySegments } from './journey.js';
import { planeOf, supporting } from './hull.js';

// Data textures for convex-hull occluder tracing. The shader rebuilds any
// occluder's current hull from: the shared morph geometry (every segment's
// triangle verts) + the occluder's transform + its phase.

const MAX_W = 2048;

function rgbaTexture(data, texelCount) {
  const w = Math.min(MAX_W, texelCount);
  const h = Math.ceil(texelCount / w);
  const buf = new Float32Array(w * h * 4);
  buf.set(data);
  const tex = new THREE.DataTexture(buf, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { tex, width: w };
}

// Offset that puts a face plane outside the shape so it doesn't constrain the
// hull (used for faces that fade in/out across a segment). Must exceed the
// largest raw circumradius (cube ~sqrt(3)).
const INACTIVE_D = 5.0;

// Unique supporting face planes of a triangle soup (coplanar triangles merged).
function uniqueFaces(verts) {
  const tc = verts.length / 9;
  const map = new Map();
  for (let t = 0; t < tc; t++) {
    const i = t * 9;
    const p = planeOf(verts, i, i + 3, i + 6);
    if (!p || !supporting(p, verts)) continue;
    const key = `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)},${Math.round(p[2] * 100)},${Math.round(p[3] * 100)}`;
    if (!map.has(key)) map.set(key, p);
  }
  return [...map.values()];
}

// Pair start faces with end faces by nearest normal; unmatched faces fade in/out
// (their inactive endpoint plane sits outside the shape). Returns slots that each
// blend a start plane to an end plane by phase.
function matchFaces(starts, ends) {
  const slots = [];
  const usedE = new Array(ends.length).fill(false);
  for (const s of starts) {
    let best = -1;
    let bestDot = 0.8; // normal-agreement threshold
    for (let j = 0; j < ends.length; j++) {
      if (usedE[j]) continue;
      const d = s[0] * ends[j][0] + s[1] * ends[j][1] + s[2] * ends[j][2];
      if (d > bestDot) { bestDot = d; best = j; }
    }
    if (best >= 0) { usedE[best] = true; slots.push([s, ends[best]]); }
    else slots.push([s, [s[0], s[1], s[2], INACTIVE_D]]); // fades out
  }
  for (let j = 0; j < ends.length; j++) {
    if (!usedE[j]) slots.push([[ends[j][0], ends[j][1], ends[j][2], INACTIVE_D], ends[j]]); // fades in
  }
  return slots;
}

// Per segment, the unique face planes of the start and end shapes, matched and
// laid out as 2 RGBA texels each ([n.xyz, d] start, then end). The shader blends
// each slot by phase. This merges coplanar triangles (e.g. cube 24 tris -> 6
// faces) so the trace loops far fewer planes. Return keys keep the "Tri" names so
// the shader/main don't change (a "tri" entry is now a face slot).
export function buildPlaneTexture() {
  const segs = buildJourneySegments();
  const segSlots = segs.map((s) => matchFaces(uniqueFaces(s.start), uniqueFaces(s.end)));

  let total = 0;
  const segTriStart = [];
  const segTriCount = [];
  for (const sl of segSlots) {
    segTriStart.push(total);
    segTriCount.push(sl.length);
    total += sl.length;
  }
  const data = new Float32Array(total * 2 * 4);
  let f = 0;
  for (const sl of segSlots) {
    for (const [ps, pe] of sl) {
      const o = f * 8;
      data[o] = ps[0]; data[o + 1] = ps[1]; data[o + 2] = ps[2]; data[o + 3] = ps[3];
      data[o + 4] = pe[0]; data[o + 5] = pe[1]; data[o + 6] = pe[2]; data[o + 7] = pe[3];
      f++;
    }
  }
  const { tex, width } = rgbaTexture(data, total * 2);
  return { planeTex: tex, planeTexW: width, segTriStart, segTriCount };
}

// Per-object transform: [pos.xyz, scale], [quat], [spinAxis.xyz, spinSpeed], [phase,..].
export function buildOccluderTransforms(objects) {
  const data = new Float32Array(objects.length * 4 * 4);
  objects.forEach((o, i) => {
    const b = i * 16;
    data[b] = o.pos[0]; data[b + 1] = o.pos[1]; data[b + 2] = o.pos[2]; data[b + 3] = o.scale;
    data[b + 4] = o.quat[0]; data[b + 5] = o.quat[1]; data[b + 6] = o.quat[2]; data[b + 7] = o.quat[3];
    data[b + 8] = o.spinAxis[0]; data[b + 9] = o.spinAxis[1]; data[b + 10] = o.spinAxis[2]; data[b + 11] = o.spinSpeed;
    data[b + 12] = o.phase; data[b + 13] = o.morphSpeed;
  });
  const { tex, width } = rgbaTexture(data, objects.length * 4);
  return { transformTex: tex, transformTexW: width };
}
