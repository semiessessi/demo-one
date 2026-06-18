import * as THREE from 'three';

const MAX_W = 2048; // safe texture width (WebGL2 guarantees >= 2048)

function dataTexture(data, texelCount, channels) {
  const w = Math.min(MAX_W, texelCount);
  const h = Math.ceil(texelCount / w);
  const format = channels === 1 ? THREE.RedFormat : THREE.RGBAFormat;
  const stride = channels === 1 ? 1 : 4;
  const buf = new Float32Array(w * h * stride);
  buf.set(data);
  const tex = new THREE.DataTexture(buf, w, h, format, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { tex, width: w };
}

// Pack lights into an RGBA32F texture, 2 texels per light:
//   texel 0: position.xyz, _
//   texel 1: color.rgb, radius
// And the flat light-index list into an R32F texture (one index per texel).
export function buildLightTextures(lights, lightIndices) {
  const lightData = new Float32Array(lights.length * 2 * 4);
  lights.forEach((l, i) => {
    const o = i * 8;
    lightData[o] = l.pos[0];
    lightData[o + 1] = l.pos[1];
    lightData[o + 2] = l.pos[2];
    lightData[o + 4] = l.color[0];
    lightData[o + 5] = l.color[1];
    lightData[o + 6] = l.color[2];
    lightData[o + 7] = l.radius;
  });

  const lightsTex = dataTexture(lightData, lights.length * 2, 4);
  const indexTex = dataTexture(lightIndices, lightIndices.length, 1);

  return {
    lightsTex: lightsTex.tex,
    lightsTexW: lightsTex.width,
    lightIndexTex: indexTex.tex,
    indexTexW: indexTex.width,
  };
}

// Occluders are the objects themselves as sphere proxies: one RGBA32F texel each
// (center.xyz, proxyRadius). Plus the flat per-object occluder index list.
export function buildOccluderTextures(objects, occluderIndices) {
  const data = new Float32Array(objects.length * 4);
  objects.forEach((o, i) => {
    data[i * 4] = o.pos[0];
    data[i * 4 + 1] = o.pos[1];
    data[i * 4 + 2] = o.pos[2];
    data[i * 4 + 3] = o.proxyRadius;
  });
  const occTex = dataTexture(data, objects.length, 4);
  const idxTex = dataTexture(occluderIndices, occluderIndices.length, 1);
  return {
    occluderTex: occTex.tex,
    occluderTexW: occTex.width,
    shadowIndexTex: idxTex.tex,
    shadowIndexW: idxTex.width,
  };
}

// Reflection data: per-object material/light texture (so a reflection hit can be
// shaded) plus the flat reflection-occluder index list.
//   instance texel 0: [albedo.rgb, rough]
//   instance texel 1: [lightOffset, lightCount, metal, 0]
export function buildReflectionData(objects, reflectionIndices) {
  const inst = new Float32Array(objects.length * 2 * 4);
  objects.forEach((o, i) => {
    const a = i * 8;
    inst[a] = o.color[0];
    inst[a + 1] = o.color[1];
    inst[a + 2] = o.color[2];
    inst[a + 3] = o.rough;
    inst[a + 4] = o.lightOffset;
    inst[a + 5] = o.lightCount;
    inst[a + 6] = o.metal;
  });
  const instTex = dataTexture(inst, objects.length * 2, 4);
  const reflIdxTex = dataTexture(reflectionIndices, reflectionIndices.length, 1);
  return {
    instanceTex: instTex.tex,
    instanceTexW: instTex.width,
    reflIndexTex: reflIdxTex.tex,
    reflIndexW: reflIdxTex.width,
  };
}
