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
  float core = pow(fall, 8.0);
  float halo = 0.4 * pow(fall, 3.0);
  float intensity = clamp(core + halo, 0.0, 1.0);

  float bright = max(vColor.r, max(vColor.g, vColor.b));
  vec3 hue = vColor / max(bright, 1e-3);
  float whiteHot = core * clamp(0.4 + 0.8 * bright, 0.0, 1.0);
  vec3 col = mix(hue, vec3(1.0), whiteHot) * intensity;

  fragColor = vec4(col * 2.5, 1.0); // HDR so bright cores bloom
}
