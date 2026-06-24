// Distance-field volumetric clouds, raymarched. The core march `marchClouds` returns
// premultiplied in-scatter + transmittance bounded by `tMax`, so the caller composites it over
// whatever is behind: the fullscreen CloudPass composites over the rendered scene (tMax = scene
// depth) so clouds sit IN FRONT of geometry; reflections composite over the reflected colour.
// lib.glsl (environment + precision) is prepended before this; ro/rd/time arrive as args so this
// file declares no uTime/cameraPosition and never clashes with the shaders it is pasted into.

uniform float uCloudsOn;      // 0/1 master switch
uniform float uCoverage;      // 0..1 — how much of the band is cloud (threshold)
uniform float uCloudDensity;  // extinction multiplier (opacity)
uniform float uCloudBase;     // band centre altitude (world y)
uniform float uCloudThick;    // band half-thickness
uniform float uCloudNoiseScale; // fbm frequency (smaller = bigger puffs)
uniform vec3  uCloudWind;     // world units/sec the noise field drifts
uniform float uCloudSteps;    // march iteration budget (quality)
uniform vec3  uSunDir;        // moonlight direction (the cloud key light)
uniform vec3  uSunColor;      // moonlight colour * intensity
uniform float uCloudAmbient;  // sky-ambient fill strength
uniform float uCloudHG;       // Henyey-Greenstein anisotropy (forward scatter)
uniform float uCloudPowder;   // 0..1 Beer-Powder dark-edge strength
uniform float uMoonStrength;  // directional moonlight on the SCENE (occluded by clouds) — morph.frag
uniform float uReflCloudSteps; // cloud march steps for reflections — morph.frag (autoscaled)
uniform float uFrame;         // frame counter -> temporal (per-frame) blue-noise dither
// Point lights colouring the cloud volume — cloudLights.js packs the N nearest/brightest band lights
// each frame: texel0 = orbiting world pos + glow reach, texel1 = colour * current emission (so dark
// lights add nothing). The CPU emission bake keeps the amplitude subset dark when quiet.
uniform sampler2D uCloudLightsTex;
uniform int   uCloudLightsTexW;
uniform int   uCloudLightCount;    // lights currently packed (<= 64)
uniform float uCloudLightGain;     // tunable in-scatter strength

// --- value-noise fbm ------------------------------------------------------
float cloudHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float cloudNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(cloudHash(i + vec3(0, 0, 0)), cloudHash(i + vec3(1, 0, 0)), f.x),
                 mix(cloudHash(i + vec3(0, 1, 0)), cloudHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(cloudHash(i + vec3(0, 0, 1)), cloudHash(i + vec3(1, 0, 1)), f.x),
                 mix(cloudHash(i + vec3(0, 1, 1)), cloudHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float cloudFbm(vec3 p, int oct) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { if (i >= oct) break; s += a * cloudNoise(p); p *= 2.02; a *= 0.5; }
  return s;
}

// Henyey-Greenstein phase (forward scattering -> silver lining toward the moon).
// pow(x, 1.5) == x * sqrt(x), exactly, and cheaper than pow's exp2/log2 pair.
float hg(float c, float g) { float g2 = g * g; float b = max(1.0 + g2 - 2.0 * g * c, 1e-4); return (1.0 - g2) / (12.566370614 * b * sqrt(b)); }
// Interleaved-gradient (blue-noise-like) dither, texture-free.
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

// Cloud density at a point: fbm shaped by a soft height gradient, thresholded by coverage.
// `oct`/`ampScale` let the sun/shadow optical-depth march use a cheaper, smoother fbm.
float cloudDensityOct(vec3 p, float time, int oct, float ampScale) {
  float dens = 0.0;
  float h = 1.0 - abs(p.y - uCloudBase) / max(uCloudThick, 1e-3); // 1 centre -> 0 at band edge
  if (h > 0.0) {
    h = smoothstep(0.0, 0.5, h); // feather the top and bottom of the band
    vec3 np = (p + uCloudWind * time) * uCloudNoiseScale;
    dens = clamp(cloudFbm(np, oct) * ampScale * h - (1.0 - uCoverage), 0.0, 1.0) * uCloudDensity;
  }
  return dens;
}
// Full-detail density for the silhouette (4 octaves).
float cloudDensity(vec3 p, float time) { return cloudDensityOct(p, time, 4, 1.0); }
// Cheaper density for the sun/shadow optical depth: Beer's exp smooths away the dropped
// high-frequency octaves, so 2 are visually indistinguishable here. ampScale = 4-octave
// weight-sum / this octave-sum -> the SAME mean optical depth (self-shadow strength unchanged).
#define CLOUD_SHADOW_OCTAVES 3
float cloudDensitySun(vec3 p, float time) {
  return cloudDensityOct(p, time, CLOUD_SHADOW_OCTAVES, 0.9375 / (1.0 - exp2(-float(CLOUD_SHADOW_OCTAVES))));
}

// Cloud shadow for the SCENE: optical depth from a world point up toward the moon through the
// band -> Beer transmittance, so objects dapple under cloud cover (morph.frag moonlight term).
float cloudShadow(vec3 worldPos, vec3 sunDir, float time) {
  if (uCloudsOn < 0.5 || sunDir.y <= 0.01) return 1.0;
  float yLo = uCloudBase - uCloudThick, yHi = uCloudBase + uCloudThick;
  float tA = (yLo - worldPos.y) / sunDir.y, tB = (yHi - worldPos.y) / sunDir.y;
  float t0 = max(min(tA, tB), 0.0), t1 = max(tA, tB);
  if (t1 <= t0) return 1.0; // the up-ray doesn't cross the band
  float dt = (t1 - t0) / 4.0, dens = 0.0;
  for (int i = 0; i < 4; i++) dens += cloudDensitySun(worldPos + sunDir * (t0 + dt * (float(i) + 0.5)), time);
  return exp(-dens * dt * 1.2);
}

// Core march: premultiplied in-scatter (rgb) + transmittance (a), bounded by tMax (depth/hit
// stop). Composite over the background behind via `bg*a + rgb` (see skyCloudsOver).
vec4 marchClouds(vec3 ro, vec3 rd, float time, float tMax, int steps, int lightCap) {
  if (uCloudsOn < 0.5) return vec4(0.0, 0.0, 0.0, 1.0);
  float yLo = uCloudBase - uCloudThick;
  float yHi = uCloudBase + uCloudThick;
  float t0, t1;
  if (abs(rd.y) < 1e-4) {
    if (ro.y < yLo || ro.y > yHi) return vec4(0.0, 0.0, 0.0, 1.0); // parallel to a band it isn't in
    t0 = 0.1; t1 = 180.0;
  } else {
    float ta = (yLo - ro.y) / rd.y;
    float tb = (yHi - ro.y) / rd.y;
    t0 = max(min(ta, tb), 0.0);
    t1 = max(ta, tb);
  }
  t1 = min(t1, min(t0 + 700.0, tMax)); // far range; the geometric step below keeps distant sampling cheap
  if (t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);

  // Distance LOD: a geometric step (fine near, coarser with distance) reaches far with a fixed budget,
  // so distant clouds recede to the horizon instead of capping into a blob near the camera.
  float minStep = max(0.4, 40.0 / float(steps)); // near detail; the step budget sets how far it reaches
  float growth = 1.07;                            // each step a little longer than the last
  float step = minStep;
  float cosT = dot(rd, uSunDir);
  float lightStep = uCloudThick * 0.12;     // world-scale spacing of the sun light-march
  // Per-ray constants, hoisted out of the march (they don't vary per step):
  float phase = 0.35 + 1.4 * hg(cosT, uCloudHG); // isotropic base + forward HG lobe (silver lining)
  vec3 ambient = environment(rd) * uCloudAmbient + 0.03; // sky fill + non-black floor
  float T = 1.0;          // transmittance
  vec3 scat = vec3(0.0);  // accumulated in-scatter (premultiplied)
  float t = t0 + fract(ign(gl_FragCoord.xy) + uFrame * 0.61803399) * minStep; // per-frame blue-noise jitter -> no slice banding/layering
  for (int i = 0; i < 192; i++) {
    if (i >= steps || t >= t1 || T < 0.02) break;
    vec3 p = ro + rd * t;
    float dens = cloudDensity(p, time);
    if (dens <= 0.002) { t += step * 1.6; step *= growth; continue; } // coarse-step empty patches (step keeps growing)
    // 6-tap light-march toward the moon (increasing spacing) -> optical depth to the sun.
    float sunDensity = 0.0;
    for (int j = 1; j <= 6; j++) sunDensity += cloudDensitySun(p + uSunDir * lightStep * float(j), time);
    // Beer octaves of the sun optical depth keep strong self-shadow contrast (form).
    float beer = exp(-sunDensity * 1.2) + 0.45 * exp(-sunDensity * 0.45) + 0.2 * exp(-sunDensity * 0.18);
    vec3 lum = uSunColor * (phase * beer * 1.6);
    lum *= mix(1.0, 1.0 - exp(-dens * 2.0), uCloudPowder); // Beer-Powder: dark thin edges
    vec3 S = lum + ambient;
    // Orbiting sprites scatter coloured light into the volume: each nearby light tints the cloud
    // around it, weighted by its CURRENT emission (baked into the colour) so it's dark when quiet.
    // Skipped for reflections (lightCap = 0); the cheap distance reject keeps empty taps near-free.
    for (int k = 0; k < 64; k++) {
      if (k >= uCloudLightCount || k >= lightCap) break;
      vec4 lp = texelFetch(uCloudLightsTex, texel(k * 2, uCloudLightsTexW), 0);     // pos.xyz, reach
      vec3 dl = lp.xyz - p;
      float dist = length(dl);
      if (dist > lp.w) continue;
      vec4 lc = texelFetch(uCloudLightsTex, texel(k * 2 + 1, uCloudLightsTexW), 0); // premult colour
      float att = clamp(1.0 - dist / lp.w, 0.0, 1.0); att *= att;                   // soft glow lobe
      S += lc.rgb * att * hg(dot(rd, dl / max(dist, 1e-4)), uCloudHG) * uCloudLightGain;
    }
    float dT = exp(-dens * step * 1.5);
    scat += T * (1.0 - dT) * S;
    T *= dT;
    t += step;
    step *= growth; // distance LOD: each step a little longer
  }
  return vec4(scat, T);
}

// Analytic far cloud deck: an infinite cloud-top plane for distant downward rays from ABOVE the band.
// Beyond the volumetric march's reach it carries the cloud deck all the way to the horizon (the near
// march, sharing the same coverage field, composites in front where it has detail). ~1 fbm/pixel.
uniform float uFarDeckOn; // 0/1 toggle
vec4 farCloudDeck(vec3 ro, vec3 rd, float time) {
  if (uCloudsOn < 0.5 || uFarDeckOn < 0.5) return vec4(0.0);
  float yTop = uCloudBase + uCloudThick;
  if (ro.y < yTop || rd.y > -1e-3) return vec4(0.0);            // only from above the deck, looking down
  float tTop = (yTop - ro.y) / rd.y;
  vec3 hit = ro + rd * tTop;
  // Sample the volume's coverage field (at band centre, where it's densest) -> deck opacity, so the
  // analytic deck lines up with the marched band's gaps and puffs.
  vec3 np = (vec3(hit.x, uCloudBase, hit.z) + uCloudWind * time) * uCloudNoiseScale;
  float cov = clamp((cloudFbm(np, 4) - (1.0 - uCoverage)) * 3.0, 0.0, 1.0);
  if (cov <= 0.002) return vec4(0.0);
  float phase = 0.4 + 1.3 * hg(dot(rd, uSunDir), uCloudHG);     // moon key (silver lining)
  vec3 lit = uSunColor * phase * (0.6 + 0.4 * cov) + environment(rd) * uCloudAmbient + 0.03;
  float fog = 1.0 - exp(-tTop * 0.0022);                        // aerial perspective -> dissolves at the horizon
  return vec4(mix(lit, environment(rd), fog), cov * (1.0 - fog * 0.85));
}

// Composite the cloud march over a given background colour (used by reflections).
vec3 skyCloudsOver(vec3 bg, vec3 ro, vec3 rd, float time, float tMax, int steps) {
  vec4 c = marchClouds(ro, rd, time, tMax, steps, 0); // reflections skip the point-light in-scatter
  return bg * c.a + c.rgb;
}
// Unbounded clouds composited over the environment() sky (reflections call this).
vec3 skyClouds(vec3 ro, vec3 rd, float time, int steps) {
  return skyCloudsOver(environment(rd), ro, rd, time, 1e9, steps);
}
