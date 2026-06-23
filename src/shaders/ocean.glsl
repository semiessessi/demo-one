// Analytic ocean for the skybox "ground": a wavy, reflective plane at uOceanY that the camera sees on
// downward rays (below the horizon / through cloud gaps). Summed directional waves give the normal;
// the surface Fresnel-reflects the sky + moon (with a moon glint streak), deep water tints the rest,
// and foam rides the crests. Prepended AFTER lib.glsl + clouds.glsl in the cloud pass, so it reuses
// environment(), uSunDir/uSunColor and cloudFbm. Aerial perspective fades it into the horizon.

uniform float uOceanOn;     // 0/1 master switch
uniform float uOceanY;      // plane altitude (world y)
uniform vec3  uOceanColor;  // deep-water tint
uniform float uOceanFog;    // aerial-perspective fade into the horizon (per world unit)
uniform float uOceanWave;   // wave steepness scale
uniform samplerCube uStarCube; // baked starfield (reflected in the water)

// Summed-sine wave field: returns height and writes the horizontal gradient (for the normal).
float oceanHeight(vec2 p, float t, out vec2 grad) {
  grad = vec2(0.0);
  float h = 0.0, amp = 1.0, freq = 0.05, spd = 0.9;
  vec2 dirs[5] = vec2[5](vec2(0.80, 0.60), vec2(-0.60, 0.80), vec2(0.30, -0.95), vec2(-0.95, -0.30), vec2(0.50, 0.50));
  for (int i = 0; i < 5; i++) {
    vec2 d = normalize(dirs[i]);
    float ph = dot(d, p) * freq + t * spd;
    h += amp * sin(ph);
    grad += d * (amp * freq * cos(ph)); // d/dp of amp*sin(dot(d,p)*freq + ...)
    amp *= 0.62; freq *= 1.9; spd *= 1.2;
  }
  return h;
}

vec3 ocean(vec3 ro, vec3 rd, float t) {
  float tHit = (uOceanY - ro.y) / rd.y; // rd.y < 0 (downward) when this is called
  if (tHit <= 0.0) return environment(rd);
  vec3 hit = ro + rd * tHit;
  vec2 p = hit.xz;
  float fade = exp(-tHit * 0.0035);                 // flatten waves toward the horizon (anti-alias)
  vec2 grad; float h = oceanHeight(p, t, grad);
  vec3 n = normalize(vec3(-grad.x * uOceanWave * fade, 1.0, -grad.y * uOceanWave * fade));
  // Fresnel reflection of the sky + stars + clouds + a sharp moon glint (huge range — it reflects
  // the whole sky, not a capped object trace).
  vec3 refl = reflect(rd, n); refl.y = abs(refl.y); // keep the reflected ray pointing up at the sky
  vec3 reflCol = environment(refl) + texture(uStarCube, refl).rgb;          // sky gradient + reflected stars
  reflCol += uSunColor * pow(max(dot(refl, uSunDir), 0.0), 300.0) * 5.0;    // moon glint
  reflCol = skyCloudsOver(reflCol, hit, refl, t, 1e9, int(uReflCloudSteps)); // reflected clouds (march up the band)
  float fres = clamp(0.02 + 0.98 * pow(1.0 - max(dot(-rd, n), 0.0), 5.0), 0.0, 1.0);
  vec3 water = uOceanColor * (0.4 + 0.6 * max(n.y, 0.0));
  vec3 col = mix(water, reflCol, fres);
  // Foam on the crests: high wave height gated by a moving noise, fading with distance.
  float crest = smoothstep(0.45, 1.0, h * 0.5 + 0.5);
  float foam = crest * smoothstep(0.45, 0.75, cloudFbm(vec3(p * 0.3, t * 0.25))) * fade;
  col = mix(col, vec3(0.85, 0.9, 0.95), clamp(foam, 0.0, 1.0));
  // Aerial perspective: dissolve into the horizon glow with distance.
  return mix(col, environment(rd), clamp(1.0 - exp(-tHit * uOceanFog), 0.0, 1.0));
}
