// Web worker: parse the .it module's sample + instrument tables (a pure IT-format parse, no
// libopenmpt) to get each instrument's representative (C-5) sample length in seconds. Posts a
// Float32Array indexed by instrument number (1-based; [0] unused) so the main thread can make
// long-sample light pulses decay slower. Runs off the main thread, ready shortly after load.
const MODULE_URL = '/x-engage.it';

(async () => {
  try {
    const buf = new Uint8Array(await (await fetch(MODULE_URL)).arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== 'IMPM') return; // not an IT file
    const ordNum = dv.getUint16(0x20, true);
    const insNum = dv.getUint16(0x22, true);
    const smpNum = dv.getUint16(0x24, true);
    const insOff = 0xC0 + ordNum;          // instrument header offset table
    const smpOff = insOff + insNum * 4;     // sample header offset table

    const rd = (off) => { let s = ''; for (let c = 0; c < 26; c++) { const ch = buf[off + c]; if (ch === 0) break; s += String.fromCharCode(ch); } return s.trim(); };
    // Each IT sample header: Length (samples) @ +0x30, C5Speed (Hz) @ +0x3C, name @ +0x14.
    const smpDur = new Float32Array(smpNum);
    const smpName = new Array(smpNum);
    for (let i = 0; i < smpNum; i++) {
      const o = dv.getUint32(smpOff + i * 4, true);
      const len = dv.getUint32(o + 0x30, true);
      const c5 = dv.getUint32(o + 0x3C, true);
      smpDur[i] = c5 > 0 ? len / c5 : 0;    // seconds
      smpName[i] = rd(o + 0x14);
    }

    // Each IT instrument: note->sample keyboard @ +0x40, name @ +0x20. Use the sample mapped to
    // C-5 (note 60) for the duration; the display label is the instrument name, else its sample name.
    const insDur = new Float32Array(insNum + 1); // 1-based by instrument number ([0] unused)
    const insNames = new Array(insNum + 1).fill('');
    for (let i = 0; i < insNum; i++) {
      const o = dv.getUint32(insOff + i * 4, true);
      const samp = buf[o + 0x40 + 60 * 2 + 1]; // sample # for C-5 (1-based)
      insDur[i + 1] = (samp > 0 && samp <= smpDur.length) ? smpDur[samp - 1] : 0;
      insNames[i + 1] = rd(o + 0x20) || (samp > 0 && samp <= smpName.length ? smpName[samp - 1] : '');
    }

    postMessage({ dur: insDur, names: insNames });
  } catch (e) {
    // Leave the decay on the pitch proxy; this enhancement is best-effort.
  }
})();
