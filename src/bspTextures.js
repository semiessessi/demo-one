import * as THREE from 'three';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';

// Streams the authentic wrackdm17 textures (diffuse + additive-glow maps) in after the level mesh
// is on screen and hot-swaps each onto its material (uMap/uHasMap). The stylized placeholder colour
// shows until then. TGAs load via three's TGALoader (browsers don't decode TGA natively).

const tgaLoader = new TGALoader();
const texLoader = new THREE.TextureLoader();

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    const loader = url.toLowerCase().endsWith('.tga') ? tgaLoader : texLoader;
    loader.load(url, resolve, undefined, reject);
  });
}

// tasks: [{ material, file }] — `file` is a public-relative path (e.g. wrackdm17/textures/.../x.jpg).
export function streamBspTextures(tasks) {
  for (const { material, file } of tasks) {
    if (!file) continue;
    loadTexture('/' + String(file).replace(/^\/+/, '')).then((tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping; // Q3 textures tile across surfaces
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      material.uniforms.uMap.value = tex;
      material.uniforms.uHasMap.value = 1; // switch from placeholder colour to the texture
    }).catch(() => { /* keep placeholder on a failed load */ });
  }
}
