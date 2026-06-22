import { floatTexture } from './textures.js';
import { cloudLightBrightness, lightKick, animLightDir } from './lightEmission.js';

// Picks the N cloud-relevant point lights each frame (those near the cloud band, ranked by
// current brightness x camera proximity) and packs them into a small RGBA32F texture the cloud
// march reads for coloured in-scatter. 2 texels/light: texel0 = orbiting world pos + glow reach,
// texel1 = colour premultiplied by the light's current emission (so dark lights add nothing).
// The whole `lights` set exists from scene creation (progressive load only swaps the per-object
// index lists, not the lights), so a per-frame pass over it stays valid as the band moves.
const MAX_CLOUD_LIGHTS = 64;
const GLOW_REACH = 1.5; // widen each light's falloff radius for a soft volumetric glow
const BAND_MARGIN = 8.0; // include lights this far outside the band (glow reach + orbit)

export function createCloudLights(lights, lightsPerObject) {
  const cap = MAX_CLOUD_LIGHTS;
  const { tex, width } = floatTexture(new Float32Array(cap * 2 * 4), cap * 2, 4);
  const data = tex.image.data;
  const pickIdx = new Int32Array(cap);
  const pickScore = new Float32Array(cap);
  const pickBright = new Float32Array(cap);
  const dir = [0, 0, 0];
  const st = { lightsPerObject, spawn: 0, lightTime: 0, musicTime: 0, amplitude: 0, ampGain: 0,
    beatTime: null, beatStrength: null, beatSeed: null, beatDecay: null };

  // Reads the per-frame music/spawn state from `u` (the shared uniforms), repacks the texture and
  // sets u.uCloudLightCount. camPos is the camera world position (THREE.Vector3).
  function update(u, camPos) {
    st.spawn = u.uSpawn.value;
    st.lightTime = u.uLightTime.value;
    st.musicTime = u.uMusicTime.value;
    st.amplitude = u.uAmplitude.value;
    st.ampGain = u.uAmpGain.value;
    st.beatTime = u.uBeatTime.value;
    st.beatStrength = u.uBeatStrength.value;
    st.beatSeed = u.uBeatSeed.value;
    st.beatDecay = u.uBeatDecay.value;

    const base = u.uCloudBase.value, thick = u.uCloudThick.value;
    const yLo = base - thick - BAND_MARGIN, yHi = base + thick + BAND_MARGIN;
    const cx = camPos.x, cy = camPos.y, cz = camPos.z;

    let count = 0, minScore = Infinity, minSlot = -1;
    for (let i = 0; i < lights.length; i++) {
      const ly = lights[i].pos[1];
      if (ly < yLo || ly > yHi) continue; // only lights in/near the band light the cloud
      const b = cloudLightBrightness(i, st);
      if (b <= 1e-4) continue; // dark right now -> contributes nothing
      const p = lights[i].pos;
      const dx = p[0] - cx, dy = ly - cy, dz = p[2] - cz;
      const score = b / (1.0 + 0.01 * (dx * dx + dy * dy + dz * dz));
      if (count < cap) {
        pickIdx[count] = i; pickScore[count] = score; pickBright[count] = b;
        if (++count === cap) {
          minScore = Infinity;
          for (let k = 0; k < cap; k++) if (pickScore[k] < minScore) { minScore = pickScore[k]; minSlot = k; }
        }
      } else if (score > minScore) {
        pickIdx[minSlot] = i; pickScore[minSlot] = score; pickBright[minSlot] = b;
        minScore = Infinity;
        for (let k = 0; k < cap; k++) if (pickScore[k] < minScore) { minScore = pickScore[k]; minSlot = k; }
      }
    }

    const lightScale = u.uLightScale.value;
    for (let k = 0; k < count; k++) {
      const i = pickIdx[k], b = pickBright[k], l = lights[i];
      const band = i % 32;
      const kick = lightKick(i, st.beatTime[band], st.beatSeed[band], st.musicTime);
      animLightDir(i, st.lightTime, kick, dir); // match the sprite's orbiting position
      const o = k * 8;
      data[o] = l.pos[0] + l.orbitRadius * dir[0];
      data[o + 1] = l.pos[1] + l.orbitRadius * dir[1];
      data[o + 2] = l.pos[2] + l.orbitRadius * dir[2];
      data[o + 3] = l.radius * GLOW_REACH;
      const g = b * lightScale; // colour already includes intensity; track global dimming
      data[o + 4] = l.color[0] * g;
      data[o + 5] = l.color[1] * g;
      data[o + 6] = l.color[2] * g;
      data[o + 7] = 0;
    }
    tex.needsUpdate = true;
    u.uCloudLightCount.value = count;
  }

  return { tex, width, update };
}
