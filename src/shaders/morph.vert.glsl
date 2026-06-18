// (lib.glsl prepended: precision + qrot/qmul/quatAxisAngle/pingpong)

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
in float aOrigIndex;  // original instance id (stable under frustum compaction)

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform float uTime;
uniform float uSpawn; // spawn-in intro clock: objects scale up as it sweeps past their slot
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

void main() {
  float spinSpeed = aMisc.x;
  // spawn rank by stable object id (aOrigIndex), so the reveal order survives the
  // frustum compaction that makes gl_InstanceID the draw slot rather than the object.
  float scale = aMisc.y * spawnReveal(float(aOrigIndex), uSpawn);
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
