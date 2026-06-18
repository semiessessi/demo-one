import * as THREE from 'three';
import lib from './shaders/lib.glsl?raw';
import vertexShaderSrc from './shaders/sprite.vert.glsl?raw';
import fragmentShader from './shaders/sprite.frag.glsl?raw';

// lib.glsl (prepended) gives the sprite vertex shader animLightDir + helpers,
// so billboards orbit in lockstep with the lighting in morph.frag.glsl.
const vertexShader = `${lib}\n${vertexShaderSrc}`;

// Billboarded, additively-blended glowing quads, one per light.
export function buildLightSprites(lights, uniforms) {
  // Quad corners as a 3D `position` attribute (z unused) so Three.js derives the
  // vertex count from it.
  const corners = new Float32Array([
    -1, -1, 0, 1, -1, 0, 1, 1, 0,
    -1, -1, 0, 1, 1, 0, -1, 1, 0,
  ]);

  const n = lights.length;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const rad = new Float32Array(n);
  const orb = new Float32Array(n);
  lights.forEach((l, i) => {
    pos.set(l.pos, i * 3);
    col.set(l.color, i * 3);
    rad[i] = l.radius;
    orb[i] = l.orbitRadius;
  });

  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(corners, 3));
  g.setAttribute('aLightPos', new THREE.InstancedBufferAttribute(pos, 3));
  g.setAttribute('aLightColor', new THREE.InstancedBufferAttribute(col, 3));
  g.setAttribute('aLightRadius', new THREE.InstancedBufferAttribute(rad, 1));
  g.setAttribute('aOrbitRadius', new THREE.InstancedBufferAttribute(orb, 1));
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
