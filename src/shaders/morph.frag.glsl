precision highp float;

in vec3 vWorldPos;
in vec3 vColor;
in float vRough;
in float vMetal;
flat in int vLightOffset;
flat in int vLightCount;

out vec4 fragColor;

// Global light data, read via texelFetch.
uniform sampler2D uLightsTex;     // 2 texels per light: [pos.xyz,_], [color.rgb, radius]
uniform sampler2D uLightIndexTex; // 1 texel per list entry: light index (as float)
uniform int uLightsTexW;
uniform int uIndexTexW;

ivec2 texel(int i, int w) { return ivec2(i % w, i / w); }

// Unreal-style point-light falloff.
float falloff(float dist, float radius) {
  float a = clamp(1.0 - pow(dist / radius, 4.0), 0.0, 1.0);
  return a * a / (dist * dist + 1.0);
}

void main() {
  // Flat per-face normal from screen-space derivatives of world position.
  vec3 N = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  if (!gl_FrontFacing) N = -N;

  vec3 lit = vec3(0.0);
  for (int k = 0; k < vLightCount; k++) {
    int idx = int(texelFetch(uLightIndexTex, texel(vLightOffset + k, uIndexTexW), 0).r + 0.5);
    vec3 lightPos = texelFetch(uLightsTex, texel(idx * 2, uLightsTexW), 0).xyz;
    vec4 colRad = texelFetch(uLightsTex, texel(idx * 2 + 1, uLightsTexW), 0);

    vec3 L = lightPos - vWorldPos;
    float dist = length(L);
    L /= max(dist, 1e-4);
    float ndl = max(dot(N, L), 0.0);
    lit += vColor * colRad.rgb * ndl * falloff(dist, colRad.w);
  }
  lit += vColor * 0.02; // faint ambient so unlit sides aren't pure black

  fragColor = vec4(lit, 1.0);
}
