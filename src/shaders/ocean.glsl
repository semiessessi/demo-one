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
uniform int   uOceanOctaves;// wave octave count (LOD; fewer on mobile)
uniform samplerCube uStarCube;   // baked starfield (reflected in the water)
uniform sampler2D uOceanReflTex; // planar reflection: the scene (objects + level) mirrored about the sea
uniform float uOceanReflOn;      // 1 when that reflection rendered this frame
uniform float uOceanReflDistort; // how much the waves ripple-distort the planar reflection (screen-space)
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
  vec3 hit = ro + rd * tHit;
  float fade = exp(-tHit * 0.0028);           // flatten waves toward the horizon (anti-alias)
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
    // Full wave steepness at all distances — the displacement texture's own detail + linear filtering
    // handle the horizon (a mild far-flatten only at the very edge to curb sparkle aliasing).
    float farFlat = mix(0.6, 1.0, fade);
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
  float fres = clamp(0.02 + 0.98 * pow(1.0 - max(dot(view, n), 0.0), 5.0), 0.0, 1.0);

  // --- Water shading: the Atlas/Acerola multiple-scattering model (GarrettGunnell/Water FFTWater). ---
  vec3 L = uSunDir;
  vec3 sunIrr = uSunColor * uMoonStrength;
  float H = max(h, 0.0);                                 // wave height above mean (crest scatter)
  float ndotl = max(dot(n, L), 0.0);
  float lit = max(L.y, 0.0);                              // no moon contribution below the horizon
  // Subsurface / multiple scattering: k1 = peak backscatter toward the moon, k2 = view-dependent body
  // glow that fills the water with colour (the term that was missing), k3 = ambient diffuse scatter.
  float k1 = uOceanScatterAmt * 4.0 * H * pow(max(dot(L, -view), 0.0), 4.0) * pow(max(0.5 - 0.5 * dot(L, n), 0.0), 3.0);
  float k2 = uOceanScatterAmt * 1.2 * pow(max(dot(view, n), 0.0), 2.0);
  float k3 = uOceanScatterAmt * 0.3 * ndotl;
  vec3 scatter = (k1 + k2 + k3) * uOceanScatter * sunIrr * lit;
  scatter += uOceanColor + uOceanColor * environment(n) * 6.0; // deep-water base + sky-ambient fill (less empty)

  // Cook-Torrance-ish GGX moon glints on the wave facets.
  vec3 Hh = normalize(view + L);
  float spec = ggxD(max(dot(n, Hh), 0.0), 0.13) * lit;
  vec3 specular = sunIrr * spec * fres * 3.0 * fade;

  // Compose: transmitted body (1-F)·scatter + microfacet specular + Fresnel-weighted sky reflection.
  vec3 col = (1.0 - fres) * scatter + specular + fres * reflCol;

  // Foam: the FFT path uses the time-accumulated foam buffer (builds on breaking crests, decays over
  // seconds); the analytic path uses the instantaneous Jacobian fold. Blend to a moonlit foam colour.
  float foamRaw = (uOceanFFTOn > 0.5) ? fftFoam : smoothstep(uOceanFoamThresh, uOceanFoamThresh - 0.45, jac);
  float foam = clamp(foamRaw, 0.0, 1.0) * uOceanFoam * fade;
  vec3 foamCol = vec3(0.78, 0.85, 0.9) * (0.4 + 0.75 * lit);
  col = mix(col, foamCol, foam);

  return mix(col, environment(rd), clamp(1.0 - exp(-tHit * uOceanFog), 0.0, 1.0));
}

// The on-screen ocean (cloud pass) — full sky reflection.
vec3 ocean(vec3 ro, vec3 rd, float t, vec2 uv) { return oceanShade(ro, rd, t, uv, true); }
