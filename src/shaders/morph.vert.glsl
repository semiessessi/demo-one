precision highp float;

// Per-vertex (shared across instances)
in vec3 position;   // start position of this vertex's segment
in vec3 aEnd;       // end position of this vertex's segment
in float aSegment;  // which journey segment this vertex belongs to

// Per-instance (scalars packed into vec4s to stay under 16 attributes)
in vec3 aInstancePos;
in vec4 aQuat;        // base orientation (unit quaternion)
in vec3 aSpinAxis;
in vec4 aMisc;        // spinSpeed, scale, phaseOffset, _
in vec3 aColor;
in vec4 aMaterial;    // rough, metal, lightOffset, lightCount
in vec4 aLists;       // shadowOffset, shadowCount, reflOffset, reflCount

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform float uTime;
uniform float uNumSegments;
uniform float uNormScale[128]; // phase -> mean-radius normalization scale

out vec3 vWorldPos;
out vec3 vColor;
out float vRough;
out float vMetal;
flat out int vLightOffset;
flat out int vLightCount;
flat out int vShadowOffset;
flat out int vShadowCount;
flat out int vReflOffset;
flat out int vReflCount;

vec3 qrot(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}
vec4 quatAxisAngle(vec3 axis, float angle) {
  float h = angle * 0.5;
  return vec4(normalize(axis) * sin(h), cos(h));
}
vec4 qmul(vec4 a, vec4 b) {
  return vec4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz),
              a.w * b.w - dot(a.xyz, b.xyz));
}
float pingpong(float x, float n) {
  float m = mod(x, 2.0 * n);
  return m <= n ? m : 2.0 * n - m;
}

void main() {
  float spinSpeed = aMisc.x;
  float scale = aMisc.y;
  float phaseOffset = aMisc.z;
  float morphSpeed = aMisc.w;

  float p = pingpong(uTime * morphSpeed + phaseOffset, uNumSegments);
  int seg = int(floor(p));
  float localT = fract(p);
  if (seg >= int(uNumSegments + 0.5)) { seg = int(uNumSegments + 0.5) - 1; localT = 1.0; }

  // Only the active segment's vertices are positioned; the rest collapse.
  vec3 local = (int(aSegment + 0.5) == seg) ? mix(position, aEnd, localT) : vec3(0.0);

  // Normalize each shape to a constant mean of in/circumradius (LUT by phase).
  float fp = (p / uNumSegments) * 127.0;
  int i0 = int(floor(fp));
  int i1 = min(i0 + 1, 127);
  local *= mix(uNormScale[i0], uNormScale[i1], fp - float(i0));

  vec4 spin = quatAxisAngle(aSpinAxis, uTime * spinSpeed);
  vec4 q = qmul(spin, aQuat);
  vec3 world = aInstancePos + qrot(q, local * scale);

  vWorldPos = world;
  vColor = aColor;
  vRough = aMaterial.x;
  vMetal = aMaterial.y;
  vLightOffset = int(aMaterial.z + 0.5);
  vLightCount = int(aMaterial.w + 0.5);
  vShadowOffset = int(aLists.x + 0.5);
  vShadowCount = int(aLists.y + 0.5);
  vReflOffset = int(aLists.z + 0.5);
  vReflCount = int(aLists.w + 0.5);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
