precision highp float;

in vec3 vWorldPos;
in vec3 vColor;
in float vRough;
in float vMetal;
flat in int vLightOffset;
flat in int vLightCount;
flat in int vShadowOffset;
flat in int vShadowCount;
flat in int vReflOffset;
flat in int vReflCount;

out vec4 fragColor;

uniform vec3 cameraPosition;
uniform sampler2D uLightsTex;      // 2 texels/light: [pos.xyz,_], [color.rgb, radius]
uniform sampler2D uLightIndexTex;  // light index per entry
uniform int uLightsTexW;
uniform int uIndexTexW;
uniform sampler2D uOccluderTex;    // 1 texel/object: [center.xyz, proxyRadius]
uniform sampler2D uShadowIndexTex; // object index per entry
uniform int uOccluderTexW;
uniform int uShadowIndexW;
uniform sampler2D uReflIndexTex;   // object index per entry (reflection lists)
uniform int uReflIndexW;
uniform sampler2D uInstanceTex;    // 2 texels/object: [albedo.rgb, rough], [lo, lc, metal, _]
uniform int uInstanceTexW;

const float REFL_ROUGHNESS_MAX = 0.35;

ivec2 texel(int i, int w) { return ivec2(i % w, i / w); }

float falloff(float dist, float radius) {
  float a = clamp(1.0 - pow(dist / radius, 4.0), 0.0, 1.0);
  return a * a / (dist * dist + 1.0);
}

vec3 environment(vec3 d) {
  return mix(vec3(0.010, 0.012, 0.020), vec3(0.05, 0.07, 0.10), 0.5 + 0.5 * d.y);
}

vec3 brdf(vec3 N, vec3 V, vec3 L, vec3 diffuseAlbedo, vec3 F0, float roughness, float dist) {
  vec3 H = normalize(V + L);
  float NdotL = max(dot(N, L), 0.0);
  float NdotV = max(dot(N, V), 1e-4);
  float NdotH = max(dot(N, H), 0.0);
  float LdotH = max(dot(L, H), 0.0);

  float alpha = roughness * roughness;
  float wAlpha = clamp(alpha + 0.12 / (3.0 * dist), 0.0, 1.0);
  float wAlpha2 = wAlpha * wAlpha;
  float energy = (alpha / wAlpha) * (alpha / wAlpha);
  float dDen = NdotH * NdotH * (wAlpha2 - 1.0) + 1.0;
  float D = energy * wAlpha2 / (dDen * dDen);

  float a2 = alpha * alpha;
  float smithV = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2);
  float smithL = NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
  float Vis = 0.5 / max(smithV + smithL, 1e-5);

  vec3 F = F0 + (1.0 - F0) * pow(1.0 - LdotH, 5.0);
  return (diffuseAlbedo + D * Vis * F) * NdotL;
}

// Soft analytic shadow against the per-object occluder spheres.
float traceShadow(vec3 p, vec3 L, float distToLight) {
  float sh = 1.0;
  for (int s = 0; s < vShadowCount; s++) {
    int oi = int(texelFetch(uShadowIndexTex, texel(vShadowOffset + s, uShadowIndexW), 0).r + 0.5);
    vec4 occ = texelFetch(uOccluderTex, texel(oi, uOccluderTexW), 0);
    vec3 oc = occ.xyz - p;
    float R = occ.w;
    float tca = dot(oc, L);
    if (tca <= 0.0 || tca - R >= distToLight) continue;
    float d = sqrt(max(dot(oc, oc) - tca * tca, 0.0));
    float soft = 0.5 * R + 0.04;
    sh *= smoothstep(-soft, soft, d - R);
    if (sh < 0.01) return 0.0;
  }
  return sh;
}

// Direct GGX lighting from a light list at an arbitrary surface point.
vec3 shadeDirect(vec3 p, vec3 N, vec3 V, vec3 albedo, float rough, float metal,
                 int lo, int lc, bool doShadow) {
  vec3 diffuseAlbedo = albedo * (1.0 - metal);
  vec3 F0 = mix(vec3(0.04), albedo, metal);
  vec3 lit = vec3(0.0);
  for (int k = 0; k < lc; k++) {
    int idx = int(texelFetch(uLightIndexTex, texel(lo + k, uIndexTexW), 0).r + 0.5);
    vec3 lightPos = texelFetch(uLightsTex, texel(idx * 2, uLightsTexW), 0).xyz;
    vec4 colRad = texelFetch(uLightsTex, texel(idx * 2 + 1, uLightsTexW), 0);
    vec3 L = lightPos - p;
    float dist = length(L);
    L /= max(dist, 1e-4);
    float shadow = doShadow ? traceShadow(p + N * 0.02, L, dist) : 1.0;
    lit += brdf(N, V, L, diffuseAlbedo, F0, rough, dist) * colRad.rgb * falloff(dist, colRad.w) * shadow;
  }
  return lit;
}

// Nearest reflection hit against the per-object occluder spheres.
bool traceReflection(vec3 ro, vec3 rd, out float hitT, out vec3 hitN, out int hitObj) {
  hitT = 1e9;
  bool hit = false;
  for (int s = 0; s < vReflCount; s++) {
    int oi = int(texelFetch(uReflIndexTex, texel(vReflOffset + s, uReflIndexW), 0).r + 0.5);
    vec4 occ = texelFetch(uOccluderTex, texel(oi, uOccluderTexW), 0);
    vec3 oc = occ.xyz - ro;
    float R = occ.w;
    float tca = dot(oc, rd);
    float d2 = dot(oc, oc) - tca * tca;
    float R2 = R * R;
    if (d2 > R2) continue;
    float t = tca - sqrt(R2 - d2);
    if (t > 0.001 && t < hitT) {
      hitT = t;
      hitObj = oi;
      hitN = normalize((ro + t * rd) - occ.xyz);
      hit = true;
    }
  }
  return hit;
}

void main() {
  vec3 N = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vWorldPos);

  vec3 lit = shadeDirect(vWorldPos, N, V, vColor, vRough, vMetal, vLightOffset, vLightCount, true);

  // Faint hemispheric ambient.
  vec3 diffuseAlbedo = vColor * (1.0 - vMetal);
  lit += diffuseAlbedo * mix(vec3(0.02, 0.02, 0.03), vec3(0.05, 0.05, 0.06), 0.5 + 0.5 * N.y);

  // Reflections for smooth surfaces only.
  if (vRough < REFL_ROUGHNESS_MAX) {
    vec3 F0 = mix(vec3(0.04), vColor, vMetal);
    vec3 Rdir = reflect(-V, N);
    float NdotV = max(dot(N, V), 0.0);
    vec3 envF = F0 + (max(vec3(1.0 - vRough), F0) - F0) * pow(1.0 - NdotV, 5.0);

    float ht;
    vec3 hN;
    int hObj;
    vec3 refl;
    if (traceReflection(vWorldPos + N * 0.02, Rdir, ht, hN, hObj)) {
      vec3 hp = vWorldPos + ht * Rdir;
      vec4 m0 = texelFetch(uInstanceTex, texel(hObj * 2, uInstanceTexW), 0);
      vec4 m1 = texelFetch(uInstanceTex, texel(hObj * 2 + 1, uInstanceTexW), 0);
      refl = shadeDirect(hp, hN, -Rdir, m0.rgb, m0.a, m1.z, int(m1.x + 0.5), int(m1.y + 0.5), false);
      refl += m0.rgb * environment(hN) * 0.3;
    } else {
      refl = environment(Rdir);
    }
    lit += refl * envF;
  }

  fragColor = vec4(lit, 1.0); // linear HDR; tone-mapped in the post pass
}
