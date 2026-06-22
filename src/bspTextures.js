import * as THREE from 'three';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';

// Streams the authentic wrackdm17 textures in after the level mesh is on screen and hot-swaps each
// onto its material (the stylized placeholder colour shows until then). Driven by a manifest
// (texture name -> public file path) produced by scripts/extractBsp.mjs; if it's missing, the
// placeholders simply stay. TGAs load via three's TGALoader (browsers don't decode TGA natively).

const tgaLoader = new TGALoader();
const texLoader = new THREE.TextureLoader();

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    const loader = url.toLowerCase().endsWith('.tga') ? tgaLoader : texLoader;
    loader.load(url, resolve, undefined, reject);
  });
}

export async function streamBspTextures(bspUrl, slots, materials) {
  const manifestUrl = bspUrl.replace(/\.bsp$/, '.textures.json');
  let manifest = null;
  try { const r = await fetch(manifestUrl); manifest = r.ok ? await r.json() : null; } catch { /* none */ }
  if (!manifest) return; // textures not extracted -> keep the stylized placeholders
  slots.forEach((slot, i) => {
    const file = manifest[slot.name];
    if (!file) return; // sky / shader-only / unresolved -> placeholder stays
    loadTexture('/' + String(file).replace(/^\/+/, '')).then((tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping; // Q3 textures tile across surfaces
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      const u = materials[i].uniforms;
      u.uMap.value = tex;
      u.uHasMap.value = 1; // switch this material from placeholder colour to the texture
    }).catch(() => { /* keep placeholder on a failed load */ });
  });
}
