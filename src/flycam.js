// Shared fly camera + pdx-style intro. Operates on a camera through .position and
// .rotation only, so it works with either three instance (core 'three' or
// 'three/webgpu') — no three import here, no cross-instance math objects.
//
// Free flight: WASD move, Q/Z up/down, Shift sprint, pointer-lock mouse look (click
// the canvas to capture, Esc to release), non-inverted Y.
// Intro: orbit `introTarget` while pulling back for INTRO_DUR seconds, then hand off to
// free flight from that exact pose (no jump). Any movement/look input skips the intro.

const SENS = 0.003;       // radians per pixel of drag
const SPEED = 16;         // units / second (Shift = x3)
const PITCH_LIMIT = 1.5;  // ~86°, so you can't flip over the poles
const INTRO_DUR = 8.0;    // seconds of orbit-and-pull-back before free flight

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = (t) => t * t * (3 - 2 * t);
const MOVE_KEYS = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyZ'];

export function createFlyCam(domElement, introTarget) {
  let px = 24, py = 17, pz = 31; // position (intro overrides immediately)
  let yaw = 0, pitch = 0;
  let mode = introTarget ? 'intro' : 'free';
  let introT = 0;
  let dragging = false;
  let last = performance.now();
  const keys = new Set();

  // Point the camera from its current position at (tx,ty,tz); leaves mode unchanged.
  function aim(tx, ty, tz) {
    let dx = tx - px, dy = ty - py, dz = tz - pz;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    yaw = Math.atan2(-dx, -dz);
    pitch = clamp(Math.asin(clamp(dy, -1, 1)), -PITCH_LIMIT, PITCH_LIMIT);
  }

  const onKeyDown = (e) => {
    keys.add(e.code);
    if (MOVE_KEYS.includes(e.code)) mode = 'free'; // moving skips the intro
  };
  const onKeyUp = (e) => keys.delete(e.code);
  const onBlur = () => { keys.clear(); dragging = false; }; // avoid stuck keys/drag on focus loss
  // Click-drag to look — the cursor stays visible (no pointer lock).
  const onMouseDown = (e) => {
    if (e.button !== 0) return; // left button
    dragging = true;
    mode = 'free'; // looking skips the intro
    domElement.style.cursor = 'grabbing';
    e.preventDefault();
  };
  const onMouseUp = () => { dragging = false; domElement.style.cursor = 'grab'; };
  const onMouseMove = (e) => {
    if (!dragging) return;
    yaw -= e.movementX * SENS;                                       // drag right -> look right
    pitch = clamp(pitch - e.movementY * SENS, -PITCH_LIMIT, PITCH_LIMIT); // drag up -> look up
  };
  domElement.style.cursor = 'grab'; // hint: drag to look
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  domElement.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);

  function update(camera) {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    if (mode === 'intro') {
      introT += dt;
      const u = introT / INTRO_DUR;
      if (u >= 1) {
        mode = 'free'; // pos/yaw/pitch carry over from the last intro frame
      } else {
        const e = smooth(u);
        const ang = introT * 0.45 + 2.0;          // slow orbit
        const r = 3.5 + (17.0 - 3.5) * e;          // pull back
        px = introTarget[0] + Math.cos(ang) * r;
        py = introTarget[1] + 1.5 + (9.0 - 1.5) * e; // rise as it pulls back
        pz = introTarget[2] + Math.sin(ang) * r;
        aim(introTarget[0], introTarget[1], introTarget[2]);
      }
    }
    if (mode === 'free') {
      const cp = Math.cos(pitch), sp = Math.sin(pitch), sy = Math.sin(yaw), cy = Math.cos(yaw);
      const fx = -cp * sy, fy = sp, fz = -cp * cy; // forward (look direction)
      const rx = cy, rz = -sy;                     // right (horizontal)
      let mz = 0, mx = 0, my = 0;
      if (keys.has('KeyW')) mz += 1;
      if (keys.has('KeyS')) mz -= 1;
      if (keys.has('KeyD')) mx += 1;
      if (keys.has('KeyA')) mx -= 1;
      if (keys.has('KeyQ')) my += 1; // up
      if (keys.has('KeyZ')) my -= 1; // down
      const v = SPEED * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3 : 1) * dt;
      px += (fx * mz + rx * mx) * v;
      py += (fy * mz + my) * v;
      pz += (fz * mz + rz * mx) * v;
    }

    camera.position.set(px, py, pz);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }

  // Jump to a fixed pose and enter free flight (used by the test-scene preset).
  function setPose(position, target) {
    if (position) { px = position[0]; py = position[1]; pz = position[2]; }
    if (target) aim(target[0], target[1], target[2]);
    mode = 'free';
  }
  // Replay the orbit-and-pull-back intro (called on play).
  function startIntro() {
    if (!introTarget) return;
    introT = 0;
    mode = 'intro';
  }
  function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    domElement.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('mousemove', onMouseMove);
  }

  return { update, setPose, startIntro, dispose };
}
