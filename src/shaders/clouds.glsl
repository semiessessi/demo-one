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
uniform float uVortex;        // 0 = flat band, 1 = full swirl
uniform float uVortexTwist;   // radians of twist per world unit of height
uniform float uCloudSteps;    // march iteration budget (quality)
uniform vec3  uSunDir;        // moonlight direction (the cloud key light)
uniform vec3  uSunColor;      // moonlight colour * intensity
uniform float uCloudAmbient;  // sky-ambient fill strength
uniform float uCloudHG;       // Henyey-Greenstein anisotropy (forward scatter)
uniform float uCloudPowder;   // 0..1 Beer-Powder dark-edge strength
uniform float uMoonStrength;  // directional moonlight on the SCENE (occluded by clouds) — morph.frag
uniform float uReflCloudSteps; // cloud march steps for reflections — morph.frag (autoscaled)
uniform float uFrame;         // frame counter -> temporal (per-frame) blue-noise dither
uniform float uCloudLightStrength; // topmost-lights cloud glow strength (base * music pulse, set on CPU)
uniform int   uCloudLightCount;    // how many topmost lights scatter into the volume (autoscaled)
uniform vec4  uCloudLightPos[16];  // xyz = world position (static orbit centre), w = per-light brightness
uniform vec3  uCloudLightColor[16];// per-light colour

const vec2 VORTEX_AXIS = vec2(0.0); // xz of the vortex centre (over the scene)

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
float cloudFbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * cloudNoise(p); p *= 2.02; a *= 0.5; }
  return s;
}

// Henyey-Greenstein phase (forward scattering -> silver lining toward the moon).
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566370614 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
// Interleaved-gradient (blue-noise-like) dither, texture-free.
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

const float VORTEX_FUNNEL_H = 35.0; // how far the vortex funnel rises above the band into clear sky

// Vortex: rotate xz about the axis by an angle that tightens toward the centre (bounded ~1/r),
// winds with height, and spins over time -> a swirling funnel, not a gentle barber-pole twist.
vec3 cloudTwist(vec3 p, float time) {
  if (uVortex <= 0.0) return p;
  vec2 q = p.xz - VORTEX_AXIS;
  float r = length(q);
  float ang = uVortex * (uVortexTwist * (p.y - uCloudBase) + time * 0.6 + 7.0 / (r + 1.5));
  float c = cos(ang), s = sin(ang);
  vec2 rot = mat2(c, -s, s, c) * q + VORTEX_AXIS;
  return vec3(rot.x, p.y, rot.y);
}

// Cloud density at a point: fbm shaped by a soft height gradient, thresholded by coverage. With the
// vortex on: a clear eye + spiral arms in the band, plus a tapering swirling funnel rising above it.
float cloudDensity(vec3 p, float time) {
  float dens = 0.0;
  float h = 1.0 - abs(p.y - uCloudBase) / max(uCloudThick, 1e-3); // 1 centre -> 0 at band edge
  if (h > 0.0) {
    h = smoothstep(0.0, 0.5, h); // feather the top and bottom of the band
    vec3 q = cloudTwist(p, time);
    vec3 np = (q + uCloudWind * time) * uCloudNoiseScale;
    dens = clamp(cloudFbm(np) * h - (1.0 - uCoverage), 0.0, 1.0) * uCloudDensity;
  }
  if (uVortex <= 0.0) return dens;

  vec2 qv = p.xz - VORTEX_AXIS;
  float rr = length(qv);
  float theta = atan(qv.y, qv.x);
  // In-band: clear conical eye + 2-arm log-spiral arms winding into it (the whirlpool base).
  if (h > 0.0) {
    float eyeR = 2.0 + max(p.y - (uCloudBase - uCloudThick), 0.0) * 0.25;
    dens *= mix(1.0, smoothstep(eyeR - 1.5, eyeR + 5.0, rr), uVortex);
    float spiral = cos(2.0 * theta - log(rr + 1.0) * 5.0 - time * 0.8);
    dens += uVortex * smoothstep(0.2, 0.85, spiral) * exp(-rr * 0.05) * smoothstep(eyeR, eyeR + 4.0, rr) * uCloudDensity * 1.5;
  }
  // Funnel rising ABOVE the band into clear sky: a tapering, swirling, wispy column (the visible spout).
  float funnelTop = uCloudBase + uCloudThick + VORTEX_FUNNEL_H;
  if (p.y > uCloudBase && p.y < funnelTop) {
    float hf = (p.y - uCloudBase) / (funnelTop - uCloudBase); // 0 at band centre -> 1 at the tip
    float funnelR = mix(10.0, 1.5, smoothstep(0.0, 1.0, hf)); // wide at the deck, tapering up
    float core = smoothstep(funnelR, funnelR * 0.35, rr); // 1 in the core, 0 at the wall (robust as it narrows)
    if (core > 0.001) {
      float wisp = 0.55 + 0.6 * cloudFbm((p + uCloudWind * time) * uCloudNoiseScale * 1.6); // break the column into cloud
      float swirl = 0.7 + 0.3 * cos(3.0 * theta - hf * 26.0 - time * 1.6); // swirling bands up the funnel
      float taper = smoothstep(1.0, 0.72, hf); // solid most of the way, fading to the tip
      dens = max(dens, uVortex * core * swirl * wisp * taper * uCloudDensity * 5.0);
    }
  }
  return dens;
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
  for (int i = 0; i < 4; i++) dens += cloudDensity(worldPos + sunDir * (t0 + dt * (float(i) + 0.5)), time);
  return exp(-dens * dt * 1.2);
}

// Core march: premultiplied in-scatter (rgb) + transmittance (a), bounded by tMax (depth/hit
// stop). Composite over the background behind via `bg*a + rgb` (see skyCloudsOver).
vec4 marchClouds(vec3 ro, vec3 rd, float time, float tMax, int steps) {
  if (uCloudsOn < 0.5) return vec4(0.0, 0.0, 0.0, 1.0);
  float yLo = uCloudBase - uCloudThick;
  float yHi = uCloudBase + uCloudThick + (uVortex > 0.0 ? VORTEX_FUNNEL_H : 0.0); // extend up for the funnel
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
  t1 = min(t1, min(t0 + 200.0, tMax)); // cap by march length AND the depth/hit stop
  if (t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);

  float baseStep = (t1 - t0) / float(steps);
  float cosT = dot(rd, uSunDir);
  float lightStep = uCloudThick * 0.12;     // world-scale spacing of the sun light-march
  float T = 1.0;          // transmittance
  vec3 scat = vec3(0.0);  // accumulated in-scatter (premultiplied)
  float t = t0 + fract(ign(gl_FragCoord.xy) + uFrame * 0.61803399) * baseStep; // per-frame blue-noise jitter -> no slice banding/layering
  for (int i = 0; i < 192; i++) {
    if (i >= steps || t >= t1 || T < 0.02) break;
    vec3 p = ro + rd * t;
    float dens = cloudDensity(p, time);
    if (dens <= 0.002) { t += baseStep * 1.5; continue; } // coarse-step empty patches
    // 6-tap light-march toward the moon (increasing spacing) -> optical depth to the sun.
    float sunDensity = 0.0;
    for (int j = 1; j <= 6; j++) sunDensity += cloudDensity(p + uSunDir * lightStep * float(j), time);
    // Phase: an isotropic base + a forward HG lobe (silver lining), so the cloud is lit from ALL
    // angles, not just looking toward the moon. Beer octaves keep strong self-shadow contrast (form).
    float phase = 0.35 + 1.4 * hg(cosT, uCloudHG);
    float beer = exp(-sunDensity * 1.2) + 0.45 * exp(-sunDensity * 0.45) + 0.2 * exp(-sunDensity * 0.18);
    vec3 lum = uSunColor * (phase * beer * 1.6);
    lum *= mix(1.0, 1.0 - exp(-dens * 2.0), uCloudPowder); // Beer-Powder: dark thin edges
    vec3 S = lum + environment(rd) * uCloudAmbient + 0.03; // sky ambient + non-black floor
    // Topmost orbiting lights scatter into the volume: a soft coloured glow near the lit objects up
    // in the band, pulsing with the music (uCloudLightStrength). Objects don't translate, so the
    // orbit centres are static and orbit radius << cloud scale -> no per-sample orbit math needed.
    for (int k = 0; k < 16; k++) {
      if (k >= uCloudLightCount) break;
      vec3 dl = uCloudLightPos[k].xyz - p;
      float d2 = dot(dl, dl);
      float fwd = 0.35 + 0.9 * max(dot(rd, dl * inversesqrt(max(d2, 1e-4))), 0.0); // brightest looking toward the light
      S += uCloudLightColor[k] * (uCloudLightPos[k].w * uCloudLightStrength * fwd / (1.0 + d2 * 0.12));
    }
    float dT = exp(-dens * baseStep * 1.5);
    scat += T * (1.0 - dT) * S;
    T *= dT;
    t += baseStep;
  }
  return vec4(scat, T);
}

// Composite the cloud march over a given background colour (used by reflections).
vec3 skyCloudsOver(vec3 bg, vec3 ro, vec3 rd, float time, float tMax, int steps) {
  vec4 c = marchClouds(ro, rd, time, tMax, steps);
  return bg * c.a + c.rgb;
}
// Unbounded clouds composited over the environment() sky (reflections call this).
vec3 skyClouds(vec3 ro, vec3 rd, float time, int steps) {
  return skyCloudsOver(environment(rd), ro, rd, time, 1e9, steps);
}
