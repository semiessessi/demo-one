// Geometry for the morphing demo.
//
// Every morph "segment" is a triangle soup (non-indexed) with a FIXED number of
// triangles. A segment provides two position arrays of identical length — the
// shape at t=0 and the shape at t=1 — and the renderer lerps between them.
// Differing vertex counts between solids are handled by *collapsing* groups of
// mesh vertices onto a single point (degenerate triangles vanish), so a single
// fixed buffer can represent both endpoints exactly.

const TAU = Math.PI * 2;

// Push triangle [a,b,c] (each a 3-array) into a flat positions list.
function tri(out, a, b, c) {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

// Build the two endpoint position arrays for a segment given:
//   faces  -> array of triangles, each [nameA, nameB, nameC]
//   vertsStart / vertsEnd -> maps vertex-name -> [x,y,z] for each endpoint
// Returns { start, end } as Float32Arrays.
function assemble(faces, vertsStart, vertsEnd) {
  const start = [];
  const end = [];
  for (const [a, b, c] of faces) {
    tri(start, vertsStart[a], vertsStart[b], vertsStart[c]);
    tri(end, vertsEnd[a], vertsEnd[b], vertsEnd[c]);
  }
  return { start: new Float32Array(start), end: new Float32Array(end) };
}

const centroid3 = (p, q, r) => [
  (p[0] + q[0] + r[0]) / 3,
  (p[1] + q[1] + r[1]) / 3,
  (p[2] + q[2] + r[2]) / 3,
];

// ===========================================================================
// Tetrahedron -> Octahedron -> Cube  (one continuous mesh, no swaps)
//
// The shared mesh has the rhombic-dodecahedron topology: the 6 octahedron
// vertices plus one apex vertex sitting over each of the 8 triangular faces.
// The 12 faces are rhombi, one per cube/octahedron edge — each rhombus joins
// two apexes (diagonally) and two octahedron vertices (diagonally). Splitting
// every rhombus along its apex–apex diagonal (the cube edge) gives 24 triangles
// that lie flat on the cube's square faces at full stellation.
//
//   - Octahedron: apexes lie flat at their face centroids (stellation = 0).
//   - Cube:       octahedron vertices stay PUT; each apex grows straight out
//                 along its face normal to a cube corner (stellation = 1). The
//                 8 apexes become the cube's corners and the 6 octahedron
//                 vertices end up exactly at the cube's face centers. Reversing
//                 the stellation returns precisely to the octahedron.
//   - Tetrahedron: the octahedron collapses to a tetrahedron (one bottom apex
//                 rises into the base plane, one equatorial vertex merges), with
//                 the stellation apexes riding flat on the collapsing faces.
//
// Because tetra/octa/cube all share this mesh and the octahedron vertices never
// move during stellation, the whole sequence is gap-free and the cube stellation
// is exactly zero at the octahedron.
// ===========================================================================

// Octahedron vertex names (one per +/- axis direction).
const O_NAMES = {
  'x+': [1, 0, 0],
  'x-': [-1, 0, 0],
  'y+': [0, 1, 0],
  'y-': [0, -1, 0],
  'z+': [0, 0, 1],
  'z-': [0, 0, -1],
};

// The 8 octahedron faces / stellation apexes, one per sign combination. Each
// face uses one vertex from each axis; its apex grows toward the cube corner
// (sx, sy, sz).
const APEXES = [];
for (const sx of [1, -1])
  for (const sy of [1, -1])
    for (const sz of [1, -1]) {
      APEXES.push({
        name: `A${sx > 0 ? '+' : '-'}${sy > 0 ? '+' : '-'}${sz > 0 ? '+' : '-'}`,
        ox: sx > 0 ? 'x+' : 'x-',
        oy: sy > 0 ? 'y+' : 'y-',
        oz: sz > 0 ? 'z+' : 'z-',
        corner: [sx, sy, sz],
      });
    }

// Look up an apex name by its corner sign triple.
function apexName(sx, sy, sz) {
  return `A${sx > 0 ? '+' : '-'}${sy > 0 ? '+' : '-'}${sz > 0 ? '+' : '-'}`;
}
const O_AXIS = ['x', 'y', 'z'];
const oName = (axis, s) => `${O_AXIS[axis]}${s > 0 ? '+' : '-'}`;

// Each rhombus (one per cube edge) joins two apexes (apexP, apexM, diagonally)
// and two octahedron vertices (octa1, octa2, diagonally). We can triangulate it
// two ways:
//   - apex-edge split  -> halves lie flat on the CUBE faces (clean cube)
//   - octa-edge split  -> halves lie flat on the OCTAHEDRON faces (clean octa)
// The rhombus is exactly planar at the rhombic-dodecahedron midpoint of the
// stellation, so swapping between the two splits there is invisible.
function rhombi(callback) {
  for (let e = 0; e < 3; e++) {
    const a1 = (e + 1) % 3;
    const a2 = (e + 2) % 3;
    for (const s1 of [1, -1])
      for (const s2 of [1, -1]) {
        const cornerSigns = (se) => {
          const v = [0, 0, 0];
          v[e] = se;
          v[a1] = s1;
          v[a2] = s2;
          return v;
        };
        const cP = cornerSigns(1);
        const cM = cornerSigns(-1);
        callback({
          apexP: apexName(cP[0], cP[1], cP[2]),
          apexM: apexName(cM[0], cM[1], cM[2]),
          octa1: oName(a1, s1),
          octa2: oName(a2, s2),
        });
      }
  }
}

// Split along the apex–apex diagonal (the cube edge): flat cube faces.
function cubeSplitFaces() {
  const faces = [];
  rhombi(({ apexP, apexM, octa1, octa2 }) => {
    faces.push([apexP, octa1, apexM]);
    faces.push([apexP, apexM, octa2]);
  });
  return faces;
}

// Split along the octa–octa diagonal (the octahedron edge): flat octa faces.
function octaSplitFaces() {
  const faces = [];
  rhombi(({ apexP, apexM, octa1, octa2 }) => {
    faces.push([octa1, octa2, apexP]);
    faces.push([octa1, apexM, octa2]);
  });
  return faces;
}

// A stellation state: octahedron vertices fixed; each apex sits at k * corner.
//   k = 1/3 -> octahedron (apex on the face centroid, stellation 0)
//   k = 1/2 -> rhombic-dodecahedron midpoint (rhombi exactly planar)
//   k = 1   -> cube (apexes are the cube corners)
function stellationState(k) {
  const v = {};
  for (const [n, p] of Object.entries(O_NAMES)) v[n] = p.slice();
  for (const a of APEXES) v[a.name] = a.corner.map((c) => c * k);
  return v;
}
const octaState = () => stellationState(1 / 3);
const rdState = () => stellationState(1 / 2);
const cubeState = () => stellationState(1);

// Tetrahedron state: collapse the octahedron to a regular tetrahedron.
//   apex y+  -> tetra apex
//   x+, z+, x- -> equilateral base (in plane y = -1/3)
//   z- -> merged onto x+   (drops one equatorial vertex)
//   y- -> base centroid    (retracts the bottom point into the base)
// Stellation apexes ride at the centroids of their collapsed faces (stay flat).
function tetraState() {
  const rBase = Math.sqrt(8) / 3;
  const baseY = -1 / 3;
  const ring = (k) => [
    rBase * Math.cos((k / 3) * TAU),
    baseY,
    rBase * Math.sin((k / 3) * TAU),
  ];
  const v = {
    'y+': [0, 1, 0],
    'x+': ring(0),
    'z+': ring(1),
    'x-': ring(2),
    'z-': ring(0), // merge onto x+
    'y-': [0, baseY, 0], // collapse to base centroid
  };
  for (const a of APEXES) v[a.name] = centroid3(v[a.ox], v[a.oy], v[a.oz]);
  return v;
}

// Segment 1: tetrahedron -> octahedron (octa-edge split keeps both flat).
export function tetraOctaSegment() {
  return {
    name: 'tetrahedron',
    endName: 'octahedron',
    ...assemble(octaSplitFaces(), tetraState(), octaState()),
  };
}

// Segment 2: octahedron -> rhombic-dodec midpoint (still octa-edge split).
export function octaToMidSegment() {
  return {
    name: 'octahedron',
    endName: 'cube',
    ...assemble(octaSplitFaces(), octaState(), rdState()),
  };
}

// Segment 3: rhombic-dodec midpoint -> cube (flip to cube-edge split). At the
// midpoint the rhombi are planar, so the triangulation flip is invisible.
export function midToCubeSegment() {
  return {
    name: 'octahedron',
    endName: 'cube',
    ...assemble(cubeSplitFaces(), rdState(), cubeState()),
  };
}
