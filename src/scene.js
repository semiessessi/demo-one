// Static scene generation: objects scattered at random (LCG, so it's
// reproducible) in a bounded cube, rejection-sampled so none overlap; lights
// scattered around each object. Per-object nearby-light lists are built once
// with a uniform 3D bucket grid (ported from pdx-gfx).
import { MAX_NORM_CIRCUMRADIUS } from './journey.js';

const TARGET_OBJECTS = 200;
const VOLUME = 16; // cube side
const LIGHTS_PER_OBJECT = 20;
const LIGHT_RADIUS = 2.0;
const SCALE_MIN = 0.45;
const SCALE_MAX = 0.62;
const PACK_MARGIN = 0.2; // extra gap between object bounding spheres
const BUCKETS_PER_AXIS = 10;
const R_PROXY = 1.0; // shadow/reflection sphere-proxy radius factor (× scale)
const SHADOW_CAP = 64; // max occluders per object for shadows (nearest kept)
const REFLECTION_CAP = 128; // max occluders per object for reflections
const REFLECTION_REACH = 7.0; // how far reflection rays look for occluders
const SEED = 0x1234abcd;

// Small LCG (numerical-recipes constants) for reproducible randomness.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function generateScene() {
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

  const objects = [];
  const lights = [];
  const half = VOLUME / 2;

  let attempts = 0;
  const maxAttempts = TARGET_OBJECTS * 400;
  while (objects.length < TARGET_OBJECTS && attempts < maxAttempts) {
    attempts++;
    const scale = rand(SCALE_MIN, SCALE_MAX);
    const radius = MAX_NORM_CIRCUMRADIUS * scale;
    const pos = [rand(-half, half), rand(-half, half), rand(-half, half)];

    let ok = true;
    for (const o of objects) {
      const dx = pos[0] - o.pos[0], dy = pos[1] - o.pos[1], dz = pos[2] - o.pos[2];
      const minD = radius + o.radius + PACK_MARGIN;
      if (dx * dx + dy * dy + dz * dz < minD * minD) { ok = false; break; }
    }
    if (!ok) continue;

    objects.push({
      pos,
      quat: randQuat(),
      spinAxis: randUnitVec(),
      spinSpeed: rand(-0.4, 0.4),
      scale,
      radius,
      proxyRadius: scale * R_PROXY,
      phase: rand(0, 20),
      color: [rand(0.55, 0.8), rand(0.55, 0.8), rand(0.55, 0.8)],
      rough: rand(0.12, 0.9), // some smooth enough to reflect
      metal: rng() < 0.25 ? 1.0 : 0.0,
      lightOffset: 0,
      lightCount: 0,
      shadowOffset: 0,
      shadowCount: 0,
      reflOffset: 0,
      reflCount: 0,
    });

    for (let k = 0; k < LIGHTS_PER_OBJECT; k++) {
      const u = randUnitVec();
      const r = 1.3 * Math.cbrt(rng());
      const rgb = hslToRgb(rng(), 0.8, 0.55);
      const intensity = rand(0.12, 0.35);
      lights.push({
        pos: [pos[0] + u[0] * r, pos[1] + u[1] * r, pos[2] + u[2] * r],
        color: [rgb[0] * intensity, rgb[1] * intensity, rgb[2] * intensity],
        radius: LIGHT_RADIUS,
      });
    }
  }

  const lightIndices = buildLightLists(objects, lights);
  const occluderIndices = buildOccluderLists(objects);
  const reflectionIndices = buildNeighborLists(
    objects, () => REFLECTION_REACH, REFLECTION_CAP, 'reflOffset', 'reflCount');
  return { objects, lights, lightIndices, occluderIndices, reflectionIndices };
}

// A minimal scene to verify shadows: one light and two objects (one big, one
// small) positioned so the big one casts a shadow on the small one. Enabled by
// adding ?test to the URL.
export function generateTestScene() {
  const objects = [];
  const makeObj = (pos, scale, color) => ({
    pos,
    quat: [0, 0, 0, 1],
    spinAxis: [0, 1, 0],
    spinSpeed: 0,
    scale,
    radius: MAX_NORM_CIRCUMRADIUS * scale,
    proxyRadius: scale * R_PROXY,
    phase: 3.0, // a cube (clear silhouette), static
    color,
    rough: 0.6,
    metal: 0,
    lightOffset: 0, lightCount: 0,
    shadowOffset: 0, shadowCount: 0,
    reflOffset: 0, reflCount: 0,
  });
  objects.push(makeObj([0, 0, 0], 1.6, [0.75, 0.75, 0.78])); // big occluder
  objects.push(makeObj([-2.7, -1.5, -0.9], 0.7, [0.8, 0.78, 0.7])); // small receiver (in shadow)

  // One bright light; small cube sits along the big cube's shadow direction.
  const lights = [{ pos: [6, 3.3, 2], color: [22, 22, 22], radius: 40 }];

  const lightIndices = buildLightLists(objects, lights);
  const occluderIndices = buildOccluderLists(objects);
  const reflectionIndices = buildNeighborLists(
    objects, () => REFLECTION_REACH, REFLECTION_CAP, 'reflOffset', 'reflCount');
  return { objects, lights, lightIndices, occluderIndices, reflectionIndices };
}

// Shadow occluder lists: reach is tied to the light radius so lists stay short.
function buildOccluderLists(objects) {
  return buildNeighborLists(
    objects, (o) => o.radius + LIGHT_RADIUS, SHADOW_CAP, 'shadowOffset', 'shadowCount');
}

// Generic per-object nearby-object lists via the bucket grid. An object j is
// included for O when their separation is within reachFn(O) + j.proxyRadius;
// nearest `cap` are kept. Writes O[offsetKey]/O[countKey] and returns the flat
// index array. Objects are treated as sphere proxies.
function buildNeighborLists(objects, reachFn, cap, offsetKey, countKey) {
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
  objects.forEach((o) => { maxProxy = Math.max(maxProxy, o.proxyRadius); });
  const buckets = Array.from({ length: B * B * B }, () => []);
  objects.forEach((o, i) => {
    buckets[key(coord(o.pos[0], 0), coord(o.pos[1], 1), coord(o.pos[2], 2))].push(i);
  });

  const indices = [];
  objects.forEach((o, self) => {
    const reach = reachFn(o);
    const bucketReach = reach + maxProxy;
    const c = o.pos;
    const x0 = coord(c[0] - bucketReach, 0), x1 = coord(c[0] + bucketReach, 0);
    const y0 = coord(c[1] - bucketReach, 1), y1 = coord(c[1] + bucketReach, 1);
    const z0 = coord(c[2] - bucketReach, 2), z1 = coord(c[2] + bucketReach, 2);
    const cands = [];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++)
          for (const j of buckets[key(x, y, z)]) {
            if (j === self) continue;
            const oc = objects[j];
            const dx = c[0] - oc.pos[0], dy = c[1] - oc.pos[1], dz = c[2] - oc.pos[2];
            const d2 = dx * dx + dy * dy + dz * dz;
            const lim = reach + oc.proxyRadius;
            if (d2 <= lim * lim) cands.push({ j, d2 });
          }
    cands.sort((a, b) => a.d2 - b.d2);
    o[offsetKey] = indices.length;
    const count = Math.min(cands.length, cap);
    for (let k = 0; k < count; k++) indices.push(cands[k].j);
    o[countKey] = count;
  });
  return new Float32Array(indices);
}

// pdx-gfx-style bucket grid: bin lights into a uniform 3D grid, then for each
// object gather candidates from the buckets its reach overlaps and keep those
// whose spheres actually overlap. Writes lightOffset/lightCount onto objects.
function buildLightLists(objects, lights) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const l of lights)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], l.pos[a]);
      hi[a] = Math.max(hi[a], l.pos[a]);
    }
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 1e-3;
  const bucketSize = extent / BUCKETS_PER_AXIS;
  const B = BUCKETS_PER_AXIS;
  const coord = (p, a) => Math.max(0, Math.min(B - 1, Math.floor((p - lo[a]) / bucketSize)));
  const idx = (x, y, z) => (x * B + y) * B + z;

  const buckets = Array.from({ length: B * B * B }, () => []);
  lights.forEach((l, li) => {
    buckets[idx(coord(l.pos[0], 0), coord(l.pos[1], 1), coord(l.pos[2], 2))].push(li);
  });

  const indices = [];
  for (const o of objects) {
    o.lightOffset = indices.length;
    const reach = o.radius + LIGHT_RADIUS;
    const c = o.pos;
    const x0 = coord(c[0] - reach, 0), x1 = coord(c[0] + reach, 0);
    const y0 = coord(c[1] - reach, 1), y1 = coord(c[1] + reach, 1);
    const z0 = coord(c[2] - reach, 2), z1 = coord(c[2] + reach, 2);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++)
          for (const li of buckets[idx(x, y, z)]) {
            const l = lights[li];
            const dx = c[0] - l.pos[0], dy = c[1] - l.pos[1], dz = c[2] - l.pos[2];
            if (dx * dx + dy * dy + dz * dz <= (o.radius + l.radius) ** 2) indices.push(li);
          }
    o.lightCount = indices.length - o.lightOffset;
  }
  return new Float32Array(indices);
}
