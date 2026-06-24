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
uniform vec3  uOceanScatter;// subsurface-scatter colour (crest glow)
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

vec3 ocean(vec3 ro, vec3 rd, float t, vec2 uv) {
  float tHit = (uOceanY - ro.y) / rd.y; // rd.y < 0 (downward) when this is called
  if (tHit <= 0.0) return environment(rd);
  vec3 hit = ro + rd * tHit;
  float fade = exp(-tHit * 0.0028);           // flatten waves toward the horizon (anti-alias)
  vec2 grad; float jac; float h = oceanWaves(hit.xz, t, grad, jac);
  vec3 n = normalize(vec3(-grad.x * uOceanWave * fade, 1.0, -grad.y * uOceanWave * fade));
  vec3 view = -rd;

  // Fresnel reflection of the whole sky: gradient + stars + clouds, then the planar scene reflection
  // (rippled by the wave normal), all weighted by a water Fresnel (F0 = 0.02).
  vec3 refl = reflect(rd, n); refl.y = abs(refl.y);
  vec3 reflCol = environment(refl) + texture(uStarCube, refl).rgb;
  reflCol = skyCloudsOver(reflCol, hit, refl, t, 1e9, int(uReflCloudSteps));
  if (uOceanReflOn > 0.5) {
    vec2 ripple = n.xz * uOceanReflDistort * (1.0 + tHit * 0.01);
    vec4 sc = texture(uOceanReflTex, clamp(uv + ripple, 0.0, 1.0));
    reflCol = mix(reflCol, sc.rgb, clamp(sc.a, 0.0, 1.0));
  }
  float fres = clamp(0.02 + 0.98 * pow(1.0 - max(dot(view, n), 0.0), 5.0), 0.0, 1.0);

  // GGX moon glints on the wave facets (sharp sparkle along the moon path).
  vec3 Hh = normalize(view + uSunDir);
  float spec = ggxD(max(dot(n, Hh), 0.0), 0.09) * max(uSunDir.y, 0.0);
  // Subsurface scatter: moonlight transmitting through the wave crests (Atlas/Acerola model) — a teal
  // glow strongest on the back of tall waves toward the moon, plus a soft ambient term.
  float crest = max(h, 0.0);
  float sss = crest * pow(max(dot(uSunDir, -view), 0.0), 4.0) * pow(max(0.5 - 0.5 * dot(uSunDir, n), 0.0), 3.0)
            + crest * 0.2 * max(dot(view, n), 0.0);
  sss *= max(uSunDir.y, 0.0);

  vec3 water = uOceanColor * (0.5 + 0.5 * max(n.y, 0.0)) + uOceanScatter * uSunColor * sss * 4.0;
  vec3 col = mix(water, reflCol, fres) + uSunColor * uMoonStrength * spec * fres * 3.0 * fade;

  // Jacobian foam: whitecaps where the choppy displacement folds (det J below the threshold). Soft,
  // distance-faded, moonlit — no noise texture.
  float foam = smoothstep(uOceanFoamThresh, uOceanFoamThresh - 0.45, jac) * uOceanFoam * fade;
  col = mix(col, vec3(0.74, 0.82, 0.86) * (0.4 + 0.6 * max(uSunDir.y, 0.0)), clamp(foam, 0.0, 1.0));

  return mix(col, environment(rd), clamp(1.0 - exp(-tHit * uOceanFog), 0.0, 1.0));
}
