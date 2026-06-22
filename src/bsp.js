// Minimal Quake-3 IBSP (version 46) reader. Pure JS, no THREE — Node-testable and
// renderer-agnostic. Reads only the lumps we need: the visible draw geometry (textures,
// vertexes, meshverts, faces) for rasterization, and the convex BRUSH volumes
// (planes, brushes, brushsides) which feed the existing half-space raytracer as static
// occluders. Coordinates are returned RAW in Quake space (Z-up); the world transform to
// the demo's Y-up scene is applied by the consumers (bspMesh.js / bspOccluders.js) so
// the mesh and the brush planes always share one transform.

// Canonical Q3 lump indices ("Unofficial Quake 3 BSP Format").
const LUMP = {
  TEXTURES: 1, PLANES: 2, BRUSHES: 8, BRUSHSIDES: 9,
  VERTEXES: 10, MESHVERTS: 11, FACES: 13,
};

export function parseBSP(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'IBSP') throw new Error(`not an IBSP file (magic="${magic}")`);
  const version = dv.getInt32(4, true);
  if (version !== 46) throw new Error(`unsupported BSP version ${version} (expected 46)`);

  // Lump directory: 17 entries of {offset, length} starting at byte 8.
  const lump = (i) => ({ offset: dv.getInt32(8 + i * 8, true), length: dv.getInt32(8 + i * 8 + 4, true) });

  // --- Textures (shader references): 72 bytes each (64-byte name + flags + contents) ---
  const texL = lump(LUMP.TEXTURES);
  const textures = [];
  for (let o = texL.offset; o < texL.offset + texL.length; o += 72) {
    let name = '';
    for (let c = 0; c < 64; c++) {
      const ch = dv.getUint8(o + c);
      if (ch === 0) break;
      name += String.fromCharCode(ch);
    }
    textures.push({ name, flags: dv.getInt32(o + 64, true), contents: dv.getInt32(o + 68, true) });
  }

  // --- Planes: 16 bytes (normal.xyz, dist) ---
  const plL = lump(LUMP.PLANES);
  const nPlanes = (plL.length / 16) | 0;
  const planes = new Float32Array(nPlanes * 4);
  for (let i = 0; i < nPlanes; i++) {
    const o = plL.offset + i * 16;
    planes[i * 4] = dv.getFloat32(o, true);
    planes[i * 4 + 1] = dv.getFloat32(o + 4, true);
    planes[i * 4 + 2] = dv.getFloat32(o + 8, true);
    planes[i * 4 + 3] = dv.getFloat32(o + 12, true);
  }

  // --- Brushes: 12 bytes (firstSide, numSides, texture) ---
  const brL = lump(LUMP.BRUSHES);
  const brushes = [];
  for (let o = brL.offset; o < brL.offset + brL.length; o += 12) {
    brushes.push({ firstSide: dv.getInt32(o, true), numSides: dv.getInt32(o + 4, true), texture: dv.getInt32(o + 8, true) });
  }

  // --- Brush sides: 8 bytes (plane, texture) ---
  const bsL = lump(LUMP.BRUSHSIDES);
  const brushSides = [];
  for (let o = bsL.offset; o < bsL.offset + bsL.length; o += 8) {
    brushSides.push({ plane: dv.getInt32(o, true), texture: dv.getInt32(o + 4, true) });
  }

  // --- Vertexes (drawverts): 44 bytes (pos.xyz, uv, lm.uv, normal.xyz, rgba) ---
  const vL = lump(LUMP.VERTEXES);
  const nVerts = (vL.length / 44) | 0;
  const position = new Float32Array(nVerts * 3);
  const normal = new Float32Array(nVerts * 3);
  const uv = new Float32Array(nVerts * 2);
  const color = new Uint8Array(nVerts * 4);
  for (let i = 0; i < nVerts; i++) {
    const o = vL.offset + i * 44;
    position[i * 3] = dv.getFloat32(o, true);
    position[i * 3 + 1] = dv.getFloat32(o + 4, true);
    position[i * 3 + 2] = dv.getFloat32(o + 8, true);
    uv[i * 2] = dv.getFloat32(o + 12, true);
    uv[i * 2 + 1] = dv.getFloat32(o + 16, true);
    normal[i * 3] = dv.getFloat32(o + 28, true);
    normal[i * 3 + 1] = dv.getFloat32(o + 32, true);
    normal[i * 3 + 2] = dv.getFloat32(o + 36, true);
    color[i * 4] = dv.getUint8(o + 40);
    color[i * 4 + 1] = dv.getUint8(o + 41);
    color[i * 4 + 2] = dv.getUint8(o + 42);
    color[i * 4 + 3] = dv.getUint8(o + 43);
  }

  // --- Meshverts (drawindexes): 4 bytes (int offset into a face's vertex range) ---
  const mvL = lump(LUMP.MESHVERTS);
  const nMeshverts = (mvL.length / 4) | 0;
  const meshverts = new Int32Array(nMeshverts);
  for (let i = 0; i < nMeshverts; i++) meshverts[i] = dv.getInt32(mvL.offset + i * 4, true);

  // --- Faces (drawsurfaces): 104 bytes ---
  const fL = lump(LUMP.FACES);
  const faces = [];
  for (let o = fL.offset; o < fL.offset + fL.length; o += 104) {
    faces.push({
      texture: dv.getInt32(o, true),
      type: dv.getInt32(o + 8, true),        // 1=polygon, 2=patch, 3=mesh, 4=billboard
      vertex: dv.getInt32(o + 12, true),
      n_vertexes: dv.getInt32(o + 16, true),
      meshvert: dv.getInt32(o + 20, true),
      n_meshverts: dv.getInt32(o + 24, true),
      normal: [dv.getFloat32(o + 84, true), dv.getFloat32(o + 88, true), dv.getFloat32(o + 92, true)],
      size: [dv.getInt32(o + 96, true), dv.getInt32(o + 100, true)], // patch control-grid dims (type 2)
    });
  }

  return { version, textures, planes, brushes, brushSides,
    verts: { position, normal, uv, color, count: nVerts }, meshverts, faces };
}
