// Renderer-independent invariants for the pure data/geometry layer.
// Run: node scripts/data-tests.mjs
import { buildJourneySegments, NUM_SEGMENTS } from '../src/journey.js';
import { buildNormScaleLUT, NORM_LUT_SIZE } from '../src/normalize.js';
import { generateScene, generateTestScene } from '../src/scene.js';
import { planeOf, supporting } from '../src/hull.js';

let failures = 0;
function check(name, cond, info = '') {
  if (cond) {
    console.log(`  ok   ${name}${info ? '  (' + info + ')' : ''}`);
  } else {
    console.log(`  FAIL ${name}${info ? '  (' + info + ')' : ''}`);
    failures++;
  }
}

// --- journey segments ------------------------------------------------------
const segs = buildJourneySegments();
check('journey: 10 segments', segs.length === NUM_SEGMENTS, `${segs.length}`);
const triCounts = segs.map((s) => s.start.length / 9);
check('journey: start/end lengths match & divisible by 9',
  segs.every((s) => s.start.length === s.end.length && s.start.length % 9 === 0),
  `tris/seg=[${triCounts.join(',')}]`);

// --- normalization LUT -----------------------------------------------------
const lut = buildNormScaleLUT();
check('normalize: LUT size', lut.length === NORM_LUT_SIZE, `${lut.length}`);
check('normalize: all finite & positive', lut.every((v) => Number.isFinite(v) && v > 0));
check('normalize: tetra (p=0) scale ~1.5', Math.abs(lut[0] - 1.5) < 0.05, `lut[0]=${lut[0].toFixed(4)}`);

// --- scene determinism (fixed LCG seed) ------------------------------------
const a = generateScene();
const b = generateScene();
const posHash = (s) => s.objects.map((o) => o.pos.map((x) => x.toFixed(3)).join()).join('|');
check('scene: deterministic placement', posHash(a) === posHash(b));
check('scene: lights = 40 per object',
  a.lights.length === a.objects.length * 40, `${a.objects.length} obj, ${a.lights.length} lights`);
check('scene: non-empty light/occluder/reflection lists',
  a.lightIndices.length > 0 && a.occluderIndices.length > 0 && a.reflectionIndices.length > 0,
  `light=${a.lightIndices.length} occ=${a.occluderIndices.length} refl=${a.reflectionIndices.length}`);
check('scene: per-object offsets in range',
  a.objects.every((o) => o.lightOffset + o.lightCount <= a.lightIndices.length));

// 70% of each object's lights orbit it (animated in-shader) and must stay outside the host and
// never sweep into a neighbour; the other 30% are "field" lights scattered through the central
// sphere with their own random orbit point, exempt from the host-orbit invariants.
const lpo = a.lights.length / a.objects.length;
const orbitCount = Math.round(lpo * 0.7);
const hostOf = (i) => a.objects[Math.floor(i / lpo)];
const orbiting = (i) => (i % lpo) < orbitCount;
const fieldR = a.objects.reduce((m, o) => Math.max(m, Math.hypot(o.pos[0], o.pos[1], o.pos[2])), 0);
check('scene: orbiting lights stay outside their host',
  a.lights.every((l, i) => !orbiting(i) || l.orbitRadius > hostOf(i).radius));
check('scene: orbiting lights never sweep into a non-host object',
  a.lights.every((l, i) => {
    if (!orbiting(i)) return true;
    const h = hostOf(i);
    return a.objects.every((o) => o === h
      || Math.hypot(l.pos[0] - o.pos[0], l.pos[1] - o.pos[1], l.pos[2] - o.pos[2]) >= l.orbitRadius + o.radius);
  }));
check('scene: field lights sit within the central sphere',
  a.lights.every((l, i) => orbiting(i) || Math.hypot(l.pos[0], l.pos[1], l.pos[2]) <= fieldR));

const t = generateTestScene();
check('test scene: 3 objects, 1 light', t.objects.length === 3 && t.lights.length === 1);

// --- hull helpers ----------------------------------------------------------
// Triangle in the z=1 plane, wound so the outward normal is +z (origin is inside).
const tri = [1, -1, 1, -1, -1, 1, 0, 1, 1];
const pl = planeOf(tri, 0, 3, 6);
check('hull: planeOf normal ~ +z, d ~ 1',
  pl && Math.abs(pl[2] - 1) < 1e-6 && Math.abs(pl[3] - 1) < 1e-6, pl ? pl.map((x) => x.toFixed(2)).join() : 'null');
check('hull: supporting accepts inner pts / rejects outer',
  supporting(pl, [0, 0, 0.5]) && !supporting(pl, [0, 0, 2]));

// --- occluder face merge (needs three for the texture; soft-skip if absent) -
try {
  const { buildPlaneTexture } = await import('../src/occluderData.js');
  const g = buildPlaneTexture();
  check('occluder: face counts per segment positive',
    g.segTriCount.length === NUM_SEGMENTS && g.segTriCount.every((c) => c > 0),
    `faces/seg=[${g.segTriCount.join(',')}]`);
  check('occluder: merge reduced plane count vs triangles',
    g.segTriCount.reduce((x, y) => x + y, 0) < triCounts.reduce((x, y) => x + y, 0),
    `faces=${g.segTriCount.reduce((x, y) => x + y, 0)} tris=${triCounts.reduce((x, y) => x + y, 0)}`);
} catch (e) {
  console.log(`  skip occluder face test (three not importable in node): ${e.message.split('\n')[0]}`);
}

console.log(failures === 0 ? '\nALL DATA TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
