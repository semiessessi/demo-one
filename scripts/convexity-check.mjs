// Empirical convexity check. For each morph segment, sample several t values,
// reconstruct the lerped triangle soup, and measure how far any vertex pokes out
// beyond any (outward-facing) face plane. ~0 => convex; positive => non-convex,
// and the value is the depth of the worst reflex/protrusion (in model units,
// where solids are ~1 unit in circumradius).

import {
  tetraOctaSegment,
  octaToMidSegment,
  midToCubeSegment,
} from '../src/solids.js';
import {
  octaIcosaSegment,
  icosaToMidSegment,
  midToDodecaSegment,
} from '../src/icosa.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

function maxProtrusion(start, end, t) {
  const n = start.length;
  const pos = new Array(n);
  for (let i = 0; i < n; i++) pos[i] = start[i] + (end[i] - start[i]) * t;

  const pts = [];
  for (let k = 0; k < n; k += 3) pts.push([pos[k], pos[k + 1], pos[k + 2]]);

  let worst = 0;
  for (let tri = 0; tri < pts.length; tri += 3) {
    const a = pts[tri];
    const b = pts[tri + 1];
    const c = pts[tri + 2];
    let nrm = cross(sub(b, a), sub(c, a));
    const L = len(nrm);
    if (L < 1e-9) continue; // degenerate (collapsed) triangle
    nrm = [nrm[0] / L, nrm[1] / L, nrm[2] / L];
    const cen = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    if (dot(nrm, cen) < 0) nrm = [-nrm[0], -nrm[1], -nrm[2]]; // orient outward
    for (const p of pts) {
      const d = dot(sub(p, a), nrm);
      if (d > worst) worst = d;
    }
  }
  return worst;
}

const segments = [
  ['tetra -> octa', tetraOctaSegment()],
  ['octa -> rd-mid', octaToMidSegment()],
  ['rd-mid -> cube', midToCubeSegment()],
  ['octa -> icosa', octaIcosaSegment()],
  ['icosa -> rt-mid', icosaToMidSegment()],
  ['rt-mid -> dodeca', midToDodecaSegment()],
];

const ts = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1];
const EPS = 1e-3;

console.log('segment            ' + ts.map((t) => t.toFixed(2).padStart(7)).join(''));
for (const [label, seg] of segments) {
  const row = ts.map((t) => maxProtrusion(seg.start, seg.end, t));
  const cells = row.map((v) => (v < EPS ? '   conv' : v.toFixed(4).padStart(7)));
  console.log(label.padEnd(18) + cells.join(''));
}
console.log(`\n("conv" = max protrusion < ${EPS}; otherwise the number is the non-convex depth)`);
