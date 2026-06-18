// Picks the rendering backend. The WebGPU path is still being built, so during
// development it is OPT-IN via ?webgpu; the default and ?force-webgl use the
// proven WebGL2 path. (At parity this flips to WebGPU-by-default with WebGL
// fallback.) Both implement the same interface:
//   { name, domElement, camera, setTime(s), setView(v), setSize(w,h), render() }.
export async function createBackend(data) {
  const params = new URLSearchParams(location.search);
  const wantsWebGPU = params.has('webgpu') && !params.has('force-webgl');

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
