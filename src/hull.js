// Convex-hull helpers shared by the occluder plane builder and the size
// normalization: a triangle's outward face plane, and whether a plane supports
// the hull (all verts on its inner side).

// Outward face plane [nx, ny, nz, d] of triangle (ai,bi,ci) in a flat vertex
// array, or null if degenerate. Shapes are centred at the origin, so "outward"
// is the side the centroid is on; d is the plane's distance from the origin.
export function planeOf(p, ai, bi, ci) {
  const ax = p[ai], ay = p[ai + 1], az = p[ai + 2];
  const ux = p[bi] - ax, uy = p[bi + 1] - ay, uz = p[bi + 2] - az;
  const vx = p[ci] - ax, vy = p[ci + 1] - ay, vz = p[ci + 2] - az;
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-7) return null;
  nx /= len; ny /= len; nz /= len;
  const cx = (ax + p[bi] + p[ci]) / 3, cy = (ay + p[bi + 1] + p[ci + 1]) / 3, cz = (az + p[bi + 2] + p[ci + 2]) / 3;
  if (nx * cx + ny * cy + nz * cz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  return [nx, ny, nz, nx * ax + ny * ay + nz * az];
}

// True if plane (n, d) is a supporting plane of the vertex set (every vertex on
// the inner side). Non-supporting triangles are interior/folded.
export function supporting(pl, verts, eps = 3e-3) {
  for (let k = 0; k < verts.length; k += 3) {
    if (pl[0] * verts[k] + pl[1] * verts[k + 1] + pl[2] * verts[k + 2] > pl[3] + eps) return false;
  }
  return true;
}
