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
  // Persistent scratch (no per-frame allocation): per visible slot the object index + squared
  // distance, an index permutation sorted by distance, and the resolved visible-object ids.
  const cidx = new Int32Array(n);
  const cd2 = new Float64Array(n);
  const cord = new Uint32Array(n);
  const visJ = new Int32Array(n);
  const aArr = attrs.map((a) => a.array); // attribute backing stores are stable for this culler's lifetime

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
        cidx[vc] = i; cd2[vc] = dx * dx + dy * dy + dz * dz; vc++;
      }
      for (let k = 0; k < vc; k++) cord[k] = k;
      cord.subarray(0, vc).sort((a, b) => cd2[a] - cd2[b]); // nearest first (early-Z); stable, so equal-distance ties keep ascending id
      for (let s = 0; s < vc; s++) { const j = cidx[cord[s]]; visJ[s] = j; origArr[s] = j; }

      // Compact each attribute near->far into the front of its buffer (backing arrays hoisted).
      for (let a = 0; a < aArr.length; a++) {
        const sz = sizes[a], dst = aArr[a], s0 = src[a];
        for (let s = 0; s < vc; s++) {
          const j = visJ[s], di = s * sz, sj = j * sz;
          for (let k = 0; k < sz; k++) dst[di + k] = s0[sj + k];
        }
      }
      for (const a of attrs) a.needsUpdate = true;
      origAttr.needsUpdate = true;
      geometry.instanceCount = vc;
      return vc;
    },
  };
}
