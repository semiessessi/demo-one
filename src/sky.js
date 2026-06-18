import * as THREE from 'three';
import lib from './shaders/lib.glsl?raw';

// Background skydome that shows the shared environment() (pdx night) gradient.
const vertexShader = `${lib}
in vec3 position;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
out vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`;

const fragmentShader = `${lib}
in vec3 vDir;
out vec4 fragColor;
void main() { fragColor = vec4(environment(normalize(vDir)), 1.0); }`;

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
  // Render after the opaque objects (renderOrder 0) but before the transparent
  // sprites, so the sky only shades the gaps instead of the whole screen.
  mesh.renderOrder = 1;
  return mesh;
}
