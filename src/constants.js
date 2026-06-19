// Shared cross-module constants — one source of truth so they can't drift between modules.
// NOTE: the GLSL shaders keep their own hardcoded copies (they can't import JS), so changing
// N_BANDS here also means updating the 32-wide uBeat* uniform arrays in the shaders.

// Light "bands" / slots: the tracker's channels are folded into this many slots, and each light
// maps to one via `idx % N_BANDS`. Must match audio.js's note slots and the shader [32] arrays.
export const N_BANDS = 32;
