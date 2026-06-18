import { buildJourneySegments } from './journey.js';
import { planeOf, supporting } from './hull.js';
import { floatTexture } from './textures.js';

// Data textures for convex-hull occluder tracing. The shader rebuilds any
// occluder's current hull from the per-segment face planes + the occluder's
// transform + its phase.

// Distance from the origin to the shape's supporting plane with normal n (the
// farthest vertex projected onto n).
function supportDist(verts, nx, ny, nz) {
  let m = -Infinity;
  for (let k = 0; k < verts.length; k += 3) {
    const d = nx * verts[k] + ny * verts[k + 1] + nz * verts[k + 2];
    if (d > m) m = d;
  }
  return m;
}

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

// Pair start faces with end faces by nearest normal. A face with no counterpart
// at the other endpoint blends to/from that shape's *supporting* plane along the
// same normal (not a sharp face yet, but still a real bounding plane) so the hull
// stays closed throughout the blend — otherwise it opens up and the shadow/
// reflection develops holes mid-morph.
function matchFaces(starts, ends, startVerts, endVerts) {
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
    else slots.push([s, [s[0], s[1], s[2], supportDist(endVerts, s[0], s[1], s[2])]]);
  }
  for (let j = 0; j < ends.length; j++) {
    if (!usedE[j]) {
      const e = ends[j];
      slots.push([[e[0], e[1], e[2], supportDist(startVerts, e[0], e[1], e[2])], e]);
    }
  }
  return slots;
}

// Per segment, the unique face planes of the start and end shapes, matched and
// laid out as 2 RGBA texels each ([n.xyz, d] start, then end). The shader blends
// each slot by phase. This merges coplanar triangles (e.g. cube 24 tris -> 6
// faces) so the trace loops far fewer planes. Return keys keep the "Tri" names so
// the shader/main don't change (a "tri" entry is now a face slot).
// Raw per-segment face-plane data (renderer-independent): a Float32Array of
// 2 RGBA slots per face ([n.xyz, d] start, then end), plus the per-segment start
// offset + count. Consumed by both the WebGL plane texture and the WebGPU storage
// buffer.
export function buildPlaneData() {
  const segs = buildJourneySegments();
  const segSlots = segs.map((s) =>
    matchFaces(uniqueFaces(s.start), uniqueFaces(s.end), s.start, s.end));

  let total = 0;
  const segTriStart = [];
  const segTriCount = [];
  for (const sl of segSlots) {
    segTriStart.push(total);
    segTriCount.push(sl.length);
    total += sl.length;
  }
  const planes = new Float32Array(total * 2 * 4);
  let f = 0;
  for (const sl of segSlots) {
    for (const [ps, pe] of sl) {
      const o = f * 8;
      planes[o] = ps[0]; planes[o + 1] = ps[1]; planes[o + 2] = ps[2]; planes[o + 3] = ps[3];
      planes[o + 4] = pe[0]; planes[o + 5] = pe[1]; planes[o + 6] = pe[2]; planes[o + 7] = pe[3];
      f++;
    }
  }
  return { planes, total, segTriStart, segTriCount };
}

export function buildPlaneTexture() {
  const { planes, total, segTriStart, segTriCount } = buildPlaneData();
  const { tex, width } = floatTexture(planes, total * 2, 4);
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
  const { tex, width } = floatTexture(data, objects.length * 4, 4);
  return { transformTex: tex, transformTexW: width };
}
