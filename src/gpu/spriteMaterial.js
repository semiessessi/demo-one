// WebGPU light sprites: billboarded, additively-blended glowing quads, one per
// light. Ported from shaders/sprite.vert/frag.glsl. Per-light data lives in
// storage buffers indexed by instanceIndex.
import * as THREE from 'three/webgpu';
import {
  wgslFn, instanceIndex, varying, positionGeometry,
  cameraViewMatrix, cameraProjectionMatrix, float,
} from 'three/tsl';
import { roVec4 } from './storage.js';

// Billboard a quad corner to clip space (camera right/up = rows of the view matrix).
const wgSpriteClip = wgslFn(`
  fn wgSpriteClip(corner: vec3<f32>, lp: vec3<f32>, radius: f32, size: f32,
                  viewM: mat4x4<f32>, projM: mat4x4<f32>) -> vec4<f32> {
    let right = vec3<f32>(viewM[0][0], viewM[1][0], viewM[2][0]);
    let up = vec3<f32>(viewM[0][1], viewM[1][1], viewM[2][1]);
    let s = size * (0.6 + 0.2 * radius);
    let world = lp + s * (corner.x * right + corner.y * up);
    return projM * viewM * vec4<f32>(world, 1.0);
  }
`);

// Glowing point: sharp core + soft halo, white-hot for bright lights. Outside the
// disc returns black (additive blending => contributes nothing, no discard).
const wgSpriteColor = wgslFn(`
  fn wgSpriteColor(corner: vec2<f32>, color: vec3<f32>) -> vec3<f32> {
    let r = length(corner);
    if (r > 1.0) { return vec3<f32>(0.0); }
    let fall = 1.0 - r;
    let core = pow(fall, 8.0);
    let halo = 0.4 * pow(fall, 3.0);
    let intensity = clamp(core + halo, 0.0, 1.0);
    let bright = max(color.r, max(color.g, color.b));
    let hue = color / max(bright, 1e-3);
    let whiteHot = core * clamp(0.4 + 0.8 * bright, 0.0, 1.0);
    let col = mix(hue, vec3<f32>(1.0), whiteHot) * intensity;
    return col * 2.5;
  }
`);

export function buildLightSprites(lights) {
  const n = lights.length;
  const corners = new Float32Array([
    -1, -1, 0, 1, -1, 0, 1, 1, 0,
    -1, -1, 0, 1, 1, 0, -1, 1, 0,
  ]);

  const posRad = new Float32Array(n * 4); // pos.xyz, radius
  const color = new Float32Array(n * 4); // color.rgb, _
  lights.forEach((l, i) => {
    posRad.set([l.pos[0], l.pos[1], l.pos[2], l.radius], i * 4);
    color.set([l.color[0], l.color[1], l.color[2], 0], i * 4);
  });
  const uPosRad = roVec4(posRad);
  const uColor = roVec4(color);

  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(corners, 3));
  g.instanceCount = n;

  const SIZE = float(0.16);
  const lpr = uPosRad.element(instanceIndex);
  const vCorner = varying(positionGeometry.xy);
  const vColor = varying(uColor.element(instanceIndex).xyz);

  const material = new THREE.MeshBasicNodeMaterial();
  material.transparent = true;
  material.blending = THREE.AdditiveBlending;
  material.depthWrite = false;
  material.name = 'sprites';
  material.vertexNode = wgSpriteClip(
    positionGeometry, lpr.xyz, lpr.w, SIZE, cameraViewMatrix, cameraProjectionMatrix,
  );
  material.colorNode = wgSpriteColor(vCorner, vColor);

  const mesh = new THREE.Mesh(g, material);
  mesh.frustumCulled = false;
  return mesh;
}
