// Checks that the size-normalization scale is continuous at the tetrahedron
// start (no pop). Mirrors meanRadius() from main.js.
import { tetraOctaSegment } from '../src/solids.js';

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

const seg = tetraOctaSegment();
const TARGET = 1.1;
console.log('   t    meanR    scale');
for (const t of [0, 0.0005, 0.002, 0.01, 0.05, 0.2]) {
  const pos = new Float64Array(seg.start.length);
  for (let i = 0; i < pos.length; i++) pos[i] = seg.start[i] + (seg.end[i] - seg.start[i]) * t;
  const m = meanRadius(pos);
  console.log(`${t.toFixed(4)}  ${m.toFixed(4)}  ${(TARGET / m).toFixed(4)}`);
}
