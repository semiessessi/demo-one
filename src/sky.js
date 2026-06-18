import * as THREE from 'three';

// Dark "night" environment gradient (à la pdx-gfx): used both as the background
// skydome and as the reflection fallback in the morph shader. Keep this in sync
// with environment() in morph.frag.glsl.
// pdx-gfx "Night" environment preset (Y-up; horizon glow band).
const ENV_GLSL = `
vec3 environment(vec3 d) {
  vec3 Sky = vec3(0.008, 0.012, 0.035);
  vec3 Horizon = vec3(0.06, 0.08, 0.14);
  vec3 Glow = vec3(0.16, 0.20, 0.30);
  vec3 GroundEdge = vec3(0.035, 0.035, 0.045);
  vec3 Ground = vec3(0.02, 0.02, 0.028);
  float Up = d.y;
  vec3 Base;
  if (Up >= 0.0) Base = mix(Horizon, Sky, pow(clamp(Up, 0.0, 1.0), 0.20));
  else Base = mix(Horizon, mix(GroundEdge, Ground, clamp(-Up, 0.0, 1.0)), pow(clamp(-Up, 0.0, 1.0), 0.30));
  float Band = pow(clamp(1.0 - abs(Up), 0.0, 1.0), 60.0);
  return mix(Base, Glow, Band);
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
