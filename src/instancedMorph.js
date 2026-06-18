import * as THREE from 'three';
import vertexShader from './shaders/morph.vert.glsl?raw';
import fragmentShader from './shaders/morph.frag.glsl?raw';
import { buildJourneySegments, NUM_SEGMENTS } from './journey.js';

// One InstancedBufferGeometry holding every segment's triangles concatenated.
// `position` = each vertex's start position, `aEnd` = its end position, and
// `aSegment` tags which journey segment it belongs to. The vertex shader keeps
// only the active segment's vertices and collapses the rest.
export function buildUnifiedGeometry() {
  const segments = buildJourneySegments();
  let totalVerts = 0;
  for (const s of segments) totalVerts += s.start.length / 3;

  const start = new Float32Array(totalVerts * 3);
  const end = new Float32Array(totalVerts * 3);
  const segId = new Float32Array(totalVerts);

  let v = 0;
  segments.forEach((s, si) => {
    const n = s.start.length / 3;
    start.set(s.start, v * 3);
    end.set(s.end, v * 3);
    for (let i = 0; i < n; i++) segId[v + i] = si;
    v += n;
  });

  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(start, 3));
  g.setAttribute('aEnd', new THREE.BufferAttribute(end, 3));
  g.setAttribute('aSegment', new THREE.BufferAttribute(segId, 1));
  return g;
}

// Attach per-instance attributes from generated scene objects.
export function setInstanceAttributes(geometry, objects) {
  const n = objects.length;
  const pos = new Float32Array(n * 3);
  const quat = new Float32Array(n * 4);
  const spinAxis = new Float32Array(n * 3);
  const spinSpeed = new Float32Array(n);
  const scale = new Float32Array(n);
  const phase = new Float32Array(n);
  const color = new Float32Array(n * 3);
  const rough = new Float32Array(n);
  const metal = new Float32Array(n);
  const lightOffset = new Float32Array(n);
  const lightCount = new Float32Array(n);
  const shadowOffset = new Float32Array(n);
  const shadowCount = new Float32Array(n);

  objects.forEach((o, i) => {
    pos.set(o.pos, i * 3);
    quat.set(o.quat, i * 4);
    spinAxis.set(o.spinAxis, i * 3);
    spinSpeed[i] = o.spinSpeed;
    scale[i] = o.scale;
    phase[i] = o.phase;
    color.set(o.color, i * 3);
    rough[i] = o.rough;
    metal[i] = o.metal;
    lightOffset[i] = o.lightOffset;
    lightCount[i] = o.lightCount;
    shadowOffset[i] = o.shadowOffset;
    shadowCount[i] = o.shadowCount;
  });

  const ia = (arr, size) => new THREE.InstancedBufferAttribute(arr, size);
  geometry.setAttribute('aInstancePos', ia(pos, 3));
  geometry.setAttribute('aQuat', ia(quat, 4));
  geometry.setAttribute('aSpinAxis', ia(spinAxis, 3));
  geometry.setAttribute('aSpinSpeed', ia(spinSpeed, 1));
  geometry.setAttribute('aScale', ia(scale, 1));
  geometry.setAttribute('aPhaseOffset', ia(phase, 1));
  geometry.setAttribute('aColor', ia(color, 3));
  geometry.setAttribute('aRough', ia(rough, 1));
  geometry.setAttribute('aMetal', ia(metal, 1));
  geometry.setAttribute('aLightOffset', ia(lightOffset, 1));
  geometry.setAttribute('aLightCount', ia(lightCount, 1));
  geometry.setAttribute('aShadowOffset', ia(shadowOffset, 1));
  geometry.setAttribute('aShadowCount', ia(shadowCount, 1));
  geometry.instanceCount = n;
}

export function buildMorphMaterial(uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader,
    uniforms,
    side: THREE.DoubleSide,
  });
}

export { NUM_SEGMENTS };
