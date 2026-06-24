import * as THREE from 'three';

// CPU frustum culling + near→far sort for the instanced morph mesh (the pdx-gfx approach).
// Each frame: test every object's bounding sphere against the camera frustum, sort the visible
// ones near→far (for early-Z), write their ORIGINAL ids into the single per-instance attribute
// (aOrigIndex), and shrink instanceCount so the draw only processes visible instances. The
// vertex shader fetches all per-instance state (transform + material + lists) from data textures
// by aOrigIndex, so culling no longer has to compact + re-upload 7 instanced attribute buffers —
// just this one index buffer.

export function createInstanceCuller(geometry, objects) {
  const n = objects.length;

  const origArr = new Float32Array(n);
  for (let i = 0; i < n; i++) origArr[i] = i;
  geometry.setAttribute('aOrigIndex', new THREE.InstancedBufferAttribute(origArr, 1));
  const origAttr = geometry.getAttribute('aOrigIndex');
  geometry.instanceCount = n; // valid until the first cull() shrinks it

  const centers = objects.map((o) => new THREE.Vector3(o.pos[0], o.pos[1], o.pos[2]));
  const radii = objects.map((o) => o.radius); // max bounding radius (spawn/morph stay within)

  const frustum = new THREE.Frustum();
  const vp = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  // Persistent scratch (no per-frame allocation): per visible slot the object index + squared
  // distance, and an index permutation sorted by distance.
  const cidx = new Int32Array(n);
  const cd2 = new Float64Array(n);
  const cord = new Uint32Array(n);

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
      for (let s = 0; s < vc; s++) origArr[s] = cidx[cord[s]]; // the draw's instance slot -> original object id

      origAttr.needsUpdate = true;
      geometry.instanceCount = vc;
      return vc;
    },
  };
}
