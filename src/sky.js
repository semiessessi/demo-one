import * as THREE from 'three';

// Dark "night" environment gradient (à la pdx-gfx): used both as the background
// skydome and as the reflection fallback in the morph shader. Keep this in sync
// with environment() in morph.frag.glsl.
const ENV_GLSL = `
vec3 environment(vec3 d) {
  float t = d.y * 0.5 + 0.5;
  vec3 lower = vec3(0.008, 0.009, 0.013);
  vec3 horizon = vec3(0.045, 0.050, 0.065);
  vec3 upper = vec3(0.015, 0.022, 0.045);
  return mix(mix(lower, horizon, smoothstep(0.0, 0.5, t)),
             upper, smoothstep(0.5, 1.0, t));
}`;

const vertexShader = `precision highp float;
in vec3 position;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
out vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`;

const fragmentShader = `precision highp float;
in vec3 vDir;
out vec4 fragColor;
${ENV_GLSL}
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
    }),
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}
