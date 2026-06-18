// Renderer-independent invariants for the pure data/geometry layer. These must
// not change across the WebGPU migration (the same builders feed both renderers).
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

// Orbiting lights (animated in-shader) must stay outside their host object and
// never sweep into a neighbour; light clouds of different objects may overlap.
const lpo = a.lights.length / a.objects.length;
const hostOf = (i) => a.objects[Math.floor(i / lpo)];
check('scene: every light orbits outside its host',
  a.lights.every((l, i) => l.orbitRadius > hostOf(i).radius));
check('scene: no light orbit reaches into a non-host object',
  a.lights.every((l, i) => {
    const h = hostOf(i);
    return a.objects.every((o) => o === h
      || Math.hypot(l.pos[0] - o.pos[0], l.pos[1] - o.pos[1], l.pos[2] - o.pos[2]) >= l.orbitRadius + o.radius);
  }));

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
