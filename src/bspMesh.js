import * as THREE from 'three';
import libGlsl from './shaders/lib.glsl?raw';

// Builds a renderable THREE mesh from a parsed wrackdm17 BSP and places it above the cloud deck.
// Q3 is Z-up; we rotate to the demo's Y-up via (qx, qy, qz) -> (qx, qz, -qy) (a -90deg X rotation,
// handedness preserved). The whole map is scaled down and offset so its floor floats just above the
// cloud top. The returned `transform` (scale + offset, in CONVERTED Y-up space) is reused by the
// brush-occluder builder so the raytraced shadows/reflections share one world space.

// Editor/structural surfaces that aren't drawn in-game.
const SKIP = ['common/caulk', 'common/nodraw', 'common/clip', 'common/hint', 'common/skip',
  'common/trigger', 'common/origin', 'common/areaportal', 'common/weapclip', 'common/donotenter',
  'common/nodrop', 'common/full_clip', 'common/clusterportal', 'common/botclip'];

const PLACE = { scale: 0.013, floorY: 64.0 }; // footprint ~100u; floor just above cloud top (base 24 + thick 32 = 56)
const PATCH_LEVEL = 6; // bezier patch tessellation per 3x3 subpatch (placeholder; raytraced later)

// Q3 surfaceFlags we never want to draw: the enclosing sky shell, nodraw/hint/skip helpers.
const SURF_SKY = 0x4, SURF_NODRAW = 0x80, SURF_HINT = 0x100, SURF_SKIP = 0x200;
const SURF_DROP = SURF_SKY | SURF_NODRAW | SURF_HINT | SURF_SKIP;

// A face is drawn only if it's a polygon/mesh/patch with a real, non-structural, non-sky surface.
function drawable(face, textures) {
  if (face.type !== 1 && face.type !== 2 && face.type !== 3) return false; // skip billboards (4)
  const t = textures[face.texture];
  if (!t || !t.name || t.name === 'noshader') return false;
  if (t.flags & SURF_DROP) return false;
  if (t.name.indexOf('sky') !== -1) return false; // skies2/nebula2 etc. (the bounds shell)
  for (const s of SKIP) if (t.name.indexOf(s) !== -1) return false;
  return true;
}

// Cheap deterministic name hash -> a muted albedo, biased by material family so the level reads as
// a dim metal arena (placeholder until the real textures stream in, phase 6). Lights read brighter.
function albedoFor(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  const j = ((h >>> 8) & 0xff) / 255 - 0.5; // -0.5..0.5 jitter
  const has = (s) => name.indexOf(s) !== -1;
  let r, g, b;
  if (has('light') || has('flare') || has('jpad') || has('launch')) { r = 0.55; g = 0.5; b = 0.42; } // warm, brighter
  else if (has('rust') || has('trim')) { r = 0.22; g = 0.15; b = 0.11; }                              // rust brown
  else if (has('floor') || has('clang') || has('hfloor')) { r = 0.15; g = 0.17; b = 0.2; }            // cool steel floor
  else if (has('wall') || has('metal') || has('shiny') || has('plate') || has('support')) { r = 0.17; g = 0.18; b = 0.2; } // steel
  else if (has('banner')) { r = 0.2; g = 0.1; b = 0.1; }                                              // dim banner
  else { r = 0.16; g = 0.16; b = 0.18; }                                                              // default grey
  const k = 1.0 + j * 0.25; // +-12% lightness jitter
  return [r * k, g * k, b * k];
}

export function buildBspMesh(parsed, manifest) {
  const { verts, meshverts, faces, textures } = parsed;
  const n = verts.count;
  const mat = (name) => (manifest && manifest[name]) || null;

  // Convert all verts to Y-up once: (qx, qy, qz) -> (qx, qz, -qy), a -90deg X rotation
  // (handedness + winding preserved). Normals convert the same way.
  const conv = new Float32Array(n * 3), cn = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    conv[i * 3] = verts.position[i * 3]; conv[i * 3 + 1] = verts.position[i * 3 + 2]; conv[i * 3 + 2] = -verts.position[i * 3 + 1];
    cn[i * 3] = verts.normal[i * 3]; cn[i * 3 + 1] = verts.normal[i * 3 + 2]; cn[i * 3 + 2] = -verts.normal[i * 3 + 1];
  }

  // Placement AABB over the DRAWN geometry only (excluding the huge sky/bounds shell).
  let mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
  for (const f of faces) {
    if (!drawable(f, textures) || mat(textures[f.texture].name)?.mode === 'sky') continue;
    for (let v = f.vertex; v < f.vertex + f.n_vertexes; v++) {
      const x = conv[v * 3], y = conv[v * 3 + 1], z = conv[v * 3 + 2];
      if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
      if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
    }
  }
  const scale = PLACE.scale;
  const offset = [-((mnx + mxx) * 0.5) * scale, PLACE.floorY - mny * scale, -((mnz + mxz) * 0.5) * scale];
  const wx = (i) => conv[i * 3] * scale + offset[0];
  const wy = (i) => conv[i * 3 + 1] * scale + offset[1];
  const wz = (i) => conv[i * 3 + 2] * scale + offset[2];

  // Three render passes: opaque (lit), transparent (alpha-blended, lit), glow (additive emissive).
  // A glowing surface (e.g. gothic_light) lands in BOTH opaque (its diffuse) and glow (its additive
  // stage). Each pass buckets faces by texture -> draw-groups + a material array.
  const mkPass = () => ({ P: [], N: [], C: [], U: [], M: [], buckets: new Map() });
  const passes = { opaque: mkPass(), trans: mkPass(), glow: mkPass() };
  const bucketOf = (p, tex) => { let b = p.buckets.get(tex); if (!b) { b = []; p.buckets.set(tex, b); } return b; };
  const emit = (p, f, alb) => {
    const idx = bucketOf(p, f.texture);
    if (f.type === 1 || f.type === 3) {
      const start = p.P.length / 3;
      for (let v = f.vertex; v < f.vertex + f.n_vertexes; v++) {
        p.P.push(wx(v), wy(v), wz(v)); p.N.push(cn[v * 3], cn[v * 3 + 1], cn[v * 3 + 2]);
        p.C.push(alb[0], alb[1], alb[2]); p.U.push(verts.uv[v * 2], verts.uv[v * 2 + 1]); p.M.push(f.texture);
      }
      for (let k = 0; k < f.n_meshverts; k++) idx.push(start + meshverts[f.meshvert + k]);
    } else if (f.type === 2) {
      tessellatePatch(f, conv, cn, verts.uv, scale, offset, alb, p.P, p.N, p.C, p.U, p.M, idx);
    }
  };

  for (const f of faces) {
    if (!drawable(f, textures)) continue;
    const name = textures[f.texture].name;
    const m = mat(name);
    const mode = m ? m.mode : 'opaque';
    if (mode === 'sky') continue;
    const alb = albedoFor(name);
    if (mode === 'add') emit(passes.glow, f, alb);                       // wholly-additive (flares)
    else emit(mode === 'blend' ? passes.trans : passes.opaque, f, alb);  // alpha or solid
    if (m && m.glow) emit(passes.glow, f, alb);                          // additive glow overlay
  }

  const build = (p) => {
    const I = [], slots = [], groups = [];
    for (const [tex, arr] of p.buckets) {
      if (!arr.length) continue;
      groups.push({ start: I.length, count: arr.length, slot: slots.length });
      for (let i = 0; i < arr.length; i++) I.push(arr[i]);
      slots.push({ texIndex: tex, name: textures[tex].name, mat: mat(textures[tex].name) });
    }
    if (!I.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p.P), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(p.N), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(p.C), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(p.U), 2));
    g.setAttribute('aMaterial', new THREE.BufferAttribute(new Float32Array(p.M), 1));
    g.setIndex(I);
    for (const gr of groups) g.addGroup(gr.start, gr.count, gr.slot);
    g.computeBoundingSphere();
    return { geometry: g, slots };
  };

  return { opaque: build(passes.opaque), transparent: build(passes.trans), glow: build(passes.glow), transform: { scale, offset } };
}

// Tessellate a Q3 biquadratic bezier patch (face.type 2) into triangles — "ordinary geometry to do
// normals", but with EXACT analytic surface normals (the true cross(dS/du, dS/dv), not interpolated
// control normals) so the curvature shades perfectly smooth with no facets. The (w x h) control grid
// decomposes into 3x3 subpatches sampled PATCH_LEVEL+1 per axis; positions/derivatives are the bezier
// of the (affine-transformed) control points. Shadows are cast by the convex brush volumes (P7a).
const bern = (t) => [(1 - t) * (1 - t), 2 * t * (1 - t), t * t]; // quadratic Bernstein basis
const dbern = (t) => [2 * (t - 1), 2 - 4 * t, 2 * t];           // its derivative
function tessellatePatch(f, conv, cn, uv, scale, offset, alb, P, N, C, U, M, I) {
  const w = f.size[0], h = f.size[1], L = PATCH_LEVEL;
  if (w < 3 || h < 3) return;
  const ctrl = (cr, cc) => f.vertex + cr * w + cc; // vert index of control point (row, col)
  for (let psj = 0; psj < (h - 1) / 2; psj++) {
    for (let psi = 0; psi < (w - 1) / 2; psi++) {
      const start = P.length / 3;
      for (let sj = 0; sj <= L; sj++) {
        const bv = bern(sj / L), dbv = dbern(sj / L);
        for (let si = 0; si <= L; si++) {
          const bu = bern(si / L), dbu = dbern(si / L);
          let px = 0, py = 0, pz = 0, rnx = 0, rny = 0, rnz = 0, u0 = 0, u1 = 0;
          let dux = 0, duy = 0, duz = 0, dvx = 0, dvy = 0, dvz = 0; // dS/du, dS/dv (converted space)
          for (let bj = 0; bj < 3; bj++) for (let bi = 0; bi < 3; bi++) {
            const ci = ctrl(psj * 2 + bj, psi * 2 + bi);
            const cx = conv[ci * 3], cy = conv[ci * 3 + 1], cz = conv[ci * 3 + 2];
            const wgt = bu[bi] * bv[bj], wu = dbu[bi] * bv[bj], wv = bu[bi] * dbv[bj];
            px += wgt * cx; py += wgt * cy; pz += wgt * cz;
            dux += wu * cx; duy += wu * cy; duz += wu * cz;
            dvx += wv * cx; dvy += wv * cy; dvz += wv * cz;
            rnx += wgt * cn[ci * 3]; rny += wgt * cn[ci * 3 + 1]; rnz += wgt * cn[ci * 3 + 2]; // ref (orientation)
            u0 += wgt * uv[ci * 2]; u1 += wgt * uv[ci * 2 + 1];
          }
          // analytic normal = dS/du x dS/dv, oriented to the BSP's intended outward normal
          let nx = duy * dvz - duz * dvy, ny = duz * dvx - dux * dvz, nz = dux * dvy - duy * dvx;
          let nl = Math.hypot(nx, ny, nz);
          if (nl < 1e-9) { nx = rnx; ny = rny; nz = rnz; nl = Math.hypot(nx, ny, nz) || 1; } // degenerate sample
          if (nx * rnx + ny * rny + nz * rnz < 0.0) { nx = -nx; ny = -ny; nz = -nz; }
          P.push(px * scale + offset[0], py * scale + offset[1], pz * scale + offset[2]);
          N.push(nx / nl, ny / nl, nz / nl);
          C.push(alb[0], alb[1], alb[2]); U.push(u0, u1); M.push(f.texture);
        }
      }
      for (let sj = 0; sj < L; sj++) for (let si = 0; si < L; si++) {
        const a = start + sj * (L + 1) + si, b = a + 1, c = a + (L + 1), d = c + 1;
        I.push(a, b, c, b, d, c);
      }
    }
  }
}


// Stylized shading until the real textures arrive: placeholder albedo lit by a sky-hemisphere
// ambient (environment) + the moon, dappled by the cloud shadow it sits under. Shares the demo's
// uSunDir/uSunColor/uMoonStrength + cloud uniforms.
const VERT = `
in vec3 position; in vec3 normal; in vec3 color; in vec2 uv; in float aMaterial;
uniform mat4 projectionMatrix; uniform mat4 viewMatrix;
out vec3 vColor; out vec3 vNormal; out vec3 vWorldPos; out vec2 vUv; out float vMaterial;
void main() {
  vColor = color; vNormal = normal; vWorldPos = position; vUv = uv; vMaterial = aMaterial;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`;

const FRAG = `
in vec3 vColor; in vec3 vNormal; in vec3 vWorldPos; in vec2 vUv; in float vMaterial;
// uSunDir/uSunColor/uMoonStrength are declared in clouds.glsl; musicFlare/falloff helpers in lib.glsl.
uniform vec3 cameraPosition;
uniform float uTime;
uniform sampler2D uMap;   // this material's diffuse (streamed in; default 1x1 white until then)
uniform float uHasMap;    // 0 = stylized placeholder colour, 1 = texture
uniform float uAlphaTest; // 1 = discard low-alpha texels (grates/decals)
// music state (the lamps pulse with the beat)
uniform float uBeatTime[32]; uniform float uBeatStrength[32]; uniform float uBeatDecay[32];
uniform float uMusicTime; uniform float uAmplitude; uniform float uAmpGain;
// map point lights (fixed-position lamps synthesised from emissive faces — bspLights.js)
uniform sampler2D uMapLightsTex; uniform int uMapLightsW; uniform int uMapLightCount; uniform int uMapLightCap;
uniform float uMapLightScale;
// convex brush occluders for raytraced shadows (bspOccluders.js)
uniform sampler2D uMapPlaneTex; uniform int uMapPlaneW;
uniform sampler2D uMapBrushTex; uniform int uMapBrushW; uniform int uMapBrushCount; uniform int uMapShadowCap;
out vec4 fragColor;

const float MAP_BASE = 0.55; // lamps stay lit (a level's lights don't go dark); the beat adds on top

// Distance falloff + GGX BRDF (copied from morph.frag.glsl — kept self-contained; that file is
// merge-sensitive and must not be modified).
float falloff(float dist, float radius) {
  float a = clamp(1.0 - pow(dist / radius, 4.0), 0.0, 1.0);
  return a * a / (dist * dist + 1.0);
}
vec3 brdf(vec3 N, vec3 V, vec3 L, vec3 diffuseAlbedo, vec3 F0, float roughness, float dist, float fallD, float fallS) {
  vec3 H = normalize(V + L);
  float NdotL = max(dot(N, L), 0.0), NdotV = max(dot(N, V), 1e-4), NdotH = max(dot(N, H), 0.0), LdotH = max(dot(L, H), 0.0);
  float specRough = min(roughness, 0.18); float alpha = specRough * specRough;
  float wAlpha = clamp(alpha + 0.015 / (3.0 * dist), 0.0, 1.0); float wAlpha2 = wAlpha * wAlpha;
  float energy = (alpha / wAlpha) * (alpha / wAlpha);
  float dDen = NdotH * NdotH * (wAlpha2 - 1.0) + 1.0; float D = energy * wAlpha2 / (dDen * dDen);
  float a2 = alpha * alpha;
  float smithV = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2);
  float smithL = NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
  float Vis = 0.5 / max(smithV + smithL, 1e-5);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - LdotH, 5.0);
  return (diffuseAlbedo * fallD + D * Vis * F * 8.0 * fallS) * NdotL;
}

// Ray vs one convex brush (world-space half-space planes, static): the traceHull slab loop.
bool traceBrush(int bi, vec3 ro, vec3 rd, out float tHit) {
  vec4 b1 = texelFetch(uMapBrushTex, texel(bi * 2 + 1, uMapBrushW), 0);
  int ps = int(b1.x + 0.5), pc = int(b1.y + 0.5);
  float tEnter = -1e9, tExit = 1e9;
  for (int i = 0; i < 32; i++) {
    if (i >= pc) break;
    vec4 pl = texelFetch(uMapPlaneTex, texel(ps + i, uMapPlaneW), 0);
    float denom = dot(pl.xyz, rd), num = pl.w - dot(pl.xyz, ro);
    if (abs(denom) < 1e-9) { if (num < 0.0) return false; continue; }
    float th = num / denom;
    if (denom < 0.0) { if (th > tEnter) tEnter = th; } else { if (th < tExit) tExit = th; }
  }
  if (tEnter <= tExit && tExit > 1e-4) { tHit = tEnter; return true; }
  return false;
}
// Hard shadow toward a point light at distance distToLight (1 = lit, 0 = occluded).
float mapShadow(vec3 p, vec3 L, float distToLight) {
  for (int s = 0; s < uMapBrushCount; s++) {
    if (s >= uMapShadowCap) break;
    vec4 b0 = texelFetch(uMapBrushTex, texel(s * 2, uMapBrushW), 0);
    vec3 D = b0.xyz - p; float r = b0.w, t = dot(D, L), perp2 = dot(D, D) - t * t;
    if (t <= -r || t >= distToLight + r || perp2 >= r * r) continue;
    float tHit;
    if (traceBrush(s, p, L, tHit) && tHit > 1e-3 && tHit < distToLight) return 0.0;
  }
  return 1.0;
}
// Directional (moon) self-shadow — same brushes, no far bound.
float mapSunShadow(vec3 p, vec3 sunDir) {
  for (int s = 0; s < uMapBrushCount; s++) {
    if (s >= uMapShadowCap) break;
    vec4 b0 = texelFetch(uMapBrushTex, texel(s * 2, uMapBrushW), 0);
    vec3 D = b0.xyz - p; float r = b0.w, t = dot(D, sunDir), perp2 = dot(D, D) - t * t;
    if (t <= -r || perp2 >= r * r) continue;
    float tHit;
    if (traceBrush(s, p, sunDir, tHit) && tHit > 1e-3) return 0.0;
  }
  return 1.0;
}
// Sum the level's lamps: dual falloff BRDF + per-light raytraced shadow + music-pulsed brightness.
vec3 shadeMapLights(vec3 p, vec3 N, vec3 V, vec3 albedo) {
  vec3 F0 = vec3(0.04); vec3 lit = vec3(0.0);
  for (int k = 0; k < uMapLightCount; k++) {
    if (k >= uMapLightCap) break;
    vec4 l0 = texelFetch(uMapLightsTex, texel(k * 2, uMapLightsW), 0);     // pos.xyz, band
    vec4 l1 = texelFetch(uMapLightsTex, texel(k * 2 + 1, uMapLightsW), 0); // color.rgb, radius
    vec3 L = l0.xyz - p; float dist = length(L); L /= max(dist, 1e-4);
    float fallS = falloff(dist, l1.w * 4.0);
    if (dot(N, L) <= 0.0 || fallS <= 1e-6) continue;          // out of reach -> no shadow ray cost
    int band = int(l0.w + 0.5);
    float flare = musicFlare(band, uBeatTime[band], uBeatStrength[band], uMusicTime, uBeatDecay[band]);
    float emission = MAP_BASE + 0.6 * flare + uAmplitude * uAmpGain * 0.15;
    float sh = mapShadow(p + N * 0.02, L, dist);
    lit += brdf(N, V, L, albedo, F0, 0.5, dist, falloff(dist, l1.w), fallS) * l1.rgb * uMapLightScale * sh * emission;
  }
  return lit;
}

// The level's environment (ambient fill + faux reflection): the night sky PLUS the moon (a glow
// toward uSunDir) and the moonlit cloud deck the level floats above (downward-facing surfaces catch
// its bounce) — so the moon + clouds are in q3dm17's environment, not just a bare gradient.
vec3 mapEnv(vec3 n) {
  vec3 e = environment(n) * 1.6 + 0.02;                                          // night-sky hemisphere
  e += uSunColor * uMoonStrength * pow(max(dot(n, uSunDir), 0.0), 6.0) * 0.7;    // moon-direction glow
  float down = clamp(-n.y, 0.0, 1.0);                                            // facing the deck below
  e += (uSunColor * uMoonStrength * 0.5 + uCloudAmbient * 0.15) * down * step(0.5, uCloudsOn); // cloud bounce
  return e;
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  if (dot(N, V) < 0.0) N = -N;                              // face the camera (DoubleSide)
  vec4 tex = texture(uMap, vUv);
  float texA = (uHasMap > 0.5) ? tex.a : 1.0;
  if (uAlphaTest > 0.5 && texA < 0.5) discard;              // alpha-tested grates/decals
  vec3 base = (uHasMap > 0.5) ? pow(tex.rgb, vec3(2.2)) : vColor; // sRGB -> linear
  vec3 lit = base * mapEnv(N);                              // night sky + moon + cloud-deck bounce
  lit += shadeMapLights(vWorldPos, N, V, base);             // the level's own lamps + raytraced shadows
  float ndl = max(dot(N, uSunDir), 0.0);
  float sunSh = (ndl > 0.0 && uSunDir.y > 0.01) ? mapSunShadow(vWorldPos + N * 0.02, uSunDir) : 1.0;
  lit += base * uSunColor * ndl * uMoonStrength * cloudShadow(vWorldPos, uSunDir, uTime) * sunSh; // moon + self-shadow
  fragColor = vec4(lit, texA);
}`;

// Additive emissive glow stage (lamp coronas, jump-pad / flare glows). No lighting — it's a light
// SOURCE; pulses via the Q3 rgbgen wave (uGlowType -1 steady, 0 sin, 1 square).
const GLOW_FRAG = `
in vec3 vColor; in vec3 vNormal; in vec3 vWorldPos; in vec2 vUv; in float vMaterial;
uniform float uTime; uniform sampler2D uMap; uniform float uHasMap;
uniform vec4 uGlowWave;   // base, amp, phase, freq
uniform float uGlowType;  // -1 steady, 0 sin, 1 square
uniform float uGlowScale; // global tunable
out vec4 fragColor;
void main() {
  vec4 t = texture(uMap, vUv);
  float w = 1.0;
  if (uGlowType >= -0.5) {
    float ph = uGlowWave.z + uGlowWave.w * uTime;
    float wave = (uGlowType < 0.5) ? sin(6.2831853 * ph) : ((fract(ph) < 0.5) ? 1.0 : -1.0);
    w = max(0.0, uGlowWave.x + uGlowWave.y * wave);
  }
  vec3 col = (uHasMap > 0.5) ? pow(t.rgb, vec3(2.2)) : vColor;
  fragColor = vec4(col * w * uGlowScale, 1.0); // additive blending in three
}`;

// 1x1 white stand-in so uMap is always a valid sampler before a texture streams in.
const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.needsUpdate = true;
const WAVE_TYPE = { sin: 0, square: 1 };

// One material per draw-group/slot: shares the demo lighting + cloud uniforms (by reference) but
// owns its uMap/uHasMap so each surface's texture can hot-swap in independently. `mode` sets the
// blend (opaque / alphatest / blend); `cull` 'none' renders both sides.
export function buildBspMaterial(shared, cloudsGlsl, mode = 'opaque', cull = 'back') {
  const uniforms = Object.assign({}, shared, {
    uMap: { value: WHITE }, uHasMap: { value: 0 }, uAlphaTest: { value: mode === 'alphatest' ? 1 : 0 },
  });
  const m = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms, vertexShader: VERT,
    fragmentShader: `${libGlsl}\n${cloudsGlsl}\n${FRAG}`, side: THREE.DoubleSide,
  });
  if (mode === 'blend') { m.transparent = true; m.depthWrite = false; }
  return m;
}

// Additive glow material for a slot. `wave` = the manifest glowWave ({type,base,amp,phase,freq}) or null.
export function buildGlowMaterial(shared, wave) {
  const uniforms = {
    uTime: shared.uTime, uMap: { value: WHITE }, uHasMap: { value: 0 }, uGlowScale: shared.uMapGlowScale,
    uGlowWave: { value: new THREE.Vector4(wave ? wave.base : 1, wave ? wave.amp : 0, wave ? wave.phase : 0, wave ? wave.freq : 0) },
    uGlowType: { value: wave ? (WAVE_TYPE[wave.type] ?? 0) : -1 },
  };
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms, vertexShader: VERT, fragmentShader: `${libGlsl}\n${GLOW_FRAG}`,
    side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
