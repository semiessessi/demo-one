// Build a compact star list for the demo's starfield from the Yale Bright Star Catalog
// (bc5v50.dat, the V/50 ADC fixed-width format). Run: node scripts/buildStars.mjs
// Reads the external star-catalog-tool data; writes src/stars.json (positions + magnitude +
// B-V colour for ~9k naked-eye stars). Re-run if the catalog path changes.
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = process.env.BSC5 || 'C:/code/star-catalog-tool/Data/bc5v50.dat';
const OUT = new URL('../src/stars.json', import.meta.url);

// B-V colour index -> blackbody temperature (Ballesteros 2012) -> approximate RGB.
function bvToRgb(bv) {
  bv = Math.max(-0.4, Math.min(2.0, bv));
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62)); // Kelvin
  const u = t / 100;
  const ln = Math.log, pw = Math.pow;
  let r = u <= 66 ? 255 : 329.7 * pw(u - 60, -0.1332);
  let g = u <= 66 ? 99.47 * ln(u) - 161.12 : 288.12 * pw(u - 60, -0.0755);
  let b = u >= 66 ? 255 : u <= 19 ? 0 : 138.52 * ln(u - 10) - 305.04;
  const cl = (x) => Math.max(0, Math.min(255, x)) / 255;
  return [cl(r), cl(g), cl(b)];
}
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const r3 = (x) => Math.round(x * 1e3) / 1e3;

const lines = readFileSync(SRC, 'utf8').split(/\r?\n/);
const pos = [], mag = [], col = [];
let count = 0, minMag = Infinity, maxMag = -Infinity;

for (const line of lines) {
  if (line.length < 114) continue; // need the J2000 position + photometry columns
  const raH = parseInt(line.substring(75, 77), 10);
  const raM = parseInt(line.substring(77, 79), 10);
  const raS = parseFloat(line.substring(79, 83));
  const decSign = line[83] === '-' ? -1 : 1;
  const decD = parseInt(line.substring(84, 86), 10);
  const decM = parseInt(line.substring(86, 88), 10);
  const decS = parseInt(line.substring(88, 90), 10);
  const vmag = parseFloat(line.substring(102, 107));
  const bv = parseFloat(line.substring(109, 114));
  if (!Number.isFinite(raH) || !Number.isFinite(decD) || !Number.isFinite(vmag)) continue;

  const ra = ((raH + raM / 60 + (raS || 0) / 3600) * 15) * Math.PI / 180;
  const dec = (decSign * (decD + (decM || 0) / 60 + (decS || 0) / 3600)) * Math.PI / 180;
  // Y-up unit vector on the celestial sphere. Negate x for the INSIDE-the-sphere view, so the
  // constellations read as seen from Earth (Orion the right way round), not mirrored like a globe.
  pos.push(r5(-Math.cos(dec) * Math.cos(ra)), r5(Math.sin(dec)), r5(Math.cos(dec) * Math.sin(ra)));
  mag.push(r3(vmag));
  const rgb = Number.isFinite(bv) ? bvToRgb(bv) : [1, 1, 1];
  col.push(r3(rgb[0]), r3(rgb[1]), r3(rgb[2]));
  count++;
  minMag = Math.min(minMag, vmag);
  maxMag = Math.max(maxMag, vmag);
}

writeFileSync(OUT, JSON.stringify({ count, mag, pos, col }));
console.log(`wrote src/stars.json: ${count} stars, mag ${minMag.toFixed(2)}..${maxMag.toFixed(2)}`);
