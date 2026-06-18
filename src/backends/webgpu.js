// WebGPU backend (Three.js WebGPURenderer + TSL/WGSL + storage buffers).
// Built up phase by phase; until it reaches parity it throws so the selector
// falls back to WebGL.
export async function createWebGPUBackend(/* data */) {
  throw new Error('WebGPU backend not implemented yet');
}
