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
uniform float uLightScale; // global light-brightness multiplier (debug-tunable)
uniform float uAmplitude;  // measured output RMS — drives the amplitude-reactive light subset
uniform float uAmpGain;    // how hard that subset reacts
uniform int uShadowCap;    // FPS-autoscale caps (min'd with the distance-LOD caps below)
uniform int uReflCap;
uniform int uLightCap;
uniform samplerCube uStarCube; // baked starfield -> real stars in reflections (sampled by direction)
uniform float uLightTime; // separate clock for the orbiting lights (toggleable)
uniform float uSpawn;       // spawn-in intro clock (object scale + light reveal/ignite)
uniform float uLightsPerObject; // lights per object, to map a light to its host's spawn rank
uniform float uBeatTime[32];     // per-slot time (uMusicTime units) of the last note-on
uniform float uBeatStrength[32]; // per-slot note-on strength; light picks slot = idx % 32
uniform float uBeatSeed[32];     // per-slot note seed; picks a fresh subset of lights per note
uniform float uBeatDecay[32];    // per-slot pulse-decay factor (from note pitch; 1 = neutral)
uniform vec4 uRipple[4];          // brightness ripples (centre.xyz, startTime) — reflected too
uniform float uMusicTime;       // music clock the beat timestamps are measured in
uniform float uScaleNotes;      // pdx music-scale note counter (smoothed); objects pulse in size
uniform sampler2D uMorphPTex;   // per-object morph position (CPU note-stepped), indexed by object id
uniform highp int uMorphPTexW;  // highp: shared with the vertex stage, must match precision
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

vec3 brdf(vec3 N, vec3 V, vec3 L, vec3 diffuseAlbedo, vec3 F0, float roughness, float dist, float fallD, float fallS) {
  vec3 H = normalize(V + L);
  float NdotL = max(dot(N, L), 0.0);
  float NdotV = max(dot(N, V), 1e-4);
  float NdotH = max(dot(N, H), 0.0);
  float LdotH = max(dot(L, H), 0.0);
  float specRough = min(roughness, 0.06); // clamp -> very tight, sprite-reflection-like highlights
  float alpha = specRough * specRough;
  float wAlpha = clamp(alpha + 0.015 / (3.0 * dist), 0.0, 1.0); // minimal light-size widening -> tighter still
  float wAlpha2 = wAlpha * wAlpha;
  float energy = (alpha / wAlpha) * (alpha / wAlpha);
  float dDen = NdotH * NdotH * (wAlpha2 - 1.0) + 1.0;
  float D = energy * wAlpha2 / (dDen * dDen);
  float a2 = alpha * alpha;
  float smithV = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2);
  float smithL = NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
  float Vis = 0.5 / max(smithV + smithL, 1e-5);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - LdotH, 5.0);
  // Diffuse uses the normal falloff; the specular highlight reaches 4x further (fallS) and is
  // brighter, so it reads as a tight bright reflection of the light sprite.
  return (diffuseAlbedo * fallD + D * Vis * F * 20.0 * fallS) * NdotL;
}

// --- Fast analytic occluder traces (exact-shape fast path) -----------------
// Objects dwell at exact solids (the note-stepped morph rests at integer p), so when an
// occluder is at an exact shape — no morph blend — we trace its hull analytically from
// hardcoded face-normal directions instead of fetching + normalizing + blending every
// face plane. Centrally-symmetric solids = face/2 slabs (|n.x| <= d); the cube is 3 axis
// slabs (pdx-gfx BoxTrace). `d` (inradius) is read once from the plane data so the result
// matches the plane-march exactly. The ray is already in normalized local space.
#define SH_NONE 0
#define SH_CUBE 1
#define SH_OCTA 2
#define SH_TETRA 3
#define SH_RHDOD 4
#define SH_DODECA 5
#define SH_ICOSA 6

// One slab |dot(n,x)| <= d (n unit): fold into the running entry(max)/exit(min) interval.
void slab(vec3 n, vec3 roL, vec3 rdL, float d, inout float tEnter, inout float tExit, inout vec3 enterN) {
  float denom = dot(n, rdL);
  float o = dot(n, roL);
  if (abs(denom) < 1e-9) { if (abs(o) > d) tExit = -1e9; return; } // parallel + outside -> miss
  float ta = (d - o) / denom;
  float tb = (-d - o) / denom;
  float near = min(ta, tb), far = max(ta, tb);
  if (near > tEnter) { tEnter = near; enterN = (ta < tb) ? n : -n; }
  tExit = min(tExit, far);
}

// One outward half-space dot(n,x) <= d (n unit): for non-centrally-symmetric solids (tetra).
void halfspace(vec3 n, vec3 roL, vec3 rdL, float d, inout float tEnter, inout float tExit, inout vec3 enterN) {
  float denom = dot(n, rdL);
  float num = d - dot(n, roL);
  if (abs(denom) < 1e-9) { if (num < 0.0) tExit = -1e9; return; } // parallel + outside -> miss
  float th = num / denom;
  if (denom < 0.0) { if (th > tEnter) { tEnter = th; enterN = n; } }
  else tExit = min(tExit, th);
}

// Axis-aligned cube, half-extent h (= inradius): branchless 3-slab (pdx-gfx BoxTrace).
void boxTrace(vec3 roL, vec3 rdL, float h, inout float tEnter, inout float tExit, inout vec3 enterN) {
  vec3 invD = 1.0 / rdL;
  vec3 t0 = (-vec3(h) - roL) * invD;
  vec3 t1 = (vec3(h) - roL) * invD;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  tEnter = max(max(tmin.x, tmin.y), tmin.z);
  tExit = min(min(tmax.x, tmax.y), tmax.z);
  enterN = (tmin.x >= tmin.y && tmin.x >= tmin.z) ? vec3(-sign(rdL.x), 0.0, 0.0)
         : (tmin.y >= tmin.z) ? vec3(0.0, -sign(rdL.y), 0.0)
         : vec3(0.0, 0.0, -sign(rdL.z));
}

// Journey p -> exact shape (fixed by the morph sequence in journey.js).
int shapeAtP(int pInt) {
  if (pInt == 0) return SH_TETRA;               // p0 = tetrahedron
  if (pInt == 1 || pInt == 5) return SH_OCTA;   // p1, p5 = octahedron
  if (pInt == 2 || pInt == 4) return SH_RHDOD;  // p2, p4 = rhombic dodecahedron
  if (pInt == 3) return SH_CUBE;                // p3 = cube
  if (pInt == 6 || pInt == 10) return SH_ICOSA; // p6, p10 = icosahedron
  if (pInt == 8) return SH_DODECA;              // p8 = dodecahedron
  return SH_NONE; // p7, p9 (rhombic triacontahedron) + active morphs: plane march
}

// Convex-hull trace of occluder `oi` against a world ray. Rebuilds the occluder's
// current hull from its transform + phase and slab-traces every triangle plane.
// Returns world-space entry distance and entry-plane normal.
bool traceHull(int oi, vec3 roW, vec3 rdW, out float tHit, out vec3 nW) {
  // Respect the spawn-in: an un-spawned object casts no shadow / shows no reflection. This cheap
  // early-out needs only oi + uSpawn, so do it BEFORE the transform fetches — un-spawned occluders
  // then cost zero texel fetches in the hot shadow/reflection loop.
  float reveal = spawnReveal(float(oi), uSpawn);
  if (reveal <= 1e-4) return false;

  int b = oi * 4;
  vec4 t0 = texelFetch(uOccTransformTex, texel(b, uOccTransformTexW), 0);
  vec4 baseQ = texelFetch(uOccTransformTex, texel(b + 1, uOccTransformTexW), 0);
  vec4 t2 = texelFetch(uOccTransformTex, texel(b + 2, uOccTransformTexW), 0); // t3 (phaseOff/morphSpeed) was dead -> dropped
  vec3 center = t0.xyz;
  float scale = t0.w;

  float p = texelFetch(uMorphPTex, texel(oi, uMorphPTexW), 0).r;
  int seg = int(floor(p));
  float localT = fract(p);
  if (seg >= int(uNumSegments + 0.5)) { seg = int(uNumSegments + 0.5) - 1; localT = 1.0; }

  vec4 q = qmul(quatAxisAngle(t2.xyz, uTime * t2.w + spinKick(oi, uBeatTime[oi % 32], uBeatSeed[oi % 32], uMusicTime)), baseQ);
  float S = scale * lookupNorm(p) * musicScale(oi, uScaleNotes) * reveal; // match the vertex's scale incl. spawn-in

  // Ray into the occluder's morph-local space (t parameter is preserved).
  vec3 roL = qrot(qconj(q), roW - center) / S;
  vec3 rdL = qrot(qconj(q), rdW) / S;

  int triBase = uSegTriStart[seg];
  int tcount = uSegTriCount[seg];

  // Exact-shape fast path: at an exact solid (localT ~ 0 or 1, no blend) trace it
  // analytically from hardcoded normals. d (inradius) read once from the data (start face
  // at localT~0, end face at localT~1) so it matches the plane march below.
  int pInt = int(floor(p + 0.5));
  int shapeType = (localT < 0.002 || localT > 0.998) ? shapeAtP(pInt) : SH_NONE;
  if (shapeType != SH_NONE) {
    float d = (localT < 0.002) ? texelFetch(uPlaneTex, texel(triBase * 2, uPlaneTexW), 0).w
                               : texelFetch(uPlaneTex, texel(triBase * 2 + 1, uPlaneTexW), 0).w;
    float aEnter = -1e9, aExit = 1e9; vec3 aN = vec3(0.0);
    if (shapeType == SH_CUBE) {
      boxTrace(roL, rdL, d, aEnter, aExit, aN);
    } else if (shapeType == SH_OCTA) { // 8 faces = 4 antipodal pairs (cube diagonals)
      float k = inversesqrt(3.0);
      slab(vec3(1.0, 1.0, 1.0) * k, roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(1.0, 1.0, -1.0) * k, roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(1.0, -1.0, 1.0) * k, roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(1.0, -1.0, -1.0) * k, roL, rdL, d, aEnter, aExit, aN);
    } else if (shapeType == SH_TETRA) { // 4 faces, not centrally symmetric -> 4 half-spaces
      halfspace(vec3(0.47140, 0.33333, 0.81650), roL, rdL, d, aEnter, aExit, aN);
      halfspace(vec3(0.94281, -0.33333, 0.0), roL, rdL, d, aEnter, aExit, aN);
      halfspace(vec3(0.47140, 0.33333, -0.81650), roL, rdL, d, aEnter, aExit, aN);
      halfspace(vec3(0.0, 1.0, 0.0), roL, rdL, d, aEnter, aExit, aN);
    } else if (shapeType == SH_RHDOD) { // 12 rhombic faces = 6 antipodal pairs (<110>)
      float k = inversesqrt(2.0);
      slab(vec3(0.0, 1.0, 1.0) * k, roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(0.0, 1.0, -1.0) * k, roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(1.0, 0.0, 1.0) * k, roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(1.0, 0.0, -1.0) * k, roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(1.0, 1.0, 0.0) * k, roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(1.0, -1.0, 0.0) * k, roL, rdL, d, aEnter, aExit, aN);
    } else if (shapeType == SH_DODECA) { // 12 faces = 6 antipodal pairs
      slab(vec3(0.0, 0.52573, 0.85065), roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(0.85065, 0.0, 0.52573), roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(0.52573, 0.85065, 0.0), roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(0.85065, 0.0, -0.52573), roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(0.0, 0.52573, -0.85065), roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(0.52573, -0.85065, 0.0), roL, rdL, d, aEnter, aExit, aN);
    } else { // SH_ICOSA: 20 faces = 10 antipodal pairs
      slab(vec3(0.57735, 0.57735, 0.57735), roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(0.35682, 0.0, 0.93417), roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(0.0, 0.93417, 0.35682), roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(0.35682, 0.0, -0.93417), roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(0.57735, -0.57735, -0.57735), roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(0.93417, 0.35682, 0.0), roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(0.57735, -0.57735, 0.57735), roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(0.93417, -0.35682, 0.0), roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(0.57735, 0.57735, -0.57735), roL, rdL, d, aEnter, aExit, aN);
      slab(vec3(0.0, 0.93417, -0.35682), roL, rdL, d, aEnter, aExit, aN);
    }
    if (aEnter <= aExit && aExit > 1e-4) { tHit = aEnter; nW = qrot(q, aN); return true; }
    return false;
  }

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
                 int lo, int lc, bool doShadow, int shadowCap, int lightCap) {
  vec3 diffuseAlbedo = albedo * (1.0 - metal);
  vec3 F0 = mix(vec3(0.04), albedo, metal);
  vec3 lit = vec3(0.0);
  for (int k = 0; k < lc && k < lightCap; k++) {
    int idx = int(texelFetch(uLightIndexTex, texel(lo + k, uIndexTexW), 0).r + 0.5);
    vec4 c0 = texelFetch(uLightsTex, texel(idx * 2, uLightsTexW), 0); // center.xyz, orbitRadius
    vec3 lightPos = c0.xyz + c0.w * animLightDir(idx, uLightTime, lightKick(idx, uBeatTime[idx % 32], uBeatSeed[idx % 32], uMusicTime)); // orbit + note-kick
    vec4 colRad = texelFetch(uLightsTex, texel(idx * 2 + 1, uLightsTexW), 0);
    vec3 L = lightPos - p;
    float dist = length(L);
    L /= max(dist, 1e-4);
    float fallD = falloff(dist, colRad.w);           // diffuse: normal radius
    float fallS = falloff(dist, colRad.w * 4.0);     // specular: reaches 4x the radius
    float lum = max(colRad.r, max(colRad.g, colRad.b));
    // skip lights that can't contribute: back-facing, beyond the specular reach, or dark
    if (dot(N, L) <= 0.0 || fallS <= 1e-6 || lum <= 0.0) continue;
    int band = idx % 32;
    float hostSlot = floor(float(idx) / uLightsPerObject); // this light's host object rank
    // Lights fade in just after their host object; the ~30% amplitude subset uses ONLY the
    // measured amplitude (no per-note flare), matching their sprites.
    float reveal = lightSpawnFade(hostSlot, uSpawn);
    float beat = musicFlare(idx, uBeatTime[band], uBeatStrength[band], uMusicTime, uBeatDecay[band]) * musicBeatLit(idx, uBeatSeed[band]);
    // beat flares halved (the amplitude subset rides uAmplitude*uAmpGain, min 0); the nearest
    // BATH_LIGHTS get a steady AMP_BASE fill EXCEPT the amplitude subset, which stays dark when quiet.
    float emission = reveal * (mix(0.5 * beat, uAmplitude * uAmpGain, ampLit(idx)) + (k < BATH_LIGHTS ? AMP_BASE * (1.0 - ampLit(idx)) : 0.0));
    if (emission <= 1e-5) continue; // not emitting (pre-reveal or between beats) -> skip shadow + BRDF
    float shadow = (doShadow && k < shadowCap) ? traceShadow(p + N * 0.02, L, dist) : 1.0;
    lit += brdf(N, V, L, diffuseAlbedo, F0, rough, dist, fallD, fallS) * colRad.rgb * uLightScale * shadow * emission;
  }
  return lit;
}

// `N` is the reflecting surface normal: occluders behind the surface, behind the
// reflection ray, or that the ray misses are culled before the full hull trace.
bool traceReflection(vec3 ro, vec3 rd, vec3 N, int maxRefl, out float bestT, out vec3 bestN, out int bestObj) {
  bestT = 1e9;
  bool hit = false;
  for (int s = 0; s < vReflCount && s < maxRefl; s++) {
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

  // Distance LOD: far surfaces trace fewer shadow lights + reflection occluders (helps fps;
  // the close hero keeps its full counts).
  float lod = clamp((distance(vWorldPos, cameraPosition) - 8.0) / 40.0, 0.0, 1.0);
  int shadowCap = min(int(mix(float(SHADOW_LIGHTS), 2.0, lod)), uShadowCap);
  int reflCap = min(int(mix(float(vReflCount), 8.0, lod)), uReflCap);
  int lightCap = min(int(mix(float(vLightCount), 12.0, lod)), uLightCap); // far surfaces shade fewer; the autoscaler caps further

  vec3 lit = shadeDirect(vWorldPos, N, V, vColor, vRough, vMetal, vLightOffset, vLightCount, true, shadowCap, lightCap);

  vec3 diffuseAlbedo = vColor * (1.0 - vMetal);
  // Full ambient/environment term (no AO): shadowing it hid the soft env reflection.
  lit += diffuseAlbedo * mix(vec3(0.02, 0.02, 0.03), vec3(0.05, 0.05, 0.06), 0.5 + 0.5 * N.y);
  // Directional moonlight on the scene, occluded by the clouds -> the field dapples under cover.
  lit += diffuseAlbedo * uSunColor * uMoonStrength * (0.3 + 0.7 * max(dot(N, uSunDir), 0.0))
       * cloudShadow(vWorldPos, uSunDir, uTime) * uLightScale;

  if (vRough < REFL_ROUGHNESS_MAX) {
    vec3 F0 = mix(vec3(0.04), vColor, vMetal);
    vec3 Rdir = reflect(-V, N);
    float NdotV = max(dot(N, V), 0.0);
    vec3 envF = F0 + (max(vec3(1.0 - vRough), F0) - F0) * pow(1.0 - NdotV, 5.0);

    float ht; vec3 hN; int hObj;
    vec3 refl;
    int reflLo = -1, reflLc = 0; // hit object's light list -> reflect its sprites as blobs
    if (traceReflection(vWorldPos + N * 0.02, Rdir, N, reflCap, ht, hN, hObj)) {
      vec3 hp = vWorldPos + ht * Rdir;
      vec4 m0 = texelFetch(uInstanceTex, texel(hObj * 2, uInstanceTexW), 0);
      vec4 m1 = texelFetch(uInstanceTex, texel(hObj * 2 + 1, uInstanceTexW), 0);
      refl = shadeDirect(hp, hN, -Rdir, m0.rgb, m0.a, m1.z, int(m1.x + 0.5), int(m1.y + 0.5), false, 4, 32);
      refl += m0.rgb * skyClouds(hp, reflect(Rdir, hN), uTime, 7) * 0.3; // 2nd bounce: B reflects the sky + clouds
      reflLo = int(m1.x + 0.5); reflLc = int(m1.y + 0.5);
    } else {
      refl = environment(Rdir) + texture(uStarCube, Rdir).rgb; // sky + real stars; clouds composited below
    }
    // Reflect light sprites as blobs: the surface's OWN orbiting lights in front of the reflected
    // hit (the swirling effect on the hero, which is what was visible before) PLUS the hit
    // object's lights around it.
    vec3 rro = vWorldPos + N * 0.02;
    for (int k = 0; k < vLightCount && k < lightCap && k < 128; k++) {
      int li = int(texelFetch(uLightIndexTex, texel(vLightOffset + k, uIndexTexW), 0).r + 0.5);
      vec4 lc0 = texelFetch(uLightsTex, texel(li * 2, uLightsTexW), 0);
      vec3 lp = lc0.xyz + lc0.w * animLightDir(li, uLightTime, lightKick(li, uBeatTime[li % 32], uBeatSeed[li % 32], uMusicTime));
      vec3 toL = lp - rro;
      float tL = dot(toL, Rdir);
      if (tL <= 0.02 || tL > ht) continue; // in front of the surface, before the reflected hit
      int lband = li % 32;
      float lhost = floor(float(li) / uLightsPerObject);
      float e = step(lhost, uSpawn) * (mix(0.5 * musicFlare(li, uBeatTime[lband], uBeatStrength[lband], uMusicTime, uBeatDecay[lband]) * musicBeatLit(li, uBeatSeed[lband]), uAmplitude * uAmpGain, ampLit(li)) + ripplePulse(lp, uRipple, uMusicTime) + (k < BATH_LIGHTS ? AMP_BASE * (1.0 - ampLit(li)) : 0.0));
      if (e <= 1e-4) continue;
      float perp = length(toL - Rdir * tL);
      float r = perp / (0.3 + 0.5 * e);
      if (r < 1.0) refl += texelFetch(uLightsTex, texel(li * 2 + 1, uLightsTexW), 0).rgb * e * pow(1.0 - r, 6.0) * 5.0;
    }
    for (int k = 0; reflLo >= 0 && k < reflLc && k < 128; k++) {
      int li = int(texelFetch(uLightIndexTex, texel(reflLo + k, uIndexTexW), 0).r + 0.5);
      vec4 lc0 = texelFetch(uLightsTex, texel(li * 2, uLightsTexW), 0);
      vec3 lp = lc0.xyz + lc0.w * animLightDir(li, uLightTime, lightKick(li, uBeatTime[li % 32], uBeatSeed[li % 32], uMusicTime));
      vec3 toL = lp - rro;
      float tL = dot(toL, Rdir);
      if (tL <= 0.5) continue;
      int lband = li % 32;
      float lhost = floor(float(li) / uLightsPerObject);
      float e = step(lhost, uSpawn) * (mix(0.5 * musicFlare(li, uBeatTime[lband], uBeatStrength[lband], uMusicTime, uBeatDecay[lband]) * musicBeatLit(li, uBeatSeed[lband]), uAmplitude * uAmpGain, ampLit(li)) + ripplePulse(lp, uRipple, uMusicTime) + (k < BATH_LIGHTS ? AMP_BASE * (1.0 - ampLit(li)) : 0.0));
      if (e <= 1e-4) continue;
      float perp = length(toL - Rdir * tL);
      float r = perp / (0.3 + 0.5 * e);
      if (r < 1.0) refl += texelFetch(uLightsTex, texel(li * 2 + 1, uLightsTexW), 0).rgb * e * pow(1.0 - r, 6.0) * 5.0;
    }
    // Volumetric clouds IN FRONT of the reflected geometry (bounded by the reflected hit distance ht).
    refl = skyCloudsOver(refl, rro, Rdir, uTime, ht, int(uReflCloudSteps));
    lit += refl * envF;
  }

  fragColor = vec4(lit, 1.0); // linear HDR; tone-mapped in the post pass
}
