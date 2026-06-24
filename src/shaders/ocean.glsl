// Analytic ocean for the skybox "ground": a wavy, reflective sea plane at uOceanY seen on downward
// rays. Waves are an FBM of EXPONENTIAL-SINE waves (exp(sin φ − 1) -> sharp crests, flat troughs)
// with domain warping (each octave's sample position is dragged by the previous octave's derivative)
// — the technique from Acerola's GarrettGunnell/Water. The surface Fresnel-reflects the sky + stars
// (uStarCube) + clouds (skyCloudsOver) + a Blinn-Phong moon sparkle, with a subsurface-scatter tip
// colour on the crests (no chunky foam). Prepended after lib.glsl + clouds.glsl.

uniform float uOceanOn;     // 0/1 master switch
uniform float uOceanY;      // plane altitude (world y)
uniform vec3  uOceanColor;  // deep-water tint
uniform vec3  uOceanScatter;// subsurface-scatter tip colour (crest glow)
uniform float uOceanFog;    // aerial-perspective fade into the horizon (per world unit)
uniform float uOceanWave;   // wave steepness scale
uniform samplerCube uStarCube;   // baked starfield (reflected in the water)
uniform sampler2D uOceanReflTex; // planar reflection: the scene (objects + level) mirrored about the sea
uniform float uOceanReflOn;      // 1 when that reflection rendered this frame

const int OCEAN_OCTAVES = 9;

// FBM exponential-sine waves. Returns height; writes the xz gradient (for the analytic normal).
float oceanWaves(vec2 pos, float t, out vec2 grad) {
  grad = vec2(0.0);
  float h = 0.0, wsum = 0.0;
  vec2 p = pos;
  float freq = 0.04, amp = 1.0, speed = 0.55, ang = 0.0;
  for (int i = 0; i < OCEAN_OCTAVES; i++) {
    ang += 2.3999632;                          // golden angle -> isotropic wave directions
    vec2 d = vec2(cos(ang), sin(ang));
    float ph = dot(d, p) * freq + t * speed;
    float w = exp(sin(ph) - 1.0);              // peaked crest, flat trough (0..1)
    float dw = w * cos(ph);                     // d(w)/d(phase)
    h += amp * w; wsum += amp;
    grad += d * (amp * dw * freq);
    p += d * (-dw * amp * 0.7);                 // domain warp (drag the next octave)
    freq *= 1.17; amp *= 0.80; speed *= 1.08;
  }
  return (h / wsum) * 2.0 - 1.0;                // ~[-1,1]
}

vec3 ocean(vec3 ro, vec3 rd, float t, vec2 uv) {
  float tHit = (uOceanY - ro.y) / rd.y; // rd.y < 0 (downward) when this is called
  if (tHit <= 0.0) return environment(rd);
  vec3 hit = ro + rd * tHit;
  float fade = exp(-tHit * 0.003);            // flatten waves toward the horizon (anti-alias)
  vec2 grad; float h = oceanWaves(hit.xz, t, grad);
  vec3 n = normalize(vec3(-grad.x * uOceanWave * fade, 1.0, -grad.y * uOceanWave * fade));
  vec3 view = -rd;

  // Fresnel reflection of the whole sky: gradient + stars + clouds + moon (huge range, no LOD cap)...
  vec3 refl = reflect(rd, n); refl.y = abs(refl.y);
  vec3 reflCol = environment(refl) + texture(uStarCube, refl).rgb;
  reflCol = skyCloudsOver(reflCol, hit, refl, t, 1e9, int(uReflCloudSteps));
  // ...then the planar reflection of the actual scene (objects + level) over it, distorted by the
  // wave normal (the sea-plane point projects to the same screen UV in the mirrored camera).
  if (uOceanReflOn > 0.5) {
    vec4 sc = texture(uOceanReflTex, clamp(uv + n.xz * 0.06, 0.0, 1.0));
    reflCol = mix(reflCol, sc.rgb, clamp(sc.a, 0.0, 1.0));
  }
  float fres = clamp(0.02 + 0.98 * pow(1.0 - max(dot(view, n), 0.0), 5.0), 0.0, 1.0);

  // Blinn-Phong moon sparkle on the wave facets + subsurface scatter glowing through the crests.
  float spec = pow(max(dot(n, normalize(view + uSunDir)), 0.0), 200.0);
  float scatter = clamp(h * 0.5 + 0.5, 0.0, 1.0) * pow(max(1.0 - dot(view, n), 0.0), 3.0) * max(uSunDir.y, 0.0);
  vec3 water = uOceanColor + uOceanScatter * uSunColor * scatter * 2.0;
  vec3 col = mix(water, reflCol, fres) + uSunColor * uMoonStrength * spec * 2.5 * fade;

  return mix(col, environment(rd), clamp(1.0 - exp(-tHit * uOceanFog), 0.0, 1.0));
}
