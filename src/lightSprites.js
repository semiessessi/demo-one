import * as THREE from 'three';
import vertexShader from './shaders/sprite.vert.glsl?raw';
import fragmentShader from './shaders/sprite.frag.glsl?raw';

// Billboarded, additively-blended glowing quads, one per light.
export function buildLightSprites(lights, uniforms) {
  const corners = new Float32Array([
    -1, -1, 1, -1, 1, 1,
    -1, -1, 1, 1, -1, 1,
  ]);

  const n = lights.length;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const rad = new Float32Array(n);
  lights.forEach((l, i) => {
    pos.set(l.pos, i * 3);
    col.set(l.color, i * 3);
    rad[i] = l.radius;
  });

  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('aCorner', new THREE.BufferAttribute(corners, 2));
  g.setAttribute('aLightPos', new THREE.InstancedBufferAttribute(pos, 3));
  g.setAttribute('aLightColor', new THREE.InstancedBufferAttribute(col, 3));
  g.setAttribute('aLightRadius', new THREE.InstancedBufferAttribute(rad, 1));
  g.instanceCount = n;

  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(g, material);
  mesh.frustumCulled = false;
  return mesh;
}
