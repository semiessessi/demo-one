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
