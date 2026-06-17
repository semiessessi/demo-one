// Sequences morph segments into one global progress value `p` in [0, N], where
// N is the number of segments. floor(p) is the active segment index and the
// fractional part is its local t. Auto-play yo-yos back and forth so the loop
// is seamless; the scrub slider drives the same `p`.
export class Timeline {
  // stops: optional [{ p, name }] marking the named solids along the timeline.
  // Used only for the on-screen label, so internal/transitional shapes (e.g. the
  // rhombic-dodecahedron midpoint) are never shown as a stop.
  constructor(segments, { secondsPerSegment = 4, stops = null } = {}) {
    this.segments = segments;
    this.n = segments.length;
    this.stops = stops;
    this.p = 0;
    this.dir = 1;
    this.playing = true;
    this.speed = 1 / secondsPerSegment; // segments per second
  }

  // Advance by dt seconds (no-op when paused). Returns true if p changed.
  advance(dt) {
    if (!this.playing) return false;
    this.p += this.dir * this.speed * dt;
    if (this.p >= this.n) {
      this.p = this.n;
      this.dir = -1;
    } else if (this.p <= 0) {
      this.p = 0;
      this.dir = 1;
    }
    return true;
  }

  // Set p directly from a normalized [0,1] scrub value.
  setNormalized(u) {
    this.p = Math.max(0, Math.min(1, u)) * this.n;
  }

  normalized() {
    return this.n === 0 ? 0 : this.p / this.n;
  }

  // Resolve the active segment index and its local t.
  resolve() {
    let idx = Math.floor(this.p);
    let t = this.p - idx;
    if (idx >= this.n) {
      idx = this.n - 1;
      t = 1;
    }
    return { idx, t };
  }

  // Human-readable label for the current point in the morph.
  label() {
    if (this.stops) {
      const eps = 0.02;
      for (const s of this.stops) {
        if (Math.abs(this.p - s.p) < eps) return s.name;
      }
      let lo = this.stops[0];
      let hi = this.stops[this.stops.length - 1];
      for (let i = 0; i < this.stops.length - 1; i++) {
        if (this.p >= this.stops[i].p && this.p <= this.stops[i + 1].p) {
          lo = this.stops[i];
          hi = this.stops[i + 1];
          break;
        }
      }
      return `${lo.name} → ${hi.name}`;
    }
    const { idx, t } = this.resolve();
    const seg = this.segments[idx];
    if (t < 0.001) return seg.name;
    if (t > 0.999) return seg.endName;
    return `${seg.name} → ${seg.endName}`;
  }
}
