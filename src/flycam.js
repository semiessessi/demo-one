// Shared fly camera + pdx-style intro. Operates on a camera through .position and
// .rotation only — no three import here, no cross-instance math objects.
//
// Free flight: WASD move, Q/Z up/down, Shift sprint, click-drag mouse look (cursor stays
// visible — no pointer lock), non-inverted Y.
// Intro: orbit `introTarget` while pulling back for INTRO_DUR seconds, then hand off to
// free flight from that exact pose (no jump). Any movement/look input skips the intro.

const SENS = 0.003;       // radians per pixel of drag
const SPEED = 16;         // units / second (Shift = x3)
const PITCH_LIMIT = 1.5;  // ~86°, so you can't flip over the poles
const ORBIT_DUR = 40.0;   // seconds of slow, graceful orbit + pull-back before joining the fly
const FLY_BLEND = 6.0;    // seconds easing the orbit into the Lissajous fly (smooth, not harsh)
const FLY_SPEED = 0.4;    // Lissajous time scale (full fly speed)
const FLY_FULL_SECS = 7.0; // seconds at full speed before the speed follows the music amplitude
const FLY_MIN_FRAC = 0.18; // floor on fly speed (fraction of FLY_SPEED) so it never fully stops
// Climax choreography (seconds since play, ~= music time): go faster + harder with spinning
// barrel rolls between CLIMAX_START and CLIMAX_END, then decelerate to a level stop.
const CLIMAX_START = 58.0;
const CLIMAX_END = 77.0;        // rolls end as the scripted finale begins
const CLIMAX_SPEED_MULT = 3.0;  // peak fly-speed multiplier during the climax
const ROLL_SPEED = 1.2;         // peak barrel-roll rate (rad/s) -> a few full rolls over the climax
// Scripted finale: a wide orbit of the sphere's outside (FINALE_START), pivoting down to its
// bottom, then a meandering fly up through its middle to FLYUP_END, ending above and looking up.
const FINALE_START = 77.0;
const FLYUP_START = 110.0;
const FLYUP_END = 138.0;
const TWO_PI = Math.PI * 2.0;
const FLY_AMP = [16.0, 10.0, 16.0];  // fly extent per axis (x, y-up, z) — wide so it isn't stuck in the centre
const FLY_FREQ = [1.0, 0.73, 1.31];  // Lissajous frequencies (pdx-gfx scene 0)
const FLY_PHASE = [0.0, 1.7, 3.1];   // Lissajous phases

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = (t) => t * t * (3 - 2 * t);
const MOVE_KEYS = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyZ'];

export function createFlyCam(domElement, introTarget, sphereR = 30) {
  const WIDE_R = sphereR * 1.5; // wide-orbit radius, outside the object sphere
  let px = 24, py = 17, pz = 31; // position (intro overrides immediately)
  let yaw = 0, pitch = 0;
  let mode = introTarget ? 'hold' : 'free'; // 'hold' = static at the orbit start pose until play
  let introT = 0;
  let dragging = false;
  let last = performance.now();
  const keys = new Set();
  let flyU = 0;                   // accumulated Lissajous phase (so the speed can vary)
  let flySpeedSmooth = FLY_SPEED; // smoothed fly speed
  let speedMultSmooth = 1;        // smoothed climax speed multiplier (eases the stop)
  let climaxRoll = 0;             // accumulated barrel-roll angle during the climax
  let rollSmooth = 0;             // smoothed camera roll (3rd euler)
  let musicLevel = 0;             // 0..1 music amplitude (note density), set by setMusicLevel
  let sox = 0, soy = 0, soz = 0, lookSmoothInit = false; // smoothed look-offset -> calms the auto-camera's view swings

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

    if (mode === 'intro' || mode === 'hold') {
      if (mode === 'intro') introT += dt; // 'hold' freezes at the intro's start pose (introT = 0)
      // Orbit the focal object, pulling back + rising over ORBIT_DUR.
      const oe = smooth(Math.pow(Math.min(introT, ORBIT_DUR) / ORBIT_DUR, 2.0)); // stay near the hero longer, then ease out
      const oang = introT * 0.35 + 1.0;
      const orad = 1.5 + (6.0 - 1.5) * oe; // start RIGHT near the hero, pull out only ~half as far
      const opx = introTarget[0] + Math.cos(oang) * orad;
      const opy = introTarget[1] + 1.0 + 2.0 * oe + Math.sin(oang * 0.8) * 5.0 * oe; // more vertical variation as it goes out
      const opz = introTarget[2] + Math.sin(oang) * orad;
      const lookK = Math.min(1, introT / ORBIT_DUR); // pan from focal toward origin
      const otx = introTarget[0] * (1 - lookK);
      const oty = introTarget[1] * (1 - lookK);
      const otz = introTarget[2] * (1 - lookK);
      // Lissajous fly. Speed is full for FLY_FULL_SECS, then very smoothly follows the music
      // amplitude up to FLY_SPEED*0.5 (near-zero in calm patches). Accumulate the phase so the
      // speed can vary over time.
      const flyTime = Math.max(0, introT - ORBIT_DUR);
      const k = smooth(clamp((flyTime - FLY_FULL_SECS) / 3.0, 0, 1)); // 0 = full speed, 1 = music-reactive
      const targetSpeed = FLY_SPEED * (1.0 - k) + FLY_SPEED * (FLY_MIN_FRAC + (0.5 - FLY_MIN_FRAC) * musicLevel) * k;
      flySpeedSmooth += (targetSpeed - flySpeedSmooth) * (1.0 - Math.exp(-dt / 0.6)); // very smooth
      // Climax: faster/harder + spinning rolls between CLIMAX_START/END, then stop (level).
      let speedMultTarget, rollVel;
      if (introT < CLIMAX_START) { speedMultTarget = 1.0; rollVel = 0.0; }
      else if (introT < CLIMAX_END) {
        const env = Math.sin(((introT - CLIMAX_START) / (CLIMAX_END - CLIMAX_START)) * Math.PI); // 0->1->0
        speedMultTarget = 1.0 + (CLIMAX_SPEED_MULT - 1.0) * env;
        rollVel = ROLL_SPEED * env;
      } else { speedMultTarget = 0.0; rollVel = 0.0; } // stop after the climax
      speedMultSmooth += (speedMultTarget - speedMultSmooth) * (1.0 - Math.exp(-dt / 1.2)); // ease (incl. the stop)
      climaxRoll += rollVel * dt;
      const rollTarget = introT >= CLIMAX_END ? Math.round(climaxRoll / (2.0 * Math.PI)) * (2.0 * Math.PI) : climaxRoll;
      rollSmooth += (rollTarget - rollSmooth) * (1.0 - Math.exp(-dt / 0.6)); // finish the roll, settle level
      if (introT >= ORBIT_DUR) flyU += flySpeedSmooth * speedMultSmooth * dt;
      const U = flyU;
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
      let lx = otx + (ftx - otx) * blend;
      let ly = oty + (fty - oty) * blend;
      let lz = otz + (ftz - otz) * blend;
      // Finale (FINALE_START..): blend the Lissajous fly into a scripted path — a wide orbit of
      // the sphere's outside that pivots down to its bottom, then a meandering fly up through its
      // middle, ending above and looking up.
      if (introT >= FINALE_START) {
        let spx, spy, spz, stx, sty, stz;
        if (introT < FLYUP_START) {
          const wp = clamp((introT - FINALE_START) / (FLYUP_START - FINALE_START), 0, 1);
          const dip = smooth(clamp((wp - 0.55) / 0.45, 0, 1)); // stay wide, then pivot to the bottom
          const wang = 0.9 + wp * 1.5 * TWO_PI;                 // ~1.5 revolutions
          const wr = WIDE_R * (1.0 - dip);
          spx = Math.cos(wang) * wr;
          spy = sphereR * 0.35 - sphereR * 1.65 * dip;          // +0.35R down to -1.3R (the bottom)
          spz = Math.sin(wang) * wr;
          stx = 0; sty = 0; stz = 0;                            // look at the centre -> ends looking up
        } else {
          const fp = clamp((introT - FLYUP_START) / (FLYUP_END - FLYUP_START), 0, 1);
          const fpe = smooth(fp);
          const meander = sphereR * 0.25;
          spx = meander * Math.sin(fp * 3.0 * TWO_PI);
          spy = -sphereR * 1.3 + sphereR * 2.6 * fpe;           // -1.3R up to +1.3R through the middle
          spz = meander * Math.sin(fp * 2.3 * TWO_PI);
          stx = spx; sty = spy + sphereR; stz = spz;            // look up, ahead of travel
        }
        const fb = smooth(clamp((introT - FINALE_START) / 6.0, 0, 1)); // ease the fly -> finale handoff
        px += (spx - px) * fb; py += (spy - py) * fb; pz += (spz - pz) * fb;
        lx += (stx - lx) * fb; ly += (sty - ly) * fb; lz += (stz - lz) * fb;
      }
      // The look target follows the fly velocity, which swings fast near the Lissajous low-speed
      // corners — reading as the whole view spinning. Low-pass the look OFFSET from the camera (not
      // the world point, so it never looks backwards as the camera moves) for a calm auto-pan.
      const ox = lx - px, oy = ly - py, oz = lz - pz;
      if (!lookSmoothInit) { sox = ox; soy = oy; soz = oz; lookSmoothInit = true; }
      const lsa = 1.0 - Math.exp(-dt / 0.5);
      sox += (ox - sox) * lsa; soy += (oy - soy) * lsa; soz += (oz - soz) * lsa;
      aim(px + sox, py + soy, pz + soz);
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
      rollSmooth *= Math.exp(-dt / 0.3); // level out if the user takes over mid-roll
    }

    camera.position.set(px, py, pz);
    camera.rotation.set(pitch, yaw, rollSmooth, 'YXZ');
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
    flyU = 0;
    flySpeedSmooth = FLY_SPEED;
    speedMultSmooth = 1;
    climaxRoll = 0;
    rollSmooth = 0;
    sox = soy = soz = 0; lookSmoothInit = false;
    mode = 'intro';
  }
  function setMusicLevel(level) { musicLevel = clamp(level, 0, 1); }
  function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    domElement.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('mousemove', onMouseMove);
  }

  return { update, setPose, startIntro, setMusicLevel, dispose };
}

// Sample the intro camera trajectory — the orbit spiral around `focal` (introT 0..ORBIT_DUR)
// plus the start of the Lissajous fly — into points, so scene generation can keep objects
// off the path (a thin keep-out tube). Pure math (no DOM), so it's safe to import in node.
// FLY_UMAX bounds the fly sample to ~the first 75s (a thin tube, not the whole dense curve).
export function cameraPathPoints(focal) {
  const pts = [];
  const ORBIT_N = 120, FLY_N = 180, FLY_UMAX = 30;
  for (let i = 0; i <= ORBIT_N; i++) {
    const introT = (i / ORBIT_N) * ORBIT_DUR;
    const oe = smooth(Math.pow(introT / ORBIT_DUR, 2.0)); // keep in sync with update()
    const oang = introT * 0.35 + 1.0;
    const orad = 1.5 + (6.0 - 1.5) * oe; // keep in sync with update()'s orbit
    pts.push([focal[0] + Math.cos(oang) * orad, focal[1] + 1.0 + 2.0 * oe + Math.sin(oang * 0.8) * 5.0 * oe, focal[2] + Math.sin(oang) * orad]);
  }
  for (let i = 0; i <= FLY_N; i++) {
    const U = (i / FLY_N) * FLY_UMAX;
    pts.push([
      FLY_AMP[0] * Math.sin(FLY_FREQ[0] * U + FLY_PHASE[0]),
      FLY_AMP[1] * Math.sin(FLY_FREQ[1] * U + FLY_PHASE[1]),
      FLY_AMP[2] * Math.sin(FLY_FREQ[2] * U + FLY_PHASE[2]),
    ]);
  }
  return pts;
}
