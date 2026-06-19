import * as THREE from 'three';
import lib from './shaders/lib.glsl?raw';
import clouds from './shaders/clouds.glsl?raw';

// Background skydome: the shared environment() (pdx night) gradient with raymarched
// volumetric clouds composited on top (clouds.glsl). The dome sits at the origin and
// the camera flies inside it, so each fragment's world position gives the per-pixel
// view ray (ro = cameraPosition, rd = worldPos - cameraPosition). The same skyClouds()
// feeds object reflections in morph.frag.glsl, so reflections show the very same sky.
const vertexShader = `${lib}
in vec3 position;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
out vec3 vWorldPos;
void main() {
  vWorldPos = position; // dome is at the origin, so local position == world position
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`;

const fragmentShader = `${lib}
${clouds}
in vec3 vWorldPos;
out vec4 fragColor;
uniform vec3 cameraPosition; // auto-provided by three for (Raw)ShaderMaterials
uniform float uTime;
void main() {
  vec3 rd = normalize(vWorldPos - cameraPosition);
  fragColor = vec4(skyClouds(cameraPosition, rd, uTime, int(uCloudSteps)), 1.0);
}`;

// `uniforms` holds uTime + the cloud-shaping uniforms (shared with the morph material
// so the sky and reflected sky stay identical).
export function buildSky(uniforms) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(140, 32, 16),
    new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms,
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
