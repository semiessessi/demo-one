// Read-only storage-buffer node helpers. Read-only access is required to read a
// storage buffer in the vertex stage (WebGPU disallows read_write there).
import * as THREE from 'three/webgpu';
import { storage } from 'three/tsl';

export const roVec4 = (data) =>
  storage(new THREE.StorageBufferAttribute(data, 4), 'vec4', data.length / 4).toReadOnly();

export const roFloat = (data) =>
  storage(new THREE.StorageBufferAttribute(data, 1), 'float', data.length).toReadOnly();
