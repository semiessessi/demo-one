import * as THREE from 'three';
import { buildJourneySegments } from './journey.js';

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

// Plane of a triangle (outward normal + offset), or null if degenerate. The
// shapes are centred at the origin, so "outward" = same side as the centroid.
function planeOf(p, ai, bi, ci) {
  const ax = p[ai], ay = p[ai + 1], az = p[ai + 2];
  const ux = p[bi] - ax, uy = p[bi + 1] - ay, uz = p[bi + 2] - az;
  const vx = p[ci] - ax, vy = p[ci + 1] - ay, vz = p[ci + 2] - az;
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-7) return null; // degenerate (collapsed) triangle
  nx /= len; ny /= len; nz /= len;
  const cx = (ax + p[bi] + p[ci]) / 3, cy = (ay + p[bi + 1] + p[ci + 1]) / 3, cz = (az + p[bi + 2] + p[ci + 2]) / 3;
  if (nx * cx + ny * cy + nz * cz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  return [nx, ny, nz, nx * ax + ny * ay + nz * az];
}

// Precompute every triangle's start-plane and end-plane (2 RGBA texels each:
// [n.xyz, d]). The shader blends them by phase. A triangle degenerate at one end
// reuses the valid end's plane; degenerate at both ends is marked inactive (n=0).
export function buildPlaneTexture() {
  const segs = buildJourneySegments();
  let total = 0;
  const segTriStart = [];
  const segTriCount = [];
  for (const s of segs) {
    const tc = s.start.length / 9;
    segTriStart.push(total);
    segTriCount.push(tc);
    total += tc;
  }
  const data = new Float32Array(total * 2 * 4);
  let tri = 0;
  for (const s of segs) {
    const tc = s.start.length / 9;
    for (let t = 0; t < tc; t++) {
      const i = t * 9;
      let ps = planeOf(s.start, i, i + 3, i + 6);
      let pe = planeOf(s.end, i, i + 3, i + 6);
      if (!ps && !pe) { tri++; continue; } // inactive: leave zeros
      if (!ps) ps = pe;
      if (!pe) pe = ps;
      const o = tri * 8;
      data[o] = ps[0]; data[o + 1] = ps[1]; data[o + 2] = ps[2]; data[o + 3] = ps[3];
      data[o + 4] = pe[0]; data[o + 5] = pe[1]; data[o + 6] = pe[2]; data[o + 7] = pe[3];
      tri++;
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
