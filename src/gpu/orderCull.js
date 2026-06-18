import * as THREE from 'three/webgpu';

// Frustum cull + near→far order for the WebGPU morph mesh. Mirrors the WebGL CPU
// culler but, instead of compacting attribute buffers, it rewrites the storage
// "order" buffer (draw slot -> global object index) the vertex shader reads, and
// shrinks instanceCount. Uses the 4 side planes (coordinate-system independent)
// plus a behind-camera test, so it's correct for the WebGPU clip space without
// depending on the projection's z range.
export function createOrderCuller(objects, orderArr, orderAttr, geometry) {
  const n = objects.length;
  const cx = new Float64Array(n), cy = new Float64Array(n), cz = new Float64Array(n);
  const rad = new Float64Array(n);
  objects.forEach((o, i) => {
    cx[i] = o.pos[0]; cy[i] = o.pos[1]; cz[i] = o.pos[2]; rad[i] = o.radius;
  });

  const vp = new THREE.Matrix4();
  const fwd = new THREE.Vector3();
  const planes = new Float64Array(16); // 4 side planes (nx,ny,nz,d)
  const order = Array.from({ length: n }, () => ({ i: 0, d2: 0 }));

  const setPlane = (idx, a, b, c, d) => {
    const inv = 1 / Math.hypot(a, b, c);
    const o = idx * 4;
    planes[o] = a * inv; planes[o + 1] = b * inv; planes[o + 2] = c * inv; planes[o + 3] = d * inv;
  };

  return {
    cull(camera) {
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

      camera.getWorldDirection(fwd); // unit forward (-Z world)
      const px = camera.position.x, py = camera.position.y, pz = camera.position.z;

      let vc = 0;
      for (let i = 0; i < n; i++) {
        const X = cx[i], Y = cy[i], Z = cz[i], R = rad[i];
        let inside = true;
        for (let pl = 0; pl < 4; pl++) {
          const b = pl * 4;
          if (planes[b] * X + planes[b + 1] * Y + planes[b + 2] * Z + planes[b + 3] < -R) { inside = false; break; }
        }
        if (!inside) continue;
        const dx = X - px, dy = Y - py, dz = Z - pz;
        if (dx * fwd.x + dy * fwd.y + dz * fwd.z < -R) continue; // behind the camera
        const e = order[vc++];
        e.i = i; e.d2 = dx * dx + dy * dy + dz * dz;
      }
      const vis = order.slice(0, vc).sort((a, b) => a.d2 - b.d2);
      for (let s = 0; s < vc; s++) orderArr[s] = vis[s].i;
      orderAttr.needsUpdate = true;
      geometry.instanceCount = vc;
      return vc;
    },
  };
}
