// Static scene generation: objects scattered at random (LCG, so it's
// reproducible) in a bounded cube, rejection-sampled so none overlap; each light
// is assigned to one object and orbits it on a sphere just outside it (animated
// in-shader). Per-object nearby-light lists are built once with a uniform 3D
// bucket grid (ported from pdx-gfx), conservatively sized for the orbit.
import { MAX_NORM_CIRCUMRADIUS } from './journey.js';
import { cameraPathPoints } from './flycam.js';
import { makeRng } from './math.js';

const TARGET_OBJECTS = 3000;
const VOLUME = 22; // cube side at 200 objects; scales with cbrt(count) to hold density
const LIGHTS_PER_OBJECT = 40;
// Hard ceiling on each object's light list (its own + neighbouring objects' + field lights,
// sorted nearest-first). The bucket gather returns a median of ~800 within reach, so this rarely
// binds — it's the quality ceiling; a dynamic FPS controller can scale the *shaded* count down
// later. The analytic occluder traces keep the nearest-16 shadows cheap.
const MAX_LIGHTS_PER_OBJECT = 1024;
const LIGHT_RADIUS = 4.5; // light falloff radius (bigger reach; sprite size is decoupled from it)
const SCALE_MIN = 0.45;
const SCALE_MAX = 0.62;
const PACK_MARGIN = 0.35; // extra gap between object spheres (tighter = denser field); > orbit reach
// Lights orbit their host object on a sphere just outside it, animated entirely
// in-shader (see animLightDir in shaders/lib.glsl). orbitRadius is
// per-light: object.radius + ORBIT_MARGIN + rng()*ORBIT_SPREAD (always > object.radius,
// so the light stays outside its host). PACK_MARGIN >= ORBIT_MARGIN + ORBIT_SPREAD so a
// light never sweeps into a neighbouring object (their light clouds may still overlap).
const ORBIT_MARGIN = 0.15; // min gap from the object surface to the orbit sphere (tighter for density)
const ORBIT_SPREAD = 0.15; // per-light random extra orbit radius (reach 0.30 < PACK_MARGIN 0.35)
const BUCKETS_PER_AXIS = 10;
const LIGHT_BUCKETS_PER_AXIS = 24; // finer grid for the ~200k lights so per-object queries don't over-scan (the coarse object grid stays for the 5k-object lists)
const R_PROXY = 1.0; // shadow/reflection sphere-proxy radius factor (× scale)
const SHADOW_CAP = 64; // max occluders per object for shadows (nearest kept)
const REFLECTION_CAP = 1024; // max occluders per object for reflections (hero needs lots)
const REFL_ROUGHNESS_MAX = 0.35; // matches the shader: only objects below this trace reflections, so only they need a reflection list
const REFLECTION_REACH = 26.0; // gather radius to reach ~1024 nearest occluders at this density
const SEED = 0x1234abcd;
const CAM_CLEARANCE = 0.8; // small gap, so the camera makes near-misses past objects (shows off reflections)

// opts.targetObjects / opts.lightsPerObject override the defaults for scale
// testing; the volume grows with the cube root of the object count so packing
// density (and thus the look) stays roughly constant.
export function generateBase(opts = {}) {
  const targetObjects = opts.targetObjects ?? TARGET_OBJECTS;
  const lightsPerObject = opts.lightsPerObject ?? LIGHTS_PER_OBJECT;
  const volume = VOLUME * Math.cbrt(targetObjects / 200) * 1.24; // x1.24 so the inscribed SPHERE holds the count

  const rng = makeRng(SEED);
  const rand = (a, b) => a + rng() * (b - a);
  const randUnitVec = () => {
    const z = rand(-1, 1);
    const t = rand(0, Math.PI * 2);
    const r = Math.sqrt(1 - z * z);
    return [r * Math.cos(t), r * Math.sin(t), z];
  };
  const randQuat = () => {
    const u1 = rng(), u2 = rng(), u3 = rng();
    const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
    return [
      s1 * Math.sin(2 * Math.PI * u2), s1 * Math.cos(2 * Math.PI * u2),
      s2 * Math.sin(2 * Math.PI * u3), s2 * Math.cos(2 * Math.PI * u3),
    ];
  };
  const hslToRgb = (h, s, l) => {
    const k = (n) => (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)];
  };

  // Material classes. A surface's class sets its albedo/roughness/metalness "family" so the field
  // reads as a mix of real materials (metal/chalk/marble/ceramic) instead of uniform random.
  // REFLECTIVE classes (0 polished metal, 1 brushed metal, 3 marble) keep roughness < the shader's
  // REFL_ROUGHNESS_MAX (0.35) so the CPU reflection lists are built for them; the matte classes
  // (2 chalk, 4 ceramic) sit above 0.35 and skip SSR. `r` is a per-object [0,1) rng.
  const MATERIAL_CLASSES = [
    { color: (r) => hslToRgb(r(), 0.10, 0.62), rough: (r) => 0.04 + r() * 0.08, metal: 1.0 }, // 0 polished metal
    { color: (r) => hslToRgb(r(), 0.12, 0.55), rough: (r) => 0.20 + r() * 0.10, metal: 1.0 }, // 1 brushed metal
    { color: (r) => hslToRgb(r(), 0.05, 0.74), rough: (r) => 0.72 + r() * 0.20, metal: 0.0 }, // 2 chalk / matte
    { color: (r) => hslToRgb(r(), 0.07, 0.80), rough: (r) => 0.16 + r() * 0.12, metal: 0.0 }, // 3 marble
    { color: (r) => hslToRgb(r(), 0.55, 0.55), rough: (r) => 0.38 + r() * 0.12, metal: 0.0 }, // 4 ceramic / plastic
  ];
  // Cumulative weights -> fewer mirrors (expensive look), more matte; keeps the reflective fraction
  // (~48%) near the old random one so the reflection-list memory/cost barely moves.
  const CLASS_CDF = [0.12, 0.30, 0.58, 0.76, 1.0];
  const pickClass = (u) => { for (let c = 0; c < 5; c++) if (u < CLASS_CDF[c]) return c; return 4; };
  // Spatial cell hash (~CELL units) -> a stable [0,1) per cell, so neighbouring objects share a class
  // and the field reads as regions of one material rather than salt-and-pepper.
  const CELL = 6;
  const cellHash01 = (x, y, z) => {
    let n = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;
    n ^= n >>> 13; n = Math.imul(n, 0x5bd1e995) >>> 0; n ^= n >>> 15;
    return (n >>> 0) / 4294967296;
  };

  const objects = [];
  const lights = [];
  const half = volume / 2;

  // Spatial hash so placement overlap checks stay O(1): the cell side is >= the largest
  // rejection distance, so only a candidate's 3x3x3 cell neighbourhood can overlap it
  // (without this, 8000 objects is O(N^2) and scene-gen takes ~12 s). The geometric test
  // is unchanged, so placement stays deterministic and identical to the brute-force result.
  const cell = 2 * MAX_NORM_CIRCUMRADIUS * SCALE_MAX + PACK_MARGIN + 1e-3;
  const grid = new Map();
  // Integer cell key (avoids a per-call string alloc + string hashing in the hottest load-time
  // loop). Collision-free while |cell coord| < GK_BIAS, which holds for any sane object count
  // (cells span ~half/cell ≈ ±20 at the default). Placement test is unchanged -> deterministic.
  const GK_BIAS = 1024, GK_STRIDE = 2048;
  const gkey = (x, y, z) => ((x + GK_BIAS) * GK_STRIDE + (y + GK_BIAS)) * GK_STRIDE + (z + GK_BIAS);
  const gco = (p) => Math.floor(p / cell);

  // The camera's hero object: placed first at the origin so it's guaranteed objects[0]
  // (closest) and the intro orbit + path are deterministic. Exempt from path culling.
  {
    const hs = rand(SCALE_MIN, SCALE_MAX);
    const hero = {
      pos: [0, 0, 0], quat: randQuat(), spinAxis: randUnitVec(), spinSpeed: rand(-0.4, 0.4),
      scale: hs, radius: MAX_NORM_CIRCUMRADIUS * hs, proxyRadius: hs * R_PROXY,
      phase: rand(0, 20), morphSpeed: rand(0.35, 0.65),
      color: [rand(0.55, 0.8), rand(0.55, 0.8), rand(0.55, 0.8)],
      rough: rand(0.12, 0.7), metal: rng() < 0.25 ? 1.0 : 0.0,
      lightOffset: 0, lightCount: 0, shadowOffset: 0, shadowCount: 0, reflOffset: 0, reflCount: 0,
    };
    objects.push(hero);
    grid.set(gkey(gco(0), gco(0), gco(0)), [hero]);
  }
  // Sample the camera trajectory once; candidates within CAM_CLEARANCE of it are rejected.
  const pathPoints = cameraPathPoints([0, 0, 0]);

  let attempts = 0;
  const maxAttempts = targetObjects * 400;
  while (objects.length < targetObjects && attempts < maxAttempts) {
    attempts++;
    const scale = rand(SCALE_MIN, SCALE_MAX);
    const radius = MAX_NORM_CIRCUMRADIUS * scale;
    const pos = [rand(-half, half), rand(-half, half), rand(-half, half)];
    if (pos[0] * pos[0] + pos[1] * pos[1] + pos[2] * pos[2] > half * half) continue; // fill a SPHERE, not a cube
    const cx = gco(pos[0]), cy = gco(pos[1]), cz = gco(pos[2]);

    let ok = true;
    for (let x = cx - 1; x <= cx + 1 && ok; x++)
      for (let y = cy - 1; y <= cy + 1 && ok; y++)
        for (let z = cz - 1; z <= cz + 1 && ok; z++) {
          const bucket = grid.get(gkey(x, y, z));
          if (!bucket) continue;
          for (const o of bucket) {
            const dx = pos[0] - o.pos[0], dy = pos[1] - o.pos[1], dz = pos[2] - o.pos[2];
            const minD = radius + o.radius + PACK_MARGIN;
            if (dx * dx + dy * dy + dz * dz < minD * minD) { ok = false; break; }
          }
        }
    // Keep the candidate off the camera's intro path (a thin tube around the orbit spiral +
    // the start of the Lissajous fly), so the camera never flies through an object.
    if (ok) for (let pi = 0; pi < pathPoints.length; pi++) {
      const pp = pathPoints[pi];
      const dx = pos[0] - pp[0], dy = pos[1] - pp[1], dz = pos[2] - pp[2];
      const clr = radius + CAM_CLEARANCE;
      if (dx * dx + dy * dy + dz * dz < clr * clr) { ok = false; break; }
    }
    if (!ok) continue;

    const obj = {
      pos,
      quat: randQuat(),
      spinAxis: randUnitVec(),
      spinSpeed: rand(-0.4, 0.4),
      scale,
      radius,
      proxyRadius: scale * R_PROXY,
      phase: rand(0, 20),
      morphSpeed: rand(0.35, 0.65),
      color: [rand(0.55, 0.8), rand(0.55, 0.8), rand(0.55, 0.8)],
      rough: rand(0.12, 0.7), // narrowed so ~40% fall under REFL_ROUGHNESS_MAX (0.35) -> reflective
      metal: rng() < 0.25 ? 1.0 : 0.0,
      lightOffset: 0,
      lightCount: 0,
      shadowOffset: 0,
      shadowCount: 0,
      reflOffset: 0,
      reflCount: 0,
    };
    objects.push(obj);
    const gk = gkey(cx, cy, cz);
    let b = grid.get(gk);
    if (!b) grid.set(gk, b = []);
    b.push(obj);
  }

  // Sort objects by distance from the origin (closest first) so the instance index is
  // the spawn rank: object 0 = closest = spawns first = the intro camera's focus, and
  // the scene then fills outward as the visible count doubles.
  objects.sort((a, b) =>
    (a.pos[0] ** 2 + a.pos[1] ** 2 + a.pos[2] ** 2) - (b.pos[0] ** 2 + b.pos[1] ** 2 + b.pos[2] ** 2));

  // Assign materials in a POST-pass (after placement + sort) so object placement, the camera-path
  // rejection, and the light generation below stay byte-identical to before — only the surface look
  // changes. The inline color/rough/metal above are overwritten here. Class clusters by cell; a 25%
  // per-object breakout adds variety. Deterministic from position + index, so every worker's
  // generateBase() computes the SAME materials (the reflection-list inclusion reads o.rough).
  objects.forEach((o, i) => {
    const mrng = makeRng((SEED ^ Math.imul(i + 1, 2654435761)) >>> 0);
    const cu = cellHash01(Math.floor(o.pos[0] / CELL), Math.floor(o.pos[1] / CELL), Math.floor(o.pos[2] / CELL));
    let mt = pickClass(cu);
    if (mrng() < 0.25) mt = pickClass(mrng()); // break the cluster -> variety within a region
    const m = MATERIAL_CLASSES[mt];
    o.materialType = mt;
    o.color = m.color(mrng);
    o.rough = m.rough(mrng);
    o.metal = m.metal;
  });
  // The closest object is the camera's opening hero — force a strong chrome mirror (polished metal).
  if (objects.length) { objects[0].materialType = 0; objects[0].color = [0.82, 0.85, 0.92]; objects[0].rough = 0.04; objects[0].metal = 1.0; }

  // Generate each object's lights, in sorted order (light i still belongs to object
  // floor(i / lightsPerObject) for spawn + indexing). ORBIT_FRACTION orbit their host object;
  // the rest are "field" lights scattered evenly through a sphere around the centre, each
  // orbiting its own random point — for a more even field of light, not just clusters on objects.
  const ORBIT_FRACTION = 0.7;
  const orbitCount = Math.round(lightsPerObject * ORBIT_FRACTION);
  const fieldR = objects.reduce((m, o) => Math.max(m, Math.hypot(o.pos[0], o.pos[1], o.pos[2])), 0) * 0.9;
  for (const o of objects) {
    for (let k = 0; k < lightsPerObject; k++) {
      const rgb = hslToRgb(rng(), 0.8, 0.55);
      const intensity = rand(0.135, 0.394); // 75% again (0.18..0.525 -> dimmer still)
      let pos, orbitRadius;
      if (k < orbitCount) {
        orbitRadius = o.radius + ORBIT_MARGIN + rng() * ORBIT_SPREAD;
        pos = [o.pos[0], o.pos[1], o.pos[2]]; // orbit the host object centre
      } else {
        // uniform random point in the field sphere; the light orbits that point
        let ux, uy, uz, m2;
        do { ux = rng() * 2 - 1; uy = rng() * 2 - 1; uz = rng() * 2 - 1; m2 = ux * ux + uy * uy + uz * uz; } while (m2 > 1 || m2 < 1e-6);
        const inv = (fieldR * Math.cbrt(rng())) / Math.sqrt(m2);
        pos = [ux * inv, uy * inv, uz * inv];
        orbitRadius = 0.3 + rng() * 1.2;
      }
      lights.push({
        pos,
        orbitRadius,
        color: [rgb[0] * intensity, rgb[1] * intensity, rgb[2] * intensity],
        radius: LIGHT_RADIUS, // falloff radius
      });
    }
  }

  const maxOrbit = lights.reduce((m, l) => Math.max(m, l.orbitRadius), 0);
  return { objects, lights, maxOrbit, sphereR: half };
}

// Build the per-object light/occluder/reflection lists. Single-threaded path (also used for
// ?test/?capture): gathers every object. The parallel path (sceneGen.worker.js) calls
// gatherChunk() per object slice across workers and merges in main.js.
export function generateScene(opts = {}) {
  const base = generateBase(opts);
  const { objects, lights, maxOrbit, sphereR } = base;
  const lightIndices = buildLightLists(objects, lights);
  const occluderIndices = buildOccluderLists(objects, maxOrbit);
  const reflectionIndices = buildNeighborLists(
    objects, () => REFLECTION_REACH, REFLECTION_CAP, 'reflOffset', 'reflCount',
    (o) => o.rough < REFL_ROUGHNESS_MAX); // only reflective objects trace reflections -> skip the rest
  return { objects, lights, lightIndices, occluderIndices, reflectionIndices, sphereR };
}

// Gather lists for objects [start, end) only (one worker's slice). Returns the slice's flat
// index arrays + per-object counts; main.js concatenates the slices and re-derives the global
// offsets. The base scene is regenerated deterministically per worker (same SEED), so every
// worker's `objects`/`lights` are identical.
export function gatherChunk(base, start, end) {
  const { objects, lights, maxOrbit } = base;
  const lightIndices = buildLightLists(objects, lights, start, end);
  const objGrid = buildObjectGrid(objects); // shared by the shadow + reflection gathers (same objects -> same grid)
  const occluderIndices = buildOccluderLists(objects, maxOrbit, start, end, objGrid);
  const reflectionIndices = buildNeighborLists(
    objects, () => REFLECTION_REACH, REFLECTION_CAP, 'reflOffset', 'reflCount',
    (o) => o.rough < REFL_ROUGHNESS_MAX, start, end, objGrid);
  const n = end - start;
  const lightCounts = new Int32Array(n), shadowCounts = new Int32Array(n), reflCounts = new Int32Array(n);
  for (let i = start; i < end; i++) {
    lightCounts[i - start] = objects[i].lightCount;
    shadowCounts[i - start] = objects[i].shadowCount;
    reflCounts[i - start] = objects[i].reflCount;
  }
  return { start, end, lightIndices, lightCounts, occluderIndices, shadowCounts, reflectionIndices, reflCounts };
}

// A minimal scene to verify shadows: one light and two objects (one big, one
// small) positioned so the big one casts a shadow on the small one. Enabled by
// adding ?test to the URL.
export function generateTestScene() {
  const objects = [];
  const makeObj = (pos, scale, color, rough, metal, phase = 3.0, morphSpeed = 0, matType = 0) => ({
    pos,
    quat: [0, 0, 0, 1],
    spinAxis: [0, 1, 0],
    spinSpeed: 0,
    scale,
    radius: MAX_NORM_CIRCUMRADIUS * scale,
    proxyRadius: scale * R_PROXY,
    phase, // 3.0 = cube, 6.0 = icosahedron
    morphSpeed, // 0 = static
    color,
    rough,
    metal,
    materialType: matType,
    lightOffset: 0, lightCount: 0,
    shadowOffset: 0, shadowCount: 0,
    reflOffset: 0, reflCount: 0,
  });
  // Big flat receiver below: a large static cube whose top catches the shadows (chalk/matte).
  objects.push(makeObj([0, -3.6, 0], 4.0, [0.7, 0.7, 0.72], 0.75, 0, 3.0, 0.0, 2));
  // Morphing object above the floor: casts a clear, shape-changing shadow onto
  // the floor and shows a bright reflection in the icosahedron. Starts at the
  // tetrahedron (phase 0) and ping-pongs through every shape (marble).
  objects.push(makeObj([-1.6, 1.2, 0.4], 1.2, [0.82, 0.8, 0.76], 0.55, 0, 0.0, 0.4, 3));
  // Shiny static icosahedron: reflects the morphing object + casts its own shadow (polished metal).
  objects.push(makeObj([1.7, 1.0, 0.6], 1.1, [0.95, 0.95, 1.0], 0.02, 1, 6.0, 0.0, 0));

  // One bright light above so both objects drop shadows onto the floor. It also
  // orbits its base point, so the test scene exercises moving lights + shadows.
  const lights = [{ pos: [1.5, 8.0, 2.5], orbitRadius: 2.0, color: [22, 22, 22], radius: 40 }];

  const maxOrbit = lights.reduce((m, l) => Math.max(m, l.orbitRadius), 0);
  const lightIndices = buildLightLists(objects, lights);
  const occluderIndices = buildOccluderLists(objects, maxOrbit);
  const reflectionIndices = buildNeighborLists(
    objects, () => REFLECTION_REACH, REFLECTION_CAP, 'reflOffset', 'reflCount',
    (o) => o.rough < REFL_ROUGHNESS_MAX); // only reflective objects trace reflections -> skip the rest
  return { objects, lights, lightIndices, occluderIndices, reflectionIndices };
}

// Shadow occluder lists: reach covers the object plus the orbit + falloff of the
// lights that can reach it, so casters between a surface and a moving light are kept.
function buildOccluderLists(objects, maxOrbit, start = 0, end = objects.length, grid = null) {
  return buildNeighborLists(
    objects, (o) => o.radius + maxOrbit + LIGHT_RADIUS, SHADOW_CAP, 'shadowOffset', 'shadowCount', null, start, end, grid);
}

// Reusable scratch for the gather hot loops below — avoids allocating a {index, d2} object per
// candidate (millions per scene -> heavy GC). The nearest `cap` are selected via an index sort.
let _gIdx = new Int32Array(8192);
let _gD2 = new Float64Array(8192);
let _gOrd = new Uint32Array(8192);
function growGatherScratch(n) {
  let s = _gIdx.length; while (s < n) s *= 2;
  _gIdx = new Int32Array(s); _gD2 = new Float64Array(s); _gOrd = new Uint32Array(s);
}

// Build the object bucket grid once (bbox + bucket binning + maxProxy). Shared by the shadow and
// reflection neighbour gathers — they otherwise rebuild the identical grid (same objects) twice.
function buildObjectGrid(objects) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const o of objects)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], o.pos[a]);
      hi[a] = Math.max(hi[a], o.pos[a]);
    }
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 1e-3;
  const bucketSize = extent / BUCKETS_PER_AXIS;
  const B = BUCKETS_PER_AXIS;
  const coord = (p, a) => Math.max(0, Math.min(B - 1, Math.floor((p - lo[a]) / bucketSize)));
  const key = (x, y, z) => (x * B + y) * B + z;
  let maxProxy = 0;
  for (const o of objects) maxProxy = Math.max(maxProxy, o.proxyRadius);
  const buckets = Array.from({ length: B * B * B }, () => []);
  objects.forEach((o, i) => {
    buckets[key(coord(o.pos[0], 0), coord(o.pos[1], 1), coord(o.pos[2], 2))].push(i);
  });
  return { coord, key, buckets, maxProxy };
}

// Generic per-object nearby-object lists via the bucket grid. An object j is
// included for O when their separation is within reachFn(O) + j.proxyRadius;
// nearest `cap` are kept. Writes O[offsetKey]/O[countKey] and returns the flat
// index array. Objects are treated as sphere proxies. `grid` is shared across calls.
function buildNeighborLists(objects, reachFn, cap, offsetKey, countKey, includeFn, start = 0, end = objects.length, grid = null) {
  const { coord, key, buckets, maxProxy } = grid || buildObjectGrid(objects);

  const indices = [];
  for (let self = start; self < end; self++) {
    const o = objects[self];
    if (includeFn && !includeFn(o)) { o[offsetKey] = indices.length; o[countKey] = 0; continue; } // never traces -> no list needed
    const reach = reachFn(o);
    const lim = reach + maxProxy; // conservative sphere-overlap bound (>= per-candidate reach + proxyRadius), hoisted out of the loop
    const lim2 = lim * lim;
    const cx = o.pos[0], cy = o.pos[1], cz = o.pos[2];
    const x0 = coord(cx - lim, 0), x1 = coord(cx + lim, 0);
    const y0 = coord(cy - lim, 1), y1 = coord(cy + lim, 1);
    const z0 = coord(cz - lim, 2), z1 = coord(cz + lim, 2);
    let nc = 0;
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++)
          for (const j of buckets[key(x, y, z)]) {
            if (j === self) continue;
            const p = objects[j].pos;
            const dx = cx - p[0], dy = cy - p[1], dz = cz - p[2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= lim2) { if (nc >= _gIdx.length) growGatherScratch(nc + 1); _gIdx[nc] = j; _gD2[nc] = d2; nc++; }
          }
    for (let i = 0; i < nc; i++) _gOrd[i] = i;
    _gOrd.subarray(0, nc).sort((a, b) => _gD2[a] - _gD2[b]); // nearest first
    o[offsetKey] = indices.length;
    const count = Math.min(nc, cap);
    for (let k = 0; k < count; k++) indices.push(_gIdx[_gOrd[k]]);
    o[countKey] = count;
  }
  return new Float32Array(indices);
}

// pdx-gfx-style bucket grid: bin lights into a uniform 3D grid, then for each
// object gather candidates from the buckets its reach overlaps and keep those
// whose spheres actually overlap. Writes lightOffset/lightCount onto objects.
function buildLightLists(objects, lights, start = 0, end = objects.length) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const l of lights)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], l.pos[a]);
      hi[a] = Math.max(hi[a], l.pos[a]);
    }
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 1e-3;
  const B = LIGHT_BUCKETS_PER_AXIS; // finer than the object grid so 200k-light queries don't over-scan oversized buckets
  const bucketSize = extent / B;
  const coord = (p, a) => Math.max(0, Math.min(B - 1, Math.floor((p - lo[a]) / bucketSize)));
  const idx = (x, y, z) => (x * B + y) * B + z;

  // A light can be anywhere on a sphere of radius orbitRadius around its stored
  // centre, so a list built from the static centres must reach orbitRadius + falloff
  // further to stay valid for every animated frame (conservative superset; falloff
  // zeroes the far side at shading time).
  let maxOrbit = 0, maxFalloff = 0;
  for (const l of lights) {
    maxOrbit = Math.max(maxOrbit, l.orbitRadius);
    maxFalloff = Math.max(maxFalloff, l.radius);
  }

  const buckets = Array.from({ length: B * B * B }, () => []);
  lights.forEach((l, li) => {
    buckets[idx(coord(l.pos[0], 0), coord(l.pos[1], 1), coord(l.pos[2], 2))].push(li);
  });

  const indices = [];
  for (let i = start; i < end; i++) {
    const o = objects[i];
    o.lightOffset = indices.length;
    const reach = o.radius + maxOrbit + maxFalloff;
    const reach2 = reach * reach; // each light's own lim (radius+orbit+falloff) <= reach, so reach2 is a conservative superset; hoisted out of the candidate loop
    const cx = o.pos[0], cy = o.pos[1], cz = o.pos[2];
    const x0 = coord(cx - reach, 0), x1 = coord(cx + reach, 0);
    const y0 = coord(cy - reach, 1), y1 = coord(cy + reach, 1);
    const z0 = coord(cz - reach, 2), z1 = coord(cz + reach, 2);
    let nc = 0;
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++)
          for (const li of buckets[idx(x, y, z)]) {
            const p = lights[li].pos;
            const dx = cx - p[0], dy = cy - p[1], dz = cz - p[2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= reach2) { if (nc >= _gIdx.length) growGatherScratch(nc + 1); _gIdx[nc] = li; _gD2[nc] = d2; nc++; }
          }
    for (let i = 0; i < nc; i++) _gOrd[i] = i;
    _gOrd.subarray(0, nc).sort((a, b) => _gD2[a] - _gD2[b]); // nearest first, so the shader shades + shadows the closest
    const n = Math.min(nc, MAX_LIGHTS_PER_OBJECT); // keep the nearest N (neighbour + field)
    for (let k = 0; k < n; k++) indices.push(_gIdx[_gOrd[k]]);
    o.lightCount = n;
  }
  return new Float32Array(indices);
}
