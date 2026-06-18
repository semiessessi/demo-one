import * as THREE from 'three';

const MAX_W = 2048; // safe texture width (WebGL2 guarantees >= 2048)

// A nearest-filtered float DataTexture holding `texelCount` texels, wrapped into
// rows so it stays within the width limit. `channels` is 1 (RedFormat) or 4
// (RGBAFormat). Returns { tex, width } for texelFetch indexing in the shader.
export function floatTexture(data, texelCount, channels = 4) {
  const w = Math.min(MAX_W, texelCount);
  const h = Math.ceil(texelCount / w);
  const format = channels === 1 ? THREE.RedFormat : THREE.RGBAFormat;
  const buf = new Float32Array(w * h * channels);
  buf.set(data);
  const tex = new THREE.DataTexture(buf, w, h, format, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { tex, width: w };
}
