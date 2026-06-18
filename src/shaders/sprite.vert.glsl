precision highp float;

in vec3 position;      // quad corner in [-1,1]^2 (z unused)
in vec3 aLightPos;     // per-instance
in vec3 aLightColor;   // per-instance (already includes intensity)
in float aLightRadius; // per-instance

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform float uSpriteSize;

out vec2 vCorner;
out vec3 vColor;

void main() {
  // Camera basis in world space = rows of the view matrix.
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

  vec2 corner = position.xy;
  float size = uSpriteSize * (0.6 + 0.2 * aLightRadius);
  vec3 world = aLightPos + size * (corner.x * right + corner.y * up);

  vCorner = corner;
  vColor = aLightColor;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
