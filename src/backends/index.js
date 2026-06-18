// The demo runs on WebGL2 — the supported, proven path. A WebGPU backend still exists
// under ./webgpu.js + ../gpu/ but is intentionally DISABLED (it hit storage-buffer limits
// at this feature set); re-enable by restoring the ?force-webgpu branch below. Both
// implement: { name, domElement, camera, setTime(s), setView(v), setSize(w,h), render() }.
export async function createBackend(data) {
  const { createWebGLBackend } = await import('./webgl.js');
  console.info('[backend] using WebGL2');
  return createWebGLBackend(data);
}
