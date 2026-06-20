import * as THREE from 'three';
import lib from './shaders/lib.glsl?raw';

// Background skydome: just the shared environment() (pdx night) gradient. Volumetric clouds are
// now a fullscreen depth-composited pass (backends/webgl.js CloudPass) that composites OVER this
// gradient (and the scene), so the dome is only the backdrop the cloud pass sees behind everything.
const vertexShader = `${lib}
in vec3 position;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
out vec3 vWorldPos;
void main() {
  // The dome follows the camera (mesh.position = camera.position), so the gradient is at infinity and
  // can never be escaped/seen from outside; pin it to the far plane so it never occludes geometry.
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w * 0.999999; // far plane (behind everything), regardless of radius
}`;

const fragmentShader = `${lib}
in vec3 vWorldPos;
out vec4 fragColor;
uniform vec3 cameraPosition; // auto-provided by three for (Raw)ShaderMaterials
void main() { fragColor = vec4(environment(normalize(vWorldPos - cameraPosition)), 1.0); }`;

export function buildSky() {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(140, 32, 16),
    new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true, // only fill pixels the opaque geometry didn't cover
    }),
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = 1; // after opaque objects, before transparent sprites
  return mesh;
}
