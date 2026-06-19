// Web worker: run the (heavy) static scene generation off the main thread so the initial
// fade-up stays smooth and the tab never locks while ~5000 objects + their light / occluder /
// reflection lists are built. Mirrors src/sampleDurations.worker.js. Posts the scene data
// (typed arrays + plain object/light records) back via structured clone.
import { generateScene } from './scene.js';

self.onmessage = (e) => {
  self.postMessage(generateScene(e.data || {}));
};
