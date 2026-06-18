// The full tetra -> ... -> icosa journey as a flat list of 10 morph segments,
// each { start, end } triangle-soup position arrays. Reuses the segment builders
// from the single-shape demo. Segment order matches the original timeline.
import {
  tetraOctaSegment,
  octaToMidSegment,
  midToCubeSegment,
} from './solids.js';
import {
  octaIcosaSegment,
  icosaToMidSegment,
  midToDodecaSegment,
} from './icosa.js';

const reversed = (d) => ({ start: d.end, end: d.start });

export const NUM_SEGMENTS = 10;

export function buildJourneySegments() {
  const segs = [
    tetraOctaSegment(), // 0: tetra -> octa
    octaToMidSegment(), // 1: octa -> rhombic-dodec midpoint
    midToCubeSegment(), // 2: midpoint -> cube
    reversed(midToCubeSegment()), // 3: cube -> midpoint
    reversed(octaToMidSegment()), // 4: midpoint -> octa
    octaIcosaSegment(), // 5: octa -> icosa
    icosaToMidSegment(), // 6: icosa -> rhombic-triacontahedron midpoint
    midToDodecaSegment(), // 7: midpoint -> dodeca
    reversed(midToDodecaSegment()), // 8: dodeca -> midpoint
    reversed(icosaToMidSegment()), // 9: midpoint -> icosa
  ];
  return segs.map((s) => ({ start: s.start, end: s.end }));
}

// Largest circumradius reached anywhere on the journey (the cube, corners at
// (+/-1,+/-1,+/-1)). Used when computing the normalization LUT.
export const MAX_CIRCUMRADIUS = Math.sqrt(3);

// After per-shape mean-radius normalization (mean of in/circumradius = 1), the
// largest circumradius any shape reaches is the tetrahedron's (ratio 1.5). Used
// to size non-overlapping packing and light/occluder reach.
export const MAX_NORM_CIRCUMRADIUS = 1.55;
