// Distance-field volumetric clouds, raymarched. Shared by the sky dome (sky.js)
// and the reflection sky-miss path (morph.frag.glsl), so reflections show the very
// same clouds as the sky. lib.glsl (which defines environment()) is prepended
// before this file; ro / rd / time arrive as arguments, so this file declares no
// uTime / cameraPosition and never clashes with the shaders it is pasted into.
//
// Technique (per the references):
//   - An analytic slab is the bounding distance field: a ray-slab intersection
//     skips everything outside the cloud band, and we coarse-step empty patches
//     inside it (the cheap "step further when there's nothing here" idea from
//     uhawkvr's SDF clouds — without the precomputed 3D SDF texture, a follow-on).
//   - fbm value noise is the density inside the band (IQ dynclouds), lit cheaply by
//     a couple of taps up the key-light ray (Beer's law self-shadowing).
//   - The vortex is IQ's opTwist: rotate the xz domain by an angle that grows with
//     height, so raising uVortex swirls the band into a funnel.

uniform float uCloudsOn;      // 0/1 master switch
uniform float uCoverage;      // 0..1 — how much of the band is cloud (threshold)
uniform float uCloudDensity;  // extinction multiplier (opacity)
uniform float uCloudBase;     // band centre altitude (world y)
uniform float uCloudThick;    // band half-thickness
uniform float uCloudNoiseScale; // fbm frequency (smaller = bigger puffs)
uniform vec3  uCloudWind;     // world units/sec the noise field drifts
uniform float uVortex;        // 0 = flat band, 1 = full swirl
uniform float uVortexTwist;   // radians of twist per world unit of height
uniform float uCloudSteps;    // march iteration budget (quality)

const vec2 VORTEX_AXIS = vec2(0.0); // xz of the vortex centre (over the scene)
const vec3 CLOUD_LIT  = vec3(0.22, 0.25, 0.32); // lit face — dim + cool for the night palette
const vec3 CLOUD_DARK = vec3(0.015, 0.025, 0.05); // self-shadowed core (close to the sky)

// --- value-noise fbm (IQ) --------------------------------------------------
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
float cloudFbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * cloudNoise(p); p *= 2.02; a *= 0.5; }
  return s;
}

// IQ opTwist: rotate xz about the vortex axis by an angle that grows with height.
vec3 cloudTwist(vec3 p) {
  if (uVortex <= 0.0) return p;
  vec2 q = p.xz - VORTEX_AXIS;
  float ang = uVortex * (p.y - uCloudBase) * uVortexTwist;
  float c = cos(ang), s = sin(ang);
  vec2 r = mat2(c, -s, s, c) * q + VORTEX_AXIS;
  return vec3(r.x, p.y, r.y);
}

// Cloud density at a point: fbm shaped by a soft height gradient, thresholded by
// coverage. 0 = clear sky, up to uCloudDensity = thick cloud.
float cloudDensity(vec3 p, float time) {
  float h = 1.0 - abs(p.y - uCloudBase) / max(uCloudThick, 1e-3); // 1 centre -> 0 at band edge
  if (h <= 0.0) return 0.0;
  h = smoothstep(0.0, 0.5, h); // feather the top and bottom of the band
  vec3 q = cloudTwist(p);
  vec3 np = (q + uCloudWind * time) * uCloudNoiseScale;
  float shape = cloudFbm(np) * h - (1.0 - uCoverage);
  return clamp(shape, 0.0, 1.0) * uCloudDensity;
}

// Raymarch the band along the ray and composite over the environment() sky.
vec3 skyClouds(vec3 ro, vec3 rd, float time, int steps) {
  vec3 bg = environment(rd);
  if (uCloudsOn < 0.5) return bg;

  // Ray-slab intersection = the analytic bounding distance field: clip the march to
  // where the ray actually crosses the [base +/- thick] band.
  float yLo = uCloudBase - uCloudThick;
  float yHi = uCloudBase + uCloudThick;
  float t0, t1;
  if (abs(rd.y) < 1e-4) {
    if (ro.y < yLo || ro.y > yHi) return bg; // parallel to a band it isn't in
    t0 = 0.1; t1 = 180.0;
  } else {
    float ta = (yLo - ro.y) / rd.y;
    float tb = (yHi - ro.y) / rd.y;
    t0 = max(min(ta, tb), 0.0);
    t1 = max(ta, tb);
  }
  if (t1 <= t0) return bg;
  t1 = min(t1, t0 + 200.0); // cap the march length

  float baseStep = (t1 - t0) / float(steps);
  vec3 sunDir = normalize(vec3(0.35, 0.85, 0.25)); // key light, for self-shadowing
  float T = 1.0;          // transmittance
  vec3 scat = vec3(0.0);  // accumulated in-scatter (premultiplied)
  float t = t0;
  for (int i = 0; i < 160; i++) {
    if (i >= steps || t >= t1 || T < 0.02) break;
    vec3 p = ro + rd * t;
    float dens = cloudDensity(p, time);
    if (dens <= 0.002) { t += baseStep * 1.5; continue; } // coarse-step empty patches
    // toward-light Beer self-shadow: two short taps up the sun ray.
    float ls = cloudDensity(p + sunDir * 2.0, time) + 0.5 * cloudDensity(p + sunDir * 5.0, time);
    float sun = exp(-ls * 1.6);
    vec3 col = mix(CLOUD_DARK, CLOUD_LIT, sun) + bg * 0.45; // sit in the local sky colour
    float dT = exp(-dens * baseStep * 1.5);
    scat += T * (1.0 - dT) * col;
    T *= dT;
    t += baseStep;
  }
  return bg * T + scat;
}
