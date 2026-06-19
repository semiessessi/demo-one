// Parallel scene generation. main.js spawns one of these per CPU core; each worker regenerates
// the (deterministic, same-SEED) base scene and gathers the per-object light/occluder/reflection
// lists for only its slice of objects [start, end). main.js regenerates the same base itself and
// merges the slices, so the worker returns ONLY the transferable index slices (no base clone).
import { generateBase, gatherChunk } from './scene.js';

self.onmessage = (e) => {
  const { opts, chunk, chunks, start: s, end: en } = e.data;
  const base = generateBase(opts || {});
  const n = base.objects.length;
  const start = s ?? Math.floor((n * chunk) / chunks);
  const end = en ?? Math.floor((n * (chunk + 1)) / chunks);
  const part = gatherChunk(base, start, end);
  // Transfer the typed-array buffers (zero-copy) back to main.
  self.postMessage(part, [
    part.lightIndices.buffer, part.lightCounts.buffer,
    part.occluderIndices.buffer, part.shadowCounts.buffer,
    part.reflectionIndices.buffer, part.reflCounts.buffer,
  ]);
};
