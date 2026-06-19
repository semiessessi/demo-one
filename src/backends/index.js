// The demo runs on WebGL2. createBackend returns the single backend implementation:
// { name, domElement, camera, setTime(s), setView(v), setSize(w,h), render(), ... }.
import { createWebGLBackend } from './webgl.js';

export async function createBackend(data) {
  return createWebGLBackend(data);
}
