import * as THREE from 'three';

// Wraps one segment (start/end position arrays of equal length) in a
// BufferGeometry and lerps between the endpoints as t goes 0 -> 1.
export class MorphSegment {
  constructor(segment) {
    this.name = segment.name; // solid at t=0
    this.endName = segment.endName; // solid at t=1
    this.start = segment.start;
    this.end = segment.end;

    const count = this.start.length; // floats (numVerts * 3)
    this.current = new Float32Array(count);
    this.current.set(this.start);

    this.geometry = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(this.current, 3);
    this.positionAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.positionAttr);
    // flatShading derives face normals in-shader, so we never recompute them.
  }

  // Write lerped positions for t in [0,1].
  apply(t) {
    const { start, end, current } = this;
    for (let i = 0; i < current.length; i++) {
      current[i] = start[i] + (end[i] - start[i]) * t;
    }
    this.positionAttr.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
  }
}
