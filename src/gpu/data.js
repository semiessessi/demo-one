// Pack the scene's static data into flat Float32Arrays for WebGPU storage
// buffers (attributeArray). Layouts mirror the WebGL DataTexture packings.

// 2 vec4 per light: [pos.xyz, _], [color.rgb, radius].
export function packLights(lights) {
  const a = new Float32Array(lights.length * 8);
  lights.forEach((l, i) => {
    const o = i * 8;
    a[o] = l.pos[0]; a[o + 1] = l.pos[1]; a[o + 2] = l.pos[2];
    a[o + 4] = l.color[0]; a[o + 5] = l.color[1]; a[o + 6] = l.color[2]; a[o + 7] = l.radius;
  });
  return a;
}

// Per-instance data as a set of vec4 storage buffers (indexed by instanceIndex).
export function packInstances(objects) {
  const n = objects.length;
  const posScale = new Float32Array(n * 4); // pos.xyz, scale
  const quat = new Float32Array(n * 4); // x,y,z,w
  const spin = new Float32Array(n * 4); // axis.xyz, spinSpeed
  const tm = new Float32Array(n * 4); // phaseOffset, morphSpeed, 0, 0
  const colorRough = new Float32Array(n * 4); // color.rgb, rough
  const matLists = new Float32Array(n * 4); // metal, lightOffset, lightCount, _
  const shadowRefl = new Float32Array(n * 4); // shadowOffset, shadowCount, reflOffset, reflCount
  objects.forEach((o, i) => {
    posScale.set([o.pos[0], o.pos[1], o.pos[2], o.scale], i * 4);
    quat.set(o.quat, i * 4);
    spin.set([o.spinAxis[0], o.spinAxis[1], o.spinAxis[2], o.spinSpeed], i * 4);
    tm.set([o.phase, o.morphSpeed, 0, 0], i * 4);
    colorRough.set([o.color[0], o.color[1], o.color[2], o.rough], i * 4);
    matLists.set([o.metal, o.lightOffset, o.lightCount, 0], i * 4);
    shadowRefl.set([o.shadowOffset, o.shadowCount, o.reflOffset, o.reflCount], i * 4);
  });
  return { posScale, quat, spin, tm, colorRough, matLists, shadowRefl };
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
