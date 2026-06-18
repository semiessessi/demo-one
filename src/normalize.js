// Per-shape size normalization for the journey: a lookup table of scale factors
// indexed by phase, so each morph stage is scaled to a constant mean of its
// inscribed- and circumscribed-sphere radii (the same metric used in the
// single-shape demo). Sampled on the CPU once; the vertex shader looks it up by
// each instance's phase.
import { buildJourneySegments, NUM_SEGMENTS } from './journey.js';

export const NORM_LUT_SIZE = 128;
export const NORM_TARGET = 1.0;

// Mean of circumradius (farthest vertex) and inradius (nearest supporting face
// plane) of a triangle soup. Only genuine hull-supporting planes count toward
// the inradius, which rejects interior/folded triangles from vertex collapses.
function meanRadius(pos) {
  const N = pos.length;
  let circum = 0;
  for (let i = 0; i < N; i += 3) {
    const d = Math.hypot(pos[i], pos[i + 1], pos[i + 2]);
    if (d > circum) circum = d;
  }
  const eps = circum * 1e-3 + 1e-6;
  let inr = Infinity;
  for (let i = 0; i < N; i += 9) {
    const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
    const ux = pos[i + 3] - ax, uy = pos[i + 4] - ay, uz = pos[i + 5] - az;
    const vx = pos[i + 6] - ax, vy = pos[i + 7] - ay, vz = pos[i + 8] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-9) continue;
    nx /= L; ny /= L; nz /= L;
    let pd = ax * nx + ay * ny + az * nz;
    if (pd < 0) { pd = -pd; nx = -nx; ny = -ny; nz = -nz; }
    if (pd >= inr) continue;
    let supporting = true;
    for (let j = 0; j < N; j += 3) {
      if (pos[j] * nx + pos[j + 1] * ny + pos[j + 2] * nz > pd + eps) { supporting = false; break; }
    }
    if (supporting) inr = pd;
  }
  if (!isFinite(inr)) inr = circum;
  return (circum + inr) / 2;
}

// LUT[i] = normalization scale at phase p = (i / (size-1)) * NUM_SEGMENTS.
export function buildNormScaleLUT() {
  const segs = buildJourneySegments();
  const lut = new Float32Array(NORM_LUT_SIZE);
  for (let i = 0; i < NORM_LUT_SIZE; i++) {
    const p = (i / (NORM_LUT_SIZE - 1)) * NUM_SEGMENTS;
    let seg = Math.floor(p), t = p - seg;
    if (seg >= NUM_SEGMENTS) { seg = NUM_SEGMENTS - 1; t = 1; }
    const s = segs[seg];
    const pos = new Float32Array(s.start.length);
    for (let j = 0; j < pos.length; j++) pos[j] = s.start[j] + (s.end[j] - s.start[j]) * t;
    lut[i] = NORM_TARGET / meanRadius(pos);
  }
  return lut;
}
