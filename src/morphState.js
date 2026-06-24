// Note-stepped morph: each object walks through the journey sequence ON THE MUSIC. On each
// note-on only ~STEP_FRACTION of objects step (a fast STEP_DUR lerp to the next stop), forward
// or backward; at the rhombic-dodecahedron / rhombic-triacontahedron midpoints (p in {2,4,7,9})
// it 50/50 stops-at vs skips to the next Platonic solid; FLIP_CHANCE of steps also flip
// direction. The walk is stochastic + cumulative, so it can't be a pure function of time —
// it lives here on the CPU, and main.js uploads the current p per object to the shaders each
// frame (the vertex geometry + the occluder hull). Initial shapes are seeded, so capture mode
// (no music -> no steps) stays deterministic.
import { NUM_SEGMENTS } from './journey.js';
import { smooth, makeRng } from './math.js';

const STEP_DUR = 0.2;        // seconds per shape transition (fast)
const STEP_FRACTION = 0.0025; // fraction of objects that step on each note (calm, not epileptic)
const FLIP_CHANCE = 0.25;    // chance a step also flips direction
const MIDPOINT_STOP = 0.5;   // at a midpoint: stop here (true) vs skip to the next solid
// Which integer stops are the non-Platonic intermediate shapes (rhombic dodeca @2,4;
// rhombic triacontahedron @7,9) — the ones that can be stopped-at or skipped.
const IS_MIDPOINT = [false, false, true, false, true, false, false, true, false, true, false];

export function createMorphState(count) {
  const init = makeRng(0x5eed1234); // seeded -> deterministic initial shapes (capture-safe)
  const p = new Float32Array(count);      // current morph position per object (uploaded each frame)
  const p0 = new Float32Array(count);     // lerp start
  const target = new Float32Array(count); // lerp end (the stop we're heading to)
  const t0 = new Float32Array(count);     // music-clock time the current lerp started
  const dir = new Int8Array(count);       // +1 / -1 walk direction
  const animating = new Uint8Array(count);
  // `dirty` tracks whether p changed since the last GPU upload, so the per-frame texture upload
  // can be skipped on calm frames (no object morphing). Starts true so the seeded initial p uploads.
  let dirty = true;

  function reset() {
    for (let i = 0; i < count; i++) {
      const s = Math.round(init() * NUM_SEGMENTS); // random integer stop
      p[i] = s; p0[i] = s; target[i] = s; t0[i] = 0; animating[i] = 0;
      dir[i] = init() < 0.5 ? 1 : -1;
    }
    // The hero (object 0, the focal object the camera opens on) starts as a dodecahedron: p=8
    // in the journey (midToDodecaSegment ends at 8). Override after the seeding loop so the RNG
    // sequence for every other object is unchanged (capture stays deterministic).
    if (count > 0) { p[0] = 8; p0[0] = 8; target[0] = 8; }
    dirty = true;
  }
  reset();

  // Ease the active lerps toward their targets. `now` is the music clock (seconds).
  function step(now) {
    for (let i = 0; i < count; i++) {
      if (!animating[i]) continue;
      const a = (now - t0[i]) / STEP_DUR;
      if (a >= 1) { p[i] = target[i]; animating[i] = 0; dirty = true; }
      else if (a > 0) { p[i] = p0[i] + (target[i] - p0[i]) * smooth(a); dirty = true; }
    }
    return p;
  }

  // Advance ~STEP_FRACTION of objects to their next stop. Called once per note-on.
  function onNote(now) {
    const k = Math.max(1, Math.round(count * STEP_FRACTION));
    for (let n = 0; n < k; n++) {
      const i = (Math.random() * count) | 0;
      if (Math.random() < FLIP_CHANCE) dir[i] = -dir[i];
      const base = Math.round(animating[i] ? target[i] : p[i]);
      let next = base + dir[i];
      if (next < 0 || next > NUM_SEGMENTS) { dir[i] = -dir[i]; next = base + dir[i]; } // bounce at the ends
      let tgt = next;
      if (IS_MIDPOINT[next] && Math.random() >= MIDPOINT_STOP) {
        const skip = next + dir[i]; // skip the midpoint straight to the next solid
        if (skip >= 0 && skip <= NUM_SEGMENTS) tgt = skip;
      }
      p0[i] = p[i]; target[i] = tgt; t0[i] = now; animating[i] = 1;
    }
  }

  return { step, onNote, reset, p, get dirty() { return dirty; }, clearDirty() { dirty = false; } };
}
