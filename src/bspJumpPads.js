// Extract the arena's jump pads from the BSP entities so the finale camera can bounce ON them.
// A Q3 jump pad is a `trigger_push` brush entity (model "*N") whose `target` names a `target_position`
// (the launch apex/destination). The pad's location is the trigger brush's AABB centre-top
// (models[N], from bsp.js); the apex is the target_position origin. Both are converted to the demo's
// Y-up WORLD space with the SAME transform bspMesh uses, and the pads are ordered by angle around the
// arena centre so a hop-to-hop tour loops cleanly around the yard.

// Q3 (Z-up) point -> demo world (Y-up): (qx,qy,qz)->(qx,qz,-qy), then * scale + offset. Matches bspMesh.
function q3ToWorld(p, t) {
  return [p[0] * t.scale + t.offset[0], p[2] * t.scale + t.offset[1], -p[1] * t.scale + t.offset[2]];
}

export function buildBspJumpPads(parsed, transform) {
  const entities = parsed.entities || [];
  const models = parsed.models || [];

  // Index the apex/destination point-entities by targetname.
  const targets = new Map();
  for (const e of entities) {
    if (!e.targetname || !e.origin) continue;
    if (e.classname === 'target_position' || e.classname === 'info_notnull' || e.classname === 'misc_teleporter_dest') {
      targets.set(e.targetname, e.origin.split(/\s+/).map(Number));
    }
  }

  const pads = [];
  for (const e of entities) {
    if (e.classname !== 'trigger_push' || !e.model || e.model[0] !== '*') continue;
    const md = models[parseInt(e.model.slice(1), 10)];
    if (!md) continue;
    // Pad surface = trigger AABB centre in X/Y, TOP in Z (where the player stands / launches).
    const padQ3 = [(md.mins[0] + md.maxs[0]) * 0.5, (md.mins[1] + md.maxs[1]) * 0.5, md.maxs[2]];
    const base = q3ToWorld(padQ3, transform);
    const tgt = e.target && targets.get(e.target);
    const apex = tgt ? q3ToWorld(tgt, transform) : [base[0], base[1] + 24, base[2]];
    pads.push({ base, apex });
  }

  // Order around the arena centre so consecutive hops sweep around the yard (a clean loop).
  if (pads.length > 1) {
    let cx = 0, cz = 0;
    for (const p of pads) { cx += p.base[0]; cz += p.base[2]; }
    cx /= pads.length; cz /= pads.length;
    pads.sort((a, b) => Math.atan2(a.base[2] - cz, a.base[0] - cx) - Math.atan2(b.base[2] - cz, b.base[0] - cx));
  }
  return pads;
}
