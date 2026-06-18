// Picks the rendering backend: WebGPU when available (storage-buffer driven,
// the primary path), else the WebGL2 fallback (broad reach + the comparison
// baseline). Force WebGL with ?force-webgl to A/B the two. Both implement the
// same interface:
//   { name, domElement, camera, setTime(s), setView(v), setSize(w,h), render() }.
export async function createBackend(data) {
  const params = new URLSearchParams(location.search);
  const useWebGPU = !params.has('force-webgl');

  if (useWebGPU && typeof navigator !== 'undefined' && navigator.gpu) {
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
