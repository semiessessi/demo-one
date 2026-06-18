// Picks the rendering backend: WebGPU when available, else WebGL2. Force WebGL
// with ?force-webgl (e.g. to A/B against the WebGPU path). Both implement the
// same interface: { name, domElement, camera, setTime(s), setSize(w,h), render() }.
export async function createBackend(data) {
  const forceWebGL = new URLSearchParams(location.search).has('force-webgl');

  if (!forceWebGL && typeof navigator !== 'undefined' && navigator.gpu) {
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
  console.info('[backend] using WebGL2' + (forceWebGL ? ' (forced)' : ''));
  return createWebGLBackend(data);
}
