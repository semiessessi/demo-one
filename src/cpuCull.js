import * as THREE from 'three';

// CPU frustum culling + near→far compaction for the instanced morph mesh (the
// pdx-gfx approach). Each frame: test every object's bounding sphere against the
// camera frustum, gather the visible ones sorted near→far (for early-Z) into the
// front of the instanced attribute buffers, and shrink instanceCount so the draw
// only processes visible instances. aOrigIndex carries each instance's original
// id so the spawn-in stagger stays stable under reordering.
const ATTRS = ['aInstancePos', 'aQuat', 'aSpinAxis', 'aMisc', 'aColor', 'aMaterial', 'aLists'];

export function createInstanceCuller(geometry, objects) {
  const n = objects.length;
  const attrs = ATTRS.map((name) => geometry.getAttribute(name));
  const src = attrs.map((a) => a.array.slice()); // immutable source (unculled) copy
  const sizes = attrs.map((a) => a.itemSize);

  const origArr = new Float32Array(n);
  for (let i = 0; i < n; i++) origArr[i] = i;
  geometry.setAttribute('aOrigIndex', new THREE.InstancedBufferAttribute(origArr, 1));
  const origAttr = geometry.getAttribute('aOrigIndex');

  const centers = objects.map((o) => new THREE.Vector3(o.pos[0], o.pos[1], o.pos[2]));
  const radii = objects.map((o) => o.radius); // max bounding radius (spawn/morph stay within)

  const frustum = new THREE.Frustum();
  const vp = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const order = Array.from({ length: n }, () => ({ i: 0, d2: 0 }));

  return {
    // Returns the visible instance count (for stats).
    cull(camera) {
      camera.updateMatrixWorld();
      vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(vp);
      const cp = camera.position;

      let vc = 0;
      for (let i = 0; i < n; i++) {
        sphere.center.copy(centers[i]);
        sphere.radius = radii[i];
        if (!frustum.intersectsSphere(sphere)) continue;
        const dx = centers[i].x - cp.x, dy = centers[i].y - cp.y, dz = centers[i].z - cp.z;
        const e = order[vc++];
        e.i = i; e.d2 = dx * dx + dy * dy + dz * dz;
      }
      const vis = order.slice(0, vc).sort((a, b) => a.d2 - b.d2);

      for (let s = 0; s < vc; s++) {
        const j = vis[s].i;
        for (let a = 0; a < attrs.length; a++) {
          const sz = sizes[a], dst = attrs[a].array, s0 = src[a];
          const di = s * sz, sj = j * sz;
          for (let k = 0; k < sz; k++) dst[di + k] = s0[sj + k];
        }
        origArr[s] = j;
      }
      for (const a of attrs) a.needsUpdate = true;
      origAttr.needsUpdate = true;
      geometry.instanceCount = vc;
      return vc;
    },
  };
}
