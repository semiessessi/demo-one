// CPU port of the per-light emission math in shaders/lib.glsl, used to bake each
// cloud-relevant light's CURRENT brightness (and orbiting position) on the CPU so the
// cloud shader stays cheap. Kept bit-faithful to the GLSL: same integer hash, same
// ampLit/musicBeatLit/musicFlare/animLightDir, so the cloud glow tracks a light's
// emission exactly (steady "bath" fill for non-amplitude lights -> always lit; the
// ~30% amplitude subset rides uAmplitude and is dark when quiet).

// pdx-gfx integer hash (lib.glsl hash()) emulated in uint32 via Math.imul + >>>0.
export function hash(seed) {
  seed = (seed ^ 2747636419) >>> 0;
  seed = Math.imul(seed, 2654435769) >>> 0;
  seed = (seed ^ (seed >>> 16)) >>> 0;
  seed = Math.imul(seed, 2654435769) >>> 0;
  seed = (seed ^ (seed >>> 16)) >>> 0;
  seed = Math.imul(seed, 2654435769) >>> 0;
  return seed >>> 0;
}
export function hashUnit(h) { return (h & 0x00ffffff) / 16777215.0; }

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// lib.glsl: AMP_FRAC = 0.30, AMP_BASE = 0.5.
const AMP_FRAC = 0.30;
const AMP_BASE = 0.5;
export function ampLit(idx) {
  return hashUnit(hash((Math.imul(idx, 374761393) + 11) >>> 0)) < AMP_FRAC ? 1.0 : 0.0;
}
// MUSIC_FRAC = 0.25 — fresh per-note subset that flares.
export function musicBeatLit(idx, seed) {
  return hashUnit(hash((idx ^ (seed >>> 0)) >>> 0)) < 0.25 ? 1.0 : 0.0;
}
export function lightFadeRate(idx) {
  return 3.0 * Math.pow(2.0, (hash(idx >>> 0) % 8) * 0.5);
}
export function musicFlare(idx, beatTime, strength, now, pitchFactor) {
  const age = now - beatTime;
  return age < 0.0 ? 0.0 : strength * Math.exp(-age * lightFadeRate(idx) * pitchFactor);
}
// Per-note orbit kick (lib.glsl lightKick): smooth bump on the flaring subset's notes.
export function lightKick(idx, beatTime, seed, now) {
  const age = now - beatTime;
  if (age < 0.0) return 0.0;
  const x = age * 2.5;
  return musicBeatLit(idx, seed) * 0.35 * x * Math.exp(1.0 - x);
}
// Lights fade in just after their host object spawns (lib.glsl lightSpawnFade).
export function lightSpawnFade(hostSlot, spawn) {
  return smoothstep(0.0, 0.6, spawn - hostSlot - 0.6);
}

// lib.glsl animLightDir: each light traces a unique closed Lissajous over its orbit
// sphere; writes the unit direction into `out` (reused to avoid per-light allocation).
export function animLightDir(idx, t, kick, out) {
  const i = idx >>> 0;
  const P = 1.0 + Math.floor(hashUnit(hash((Math.imul(i, 3) + 0) >>> 0)) * 6.0); // 1..6
  const Q = 1.0 + Math.floor(hashUnit(hash((Math.imul(i, 3) + 1) >>> 0)) * 7.0); // 1..7
  const R = 1.0 + Math.floor(hashUnit(hash((Math.imul(i, 3) + 2) >>> 0)) * 4.0); // 1..4
  const phase = hashUnit(hash((Math.imul(i, 3) + 7) >>> 0)) * 6.28318530718;
  const freqMag = Math.sqrt(P * P + Q * Q + R * R);
  const speed = 0.15 + hashUnit(hash((Math.imul(i, 2654435761) + 99) >>> 0)) * 0.10;
  const sgn = hashUnit(hash((Math.imul(i, 2654435761) + 777) >>> 0)) < 0.5 ? 1.0 : -1.0;
  const A = ((t * speed + kick) / freqMag) * sgn + phase;
  const th = P * A, ph = Q * A, ps = R * A;
  let dx = Math.sin(th) * Math.cos(ph);
  let dy = Math.sin(th) * Math.sin(ph);
  const dz = Math.cos(th);
  const c = Math.cos(ps), s = Math.sin(ps);
  out[0] = dx * c - dy * s;
  out[1] = dx * s + dy * c;
  out[2] = dz;
  return out;
}

// Current emission of a light for the CLOUD glow. Mirrors morph.frag.glsl's emission
// (line ~312) but treats every cloud light as bath-lit: non-amplitude lights get a
// steady AMP_BASE fill (so the cloud is "always lit"), while the amplitude subset
// contributes only uAmplitude*uAmpGain (zero in silence — the lights-dark-when-quiet
// rule, enforced here on the CPU). `st` carries the per-frame music state.
export function cloudLightBrightness(idx, st) {
  const hostSlot = Math.floor(idx / st.lightsPerObject);
  const reveal = lightSpawnFade(hostSlot, st.spawn);
  if (reveal <= 0.0) return 0.0;
  const band = idx % 32;
  const al = ampLit(idx);
  let m;
  if (al >= 0.5) {
    m = st.amplitude * st.ampGain; // amplitude subset: rides loudness, 0 when quiet
  } else {
    const beat = musicFlare(idx, st.beatTime[band], st.beatStrength[band], st.musicTime, st.beatDecay[band])
      * musicBeatLit(idx, st.beatSeed[band]);
    m = 0.5 * beat + AMP_BASE; // steady fill + halved beat flare -> always lit
  }
  return reveal * m;
}
