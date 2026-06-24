// Analytic ocean for the skybox "ground": a wavy, reflective sea plane at uOceanY seen on downward
// rays. Height is an FBM of EXPONENTIAL-SINE waves (exp(steep·sinφ − steep) -> sharp crests) with
// domain warping and golden-angle directions (Acerola's GarrettGunnell/Water, a cheap FFT stand-in).
// Each octave also carries a Gerstner horizontal displacement whose JACOBIAN we accumulate: where it
// folds/compresses (det J < 1) the wave is pinching into a whitecap -> physically-placed foam, no
// noise texture. Lighting: Fresnel reflection (sky+stars+clouds+planar) + GGX moon glints + subsurface
// scatter through the crests. Prepended after lib.glsl + clouds.glsl.

uniform float uOceanOn;     // 0/1 master switch
uniform float uOceanY;      // plane altitude (world y)
uniform vec3  uOceanColor;  // deep-water tint
uniform vec3  uOceanScatter;// subsurface-scatter colour (water body glow)
uniform float uOceanScatterAmt; // multiple-scattering strength (fills the water with colour)
uniform float uOceanFog;    // aerial-perspective fade into the horizon (per world unit)
uniform float uOceanWave;   // wave steepness scale
uniform float uOceanFreq;   // base wave frequency (bigger = shorter, choppier waves)
uniform float uOceanFoam;   // foam amount on the folds
uniform float uOceanFoamThresh; // Jacobian level below which foam forms (1 = flat, <1 = pinching)
uniform float uOceanCrestFoam;  // a little foam that always rides the wave crests (height-based)
uniform float uOceanDisp;       // on-screen heightfield-raymarch steps (0 = flat plane); real surface relief/parallax
uniform int   uOceanOctaves;// wave octave count (LOD; fewer on mobile)
uniform samplerCube uStarCube;   // baked starfield (reflected in the water)
uniform sampler2D uOceanReflTex; // planar reflection: the scene (objects + level) mirrored about the sea
uniform float uOceanReflOn;      // 1 when that reflection rendered this frame
uniform float uOceanReflDistort; // how much the waves ripple-distort the planar reflection (screen-space)
uniform float uOceanReady;       // 0..1 startup warm-up: the on-screen sea fades in (no first-frames garbage/fog)
uniform sampler2D uOceanFFTDisp; // GPU FFT displacement (dx, dy, dz), tiled over world XZ
uniform sampler2D uOceanFFTFoam; // accumulated foam (evolves over time), same tiling
uniform float uOceanFFTOn;       // 0 analytic, 1 FFT, 2 FFT debug (height as grey)
uniform float uOceanFFTL;        // FFT tile size (world units)

const float OCEAN_PI = 3.14159265;

// GGX / Trowbridge-Reitz normal-distribution term — sharp, physical moon glints on the wave facets.
float ggxD(float ndoth, float rough) {
  float a2 = rough * rough * rough * rough;
  float dd = ndoth * ndoth * (a2 - 1.0) + 1.0;
  return a2 / (OCEAN_PI * dd * dd);
}

// FBM exp-sine height; writes the xz height-gradient (for the normal) and the determinant of the
// Gerstner horizontal-displacement Jacobian (det J < 1 -> the surface compresses -> whitecap).
float oceanWaves(vec2 pos, float t, out vec2 grad, out float jac) {
  grad = vec2(0.0);
  float h = 0.0, wsum = 0.0;
  float Jxx = 0.0, Jxz = 0.0, Jzx = 0.0, Jzz = 0.0;
  vec2 p = pos;
  float freq = uOceanFreq, amp = 1.0, speed = 0.5, ang = 0.0;
  const float STEEP = 1.7; // vertical crest sharpness
  const float CHOP = 2.6;  // horizontal choppiness (drives the Jacobian folds)
  for (int i = 0; i < 12; i++) {
    if (i >= uOceanOctaves) break;
    ang += 2.3999632;                          // golden angle -> isotropic wave directions
    vec2 d = vec2(cos(ang), sin(ang));
    float ph = dot(d, p) * freq + t * speed;
    float s = sin(ph), c = cos(ph);
    float w = exp(STEEP * s - STEEP);          // sharp crest, flat trough (0..1)
    float dw = w * STEEP * c;
    h += amp * w; wsum += amp;
    grad += d * (amp * dw * freq);
    // Gerstner horizontal displacement D = d·(amp·CHOP·cos ph); accumulate ∂D/∂p for the Jacobian.
    float k = amp * CHOP * (-s) * freq;
    Jxx += d.x * d.x * k; Jxz += d.x * d.y * k;
    Jzx += d.y * d.x * k; Jzz += d.y * d.y * k;
    p += d * (-dw * amp * 0.8);                 // domain warp (drag the next octave)
    freq *= 1.18; amp *= 0.78; speed *= 1.06;
  }
  jac = (1.0 + Jxx) * (1.0 + Jzz) - Jxz * Jzx;
  return (h / wsum) * 2.0 - 1.0;                // ~[-1,1]
}

// full=true: the on-screen ocean (per-ray cloud march + planar scene reflection). full=false: the
// lighter version for reflections-of-the-sea (object/surface reflection rays) — same waves, foam and
// Atlas lighting, but the sky reflection skips the expensive cloud march + planar pass.
vec3 oceanShade(vec3 ro, vec3 rd, float t, vec2 uv, bool full) {
  float tHit = (uOceanY - ro.y) / rd.y; // rd.y < 0 (downward) when this is called
  if (tHit <= 0.0) return environment(rd);
  // On-screen sea (full) with FFT: raymarch the heightfield so the surface has real RELIEF + parallax
  // instead of a flat normal-mapped plane (the "flat and weird" look). Reflections + analytic/mobile
  // keep the cheap flat-plane hit. Height-only samples (skip the choppy inverse) keep each step cheap;
  // the full inversion below still runs at the final hit for the shading normals.
  float dispFade = exp(-tHit * 0.003); // relief on the near/mid sea only; far flattens (no distance aliasing, cheaper)
  if (full && uOceanDisp > 0.5 && uOceanFFTOn > 0.5 && dispFade > 0.04) {
    // FFT height field is ~[-1,1]; scale it by uOceanWave (same factor the normals use) so the
    // wave-height slider drives real geometry, faded with distance. Size the march band to the ACTUAL
    // amplitude (not a fixed floor) so steps aren't wasted in empty space above/below small waves.
    float amp = max(0.05, uOceanWave * 1.4) * dispFade;
    float tTop = (uOceanY + amp - ro.y) / rd.y;            // band top, above every crest
    float tBot = (uOceanY - amp - ro.y) / rd.y;            // band bottom, below every trough
    float ta = max(min(tTop, tBot), 0.0), tb = max(tTop, tBot);
    int steps = int(uOceanDisp);
    float dt = (tb - ta) / float(steps);
    float tt = ta, prevDiff = 1e9;
    for (int i = 0; i < 16; i++) {
      if (i >= steps) break;
      vec3 p = ro + rd * tt;
      float surf = uOceanY + texture(uOceanFFTDisp, p.xz / uOceanFFTL).y * uOceanWave * dispFade; // height-only sample
      float diff = p.y - surf;                              // >0 above the surface, <0 below
      if (diff < 0.0) { tHit = tt - dt * (1.0 - prevDiff / max(prevDiff - diff, 1e-4)); break; } // lerp the crossing
      prevDiff = diff; tt += dt;
    }
  }
  vec3 hit = ro + rd * tHit;
  float fade = exp(-tHit * 0.0014);           // distance LOD (gentler -> detail survives from height)
  float far = 1.0 - fade;                      // 0 near -> 1 far
  vec3 n; float h; float jac; float fftFoam = 0.0;
  if (uOceanFFTOn > 0.5) {
    // Invert the horizontal (choppy) displacement so the surface pinches into CUSPS at the crests:
    // find the undisplaced sample point p with p + D(p) = hit.xz (fixed-point p = hit.xz − D(p)).
    vec2 suv = hit.xz / uOceanFFTL;
    for (int i = 0; i < 4; i++) suv = (hit.xz - texture(uOceanFFTDisp, suv).xz) / uOceanFFTL;
    float tx = 1.0 / 256.0, texel = uOceanFFTL / 256.0;
    vec3 d0 = texture(uOceanFFTDisp, suv).xyz;
    if (uOceanFFTOn > 1.5) return vec3(d0.y * 0.5 + 0.5); // debug: raw height field
    vec3 dXp = texture(uOceanFFTDisp, suv + vec2(tx, 0.0)).xyz;
    vec3 dZp = texture(uOceanFFTDisp, suv + vec2(0.0, tx)).xyz;
    float hx = (dXp.y - d0.y) / texel, hz = (dZp.y - d0.y) / texel;
    // Keep wave steepness almost all the way out (only a slight far-flatten to curb sparkle aliasing);
    // the lost sub-pixel detail is recovered as a wider specular shimmer below, not by going flat.
    float farFlat = mix(0.82, 1.0, fade);
    n = normalize(vec3(-hx * uOceanWave * farFlat, 1.0, -hz * uOceanWave * farFlat));
    jac = 0.0;
    h = d0.y;
    fftFoam = texture(uOceanFFTFoam, suv).r;
  } else {
    vec2 grad; h = oceanWaves(hit.xz, t, grad, jac);
    n = normalize(vec3(-grad.x * uOceanWave * fade, 1.0, -grad.y * uOceanWave * fade));
  }
  vec3 view = -rd;

  // Fresnel reflection of the whole sky: gradient + stars + clouds, then the planar scene reflection
  // (rippled by the wave normal), all weighted by a water Fresnel (F0 = 0.02).
  vec3 refl = reflect(rd, n); refl.y = abs(refl.y);
  vec3 reflCol = environment(refl) + texture(uStarCube, refl).rgb;
  reflCol = skyCloudsOver(reflCol, hit, refl, t, 1e9, int(uReflCloudSteps)); // clouds in the sea reflection — BOTH paths now (matches the on-screen sea)
  if (full && uOceanReflOn > 0.5) { // planar scene reflection: on-screen pass only (it's screen-space; meaningless on an object's reflection ray)
    vec2 ripple = n.xz * uOceanReflDistort * (1.0 + tHit * 0.01);
    vec4 sc = texture(uOceanReflTex, clamp(uv + ripple, 0.0, 1.0));
    reflCol = mix(reflCol, sc.rgb, clamp(sc.a, 0.0, 1.0));
  }
  float fres = clamp(0.02 + 0.98 * pow5(1.0 - max(dot(view, n), 0.0)), 0.0, 1.0);

  // --- Water shading: the Atlas/Acerola multiple-scattering model (GarrettGunnell/Water FFTWater). ---
  vec3 L = uSunDir;
  vec3 sunIrr = uSunColor * uMoonStrength;
  float H = max(h, 0.0);                                 // wave height above mean (crest scatter)
  float ndotl = max(dot(n, L), 0.0);
  float lit = max(L.y, 0.0);                              // no moon contribution below the horizon
  // Subsurface / multiple scattering: k1 = peak backscatter toward the moon, k2 = view-dependent body
  // glow that fills the water with colour (the term that was missing), k3 = ambient diffuse scatter.
  float k1 = uOceanScatterAmt * 4.0 * H * pow4(max(dot(L, -view), 0.0)) * pow3(max(0.5 - 0.5 * dot(L, n), 0.0));
  float k2 = uOceanScatterAmt * 1.2 * pow2(max(dot(view, n), 0.0));
  float k3 = uOceanScatterAmt * 0.3 * ndotl;
  vec3 scatter = (k1 + k2 + k3) * uOceanScatter * sunIrr * lit;
  scatter += uOceanColor + uOceanColor * environment(n) * 6.0; // deep-water base + sky-ambient fill (less empty)

  // Cook-Torrance-ish GGX moon glints. With distance the sub-pixel waves can't be resolved, so widen
  // the roughness -> the sharp glints merge into a soft shimmering glitter band (the distant ocean
  // sparkle) instead of aliasing or fading to flat. No *fade, so the shimmer survives from height.
  vec3 Hh = normalize(view + L);
  float rough = mix(0.12, 0.45, clamp(far * 1.4, 0.0, 1.0));
  float spec = ggxD(max(dot(n, Hh), 0.0), rough) * lit;
  vec3 specular = sunIrr * spec * fres * 3.0;

  // Compose: transmitted body (1-F)·scatter + microfacet specular + Fresnel-weighted sky reflection.
  vec3 col = (1.0 - fres) * scatter + specular + fres * reflCol;

  // Foam: the FFT path uses the time-accumulated foam buffer (builds on breaking crests, decays over
  // seconds); the analytic path uses the instantaneous Jacobian fold. Blend to a moonlit foam colour.
  float foamRaw = (uOceanFFTOn > 0.5) ? fftFoam : smoothstep(uOceanFoamThresh, uOceanFoamThresh - 0.45, jac);
  float foam = clamp(foamRaw, 0.0, 1.0) * uOceanFoam;            // fold/Jacobian whitecaps (FFT path: the foam buffer)
  foam = max(foam, smoothstep(0.72, 0.98, H) * uOceanCrestFoam); // sharp foam on the wave TOPS only (less coverage)
  foam = clamp(foam, 0.0, 1.0) * mix(1.0, 0.6, far);             // distant whitecaps stay visible
  vec3 foamCol = vec3(0.80, 0.86, 0.92) * (0.55 + 0.6 * lit);    // brighter floor -> foam isn't killed by the low moon
  col = mix(col, foamCol, foam);

  return mix(col, environment(rd), clamp(1.0 - exp(-tHit * uOceanFog), 0.0, 1.0));
}

// The on-screen ocean (cloud pass) — full sky reflection.
vec3 ocean(vec3 ro, vec3 rd, float t, vec2 uv) { return oceanShade(ro, rd, t, uv, true); }
