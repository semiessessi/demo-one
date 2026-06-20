import * as THREE from 'three';

// The moon: an additive billboard of the real full-moon photo (public/moon.jpg, the Wikipedia
// FullMoon2010 by Gregory H. Revera, CC BY-SA). Placed in the uSunDir direction (so the disc and the
// moonlight agree), computed from cameraPosition in-shader so it sits at infinity (follows the camera,
// far-plane pinned), and fades in as it rises past the horizon. Rendered into the scene, so the
// fullscreen CloudPass dims it behind clouds and near geometry occludes it.
const MOON_DIST = 130.0; // just inside the stars (135); follows the camera, so the distance is moot

const vertexShader = `
in vec3 position;   // quad corner in [-1,1]
in vec2 uv;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;
uniform vec3 uSunDir;     // moon direction (shared with the cloud moonlight)
uniform float uMoonSize;  // disc half-size at MOON_DIST
out vec2 vUv;
out float vElevY;
void main() {
  vUv = uv;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]); // camera basis from the view matrix
  vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 center = cameraPosition + uSunDir * ${MOON_DIST.toFixed(1)};        // always MOON_DIST from the camera
  vec3 wp = center + (position.x * right + position.y * up) * uMoonSize;   // billboard, faces the camera
  vElevY = normalize(wp - cameraPosition).y; // this corner's elevation (sine) -> per-fragment horizon cut
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  gl_Position.z = gl_Position.w * 0.999999; // far plane: behind objects + dimmed by clouds, never escaped
}`;

const fragmentShader = `
precision highp float;
in vec2 vUv;
in float vElevY;
uniform sampler2D uMoonTex;
uniform vec3 uSunColor; // moonlight colour, so the disc matches the light it casts
out vec4 fragColor;
void main() {
  // The horizon ("ground") cuts the bottom of the disc; a soft fade through the bright horizon-fog
  // band just above it -> the moon emerges OVER the horizon like a real moonrise as uSunDir climbs.
  float vis = smoothstep(0.0, 0.06, vElevY);
  vec3 moon = texture(uMoonTex, vUv).rgb;
  fragColor = vec4(moon * uSunColor * 1.6 * vis, 1.0); // additive: black background + below-horizon drop out
}`;

// Async: loads the moon texture, then resolves to a billboard mesh to add to the scene.
export async function buildMoon(uniforms) {
  const tex = await new THREE.TextureLoader().loadAsync('/moon.jpg');
  tex.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uSunDir: uniforms.uSunDir, uMoonSize: uniforms.uMoonSize,
      uMoonTex: { value: tex }, uSunColor: uniforms.uSunColor,
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true, // occluded by near geometry
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3; // over the gradient dome + stars
  return mesh;
}
