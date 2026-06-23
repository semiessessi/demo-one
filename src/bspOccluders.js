// Turns the level's solid Quake brushes into convex shadow occluders for the GPU raytracer. A Q3 brush
// is the intersection of half-spaces {x : dot(n,x) <= d} — exactly the convex hull the shader's slab
// loop (traceBrush) consumes. We transform each brush's planes into the demo's world space (the SAME
// transform bspMesh bakes into the rasterised verts, so shadows register), enumerate the brush corners
// to get a bounding sphere for the cheap reject, and keep only solid, significant brushes.

const CONTENTS_SOLID = 1;
const MIN_RADIUS = 0.4;   // drop tiny detail brushes (world units)
const MAX_RADIUS = 50;    // drop the enclosing sky hull / map-spanning slabs (shadow receivers, not casters)
const MAX_BRUSHES = 256;  // keep the largest N -> bounded sphere-reject loop
const MAX_PLANES = 24;    // per brush
const EPS = 1e-3;

const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];

// Intersection point of three planes (each [nx,ny,nz,d], dot(n,x)=d), or null if near-parallel.
function intersect3(a, b, c) {
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  if (Math.abs(det) < 1e-6) return null;
  const c12 = cross(b, c), c20 = cross(c, a), c01 = cross(a, b);
  return [
    (a[3] * c12[0] + b[3] * c20[0] + c[3] * c01[0]) / det,
    (a[3] * c12[1] + b[3] * c20[1] + c[3] * c01[1]) / det,
    (a[3] * c12[2] + b[3] * c20[2] + c[3] * c01[2]) / det,
  ];
}

// Bounding sphere (centroid + max radius) of a convex brush from its world-space planes.
function brushSphere(planes) {
  const verts = [];
  const N = planes.length;
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) for (let k = j + 1; k < N; k++) {
    const p = intersect3(planes[i], planes[j], planes[k]);
    if (!p) continue;
    let inside = true;
    for (let m = 0; m < N; m++) {
      if (planes[m][0] * p[0] + planes[m][1] * p[1] + planes[m][2] * p[2] - planes[m][3] > EPS) { inside = false; break; }
    }
    if (inside) verts.push(p);
  }
  if (verts.length < 4) return null;
  let cx = 0, cy = 0, cz = 0;
  for (const v of verts) { cx += v[0]; cy += v[1]; cz += v[2]; }
  cx /= verts.length; cy /= verts.length; cz /= verts.length;
  let r = 0;
  for (const v of verts) { const d = Math.hypot(v[0] - cx, v[1] - cy, v[2] - cz); if (d > r) r = d; }
  return { center: [cx, cy, cz], radius: r };
}

export function buildBspOccluders(parsed, transform) {
  const { brushes, brushSides, planes, textures } = parsed;
  const { scale, offset } = transform;
  const out = [];
  for (const b of brushes) {
    if (((textures[b.texture]?.contents || 0) & CONTENTS_SOLID) === 0) continue; // solid only
    // Gather + transform the brush's planes to world space, deduping near-identical sides.
    const wp = [];
    for (let k = 0; k < b.numSides && wp.length < MAX_PLANES; k++) {
      const pi = brushSides[b.firstSide + k].plane;
      const nx = planes[pi * 4], ny = planes[pi * 4 + 1], nz = planes[pi * 4 + 2], d = planes[pi * 4 + 3];
      const wnx = nx, wny = nz, wnz = -ny;                 // axis swap (qx,qy,qz)->(qx,qz,-qy)
      const wd = scale * d + (wnx * offset[0] + wny * offset[1] + wnz * offset[2]);
      let dup = false;
      for (const q of wp) if (q[0] * wnx + q[1] * wny + q[2] * wnz > 0.9995 && Math.abs(q[3] - wd) < 1e-3) { dup = true; break; }
      if (!dup) wp.push([wnx, wny, wnz, wd]);
    }
    if (wp.length < 4) continue;
    const sph = brushSphere(wp);
    if (!sph || sph.radius < MIN_RADIUS || sph.radius > MAX_RADIUS) continue;
    out.push({ planes: wp, center: sph.center, radius: sph.radius });
  }

  out.sort((a, b) => b.radius - a.radius);
  if (out.length > MAX_BRUSHES) out.length = MAX_BRUSHES;

  // Pack: uMapPlaneTex = 1 texel/plane [n.xyz,d]; uMapBrushTex = 2 texels/brush ([center,radius],
  // [planeStart, planeCount, 0, 0]).
  let totalPlanes = 0;
  for (const o of out) totalPlanes += o.planes.length;
  const planeData = new Float32Array(totalPlanes * 4);
  const brushData = new Float32Array(out.length * 2 * 4);
  let pc = 0;
  out.forEach((o, i) => {
    const start = pc;
    for (const pl of o.planes) { planeData[pc * 4] = pl[0]; planeData[pc * 4 + 1] = pl[1]; planeData[pc * 4 + 2] = pl[2]; planeData[pc * 4 + 3] = pl[3]; pc++; }
    const bo = i * 8;
    brushData[bo] = o.center[0]; brushData[bo + 1] = o.center[1]; brushData[bo + 2] = o.center[2]; brushData[bo + 3] = o.radius;
    brushData[bo + 4] = start; brushData[bo + 5] = o.planes.length;
  });

  return { planeData, planeCount: totalPlanes, brushData, brushCount: out.length };
}
