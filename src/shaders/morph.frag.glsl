// (lib.glsl prepended: precision + texel/quat helpers/pingpong/environment)

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
uniform float uTime;
uniform float uNumSegments;
uniform float uNormScale[128];
uniform float uMaxCircumradius; // occluder bounding radius = scale * this (cull)

uniform sampler2D uLightsTex;
uniform sampler2D uLightIndexTex;
uniform int uLightsTexW;
uniform int uIndexTexW;
uniform sampler2D uShadowIndexTex;
uniform int uShadowIndexW;
uniform sampler2D uReflIndexTex;
uniform int uReflIndexW;
uniform sampler2D uInstanceTex;     // 2 texels/object: [albedo.rgb, rough], [lo, lc, metal, _]
uniform int uInstanceTexW;
uniform sampler2D uPlaneTex;        // 2 texels/triangle: [n0.xyz, d0], [n1.xyz, d1]
uniform int uPlaneTexW;
uniform sampler2D uOccTransformTex; // 4 texels/object: pos+scale, quat, spinAxis+speed, phase
uniform int uOccTransformTexW;
uniform int uSegTriStart[16];
uniform int uSegTriCount[16];

const float REFL_ROUGHNESS_MAX = 0.35;
const int SHADOW_LIGHTS = 16; // nearest N lights cast shadows (planes merged, so affordable)

float lookupNorm(float p) {
  float fp = (p / uNumSegments) * 127.0;
  int i0 = int(floor(fp));
  return mix(uNormScale[i0], uNormScale[min(i0 + 1, 127)], fp - float(i0));
}

float falloff(float dist, float radius) {
  float a = clamp(1.0 - pow(dist / radius, 4.0), 0.0, 1.0);
  return a * a / (dist * dist + 1.0);
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

// Convex-hull trace of occluder `oi` against a world ray. Rebuilds the occluder's
// current hull from its transform + phase and slab-traces every triangle plane.
// Returns world-space entry distance and entry-plane normal.
bool traceHull(int oi, vec3 roW, vec3 rdW, out float tHit, out vec3 nW) {
  int b = oi * 4;
  vec4 t0 = texelFetch(uOccTransformTex, texel(b, uOccTransformTexW), 0);
  vec4 baseQ = texelFetch(uOccTransformTex, texel(b + 1, uOccTransformTexW), 0);
  vec4 t2 = texelFetch(uOccTransformTex, texel(b + 2, uOccTransformTexW), 0);
  vec4 t3 = texelFetch(uOccTransformTex, texel(b + 3, uOccTransformTexW), 0);
  float phaseOff = t3.x;
  float morphSpeed = t3.y;
  vec3 center = t0.xyz;
  float scale = t0.w;

  float p = pingpong(uTime * morphSpeed + phaseOff, uNumSegments);
  int seg = int(floor(p));
  float localT = fract(p);
  if (seg >= int(uNumSegments + 0.5)) { seg = int(uNumSegments + 0.5) - 1; localT = 1.0; }

  vec4 q = qmul(quatAxisAngle(t2.xyz, uTime * t2.w), baseQ);
  float S = scale * lookupNorm(p);

  // Ray into the occluder's morph-local space (t parameter is preserved).
  vec3 roL = qrot(qconj(q), roW - center) / S;
  vec3 rdL = qrot(qconj(q), rdW) / S;

  int triBase = uSegTriStart[seg];
  int tcount = uSegTriCount[seg];
  float tEnter = -1e9;
  float tExit = 1e9;
  vec3 enterN = vec3(0.0);
  for (int t = 0; t < tcount; t++) {
    int gi = (triBase + t) * 2;
    vec4 p0 = texelFetch(uPlaneTex, texel(gi, uPlaneTexW), 0);
    if (dot(p0.xyz, p0.xyz) < 0.25) continue; // inactive (degenerate) triangle
    vec4 p1 = texelFetch(uPlaneTex, texel(gi + 1, uPlaneTexW), 0);
    vec3 n = normalize(mix(p0.xyz, p1.xyz, localT));
    float d = mix(p0.w, p1.w, localT);
    float denom = dot(n, rdL);
    float num = d - dot(n, roL);
    if (abs(denom) < 1e-9) {
      if (num < 0.0) return false; // parallel and outside this half-space
      continue;
    }
    float th = num / denom;
    if (denom < 0.0) { if (th > tEnter) { tEnter = th; enterN = n; } }
    else { if (th < tExit) tExit = th; }
  }
  if (tEnter <= tExit && tExit > 1e-4) {
    tHit = tEnter;
    nW = qrot(q, enterN);
    return true;
  }
  return false;
}

// Cheap ray-sphere reject (bounding radius = scale * uMaxCircumradius) skips the
// full hull trace for occluders the shadow ray can't reach.
float traceShadow(vec3 p, vec3 L, float distToLight) {
  for (int s = 0; s < vShadowCount; s++) {
    int oi = int(texelFetch(uShadowIndexTex, texel(vShadowOffset + s, uShadowIndexW), 0).r + 0.5);
    vec4 t0 = texelFetch(uOccTransformTex, texel(oi * 4, uOccTransformTexW), 0);
    vec3 D = t0.xyz - p;
    float r = t0.w * uMaxCircumradius;
    float t = dot(D, L);
    float perp2 = dot(D, D) - t * t;
    if (t <= -r || t >= distToLight + r || perp2 >= r * r) continue; // can't reach
    float tHit; vec3 nW;
    if (traceHull(oi, p, L, tHit, nW) && tHit > 1e-3 && tHit < distToLight) return 0.0;
  }
  return 1.0;
}

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
    float fall = falloff(dist, colRad.w);
    float lum = max(colRad.r, max(colRad.g, colRad.b));
    // skip lights that can't contribute: back-facing, out of radius, or dark
    if (dot(N, L) <= 0.0 || fall <= 1e-6 || lum <= 0.0) continue;
    float shadow = (doShadow && k < SHADOW_LIGHTS) ? traceShadow(p + N * 0.02, L, dist) : 1.0;
    lit += brdf(N, V, L, diffuseAlbedo, F0, rough, dist) * colRad.rgb * fall * shadow;
  }
  return lit;
}

// `N` is the reflecting surface normal: occluders behind the surface, behind the
// reflection ray, or that the ray misses are culled before the full hull trace.
bool traceReflection(vec3 ro, vec3 rd, vec3 N, out float bestT, out vec3 bestN, out int bestObj) {
  bestT = 1e9;
  bool hit = false;
  for (int s = 0; s < vReflCount; s++) {
    int oi = int(texelFetch(uReflIndexTex, texel(vReflOffset + s, uReflIndexW), 0).r + 0.5);
    vec4 t0 = texelFetch(uOccTransformTex, texel(oi * 4, uOccTransformTexW), 0);
    vec3 D = t0.xyz - ro;
    float r = t0.w * uMaxCircumradius;
    float t = dot(D, rd);
    float perp2 = dot(D, D) - t * t;
    if (dot(D, N) <= -r || t <= -r || perp2 >= r * r) continue; // behind surface/ray or missed
    float tHit; vec3 nW;
    if (traceHull(oi, ro, rd, tHit, nW) && tHit > 1e-3 && tHit < bestT) {
      bestT = tHit; bestN = nW; bestObj = oi; hit = true;
    }
  }
  return hit;
}

void main() {
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 N = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  if (dot(N, V) < 0.0) N = -N; // face the camera (winding-independent)

  vec3 lit = shadeDirect(vWorldPos, N, V, vColor, vRough, vMetal, vLightOffset, vLightCount, true);

  vec3 diffuseAlbedo = vColor * (1.0 - vMetal);
  lit += diffuseAlbedo * mix(vec3(0.02, 0.02, 0.03), vec3(0.05, 0.05, 0.06), 0.5 + 0.5 * N.y);

  if (vRough < REFL_ROUGHNESS_MAX) {
    vec3 F0 = mix(vec3(0.04), vColor, vMetal);
    vec3 Rdir = reflect(-V, N);
    float NdotV = max(dot(N, V), 0.0);
    vec3 envF = F0 + (max(vec3(1.0 - vRough), F0) - F0) * pow(1.0 - NdotV, 5.0);

    float ht; vec3 hN; int hObj;
    vec3 refl;
    if (traceReflection(vWorldPos + N * 0.02, Rdir, N, ht, hN, hObj)) {
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
