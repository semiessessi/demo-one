// One-time build step: extract maps/wrackdm17.bsp from the OpenArena pak (a ZIP) into public/
// so it can be streamed at runtime (after the first frame), like public/x-engage.it.
//
//   node scripts/extractBsp.mjs [path-to-openarena]
//
// Defaults to C:\code\openarena-0.8.8. wrackdm17 is OpenArena's homage to Quake 3's q3dm17
// "The Longest Yard". GPL v2 + CC-BY/CC-BY-SA — ship COPYING/CREDITS alongside if distributing.
// Pure Node (minimal ZIP reader, no external unzip) so it runs on any platform.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseBSP } from '../src/bsp.js';

// Index a ZIP's central directory once: lowercased entry name -> { method, compSize, localOff }.
// (Q3 paks are effectively case-insensitive, so we key by lowercase.)
function indexZip(zip) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) { if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('not a ZIP (no EOCD)');
  let off = zip.readUInt32LE(eocd + 16);
  const count = zip.readUInt16LE(eocd + 10);
  const map = new Map();
  for (let e = 0; e < count && zip.readUInt32LE(off) === 0x02014b50; e++) {
    const method = zip.readUInt16LE(off + 10), compSize = zip.readUInt32LE(off + 20);
    const nameLen = zip.readUInt16LE(off + 28), extraLen = zip.readUInt16LE(off + 30), commLen = zip.readUInt16LE(off + 32);
    const localOff = zip.readUInt32LE(off + 42);
    map.set(zip.toString('latin1', off + 46, off + 46 + nameLen).toLowerCase(), { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commLen;
  }
  return map;
}
function readZipEntry(zip, e) {
  const lNameLen = zip.readUInt16LE(e.localOff + 26), lExtraLen = zip.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + lNameLen + lExtraLen;
  const comp = zip.subarray(start, start + e.compSize);
  return e.method === 0 ? Buffer.from(comp) : inflateRawSync(comp);
}

// Pull a single entry out of a ZIP buffer via the End-Of-Central-Directory + central directory.
function extractEntry(zip, wanted) {
  // Find EOCD (signature 0x06054b50), scanning back from the end (no ZIP64 here).
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) { if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('not a ZIP (no EOCD)');
  let off = zip.readUInt32LE(eocd + 16);          // central directory offset
  const count = zip.readUInt16LE(eocd + 10);      // total entries
  for (let e = 0; e < count; e++) {
    if (zip.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory');
    const method = zip.readUInt16LE(off + 10);
    const compSize = zip.readUInt32LE(off + 20);
    const nameLen = zip.readUInt16LE(off + 28);
    const extraLen = zip.readUInt16LE(off + 30);
    const commLen = zip.readUInt16LE(off + 32);
    const localOff = zip.readUInt32LE(off + 42);
    const name = zip.toString('latin1', off + 46, off + 46 + nameLen);
    if (name === wanted) {
      // Local header: recompute the data start from its own variable-length fields.
      const lNameLen = zip.readUInt16LE(localOff + 26);
      const lExtraLen = zip.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = zip.subarray(dataStart, dataStart + compSize);
      return method === 0 ? Buffer.from(comp) : inflateRawSync(comp); // 0=stored, 8=deflate
    }
    off += 46 + nameLen + extraLen + commLen;
  }
  throw new Error(`entry not found: ${wanted}`);
}

// Repack a full IBSP down to only the lumps src/bsp.js reads: the draw geometry (textures, planes,
// brushes, brushsides, vertexes, meshverts, faces) PLUS entities(0) + models(7) — the latter two are
// tiny (text + AABBs) and carry the jump-pad / teleporter entity data the finale camera bounces on.
// Drops the big unused lumps (visdata, nodes, leafs, lightmaps, lightgrid). Stays a valid IBSP v46
// (other lumps just have length 0), so the parser is unchanged.
function slimBsp(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== 'IBSP') throw new Error('not IBSP');
  const KEEP = new Set([0, 1, 2, 7, 8, 9, 10, 11, 13]);
  const lumps = [];
  for (let i = 0; i < 17; i++) lumps.push({ off: dv.getInt32(8 + i * 8, true), len: dv.getInt32(8 + i * 8 + 4, true) });
  let outLen = 144; // 8-byte header + 17 * 8-byte directory
  for (let i = 0; i < 17; i++) if (KEEP.has(i)) outLen += lumps[i].len;
  const out = Buffer.alloc(outLen);
  out.write('IBSP', 0, 'latin1'); out.writeInt32LE(46, 4);
  let cur = 144;
  for (let i = 0; i < 17; i++) {
    if (KEEP.has(i)) {
      buf.copy(out, cur, lumps[i].off, lumps[i].off + lumps[i].len);
      out.writeInt32LE(cur, 8 + i * 8); out.writeInt32LE(lumps[i].len, 8 + i * 8 + 4);
      cur += lumps[i].len;
    } else { out.writeInt32LE(144, 8 + i * 8); out.writeInt32LE(0, 8 + i * 8 + 4); }
  }
  return out;
}

// --- Minimal Quake-3 .shader parser + classifier (for transparency / blend modes / glows) ---
function parseShaders(text) {
  text = text.replace(/\/\/[^\n]*/g, '');                            // strip // comments
  const lines = text.replace(/([{}])/g, '\n$1\n').split('\n').map((l) => l.trim()).filter(Boolean);
  const shaders = new Map();
  let i = 0;
  while (i < lines.length) {
    const name = lines[i++];
    if (name === '{' || name === '}') continue;
    if (lines[i] !== '{') continue;
    i++;
    const def = { surfaceparms: [], cull: 'back', sky: false, stages: [] };
    while (i < lines.length && lines[i] !== '}') {
      if (lines[i] === '{') {
        i++;
        const st = {};
        while (i < lines.length && lines[i] !== '}') {
          const t = lines[i++].split(/\s+/); const k = t[0].toLowerCase();
          if (k === 'map' || k === 'clampmap') st.map = t[1];
          else if (k === 'animmap') st.map = t[2];                   // first frame of an anim
          else if (k === 'blendfunc') st.blend = t.slice(1).map((x) => x.toLowerCase()).join(' ');
          else if (k === 'alphafunc') st.alpha = true;
          else if (k === 'rgbgen') st.rgbgen = t.slice(1);
        }
        i++; def.stages.push(st);
      } else {
        const t = lines[i++].split(/\s+/); const k = t[0].toLowerCase();
        if (k === 'surfaceparm') def.surfaceparms.push((t[1] || '').toLowerCase());
        else if (k === 'cull') def.cull = (t[1] || '').toLowerCase();
        else if (k === 'skyparms') def.sky = true;
      }
    }
    i++; shaders.set(name, def);
  }
  return shaders;
}
const blendMode = (b) => {
  if (!b) return 'opaque';
  if (b === 'add' || b === 'gl_one gl_one') return 'add';
  if (b === 'blend' || b === 'gl_src_alpha gl_one_minus_src_alpha') return 'blend';
  return 'filter'; // gl_dst_color gl_zero etc (multiply) -> treated as opaque diffuse
};
// Reduce a shader def to what the renderer needs: a diffuse map + render mode, plus an optional
// additive glow stage (the see-through bits: pulsing lamp/jumppad/flare glows).
function classifyShader(def) {
  if (def.sky || def.surfaceparms.includes('sky')) return { mode: 'sky' };
  let diffuse = null, mode = 'opaque', glow = null, glowWave = null;
  for (const s of def.stages) {
    if (!s.map || s.map === '$lightmap') continue;
    const bm = blendMode(s.blend);
    if (bm === 'add' && !glow) {
      glow = s.map;
      const g = s.rgbgen;
      glowWave = g && g[0] === 'wave' ? { type: g[1], base: +g[2], amp: +g[3], phase: +g[4], freq: +g[5] } : null;
      continue;
    }
    if (!diffuse && bm !== 'add') { diffuse = s.map; mode = s.alpha ? 'alphatest' : (bm === 'blend' ? 'blend' : 'opaque'); }
  }
  if (!diffuse && glow) { diffuse = glow; mode = 'add'; glow = null; glowWave = null; }
  return { diffuse, mode, glow, glowWave, cull: def.cull };
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const oaDir = process.argv[2] || 'C:/code/openarena-0.8.8';
const pk3 = join(oaDir, 'baseoa', 'pak1-maps.pk3');
const entry = 'maps/wrackdm17.bsp';
const outDir = join(root, 'public');
const out = join(outDir, 'wrackdm17.bsp');

if (!existsSync(pk3)) {
  console.error(`pak not found: ${pk3}\nPass the OpenArena install dir as arg 1.`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const data = extractEntry(readFileSync(pk3), entry);
if (data.length < 1024) { console.error(`extracted a tiny file (${data.length}B) — wrong entry?`); process.exit(1); }
const slim = slimBsp(data);
writeFileSync(out, slim);
console.log(`wrote ${out} (${(slim.length / 1048576).toFixed(2)} MB, slimmed from ${(data.length / 1048576).toFixed(2)} MB)`);

// --- Materials: parse the Q3 .shader scripts, classify each referenced surface (opaque / blend /
// alphatest / additive-glow / sky), resolve its diffuse + glow images across the paks, and write a
// shader-aware manifest (name -> {diffuse, mode, glow, glowWave, cull}). ---
const parsed = parseBSP(slim.buffer.slice(slim.byteOffset, slim.byteOffset + slim.byteLength));
const wantNames = [...new Set(parsed.textures.map((t) => t.name))]
  .filter((n) => (n.startsWith('textures/') || n.startsWith('models/')) && !n.includes('common/')); // models/ = mapobject shaders (teleporters)

const texPaks = ['pak6-patch088.pk3', 'pak6-patch085.pk3', 'pak4-textures.pk3', 'pak0.pk3', 'pak6-misc.pk3']
  .map((f) => join(oaDir, 'baseoa', f)).filter(existsSync);
const index = new Map(); // lowercased entry name -> { zip, e } (first pak wins -> patches override base)
for (const p of texPaks) {
  const zip = readFileSync(p);
  for (const [name, e] of indexZip(zip)) if (!index.has(name)) index.set(name, { zip, e });
}
// Parse every .shader script across the paks.
const shaderDefs = new Map();
for (const [name, v] of index) {
  if (!name.endsWith('.shader')) continue;
  try { for (const [sn, def] of parseShaders(readZipEntry(v.zip, v.e).toString('latin1'))) if (!shaderDefs.has(sn)) shaderDefs.set(sn, def); } catch { /* skip */ }
}

const exts = ['.tga', '.jpg', '.jpeg', '.png'];
const extracted = new Map(); // base name (no ext) -> public rel path | null (dedup the shared images)
let texBytes = 0;
function extractTex(texName) {
  if (!texName) return null;
  const base = texName.replace(/\.(tga|jpg|jpeg|png)$/i, '');
  if (extracted.has(base)) return extracted.get(base);
  for (const ext of exts) {
    const hit = index.get((base + ext).toLowerCase());
    if (!hit) continue;
    const buf = readZipEntry(hit.zip, hit.e);
    const rel = `wrackdm17/${base}${ext}`;
    mkdirSync(dirname(join(outDir, rel)), { recursive: true });
    writeFileSync(join(outDir, rel), buf);
    texBytes += buf.length; extracted.set(base, rel); return rel;
  }
  extracted.set(base, null); return null;
}

const manifest = {};
let nGlow = 0, nBlend = 0, nSky = 0;
for (const name of wantNames) {
  const def = shaderDefs.get(name);
  const c = def ? classifyShader(def) : { diffuse: name, mode: 'opaque', glow: null, glowWave: null, cull: 'back' };
  if (c.mode === 'sky') { nSky++; continue; }                  // the level uses the demo's own sky
  const diffuse = extractTex(c.diffuse || name);
  const glow = extractTex(c.glow);
  if (!diffuse && !glow) continue;                              // unresolved -> stylized placeholder stays
  manifest[name] = { diffuse, mode: c.mode, glow, glowWave: c.glowWave || null, cull: c.cull || 'back' };
  if (glow) nGlow++;
  if (c.mode === 'blend' || c.mode === 'add') nBlend++;
}
writeFileSync(join(outDir, 'wrackdm17.textures.json'), JSON.stringify(manifest));
console.log(`materials: ${Object.keys(manifest).length} (${nGlow} glow, ${nBlend} translucent, ${nSky} sky skipped), ${(texBytes / 1048576).toFixed(1)} MB -> public/wrackdm17/`);
