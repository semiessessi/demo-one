// Octahedron -> Icosahedron -> Dodecahedron.
//
// This mirrors the tetra -> octa -> cube half:
//   - octahedron -> icosahedron: a deltahedron "grows" (8 triangular faces ->
//     20). The icosahedron's 12 vertices lie on the 12 edges of an octahedron,
//     so we collapse them in pairs onto the 6 octahedron vertices.
//   - icosahedron -> dodecahedron: a pure stellation, exactly analogous to
//     octahedron -> cube. Each of the 20 icosahedron faces grows an apex out
//     along its normal to a dodecahedron vertex; the 12 icosahedron vertices end
//     up at the dodecahedron's 12 face centers. It passes through the rhombic
//     triacontahedron midpoint, where the rhombi are planar and we flip the
//     triangulation (octa-edge split for a flat icosahedron, dodeca-edge split
//     for a flat dodecahedron).
//
// All shapes share the icosahedron's orientation and an octahedron circumradius
// of 1, so the seams with the cube/octahedron half line up exactly.

const PHI = (1 + Math.sqrt(5)) / 2;

// --- tiny vector helpers ---------------------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / len(a));
const lerp = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const avg = (pts) => mul(pts.reduce(add, [0, 0, 0]), 1 / pts.length);

// --- icosahedron vertices (circumradius 1) ---------------------------------
// Cyclic permutations of (0, ±1, ±φ). The ±φ coordinate identifies which
// octahedron vertex each icosahedron vertex collapses onto.
const RAW = [];
for (const s1 of [1, -1])
  for (const s2 of [1, -1]) {
    RAW.push([0, s1 * 1, s2 * PHI]); // phi on z
    RAW.push([s2 * PHI, 0, s1 * 1]); // phi on x
    RAW.push([s1 * 1, s2 * PHI, 0]); // phi on y
  }

const ICO_R = len(RAW[0]); // sqrt(phi + 2)
const ICO_V = RAW.map((v) => mul(v, 1 / ICO_R)); // circumradius 1

// Octahedron vertex each icosahedron vertex collapses to (axis of the ±φ coord).
const OCTA_TARGET = RAW.map((v) => {
  const axis = v.findIndex((c) => Math.abs(Math.abs(c) - PHI) < 1e-9);
  const t = [0, 0, 0];
  t[axis] = Math.sign(v[axis]); // octahedron circumradius 1
  return t;
});

// --- faces, edges, adjacency (computed from the vertices) -------------------
function buildTopology(verts) {
  // Edge length: the smallest non-zero pairwise distance.
  let minD = Infinity;
  for (let i = 0; i < verts.length; i++)
    for (let j = i + 1; j < verts.length; j++) {
      const d = len(sub(verts[i], verts[j]));
      if (d < minD) minD = d;
    }
  const adj = (i, j) => Math.abs(len(sub(verts[i], verts[j])) - minD) < minD * 0.1;

  // Faces: triples of mutually adjacent vertices, wound outward.
  const faces = [];
  for (let i = 0; i < verts.length; i++)
    for (let j = i + 1; j < verts.length; j++)
      for (let k = j + 1; k < verts.length; k++) {
        if (adj(i, j) && adj(j, k) && adj(i, k)) {
          let f = [i, j, k];
          const n = cross(sub(verts[j], verts[i]), sub(verts[k], verts[i]));
          if (dot(n, verts[i]) < 0) f = [i, k, j]; // flip to face outward
          faces.push(f);
        }
      }

  // Edges and the two faces adjacent to each.
  const edges = [];
  for (let i = 0; i < verts.length; i++)
    for (let j = i + 1; j < verts.length; j++)
      if (adj(i, j)) {
        const inc = faces.filter((f) => f.includes(i) && f.includes(j));
        edges.push({ i, j, faces: inc });
      }
  return { faces, edges };
}

const { faces: ICO_F, edges: ICO_E } = buildTopology(ICO_V);

// Face centroids (apex start = stellation 0) and the dodecahedron vertex each
// face grows to (apex end = stellation 1).
const FACE_CENTROID = ICO_F.map((f) => avg(f.map((i) => ICO_V[i])));
const FACE_DIR = FACE_CENTROID.map(norm); // = dodecahedron vertex directions

// Scale dodecahedron so its inradius equals the icosahedron circumradius (1),
// i.e. the icosahedron vertices land exactly on the dodecahedron face centers.
function vertexFaces(vi) {
  return ICO_F.map((f, fi) => (f.includes(vi) ? fi : -1)).filter((x) => x >= 0);
}
const inradiusAtUnit = len(avg(vertexFaces(0).map((fi) => FACE_DIR[fi])));
const DODECA_R = 1 / inradiusAtUnit; // dodecahedron circumradius
const DODECA_VERT = FACE_DIR.map((d) => mul(d, DODECA_R));

// Apex position at stellation amount s in [0,1] (radial: centroid -> dodeca vert).
const apexAt = (fi, s) => lerp(FACE_CENTROID[fi], DODECA_VERT[fi], s);

// Stellation amount where the rhombi are planar (the rhombic-triacontahedron
// midpoint). Found by bisection on the scalar triple product of one rhombus.
const RT_S = (() => {
  const e = ICO_E[0];
  const [fa, fb] = e.faces.map((f) => ICO_F.indexOf(f));
  const planarity = (s) => {
    const vi = ICO_V[e.i];
    const vj = ICO_V[e.j];
    const ap = apexAt(fa, s);
    const am = apexAt(fb, s);
    return dot(cross(sub(ap, vi), sub(vj, vi)), sub(am, vi));
  };
  let lo = 0.001;
  let hi = 0.999;
  let flo = planarity(lo);
  for (let n = 0; n < 60; n++) {
    const mid = (lo + hi) / 2;
    const fm = planarity(mid);
    if (flo * fm <= 0) hi = mid;
    else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
})();

// --- assembly --------------------------------------------------------------
// Stellation meshes index vertices as: 0..11 icosahedron vertices, 12+fi apexes.
const APEX = (fi) => 12 + fi;

function pack(faces, positions) {
  const out = [];
  for (const [a, b, c] of faces) {
    out.push(...positions[a], ...positions[b], ...positions[c]);
  }
  return new Float32Array(out);
}

// Stellation triangulations (one rhombus per icosahedron edge).
function icosaSplitFaces() {
  // Split along the icosahedron edge (vi–vj): flat icosahedron.
  return ICO_E.flatMap((e) => {
    const [fa, fb] = e.faces.map((f) => ICO_F.indexOf(f));
    return [
      [e.i, e.j, APEX(fa)],
      [e.i, APEX(fb), e.j],
    ];
  });
}
function dodecaSplitFaces() {
  // Split along the dodecahedron edge (apex–apex): flat dodecahedron.
  return ICO_E.flatMap((e) => {
    const [fa, fb] = e.faces.map((f) => ICO_F.indexOf(f));
    return [
      [APEX(fa), e.i, APEX(fb)],
      [APEX(fa), APEX(fb), e.j],
    ];
  });
}

// Stellation state positions at amount s (icosahedron vertices fixed).
function stellationPositions(s) {
  const p = ICO_V.map((v) => v.slice());
  ICO_F.forEach((_, fi) => (p[APEX(fi)] = apexAt(fi, s)));
  return p;
}

// Segment: octahedron -> icosahedron (icosahedron triangle mesh, collapsed).
export function octaIcosaSegment() {
  const octa = OCTA_TARGET.map((v) => v.slice());
  return {
    name: 'octahedron',
    endName: 'icosahedron',
    start: pack(ICO_F, octa),
    end: pack(ICO_F, ICO_V),
  };
}

// Segment: icosahedron -> rhombic-triacontahedron midpoint (flat-icosa split).
export function icosaToMidSegment() {
  return {
    name: 'icosahedron',
    endName: 'dodecahedron',
    start: pack(icosaSplitFaces(), stellationPositions(0)),
    end: pack(icosaSplitFaces(), stellationPositions(RT_S)),
  };
}

// Segment: midpoint -> dodecahedron (flat-dodeca split; flip is invisible here).
export function midToDodecaSegment() {
  return {
    name: 'icosahedron',
    endName: 'dodecahedron',
    start: pack(dodecaSplitFaces(), stellationPositions(RT_S)),
    end: pack(dodecaSplitFaces(), stellationPositions(1)),
  };
}
