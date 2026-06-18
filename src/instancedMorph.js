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

// Attach per-instance attributes from generated scene objects. Scalars are
// packed into vec4s to stay under the 16 vertex-attribute limit.
export function setInstanceAttributes(geometry, objects) {
  const n = objects.length;
  const pos = new Float32Array(n * 3);
  const quat = new Float32Array(n * 4);
  const spinAxis = new Float32Array(n * 3);
  const misc = new Float32Array(n * 4); // spinSpeed, scale, phaseOffset, _
  const color = new Float32Array(n * 3);
  const material = new Float32Array(n * 4); // rough, metal, lightOffset, lightCount
  const lists = new Float32Array(n * 4); // shadowOffset, shadowCount, reflOffset, reflCount

  objects.forEach((o, i) => {
    pos.set(o.pos, i * 3);
    quat.set(o.quat, i * 4);
    spinAxis.set(o.spinAxis, i * 3);
    misc.set([o.spinSpeed, o.scale, o.phase, 0], i * 4);
    color.set(o.color, i * 3);
    material.set([o.rough, o.metal, o.lightOffset, o.lightCount], i * 4);
    lists.set([o.shadowOffset, o.shadowCount, o.reflOffset, o.reflCount], i * 4);
  });

  const ia = (arr, size) => new THREE.InstancedBufferAttribute(arr, size);
  geometry.setAttribute('aInstancePos', ia(pos, 3));
  geometry.setAttribute('aQuat', ia(quat, 4));
  geometry.setAttribute('aSpinAxis', ia(spinAxis, 3));
  geometry.setAttribute('aMisc', ia(misc, 4));
  geometry.setAttribute('aColor', ia(color, 3));
  geometry.setAttribute('aMaterial', ia(material, 4));
  geometry.setAttribute('aLists', ia(lists, 4));
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
