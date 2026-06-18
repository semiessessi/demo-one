// Per-light orbit direction, shared by the WebGPU morph + sprite materials.
// WGSL port of animLightDir in shaders/lib.glsl (pdx-gfx sphere parameterisation):
// position = center + orbitRadius * wgAnimDir(index, time). The pdx integer hash is
// inlined 4x (seeds idx*3+{0,1,2,7}) so this stays one self-contained function; the
// hash, ORBIT_SPEED (0.125) and the P/Q/R frequency caps MUST stay byte-identical to
// the GLSL so the WebGL and WebGPU backends animate (and pixel-match) identically.
// idx is taken as f32 and cast to u32 inside, so both call sites can pass a float.
import { wgslFn } from 'three/tsl';

export const wgAnimDir = wgslFn(`
  fn wgAnimDir(idxF: f32, t: f32) -> vec3<f32> {
    let idx = u32(idxF);
    var hp = (idx * 3u + 0u) ^ 2747636419u; hp = hp * 2654435769u; hp = hp ^ (hp >> 16u); hp = hp * 2654435769u; hp = hp ^ (hp >> 16u); hp = hp * 2654435769u;
    var hq = (idx * 3u + 1u) ^ 2747636419u; hq = hq * 2654435769u; hq = hq ^ (hq >> 16u); hq = hq * 2654435769u; hq = hq ^ (hq >> 16u); hq = hq * 2654435769u;
    var hr = (idx * 3u + 2u) ^ 2747636419u; hr = hr * 2654435769u; hr = hr ^ (hr >> 16u); hr = hr * 2654435769u; hr = hr ^ (hr >> 16u); hr = hr * 2654435769u;
    var hf = (idx * 3u + 7u) ^ 2747636419u; hf = hf * 2654435769u; hf = hf ^ (hf >> 16u); hf = hf * 2654435769u; hf = hf ^ (hf >> 16u); hf = hf * 2654435769u;
    let P = 1.0 + floor(f32(hp & 0x00FFFFFFu) / 16777215.0 * 3.0);
    let Q = 1.0 + floor(f32(hq & 0x00FFFFFFu) / 16777215.0 * 4.0);
    let R = 1.0 + floor(f32(hr & 0x00FFFFFFu) / 16777215.0 * 2.0);
    let phase = f32(hf & 0x00FFFFFFu) / 16777215.0 * 6.28318530718;
    let A = t * 0.125 + phase;
    let th = P * A; let ph = Q * A; let ps = R * A;
    let dir = vec3<f32>(sin(th) * cos(ph), sin(th) * sin(ph), cos(th));
    return vec3<f32>(dir.x * cos(ps) - dir.y * sin(ps), dir.x * sin(ps) + dir.y * cos(ps), dir.z);
  }
`);

// Object spawn-in scale (0 before the object's slot, →1 after) — WGSL port of
// spawnReveal(spawnSlot(i)) in shaders/lib.glsl. Hash inlined for byte-identical parity.
export const wgSpawnScale = wgslFn(`
  fn wgSpawnScale(idxF: f32, spawn: f32) -> f32 {
    var h = (u32(idxF) * 2654435761u + 12345u) ^ 2747636419u; h = h * 2654435769u; h = h ^ (h >> 16u); h = h * 2654435769u; h = h ^ (h >> 16u); h = h * 2654435769u;
    let slot = f32(h & 0x00FFFFFFu) / 16777215.0;
    let a = spawn - slot;
    return select(0.0, smoothstep(0.0, 0.25, a), a > 0.0);
  }
`);

// Light emission — WGSL port of the spawn + beat-flare combo in shaders/lib.glsl /
// morph.frag. `spawn` is the lights' (lagged) clock. A one-shot ignite flash as the
// light reveals, plus the music flare: the band's last beat (beatTime/strength) re-fires
// the light, which then fades at one of 8 pseudo-random per-light rates. Exactly 0 before
// reveal. Both inlined hashes MUST stay byte-identical to the GLSL (spawnSlot, lightFadeRate).
export const wgLightEmission = wgslFn(`
  fn wgLightEmission(idxF: f32, spawn: f32, beatTime: f32, strength: f32, now: f32) -> f32 {
    var hs = (u32(idxF) * 2654435761u + 12345u) ^ 2747636419u; hs = hs * 2654435769u; hs = hs ^ (hs >> 16u); hs = hs * 2654435769u; hs = hs ^ (hs >> 16u); hs = hs * 2654435769u;
    let slot = f32(hs & 0x00FFFFFFu) / 16777215.0;
    let a = spawn - slot;
    let reveal = select(0.0, smoothstep(0.0, 0.25, a), a > 0.0);
    let ignite = select(0.0, 1.5 * exp(-a / 0.3), a > 0.0);
    var hr = u32(idxF) ^ 2747636419u; hr = hr * 2654435769u; hr = hr ^ (hr >> 16u); hr = hr * 2654435769u; hr = hr ^ (hr >> 16u); hr = hr * 2654435769u;
    let rate = 0.5 * pow(2.0, f32(hr % 8u) * 0.5);
    let age = now - beatTime;
    let flare = select(0.0, strength * exp(-age * rate), age >= 0.0);
    var hl = (u32(idxF) * 2246822519u) ^ 2747636419u; hl = hl * 2654435769u; hl = hl ^ (hl >> 16u); hl = hl * 2654435769u; hl = hl ^ (hl >> 16u); hl = hl * 2654435769u;
    let lit = select(0.0, 1.0, f32(hl & 0x00FFFFFFu) / 16777215.0 < 0.4); // MUSIC_LIT — keep in sync with lib.glsl
    return (ignite + reveal * flare) * lit;
  }
`);
