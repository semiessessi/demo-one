// Parallel scene generation. main.js spawns one of these per CPU core; each worker regenerates
// the (deterministic, same-SEED) base scene and gathers the per-object light/occluder/reflection
// lists for only its slice of objects [start, end). main.js merges the slices. The base regen is
// cheap (~180 ms, duplicated per worker) but the heavy per-object gather is split across cores.
import { generateBase, gatherChunk } from './scene.js';

self.onmessage = (e) => {
  const { opts, chunk, chunks } = e.data;
  const base = generateBase(opts || {});
  const n = base.objects.length;
  const start = Math.floor((n * chunk) / chunks);
  const end = Math.floor((n * (chunk + 1)) / chunks);
  const part = gatherChunk(base, start, end);
  // Chunk 0 also returns the base scene (objects + lights + sphereR) for the GPU textures.
  const msg = { ...part, base: chunk === 0 ? { objects: base.objects, lights: base.lights, sphereR: base.sphereR } : null };
  // Transfer the typed-array buffers (zero-copy) back to main.
  self.postMessage(msg, [
    part.lightIndices.buffer, part.lightCounts.buffer,
    part.occluderIndices.buffer, part.shadowCounts.buffer,
    part.reflectionIndices.buffer, part.reflCounts.buffer,
  ]);
};
