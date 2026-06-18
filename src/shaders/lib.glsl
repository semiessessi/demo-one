// Shared GLSL helpers, prepended to the morph + sky shaders. Pure functions only
// (no uniforms), so they can sit above each shader's own declarations. Includes
// the precision qualifier so the shader files don't repeat it.
precision highp float;

// 2D index into a row-wrapped data texture of width w.
ivec2 texel(int i, int w) { return ivec2(i % w, i / w); }

// Quaternion helpers.
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
vec4 qconj(vec4 q) { return vec4(-q.xyz, q.w); }
vec4 quatAxisAngle(vec3 axis, float angle) { float h = angle * 0.5; return vec4(normalize(axis) * sin(h), cos(h)); }
vec4 qmul(vec4 a, vec4 b) {
  return vec4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}

// Triangle wave on [0, n] with period 2n (ping-pong, no seam).
float pingpong(float x, float n) {
  float m = mod(x, 2.0 * n);
  return m <= n ? m : 2.0 * n - m;
}

// pdx-gfx integer hash + per-light orbit parameterisation (test_vert.hlsl). Lights
// orbit their host object on a sphere: position = center + orbitRadius * animLightDir.
// ORBIT_SPEED (0.125) and the P/Q/R frequency caps MUST match the WGSL ports in
// gpu/morphMaterial.js and gpu/spriteMaterial.js (cross-backend pixel parity).
uint hash(uint seed) {
  seed ^= 2747636419u;
  seed *= 2654435769u;
  seed ^= seed >> 16u;
  seed *= 2654435769u;
  seed ^= seed >> 16u;
  seed *= 2654435769u;
  return seed;
}
float hashUnit(uint h) { return float(h & 0x00FFFFFFu) / 16777215.0; }
vec3 animLightDir(int idx, float t) {
  uint i = uint(idx);
  float P = 1.0 + floor(hashUnit(hash(i * 3u + 0u)) * 3.0);
  float Q = 1.0 + floor(hashUnit(hash(i * 3u + 1u)) * 4.0);
  float R = 1.0 + floor(hashUnit(hash(i * 3u + 2u)) * 2.0);
  float phase = hashUnit(hash(i * 3u + 7u)) * 6.28318530718;
  float A = t * 0.125 + phase; // 0.125 = ORBIT_SPEED
  float th = P * A, ph = Q * A, ps = R * A;
  vec3 dir = vec3(sin(th) * cos(ph), sin(th) * sin(ph), cos(th));
  dir.xy = vec2(dir.x * cos(ps) - dir.y * sin(ps), dir.x * sin(ps) + dir.y * cos(ps));
  return dir;
}

// Music-reactive flare: each light maps to a slot (index % 32). A beat in
// that band re-triggers all of its lights (uBeatTime/uBeatStrength record the band's
// last beat); each light then fades at one of 8 pseudo-random per-light rates, so some
// linger far longer than others. Returns the raw flare; the caller folds it into the
// spawn emission below. Keep in sync with gpu/orbit.js (wgLightEmission).
float lightFadeRate(int idx) {
  return 0.5 * pow(2.0, float(hash(uint(idx)) % 8u) * 0.5); // ~0.5..5.7 /s -> ~2s..~0.18s
}
float musicFlare(int idx, float beatTime, float strength, float now) {
  float age = now - beatTime;
  return age < 0.0 ? 0.0 : strength * exp(-age * lightFadeRate(idx));
}
// Only a fraction of lights react to the music (so loud beats don't over-brighten the
// scene); the rest never flare. Static per-light, independent of the band/rate/slot
// hashes. Keep MUSIC_LIT in sync with gpu/orbit.js.
const float MUSIC_LIT = 1.0; // fraction of lights that react (1.0 = all of them)
float musicLit(int idx) { return hashUnit(hash(uint(idx) * 2246822519u)) < MUSIC_LIT ? 1.0 : 0.0; }
// Per-NOTE participation: each note writes a fresh seed to its slot (uBeatSeed), so a
// different ~MUSIC_FRAC subset of the slot's lights flares each note (few, and never the
// same set). Replaces the static musicLit gate for the flare. Sync with gpu/orbit.js.
const float MUSIC_FRAC = 0.12;
float musicBeatLit(int idx, float seed) {
  return hashUnit(hash(uint(idx) ^ uint(seed))) < MUSIC_FRAC ? 1.0 : 0.0;
}

// pdx-gfx music-reactive object scale: steps every 20 notes (uScaleNotes = a smoothed note
// count), easing between random per-object scales in [0.2,1.0]. Sync with wgMusicScale.
float musicScale(int i, float notes) {
  float off = hashUnit(hash(uint(i) * 5u + 7u)) * 20.0; // NotesPerChange = 20
  float prog = (notes + off) / 20.0;
  float epoch = floor(prog);
  float blend = smoothstep(0.0, 0.3, prog - epoch);
  uint cs = uint(epoch);
  float prev = mix(0.2, 1.0, hashUnit(hash(uint(i) ^ ((cs - 1u) * 2246822519u))));
  float cur  = mix(0.2, 1.0, hashUnit(hash(uint(i) ^ (cs * 2246822519u))));
  return mix(prev, cur, blend);
}

// Spawn-in intro: a global, ever-increasing spawn clock (uSpawn) sweeps past each
// item's slot. Objects scale in via spawnReveal; lights ignite with a one-shot flash
// (spawnIgnite) then settle to music-reactive. Keep in sync with gpu/orbit.js.
float spawnSlot(int i) { return hashUnit(hash(uint(i) * 2654435761u + 12345u)); }
float spawnReveal(float slot, float spawn) {
  float a = spawn - slot;
  return a <= 0.0 ? 0.0 : smoothstep(0.0, 0.6, a); // object scales in over ~0.6 of a spawn count
}
float spawnIgnite(float slot, float spawn) {
  float a = spawn - slot;
  return a <= 0.0 ? 0.0 : 3.0 * exp(-a / 0.25); // sharp bright flash-in (not a slow lerp)
}
// Lights reveal a touch later and slower than objects, via their own derived clock.
const float LIGHT_SPAWN_DELAY = 0.2;
const float LIGHT_SPAWN_SCALE = 0.7;
float lightSpawnClock(float spawn) { return max(0.0, spawn - LIGHT_SPAWN_DELAY) * LIGHT_SPAWN_SCALE; }

// pdx-gfx "Night" environment preset (Y-up; horizon glow band). Used as both the
// background skydome and the reflection fallback.
vec3 environment(vec3 d) {
  vec3 Sky = vec3(0.008, 0.012, 0.035);
  vec3 Horizon = vec3(0.06, 0.08, 0.14);
  vec3 Glow = vec3(0.16, 0.20, 0.30);
  vec3 GroundEdge = vec3(0.035, 0.035, 0.045);
  vec3 Ground = vec3(0.02, 0.02, 0.028);
  float Up = d.y;
  vec3 Base;
  if (Up >= 0.0) Base = mix(Horizon, Sky, pow(clamp(Up, 0.0, 1.0), 0.20));
  else Base = mix(Horizon, mix(GroundEdge, Ground, clamp(-Up, 0.0, 1.0)), pow(clamp(-Up, 0.0, 1.0), 0.30));
  float Band = pow(clamp(1.0 - abs(Up), 0.0, 1.0), 60.0);
  return mix(Base, Glow, Band);
}
