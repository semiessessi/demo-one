# WebGPU migration

The renderer now runs on **WebGPU** (Three.js `WebGPURenderer` + TSL/WGSL, global
data in **storage buffers**), with the original **WebGL2** path kept as a runtime
fallback and A/B baseline.

## Backend selection (`src/backends/index.js`)

- Default: **WebGPU** when `navigator.gpu` is available; on init failure it falls
  back to WebGL2 with a console warning.
- `?force-webgl` — force the WebGL2 path (for comparison / older hardware).

Both backends implement one interface:
`{ name, domElement, camera, setTime(s), setView(v), setSize(w,h), render() }`,
and each owns its own camera + OrbitControls (the WebGL path imports core `three`,
the WebGPU path imports `three/webgpu` — kept separate to avoid two-instance bugs).

## Layout

- `src/backends/webgl.js` — original WebGL2 path (RawShaderMaterial + DataTextures
  + EffectComposer). Unchanged behaviour.
- `src/backends/webgpu.js` — WebGPURenderer, skydome, morph mesh, sprites, and the
  bloom + ACES tone-map PostProcessing chain.
- `src/gpu/` — WebGPU material code:
  - `data.js` — pack scene data into flat `Float32Array`s for storage buffers.
  - `storage.js` — read-only storage-buffer node helpers.
  - `morphMaterial.js` — instanced morph (vertex phase morph) + GGX direct lighting
    + convex-hull shadows & reflections. Storage access + control flow in TSL
    (`Fn`/`Loop`/`If`); leaf math (quaternions, GGX `brdf`, `falloff`, `environment`)
    in raw WGSL (`wgslFn`). Trace functions use `setLayout` so they compile to real
    WGSL functions.
  - `spriteMaterial.js` — billboarded additive light glows.
- Pure data builders are shared with the WebGL path unchanged: `journey.js`,
  `solids.js`, `icosa.js`, `normalize.js`, `hull.js`, `scene.js`, `occluderData.js`
  (now also exposes `buildPlaneData()` for the storage buffer).

Storage buffers are consolidated to stay within `maxStorageBuffersPerShaderStage`
(8, the WebGPU baseline): all per-instance data in one interleaved buffer (7 vec4
/instance), the three index lists in one buffer with base offsets, and
segTriStart+segTriCount in one. Fragment uses 7 storage buffers, vertex 2.

## Verifying (no visual regressions)

- `baselines/` — reference WebGL PNGs at fixed (scene, phase, camera) states.
- Deterministic capture mode for matching frames on either backend:
  `?capture&cam=main-overview|main-close|test&t=<seconds>` (add `?test` for the
  test scene). Pins time + camera and hides the UI.
- `node scripts/data-tests.mjs` — renderer-independent invariants (journey,
  normalize LUT, hull planes, scene determinism, list sizes). Must stay green.

The WebGPU path was checked against every baseline and is at visual parity
(morph, GGX, shadows, reflections, sprites, bloom, sky).

## Performance / scale

- `?objects=N` (and `?lpo=N` lights per object) scales the scene for stress tests;
  the volume grows with `cbrt(N/200)` so density stays constant.
- Press **`f`** for the live FPS / frame-time overlay (works on both backends).
- `?debug` exposes `window.__wgpu = { renderer, scene, camera, morphMesh }` for
  shader inspection / error-scope checks.

**Measure on real hardware.** In headless Chrome, WebGPU runs on a *software* Dawn
backend that is far slower than the WebGL/ANGLE path, so a headless A/B favours
WebGL (e.g. at 1000 objects ~90 ms WebGPU vs ~33 ms WebGL there). That is a
software-backend artifact, not the storage-buffer architecture — compare on a real
GPU with `?objects=N` + `f`, and `?force-webgl` for the WebGL number.

To revert the default to WebGL, flip the `useWebGPU` condition in
`src/backends/index.js`.
