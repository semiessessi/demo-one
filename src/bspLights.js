// Synthesises point lights for the wrackdm17 level. The map has NO Quake `light` entities — it was
// lit by q3map2 radiosity from light-EMITTING surfaces. So we place a point light at each light-fixture
// face (gothic_light lamps, evil6 lights, jump pads, flares, teleporters), coloured by the fixture and
// merged per fixture. Positions are FIXED (wall lamps don't orbit); brightness is music-reactive in the
// shader. Output is in the SAME world space as bspMesh (so shadows line up): convert Q3 Z-up -> Y-up
// (qx,qy,qz)->(qx,qz,-qy), then *scale + offset.

// texture-name marker -> [linear colour, radius multiplier]. First match wins, so list specific before
// the generic 'light' fallback.
const KINDS = [
  ['gothic_light', [1.00, 0.72, 0.36], 7], // warm hall lamps
  ['e6v_light', [0.55, 0.72, 1.00], 6],     // evil6 cool lights
  ['evil6', [0.55, 0.72, 1.00], 6],
  ['jpad', [0.40, 0.90, 1.00], 5],          // jump pads
  ['launch', [0.40, 0.90, 1.00], 5],
  ['diamond', [0.40, 0.90, 1.00], 5],
  ['teleport', [0.70, 0.40, 1.00], 6],      // teleporter glow
  ['flare', [1.00, 0.80, 0.50], 4],
  ['light', [1.00, 0.85, 0.60], 6],         // generic fallback
];
const BASE_R = 1.6;       // world-unit base reach; * the kind's multiplier
const INTENSITY = 11.0;   // colour scale (5x — punchier lamps; tune live via uMapLightScale)
const MERGE_DIST = 1.6;   // collapse a fixture's many faces into one lamp (world units)
const NUDGE = 0.3;        // push the lamp this far off the surface along its normal

function kindFor(name) {
  for (const [key, color, rmul] of KINDS) if (name.indexOf(key) !== -1) return { color, rmul };
  return null;
}

export function buildBspLights(parsed, transform) {
  const { faces, verts, textures } = parsed;
  const { scale, offset } = transform;
  const wx = (i) => verts.position[i * 3] * scale + offset[0];
  const wy = (i) => verts.position[i * 3 + 2] * scale + offset[1];
  const wz = (i) => -verts.position[i * 3 + 1] * scale + offset[2];

  const raw = [];
  for (const f of faces) {
    if (f.type !== 1 && f.type !== 2 && f.type !== 3) continue;
    const name = textures[f.texture]?.name || '';
    if (name.indexOf('sky') !== -1 || name.indexOf('common/') !== -1) continue;
    const kind = kindFor(name);
    if (!kind) continue;
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (let v = f.vertex; v < f.vertex + f.n_vertexes; v++) { cx += wx(v); cy += wy(v); cz += wz(v); n++; }
    if (!n) continue;
    cx /= n; cy /= n; cz /= n;
    // nudge off the surface along the converted face normal
    const nx = f.normal[0], ny = f.normal[2], nz = -f.normal[1];
    const nl = Math.hypot(nx, ny, nz) || 1;
    cx += (nx / nl) * NUDGE; cy += (ny / nl) * NUDGE; cz += (nz / nl) * NUDGE;
    const bump = (name.indexOf('_8k') !== -1 || name.indexOf('_7k') !== -1 || name.indexOf('_3k') !== -1) ? 1.4 : 1.0;
    raw.push({
      pos: [cx, cy, cz],
      color: [kind.color[0] * INTENSITY * bump, kind.color[1] * INTENSITY * bump, kind.color[2] * INTENSITY * bump],
      radius: kind.rmul * BASE_R,
    });
  }

  // Merge faces of the same fixture (within MERGE_DIST) into a single lamp.
  const merged = [];
  const md2 = MERGE_DIST * MERGE_DIST;
  for (const l of raw) {
    let hit = null;
    for (const m of merged) {
      const dx = m.pos[0] - l.pos[0], dy = m.pos[1] - l.pos[1], dz = m.pos[2] - l.pos[2];
      if (dx * dx + dy * dy + dz * dz < md2) { hit = m; break; }
    }
    if (hit) {
      const k = hit.n;
      hit.pos[0] = (hit.pos[0] * k + l.pos[0]) / (k + 1);
      hit.pos[1] = (hit.pos[1] * k + l.pos[1]) / (k + 1);
      hit.pos[2] = (hit.pos[2] * k + l.pos[2]) / (k + 1);
      hit.color[0] = Math.max(hit.color[0], l.color[0]);
      hit.color[1] = Math.max(hit.color[1], l.color[1]);
      hit.color[2] = Math.max(hit.color[2], l.color[2]);
      hit.radius = Math.max(hit.radius, l.radius);
      hit.n++;
    } else {
      merged.push({ pos: l.pos.slice(), color: l.color.slice(), radius: l.radius, n: 1 });
    }
  }
  merged.forEach((m, i) => { m.band = i % 32; }); // music slot, for the beat-reactive brightness
  return merged;
}
