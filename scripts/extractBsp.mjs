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
writeFileSync(out, data);
console.log(`wrote ${out} (${(data.length / 1048576).toFixed(1)} MB)`);
