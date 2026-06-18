// (lib.glsl prepended: precision + animLightDir + helpers)

in vec3 position;      // quad corner in [-1,1]^2 (z unused)
in vec3 aLightPos;     // per-instance: host object centre
in vec3 aLightColor;   // per-instance (already includes intensity)
in float aLightRadius; // per-instance: falloff radius (drives sprite size)
in float aOrbitRadius; // per-instance: orbit radius around the centre

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform float uSpriteSize;
uniform float uLightTime;
uniform float uSpawn;        // spawn-in intro clock (light reveal/ignite)
uniform float uLightsPerObject; // lights per object, to map a light to its host's spawn rank
uniform float uBeatTime[32];     // per-slot last note-on time (uMusicTime units)
uniform float uBeatStrength[32]; // per-slot last note-on strength
uniform float uBeatSeed[32];     // per-slot note seed; picks a fresh subset of lights per note
uniform float uBeatDecay[32];    // per-slot pulse-decay factor (from note pitch; 1 = neutral)
uniform float uMusicTime;       // music clock for the beat timestamps
uniform vec4 uRipple[4];         // brightness ripples: (centre.xyz, startTime)

out vec2 vCorner;
out vec3 vColor;

void main() {
  // Camera basis in world space = rows of the view matrix.
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

  // Orbit the light around its host centre (matches morph.frag.glsl shadeDirect).
  vec3 lightPos = aLightPos + aOrbitRadius * animLightDir(gl_InstanceID, uLightTime);

  // Spawn-in + beat flare (matches morph.frag.glsl). emission = one-shot ignite flash
  // plus the music flare once revealed, and is exactly 0 before reveal / between beats,
  // so the sprite has zero size + zero brightness (no dot) when not emitting.
  int band = gl_InstanceID % 32;
  float hostSlot = floor(float(gl_InstanceID) / uLightsPerObject); // this light's host object rank
  // Dark until the host spawns, then flash only on notes — fresh ~MUSIC_FRAC subset per note.
  float emission = step(hostSlot, uSpawn)
                 * musicFlare(gl_InstanceID, uBeatTime[band], uBeatStrength[band], uMusicTime, uBeatDecay[band])
                 * musicBeatLit(gl_InstanceID, uBeatSeed[band]);
  emission += step(hostSlot, uSpawn) * ripplePulse(lightPos, uRipple, uMusicTime); // ride the brightness wave

  vec2 corner = position.xy;
  float size = uSpriteSize * emission; // decoupled from falloff radius; 0 emission -> 0 size -> no dot
  vec3 world = lightPos + size * (corner.x * right + corner.y * up);

  vCorner = corner;
  vColor = aLightColor * emission;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
