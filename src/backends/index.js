// Picks the rendering backend. WebGL2 is the default (proven + broad reach) while
// the WebGPU path's performance is being tuned; opt into WebGPU with ?force-webgpu.
// (If WebGPU init fails it falls back to WebGL2.) Both implement the same interface:
//   { name, domElement, camera, setTime(s), setView(v), setSize(w,h), render() }.
export async function createBackend(data) {
  const params = new URLSearchParams(location.search);
  const wantsWebGPU = params.has('force-webgpu');

  if (wantsWebGPU && typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const { createWebGPUBackend } = await import('./webgpu.js');
      const backend = await createWebGPUBackend(data);
      console.info('[backend] using WebGPU');
      return backend;
    } catch (err) {
      console.warn('[backend] WebGPU init failed, falling back to WebGL:', err);
    }
  }

  const { createWebGLBackend } = await import('./webgl.js');
  console.info('[backend] using WebGL2');
  return createWebGLBackend(data);
}
