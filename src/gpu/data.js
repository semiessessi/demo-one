// Pack the scene's static data into flat Float32Arrays for WebGPU storage
// buffers (attributeArray). Layouts mirror the WebGL DataTexture packings.

// 2 vec4 per light: [center.xyz, orbitRadius], [color.rgb, radius(falloff)].
export function packLights(lights) {
  const a = new Float32Array(lights.length * 8);
  lights.forEach((l, i) => {
    const o = i * 8;
    a[o] = l.pos[0]; a[o + 1] = l.pos[1]; a[o + 2] = l.pos[2]; a[o + 3] = l.orbitRadius;
    a[o + 4] = l.color[0]; a[o + 5] = l.color[1]; a[o + 6] = l.color[2]; a[o + 7] = l.radius;
  });
  return a;
}

// All per-instance data interleaved into ONE storage buffer (7 vec4 per
// instance), to stay within maxStorageBuffersPerShaderStage (8). Slot layout:
//   0 posScale (pos.xyz, scale)        4 colorRough (color.rgb, rough)
//   1 quat (x,y,z,w)                   5 matLists (metal, lightOffset, lightCount, _)
//   2 spin (axis.xyz, spinSpeed)       6 shadowRefl (shadowOff, shadowCount, reflOff, reflCount)
//   3 tm (phaseOffset, morphSpeed, _, _)
export const INSTANCE_STRIDE = 7;
export function packInstanceBuffer(objects) {
  const a = new Float32Array(objects.length * INSTANCE_STRIDE * 4);
  objects.forEach((o, i) => {
    const b = i * INSTANCE_STRIDE * 4;
    a[b] = o.pos[0]; a[b + 1] = o.pos[1]; a[b + 2] = o.pos[2]; a[b + 3] = o.scale;
    a[b + 4] = o.quat[0]; a[b + 5] = o.quat[1]; a[b + 6] = o.quat[2]; a[b + 7] = o.quat[3];
    a[b + 8] = o.spinAxis[0]; a[b + 9] = o.spinAxis[1]; a[b + 10] = o.spinAxis[2]; a[b + 11] = o.spinSpeed;
    a[b + 12] = o.phase; a[b + 13] = o.morphSpeed;
    a[b + 16] = o.color[0]; a[b + 17] = o.color[1]; a[b + 18] = o.color[2]; a[b + 19] = o.rough;
    a[b + 20] = o.metal; a[b + 21] = o.lightOffset; a[b + 22] = o.lightCount;
    a[b + 24] = o.shadowOffset; a[b + 25] = o.shadowCount; a[b + 26] = o.reflOffset; a[b + 27] = o.reflCount;
  });
  return a;
}

// Concatenate the three index lists into one buffer; returns the buffer + the
// base offsets of the shadow and reflection sections.
export function packIndices(lightIndices, shadowIndices, reflIndices) {
  const l = new Float32Array(lightIndices);
  const s = new Float32Array(shadowIndices);
  const r = new Float32Array(reflIndices);
  const shadowBase = l.length;
  const reflBase = shadowBase + s.length;
  const combined = new Float32Array(reflBase + r.length);
  combined.set(l, 0);
  combined.set(s, shadowBase);
  combined.set(r, reflBase);
  return { combined, shadowBase, reflBase };
}

// 2 vec4 per object for reflection-hit shading: [albedo.rgb, rough], [lo, lc, metal, _].
export function packInstanceMaterial(objects) {
  const a = new Float32Array(objects.length * 8);
  objects.forEach((o, i) => {
    const b = i * 8;
    a[b] = o.color[0]; a[b + 1] = o.color[1]; a[b + 2] = o.color[2]; a[b + 3] = o.rough;
    a[b + 4] = o.lightOffset; a[b + 5] = o.lightCount; a[b + 6] = o.metal;
  });
  return a;
}

// Per-object occluder transform: 4 vec4 [pos.xyz, scale], [quat], [axis.xyz, spinSpeed], [phase, morphSpeed, 0, 0].
export function packOccluderTransforms(objects) {
  const a = new Float32Array(objects.length * 16);
  objects.forEach((o, i) => {
    const b = i * 16;
    a[b] = o.pos[0]; a[b + 1] = o.pos[1]; a[b + 2] = o.pos[2]; a[b + 3] = o.scale;
    a[b + 4] = o.quat[0]; a[b + 5] = o.quat[1]; a[b + 6] = o.quat[2]; a[b + 7] = o.quat[3];
    a[b + 8] = o.spinAxis[0]; a[b + 9] = o.spinAxis[1]; a[b + 10] = o.spinAxis[2]; a[b + 11] = o.spinSpeed;
    a[b + 12] = o.phase; a[b + 13] = o.morphSpeed;
  });
  return a;
}
