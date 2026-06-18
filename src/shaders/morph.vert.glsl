precision highp float;

// Per-vertex (shared across instances)
in vec3 position;   // start position of this vertex's segment
in vec3 aEnd;       // end position of this vertex's segment
in float aSegment;  // which journey segment this vertex belongs to

// Per-instance
in vec3 aInstancePos;
in vec4 aQuat;       // base orientation (unit quaternion)
in vec3 aSpinAxis;
in float aSpinSpeed;
in float aScale;
in float aPhaseOffset;
in vec3 aColor;
in float aRough;
in float aMetal;
in float aLightOffset;
in float aLightCount;

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform float uTime;
uniform float uSpeed;
uniform float uNumSegments;

out vec3 vWorldPos;
out vec3 vColor;
out float vRough;
out float vMetal;
flat out int vLightOffset;
flat out int vLightCount;

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
// Triangle wave on [0, n] with period 2n (ping-pong, no seam).
float pingpong(float x, float n) {
  float m = mod(x, 2.0 * n);
  return m <= n ? m : 2.0 * n - m;
}

void main() {
  float p = pingpong(uTime * uSpeed + aPhaseOffset, uNumSegments);
  int seg = int(floor(p));
  float localT = fract(p);
  if (seg >= int(uNumSegments + 0.5)) { seg = int(uNumSegments + 0.5) - 1; localT = 1.0; }

  // Only the vertices of the object's current segment are positioned; the rest
  // collapse to a point and are culled as degenerate triangles.
  vec3 local = (int(aSegment + 0.5) == seg) ? mix(position, aEnd, localT) : vec3(0.0);

  vec4 spin = quatAxisAngle(aSpinAxis, uTime * aSpinSpeed);
  vec4 q = qmul(spin, aQuat);
  vec3 world = aInstancePos + qrot(q, local * aScale);

  vWorldPos = world;
  vColor = aColor;
  vRough = aRough;
  vMetal = aMetal;
  vLightOffset = int(aLightOffset + 0.5);
  vLightCount = int(aLightCount + 0.5);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
