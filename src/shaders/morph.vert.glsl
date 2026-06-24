// (lib.glsl prepended: precision + qrot/qmul/quatAxisAngle/pingpong)

// Per-vertex (shared across instances)
in vec3 position;   // start position of this vertex's segment
in vec3 aEnd;       // end position of this vertex's segment
in float aSegment;  // which journey segment this vertex belongs to

// The ONLY per-instance attribute: the stable object id. Every other per-instance value is
// fetched from the shared data textures by it, so the frustum culler uploads just this 1 buffer
// per frame instead of compacting + re-uploading 7 instanced attributes.
in float aOrigIndex;

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
// Per-instance state, shared with the fragment stage (occluder hull / reflection shading):
uniform sampler2D uOccTransformTex; // 4 texels/obj: [pos.xyz, scale], [quat], [spinAxis.xyz, spinSpeed], _
uniform highp int uOccTransformTexW;
uniform sampler2D uInstanceTex;     // 3 texels/obj: [albedo.rgb, rough], [lightOff, lightCnt, metal, _], [shadowOff, shadowCnt, reflOff, reflCnt]
uniform highp int uInstanceTexW;
uniform float uTime;
uniform float uSpawn; // spawn-in intro clock: objects scale up as it sweeps past their slot
uniform float uScaleNotes; // pdx music-scale note counter (smoothed); objects pulse in size
uniform sampler2D uMorphPTex; // per-object morph position (CPU note-stepped), indexed by aOrigIndex
uniform highp int uMorphPTexW; // highp: shared with the fragment stage, must match precision
uniform float uNumSegments;
uniform float uNormScale[128]; // phase -> mean-radius normalization scale
uniform float uBeatTime[32];   // per-slot last note-on time (for the beat-reactive spin kick)
uniform float uBeatSeed[32];   // per-slot note seed (which objects kick this note)
uniform float uMusicTime;      // music clock for the beat timestamps

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
  int oi = int(aOrigIndex);
  // Fetch this instance's transform + material from the shared textures by its stable id.
  vec4 xf0 = texelFetch(uOccTransformTex, texel(oi * 4, uOccTransformTexW), 0);       // pos.xyz, scale
  vec4 baseQ = texelFetch(uOccTransformTex, texel(oi * 4 + 1, uOccTransformTexW), 0); // base orientation
  vec4 xf2 = texelFetch(uOccTransformTex, texel(oi * 4 + 2, uOccTransformTexW), 0);   // spinAxis.xyz, spinSpeed
  vec4 inst0 = texelFetch(uInstanceTex, texel(oi * 3, uInstanceTexW), 0);              // albedo.rgb, rough
  vec4 inst1 = texelFetch(uInstanceTex, texel(oi * 3 + 1, uInstanceTexW), 0);          // lightOff, lightCnt, metal, _
  vec4 inst2 = texelFetch(uInstanceTex, texel(oi * 3 + 2, uInstanceTexW), 0);          // shadow/refl offsets+counts (mat2 is a reserved word)

  float spinSpeed = xf2.w;
  // spawn rank by stable object id, so the reveal order survives the frustum compaction
  // (gl_InstanceID is the draw slot, not the object).
  float scale = xf0.w * spawnReveal(float(oi), uSpawn) * musicScale(oi, uScaleNotes);
  // Morph position is CPU-driven (note-stepped), uploaded per object, indexed by the stable id.
  float p = texelFetch(uMorphPTex, texel(oi, uMorphPTexW), 0).r;
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

  int oslot = oi % 32; // music slot -> beat-reactive spin kick
  vec4 spin = quatAxisAngle(xf2.xyz, uTime * spinSpeed + spinKick(oi, uBeatTime[oslot], uBeatSeed[oslot], uMusicTime));
  vec4 q = qmul(spin, baseQ);
  vec3 world = xf0.xyz + qrot(q, local * scale);

  vWorldPos = world;
  vColor = inst0.rgb;
  vRough = inst0.a;
  vMetal = inst1.z;
  vLightOffset = int(inst1.x + 0.5);
  vLightCount = int(inst1.y + 0.5);
  vShadowOffset = int(inst2.x + 0.5);
  vShadowCount = int(inst2.y + 0.5);
  vReflOffset = int(inst2.z + 0.5);
  vReflCount = int(inst2.w + 0.5);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
