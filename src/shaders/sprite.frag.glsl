precision highp float;

in vec2 vCorner;
in vec3 vColor;

out vec4 fragColor;

// Glowing point sprite: sharp bright core + soft halo, white-hot for bright
// lights, colour-preserving for dim ones. Drawn with additive blending.
void main() {
  float r = length(vCorner);
  if (r > 1.0) discard;

  float fall = 1.0 - r;
  // Soft, round falloff: the old tight pow(fall,8) core was a near-pixel hot point that
  // bloomed into a boxy UnrealBloom artifact. A broader core + wider halo read as a round glow.
  float core = pow(fall, 3.5);
  float halo = 0.6 * pow(fall, 1.7);
  float intensity = clamp(core + halo, 0.0, 1.0);

  float bright = max(vColor.r, max(vColor.g, vColor.b));
  vec3 hue = vColor / max(bright, 1e-3);
  float whiteHot = core * clamp(0.4 + 0.8 * bright, 0.0, 1.0);
  vec3 col = mix(hue, vec3(1.0), whiteHot) * intensity;

  fragColor = vec4(col * 5.0, 1.0); // HDR so bright cores bloom (boosted to keep small dots punchy)
}
