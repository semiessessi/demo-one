// Shared pure-math helpers. No DOM / three / side effects, so this is safe to import
// from web workers and node (scene generation, capture). Previously these were copy-pasted
// across morphState.js, flycam.js, scene.js, audio.js and lightEmission.js.

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Hermite smoothstep on a unit domain (t already in [0,1]).
export const smooth = (t) => t * t * (3 - 2 * t);
// Full smoothstep over [a,b].
export const smoothstep = (a, b, x) => smooth(clamp01((x - a) / (b - a)));

// Small LCG (Numerical-Recipes constants) for reproducible randomness.
export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 3-axis Lissajous sample: position[i] = amp[i] * sin(freq[i] * U + phase[i]).
export const lissajous3 = (U, amp, freq, phase) => [
  amp[0] * Math.sin(freq[0] * U + phase[0]),
  amp[1] * Math.sin(freq[1] * U + phase[1]),
  amp[2] * Math.sin(freq[2] * U + phase[2]),
];
