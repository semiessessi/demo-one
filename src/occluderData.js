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

// All segments' triangle vertices concatenated; 2 texels/vertex (start, end).
// Also returns each segment's first-vertex offset and triangle count.
export function buildGeometryTexture() {
  const segs = buildJourneySegments();
  let total = 0;
  const segVertStart = [];
  const segTriCount = [];
  for (const s of segs) {
    const vc = s.start.length / 3;
    segVertStart.push(total);
    segTriCount.push(vc / 3);
    total += vc;
  }
  const data = new Float32Array(total * 2 * 4);
  let v = 0;
  for (const s of segs) {
    const vc = s.start.length / 3;
    for (let i = 0; i < vc; i++) {
      const o = (v + i) * 8;
      data[o] = s.start[i * 3];
      data[o + 1] = s.start[i * 3 + 1];
      data[o + 2] = s.start[i * 3 + 2];
      data[o + 4] = s.end[i * 3];
      data[o + 5] = s.end[i * 3 + 1];
      data[o + 6] = s.end[i * 3 + 2];
    }
    v += vc;
  }
  const { tex, width } = rgbaTexture(data, total * 2);
  return { geoTex: tex, geoTexW: width, segVertStart, segTriCount };
}

// Per-object transform: [pos.xyz, scale], [quat], [spinAxis.xyz, spinSpeed], [phase,..].
export function buildOccluderTransforms(objects) {
  const data = new Float32Array(objects.length * 4 * 4);
  objects.forEach((o, i) => {
    const b = i * 16;
    data[b] = o.pos[0]; data[b + 1] = o.pos[1]; data[b + 2] = o.pos[2]; data[b + 3] = o.scale;
    data[b + 4] = o.quat[0]; data[b + 5] = o.quat[1]; data[b + 6] = o.quat[2]; data[b + 7] = o.quat[3];
    data[b + 8] = o.spinAxis[0]; data[b + 9] = o.spinAxis[1]; data[b + 10] = o.spinAxis[2]; data[b + 11] = o.spinSpeed;
    data[b + 12] = o.phase;
  });
  const { tex, width } = rgbaTexture(data, objects.length * 4);
  return { transformTex: tex, transformTexW: width };
}
