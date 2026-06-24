import * as THREE from 'three';
import lib from './shaders/lib.glsl?raw';
import vertexShaderSrc from './shaders/morph.vert.glsl?raw';
import fragmentShaderSrc from './shaders/morph.frag.glsl?raw';
import clouds from './shaders/clouds.glsl?raw';
import ocean from './shaders/ocean.glsl?raw';
import { buildJourneySegments, NUM_SEGMENTS } from './journey.js';

const vertexShader = `${lib}\n${vertexShaderSrc}`;
// clouds.glsl gives the fragment skyClouds(); ocean.glsl gives oceanShade() so downward reflection
// rays show the SAME sea (FFT waves, foam, Atlas lighting) as on screen.
const fragmentShader = `${lib}\n${clouds}\n${ocean}\n${fragmentShaderSrc}`;

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

// Per-instance state (transform, material, light/shadow/reflection lists) is no longer stored
// as instanced attributes — the vertex shader fetches it from the shared occluder-transform +
// instance data textures by aOrigIndex (see cpuCull.js / morph.vert.glsl). Only aOrigIndex is a
// per-instance attribute now, created + updated by the culler.

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
