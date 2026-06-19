import * as THREE from 'three';

// Real-star background from the Bright Star Catalog (src/stars.json, built by
// scripts/buildStars.mjs). Additive billboard points on a large celestial sphere, brighter +
// bigger for lower magnitudes, tinted by B-V colour, gently twinkling. Rendered into the scene
// (depth-tested behind objects) so the fullscreen CloudPass dims them where the cloud is thick.
const STAR_RADIUS = 135.0; // inside the gradient dome (140); large vs the scene so parallax is tiny.

const vertexShader = `
in vec3 position;   // unit direction on the celestial sphere
in float aMag;      // visual magnitude (lower = brighter)
in vec3 aColor;     // star colour (B-V -> RGB)
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform float uTime;
uniform float uStarSize;
uniform float uStarTwinkle;
out vec3 vColor;
out float vBright;
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
void main() {
  // brighter stars -> bigger + brighter; clamp the huge magnitude dynamic range.
  float b = clamp(pow(2.0, (5.5 - aMag) * 0.5), 0.35, 6.0);
  float tw = 1.0 + uStarTwinkle * sin(uTime * 3.0 + hash11(aMag + position.x * 131.0) * 6.2831);
  gl_Position = projectionMatrix * viewMatrix * vec4(position * ${STAR_RADIUS.toFixed(1)}, 1.0);
  gl_PointSize = max(1.0, uStarSize * b * tw);
  vColor = aColor;
  vBright = b * tw;
}`;

const fragmentShader = `
precision highp float;
in vec3 vColor;
in float vBright;
out vec4 fragColor;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float a = pow(1.0 - r, 2.0); // soft round falloff
  fragColor = vec4(vColor * a * min(vBright, 3.0), 1.0); // additive
}`;

// Async: dynamically imports the ~400 KB catalogue so it's code-split out of the main bundle
// (keeps first paint fast). Resolves to a THREE.Points to add to the scene.
export async function buildStarfield(uniforms) {
  const stars = (await import('./stars.json')).default;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(stars.pos, 3));
  g.setAttribute('aMag', new THREE.Float32BufferAttribute(stars.mag, 1));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(stars.col, 3));
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true, // occluded by near geometry
  });
  const points = new THREE.Points(g, material);
  points.frustumCulled = false;
  points.renderOrder = 2; // over the gradient dome (renderOrder 1), behind nothing
  return points;
}
