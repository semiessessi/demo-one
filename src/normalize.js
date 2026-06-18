// Per-shape size normalization for the journey: a lookup table of scale factors
// indexed by phase, so each morph stage is scaled to a constant mean of its
// inscribed- and circumscribed-sphere radii (the same metric used in the
// single-shape demo). Sampled on the CPU once; the vertex shader looks it up by
// each instance's phase.
import { buildJourneySegments, NUM_SEGMENTS } from './journey.js';
import { planeOf, supporting } from './hull.js';

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
    const p = planeOf(pos, i, i + 3, i + 6);
    if (p && p[3] < inr && supporting(p, pos, eps)) inr = p[3];
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
