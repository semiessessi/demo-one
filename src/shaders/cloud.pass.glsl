// Fullscreen cloud pass: reconstruct each pixel's world ray from the camera, read the scene
// depth, raymarch the cloud volume from the camera UP TO that depth, and composite the clouds in
// front of the scene colour. lib.glsl + clouds.glsl are prepended (environment + marchClouds +
// the cloud uniforms). Paired with the trivial fullscreen vertex shader in webgl.js.

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D tColor;  // rendered scene colour
uniform sampler2D tDepth;  // rendered scene depth (window depth 0..1)
uniform mat4 uInvProj;     // camera.projectionMatrixInverse
uniform mat4 uCamWorld;    // camera.matrixWorld
uniform vec3 uCamPos;      // camera world position
uniform float uCamNear;
uniform float uCamFar;
uniform float uTime;
uniform int uCloudLightCap; // FPS-autoscaled per-step cloud-light budget (0 disables in-scatter)

// window depth [0,1] -> view-space Z (negative), for a perspective camera.
float viewZFromDepth(float d) {
  return (uCamNear * uCamFar) / ((uCamFar - uCamNear) * d - uCamFar);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 vh = uInvProj * vec4(ndc, 1.0, 1.0);
  vec3 viewDir = vh.xyz / vh.w;                       // view-space ray direction (z < 0)
  vec3 rd = normalize((uCamWorld * vec4(viewDir, 0.0)).xyz);

  float d = texture(tDepth, vUv).x;
  float sceneDist;
  if (d >= 1.0) {
    sceneDist = 1e6;                                  // background — let the band / far-range cap govern,
                                                       // NOT the 300u far plane (so distant clouds reach the horizon)
  } else {
    float vz = viewZFromDepth(d);                     // negative
    vec3 viewPos = viewDir * (vz / viewDir.z);        // view-space position of this fragment
    sceneDist = length(viewPos);                      // = world distance from the camera
  }

  vec3 sceneCol = texture(tColor, vUv).rgb;
  // The skybox "ground" is an ocean: on downward background rays, replace the sky-dome backdrop with
  // the wavy reflective sea; the clouds then composite IN FRONT (they sit above the ocean). Keep the
  // bright light sprites drawn over it (they're foreground glows), but let the dim starfield be
  // covered by the water (stars belong in the sky + the reflection, not on the surface).
  if (d >= 1.0 && uOceanOn > 0.5 && rd.y < -0.001) {
    vec3 ocn = ocean(uCamPos, rd, uTime, vUv);
    vec3 sky = environment(rd);
    float fg = clamp((max(max(sceneCol.r, sceneCol.g), sceneCol.b)
                      - max(max(sky.r, sky.g), sky.b) - 0.12) * 5.0, 0.0, 1.0); // bright sprites -> 1, dim stars -> 0
    sceneCol = mix(ocn, sceneCol, fg);
  }
  // Analytic far cloud deck (infinite cloud top) over the background, BEHIND the near volumetric march
  // (which composites in front where it has detail). Carries the deck to the horizon from above.
  if (d >= 1.0) {
    vec4 deck = farCloudDeck(uCamPos, rd, uTime);
    sceneCol = mix(sceneCol, deck.rgb, deck.a);
  }
  vec4 c = marchClouds(uCamPos, rd, uTime, sceneDist, int(uCloudSteps), uCloudLightCap);
  fragColor = vec4(sceneCol * c.a + c.rgb, 1.0);
}
