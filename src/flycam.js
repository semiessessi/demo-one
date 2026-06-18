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
const ORBIT_DUR = 22.0;   // seconds orbiting the focal object before the fly (slow pan-back)
const FLY_BLEND = 8.0;    // seconds blending the orbit into the Lissajous fly
const FLY_SPEED = 0.4;    // Lissajous time scale
const FLY_AMP = [9.0, 4.5, 9.0];     // fly extent per axis (x, y-up, z)
const FLY_FREQ = [1.0, 0.73, 1.31];  // Lissajous frequencies (pdx-gfx scene 0)
const FLY_PHASE = [0.0, 1.7, 3.1];   // Lissajous phases

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
      // Orbit the focal object, pulling back + rising over ORBIT_DUR.
      const oe = smooth(Math.min(introT, ORBIT_DUR) / ORBIT_DUR);
      const oang = introT * 0.35 + 1.0;
      const orad = 4.0 + (16.0 - 4.0) * oe;
      const opx = introTarget[0] + Math.cos(oang) * orad;
      const opy = introTarget[1] + 2.0 + 7.0 * oe;
      const opz = introTarget[2] + Math.sin(oang) * orad;
      const lookK = Math.min(1, introT / ORBIT_DUR); // pan from focal toward origin
      const otx = introTarget[0] * (1 - lookK);
      const oty = introTarget[1] * (1 - lookK);
      const otz = introTarget[2] * (1 - lookK);
      // Lissajous fly (auto), looking along velocity with a slight inward pull.
      const U = Math.max(0, introT - ORBIT_DUR) * FLY_SPEED;
      const fpx = FLY_AMP[0] * Math.sin(FLY_FREQ[0] * U + FLY_PHASE[0]);
      const fpy = FLY_AMP[1] * Math.sin(FLY_FREQ[1] * U + FLY_PHASE[1]);
      const fpz = FLY_AMP[2] * Math.sin(FLY_FREQ[2] * U + FLY_PHASE[2]);
      const vx = FLY_AMP[0] * FLY_FREQ[0] * Math.cos(FLY_FREQ[0] * U + FLY_PHASE[0]);
      const vy = FLY_AMP[1] * FLY_FREQ[1] * Math.cos(FLY_FREQ[1] * U + FLY_PHASE[1]);
      const vz = FLY_AMP[2] * FLY_FREQ[2] * Math.cos(FLY_FREQ[2] * U + FLY_PHASE[2]);
      const vl = Math.hypot(vx, vy, vz) || 1;
      const cl = Math.hypot(fpx, fpy, fpz) || 1;
      const ftx = fpx + (vx / vl) * 0.85 - (fpx / cl) * 0.15;
      const fty = fpy + (vy / vl) * 0.85 - (fpy / cl) * 0.15;
      const ftz = fpz + (vz / vl) * 0.85 - (fpz / cl) * 0.15;
      // Blend orbit -> fly; then keep flying until the user takes over (input -> 'free').
      let blend = clamp((introT - ORBIT_DUR) / FLY_BLEND, 0, 1);
      blend = smooth(blend);
      px = opx + (fpx - opx) * blend;
      py = opy + (fpy - opy) * blend;
      pz = opz + (fpz - opz) * blend;
      aim(otx + (ftx - otx) * blend, oty + (fty - oty) * blend, otz + (ftz - otz) * blend);
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
