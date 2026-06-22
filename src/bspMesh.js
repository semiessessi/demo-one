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

export function buildBspMesh(parsed) {
  const { verts, meshverts, faces, textures } = parsed;
  const n = verts.count;

  // Convert all verts to Y-up once: (qx, qy, qz) -> (qx, qz, -qy), a -90deg X rotation
  // (handedness + winding preserved). Normals convert the same way.
  const conv = new Float32Array(n * 3), cn = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    conv[i * 3] = verts.position[i * 3]; conv[i * 3 + 1] = verts.position[i * 3 + 2]; conv[i * 3 + 2] = -verts.position[i * 3 + 1];
    cn[i * 3] = verts.normal[i * 3]; cn[i * 3 + 1] = verts.normal[i * 3 + 2]; cn[i * 3 + 2] = -verts.normal[i * 3 + 1];
  }

  // Placement AABB over the DRAWN geometry only (excluding the huge sky/bounds shell, which would
  // otherwise dominate the box and shrink the real level).
  let mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
  for (const f of faces) {
    if (!drawable(f, textures)) continue;
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

  // Build the draw arrays by expanding each drawn face (no cross-face vertex sharing — the BSP's
  // vertex ranges are per-face anyway). Indices are bucketed by texture so the geometry can carry
  // one draw-group per material -> a material array, each with its own (streamed) texture.
  const P = [], N = [], C = [], U = [], M = [];
  const buckets = new Map(); // texture index -> index list
  const bucket = (tex) => { let b = buckets.get(tex); if (!b) { b = []; buckets.set(tex, b); } return b; };
  for (const f of faces) {
    if (!drawable(f, textures)) continue;
    const alb = albedoFor(textures[f.texture].name);
    const idx = bucket(f.texture);
    if (f.type === 1 || f.type === 3) {
      const start = P.length / 3;
      for (let v = f.vertex; v < f.vertex + f.n_vertexes; v++) {
        P.push(wx(v), wy(v), wz(v)); N.push(cn[v * 3], cn[v * 3 + 1], cn[v * 3 + 2]);
        C.push(alb[0], alb[1], alb[2]); U.push(verts.uv[v * 2], verts.uv[v * 2 + 1]); M.push(f.texture);
      }
      for (let k = 0; k < f.n_meshverts; k++) idx.push(start + meshverts[f.meshvert + k]);
    } else if (f.type === 2) {
      tessellatePatch(f, conv, cn, verts.uv, scale, offset, alb, P, N, C, U, M, idx);
    }
  }

  // Flatten the buckets into one index buffer, one draw-group + slot per material.
  const I = [];
  const slots = []; // [{ texIndex, name }] -> parallel to geometry groups / the material array
  const groups = [];
  for (const [tex, arr] of buckets) {
    if (!arr.length) continue;
    groups.push({ start: I.length, count: arr.length, slot: slots.length });
    for (let i = 0; i < arr.length; i++) I.push(arr[i]);
    slots.push({ texIndex: tex, name: textures[tex].name });
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(C), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(U), 2));
  g.setAttribute('aMaterial', new THREE.BufferAttribute(new Float32Array(M), 1));
  g.setIndex(I);
  for (const gr of groups) g.addGroup(gr.start, gr.count, gr.slot);
  g.computeBoundingSphere();

  return { geometry: g, slots, transform: { scale, offset }, indexCount: I.length };
}

// Tessellate a Q3 biquadratic bezier patch (face.type 2) into triangles. The patch is a (w x h)
// grid of control points (both odd), decomposed into 3x3 subpatches; each is sampled at PATCH_LEVEL+1
// steps per axis. Positions go straight to world space (the affine transform of a bezier equals the
// bezier of the transformed control points). Temporary triangle stand-in until these become true
// raytraced bezier patches (the control grid stays available in the parsed BSP for that).
const bern = (t) => [(1 - t) * (1 - t), 2 * t * (1 - t), t * t]; // quadratic Bernstein basis
function tessellatePatch(f, conv, cn, uv, scale, offset, alb, P, N, C, U, M, I) {
  const w = f.size[0], h = f.size[1], L = PATCH_LEVEL;
  if (w < 3 || h < 3) return;
  const ctrl = (cr, cc) => f.vertex + cr * w + cc; // vert index of control point (row, col)
  for (let psj = 0; psj < (h - 1) / 2; psj++) {
    for (let psi = 0; psi < (w - 1) / 2; psi++) {
      const start = P.length / 3;
      for (let sj = 0; sj <= L; sj++) {
        const bv = bern(sj / L);
        for (let si = 0; si <= L; si++) {
          const bu = bern(si / L);
          let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0, u0 = 0, u1 = 0;
          for (let bj = 0; bj < 3; bj++) for (let bi = 0; bi < 3; bi++) {
            const wgt = bu[bi] * bv[bj];
            const ci = ctrl(psj * 2 + bj, psi * 2 + bi);
            px += wgt * conv[ci * 3]; py += wgt * conv[ci * 3 + 1]; pz += wgt * conv[ci * 3 + 2];
            nx += wgt * cn[ci * 3]; ny += wgt * cn[ci * 3 + 1]; nz += wgt * cn[ci * 3 + 2];
            u0 += wgt * uv[ci * 2]; u1 += wgt * uv[ci * 2 + 1];
          }
          const nl = Math.hypot(nx, ny, nz) || 1;
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
// uSunDir/uSunColor/uMoonStrength are already declared in clouds.glsl (prepended); these are new.
uniform float uTime;
uniform sampler2D uMap;   // this material's diffuse (streamed in; default 1x1 white until then)
uniform float uHasMap;    // 0 = use the stylized placeholder colour, 1 = use the texture
out vec4 fragColor;
void main() {
  vec3 N = normalize(vNormal);
  vec3 base = (uHasMap > 0.5) ? pow(texture(uMap, vUv).rgb, vec3(2.2)) : vColor; // sRGB texture -> linear
  vec3 amb = environment(N) * 1.6 + 0.02;                 // night-sky hemisphere fill
  float ndl = max(dot(N, uSunDir), 0.0);
  float sh = cloudShadow(vWorldPos, uSunDir, uTime);       // dappled under the cloud deck
  vec3 lit = base * (amb + uSunColor * ndl * uMoonStrength * sh);
  fragColor = vec4(lit, 1.0);
}`;

// 1x1 white stand-in so uMap is always a valid sampler before a texture streams in.
const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.needsUpdate = true;

// One material per draw-group/slot: shares the demo lighting + cloud uniforms (by reference) but
// owns its uMap/uHasMap so each surface's texture can hot-swap in independently.
export function buildBspMaterial(shared, cloudsGlsl) {
  const uniforms = Object.assign({}, shared, { uMap: { value: WHITE }, uHasMap: { value: 0 } });
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: VERT,
    fragmentShader: `${libGlsl}\n${cloudsGlsl}\n${FRAG}`,
    side: THREE.DoubleSide,
  });
}
