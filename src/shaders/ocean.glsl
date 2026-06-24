// Analytic ocean for the skybox "ground": a wavy, reflective sea plane at uOceanY seen on downward
// rays. Waves are an FBM of EXPONENTIAL-SINE waves (exp(steep·sin φ − steep) -> sharp crests, flat
// troughs) with domain warping (each octave's sample position dragged by the previous octave's
// derivative) and golden-angle directions — the look from Acerola's GarrettGunnell/Water (a cheap
// stand-in for a true FFT). The surface Fresnel-reflects the sky + stars (uStarCube) + clouds
// (skyCloudsOver) + the planar scene reflection (uOceanReflTex), with a Blinn-Phong moon sparkle,
// subsurface-scatter crest glow, and soft foam on the steep crests. uOceanOctaves is the wave LOD
// (lowered on mobile). Prepended after lib.glsl + clouds.glsl.

uniform float uOceanOn;     // 0/1 master switch
uniform float uOceanY;      // plane altitude (world y)
uniform vec3  uOceanColor;  // deep-water tint
uniform vec3  uOceanScatter;// subsurface-scatter tip colour (crest glow)
uniform float uOceanFog;    // aerial-perspective fade into the horizon (per world unit)
uniform float uOceanWave;   // wave steepness scale
uniform float uOceanFoam;   // foam amount on the crests
uniform int   uOceanOctaves;// wave octave count (LOD; fewer on mobile)
uniform samplerCube uStarCube;   // baked starfield (reflected in the water)
uniform sampler2D uOceanReflTex; // planar reflection: the scene (objects + level) mirrored about the sea
uniform float uOceanReflOn;      // 1 when that reflection rendered this frame

// FBM exponential-sine waves. Returns height; writes the xz gradient (for the analytic normal).
float oceanWaves(vec2 pos, float t, out vec2 grad) {
  grad = vec2(0.0);
  float h = 0.0, wsum = 0.0;
  vec2 p = pos;
  float freq = 0.035, amp = 1.0, speed = 0.5, ang = 0.0;
  const float STEEP = 1.7;
  for (int i = 0; i < 12; i++) {
    if (i >= uOceanOctaves) break;
    ang += 2.3999632;                          // golden angle -> isotropic wave directions
    vec2 d = vec2(cos(ang), sin(ang));
    float ph = dot(d, p) * freq + t * speed;
    float w = exp(STEEP * sin(ph) - STEEP);    // sharp crest, flat trough (0..1)
    float dw = w * STEEP * cos(ph);             // d(w)/d(phase)
    h += amp * w; wsum += amp;
    grad += d * (amp * dw * freq);
    p += d * (-dw * amp * 0.8);                 // domain warp (drag the next octave)
    freq *= 1.18; amp *= 0.78; speed *= 1.06;
  }
  return (h / wsum) * 2.0 - 1.0;                // ~[-1,1]
}

vec3 ocean(vec3 ro, vec3 rd, float t, vec2 uv) {
  float tHit = (uOceanY - ro.y) / rd.y; // rd.y < 0 (downward) when this is called
  if (tHit <= 0.0) return environment(rd);
  vec3 hit = ro + rd * tHit;
  float fade = exp(-tHit * 0.0028);           // flatten waves toward the horizon (anti-alias)
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

  // Soft foam on the steep crests (high slope near the top), broken up by noise, fading with distance.
  float slope = clamp(length(grad) * uOceanWave * 7.0, 0.0, 1.0);
  float crest = smoothstep(0.15, 0.7, h * 0.5 + 0.5);
  float fn = cloudFbm(vec3(hit.xz * 0.45, t * 0.35));
  float foam = clamp(smoothstep(0.35, 0.8, slope * crest) * smoothstep(0.35, 0.75, fn), 0.0, 1.0) * uOceanFoam * fade;
  col = mix(col, vec3(0.72, 0.80, 0.85) * (0.35 + 0.65 * max(uSunDir.y, 0.0)), foam);

  return mix(col, environment(rd), clamp(1.0 - exp(-tHit * uOceanFog), 0.0, 1.0));
}
