precision highp float;

in vec3 vWorldPos;
in vec3 vColor;
in float vRough;
in float vMetal;
flat in int vLightOffset;
flat in int vLightCount;
flat in int vShadowOffset;
flat in int vShadowCount;

out vec4 fragColor;

uniform vec3 cameraPosition;
uniform sampler2D uLightsTex;     // 2 texels per light: [pos.xyz,_], [color.rgb, radius]
uniform sampler2D uLightIndexTex; // 1 texel per list entry: light index (as float)
uniform int uLightsTexW;
uniform int uIndexTexW;
uniform sampler2D uOccluderTex;    // 1 texel per object: [center.xyz, proxyRadius]
uniform sampler2D uShadowIndexTex; // 1 texel per occluder-list entry: object index
uniform int uOccluderTexW;
uniform int uShadowIndexW;

ivec2 texel(int i, int w) { return ivec2(i % w, i / w); }

// Unreal-style point-light falloff.
float falloff(float dist, float radius) {
  float a = clamp(1.0 - pow(dist / radius, 4.0), 0.0, 1.0);
  return a * a / (dist * dist + 1.0);
}

// Soft analytic shadow: trace from the surface toward a light, attenuating by
// nearby occluder spheres (ray-sphere closest approach, smoothstep penumbra).
float traceShadow(vec3 p, vec3 L, float distToLight) {
  float sh = 1.0;
  for (int s = 0; s < vShadowCount; s++) {
    int oi = int(texelFetch(uShadowIndexTex, texel(vShadowOffset + s, uShadowIndexW), 0).r + 0.5);
    vec4 occ = texelFetch(uOccluderTex, texel(oi, uOccluderTexW), 0);
    vec3 oc = occ.xyz - p;
    float R = occ.w;
    float tca = dot(oc, L);
    if (tca <= 0.0 || tca - R >= distToLight) continue; // behind us or past the light
    float d = sqrt(max(dot(oc, oc) - tca * tca, 0.0));
    float soft = 0.5 * R + 0.04;
    sh *= smoothstep(-soft, soft, d - R);
    if (sh < 0.01) return 0.0;
  }
  return sh;
}

// GGX microfacet BRDF (matches pdx-gfx: Trowbridge-Reitz D with source-radius
// widening, Smith joint visibility, Schlick Fresnel; no 1/pi, folded into
// light intensity).
vec3 brdf(vec3 N, vec3 V, vec3 L, vec3 diffuseAlbedo, vec3 F0, float roughness, float dist) {
  vec3 H = normalize(V + L);
  float NdotL = max(dot(N, L), 0.0);
  float NdotV = max(dot(N, V), 1e-4);
  float NdotH = max(dot(N, H), 0.0);
  float LdotH = max(dot(L, H), 0.0);

  float alpha = roughness * roughness;
  float sourceRadius = 0.12; // emissive size -> softens highlights
  float wAlpha = clamp(alpha + sourceRadius / (3.0 * dist), 0.0, 1.0);
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

void main() {
  vec3 N = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vWorldPos);

  vec3 diffuseAlbedo = vColor * (1.0 - vMetal);
  vec3 F0 = mix(vec3(0.04), vColor, vMetal);

  vec3 lit = vec3(0.0);
  for (int k = 0; k < vLightCount; k++) {
    int idx = int(texelFetch(uLightIndexTex, texel(vLightOffset + k, uIndexTexW), 0).r + 0.5);
    vec3 lightPos = texelFetch(uLightsTex, texel(idx * 2, uLightsTexW), 0).xyz;
    vec4 colRad = texelFetch(uLightsTex, texel(idx * 2 + 1, uLightsTexW), 0);

    vec3 L = lightPos - vWorldPos;
    float dist = length(L);
    L /= max(dist, 1e-4);
    float shadow = traceShadow(vWorldPos + N * 0.02, L, dist);
    lit += brdf(N, V, L, diffuseAlbedo, F0, vRough, dist) * colRad.rgb * falloff(dist, colRad.w) * shadow;
  }

  // Faint hemispheric ambient so faces with no nearby light aren't pure black.
  float hemi = 0.5 + 0.5 * N.y;
  lit += diffuseAlbedo * mix(vec3(0.02, 0.02, 0.03), vec3(0.05, 0.05, 0.06), hemi);

  // Output linear HDR; tone mapping happens once in the post pass.
  fragColor = vec4(lit, 1.0);
}
