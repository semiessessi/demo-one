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
