import * as THREE from 'three/webgpu';
import {
  Fn, instanceIndex, storage, instancedArray, uniformArray, compute,
  If, Loop, atomicAdd, atomicStore, uint, int, dot,
} from 'three/tsl';

// ⚠ WIP / experimental (opt in with ?computecull). Fully GPU-driven frustum culling:
// a compute pass tests every instance vs the frustum, atomically appends visible
// global indices to the order buffer + counts them, a finalize pass writes the count
// into an IndirectStorageBufferAttribute, and the mesh is drawn with drawIndirect —
// no CPU loop, no readback. This is the technique that scales WebGPU past the CPU
// cull (createOrderCuller) at ~10k+ objects.
//
// STATUS on three r171: the indirect-draw + shared order-buffer mechanism works
// (verified by bisection), but the *atomic* compute pipeline fails to compile (opaque
// "Invalid ComputePipeline" — Tint error not surfaced) with both
// storage(StorageBufferAttribute).setAtomic(true) and instancedArray(...).setAtomic(true).
// So the default WebGPU path uses the CPU order culler, which gives identical results
// and identical perf at current scales. Revisit when three's TSL atomics land/​fix or
// drop to raw WGSL via wgslFn with ptr<storage, atomic<u32>> params.
const NUM_PLANES = 5;

export function createComputeCuller(objects, orderAttr) {
  const n = objects.length;

  const bounds = new Float32Array(n * 4); // center.xyz, radius (static)
  objects.forEach((o, i) => {
    bounds[i * 4] = o.pos[0]; bounds[i * 4 + 1] = o.pos[1];
    bounds[i * 4 + 2] = o.pos[2]; bounds[i * 4 + 3] = o.radius;
  });
  const uBounds = storage(new THREE.StorageBufferAttribute(bounds, 4), 'vec4', n).toReadOnly();

  const uOrder = storage(orderAttr, 'uint', n); // read-write view of the material's order buffer
  const uCounter = instancedArray(1, 'uint').setAtomic(true);

  const indirectAttr = new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 0, 0, 0]), 4);
  const uIndirect = storage(indirectAttr, 'uint', 4);

  const planesArr = new Float32Array(NUM_PLANES * 4);
  const uFrustum = uniformArray(planesArr, 'vec4');

  const resetNode = compute(Fn(() => {
    atomicStore(uCounter.element(int(0)), uint(0));
  })(), 1);

  const cullNode = compute(Fn(() => {
    If(instanceIndex.lessThan(uint(n)), () => {
      const b = uBounds.element(instanceIndex);
      const c = b.xyz;
      const r = b.w;
      const inside = int(1).toVar();
      Loop(NUM_PLANES, ({ i: p }) => {
        const pl = uFrustum.element(p);
        If(dot(pl.xyz, c).add(pl.w).lessThan(r.negate()), () => { inside.assign(int(0)); });
      });
      If(inside.greaterThan(int(0)), () => {
        const slot = atomicAdd(uCounter.element(int(0)), uint(1));
        uOrder.element(slot).assign(instanceIndex);
      });
    });
  })(), n);

  const finalizeNode = compute(Fn(() => {
    // atomicAdd(..., 0) reads the current value (no atomicLoad export in r171).
    uIndirect.element(int(1)).assign(atomicAdd(uCounter.element(int(0)), uint(0)));
  })(), 1);

  const vp = new THREE.Matrix4();
  const fwd = new THREE.Vector3();
  const setPlane = (idx, a, b, c, d) => {
    const inv = 1 / Math.hypot(a, b, c);
    const o = idx * 4;
    planesArr[o] = a * inv; planesArr[o + 1] = b * inv; planesArr[o + 2] = c * inv; planesArr[o + 3] = d * inv;
  };

  return {
    attach(geometry) {
      indirectAttr.array[0] = geometry.getAttribute('position').count; // vertexCount
      geometry.indirect = indirectAttr;
    },
    update(renderer, camera) {
      camera.updateMatrixWorld();
      vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      const m = vp.elements; // column-major: m[col*4 + row]
      const r3 = [m[3], m[7], m[11], m[15]];
      const r0 = [m[0], m[4], m[8], m[12]];
      const r1 = [m[1], m[5], m[9], m[13]];
      setPlane(0, r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]); // left
      setPlane(1, r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]); // right
      setPlane(2, r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]); // bottom
      setPlane(3, r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]); // top
      camera.getWorldDirection(fwd);
      const px = camera.position.x, py = camera.position.y, pz = camera.position.z;
      setPlane(4, fwd.x, fwd.y, fwd.z, -(fwd.x * px + fwd.y * py + fwd.z * pz));

      renderer.compute(resetNode);
      renderer.compute(cullNode);
      renderer.compute(finalizeNode);
    },
  };
}
