// Shared by tools/fft-diff.mjs and tools/lut-diff.mjs: buffer transfer out of a page and the error measure.
export const toF32 = (b64) => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
// in-page (eval it): Float32Array -> base64
export const B64 = `(a) => { const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }`;

// relative RMS of (got - want) over channels `ch` of a stride-`stride` buffer
export function relRms(got, want, stride = 4, ch = [0, 1, 2, 3], gotStride = stride, gotCh = ch) {
  let e = 0, r = 0;
  const n = want.length / stride;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch.length; c++) {
    const w = want[i * stride + ch[c]], d = got[i * gotStride + gotCh[c]] - w;
    e += d * d; r += w * w;
  }
  return r === 0 ? NaN : Math.sqrt(e / r); // an all-zero reference fails: it would hide two empty buffers
}

// prints one result line and collects failures; mustFail: a known-bad case that has to exceed the limit
export function reporter() {
  const failures = [];
  const report = (label, err, limit, mustFail = false) => {
    const bad = !(err <= limit);
    const pass = mustFail ? bad : !bad;
    if (!pass) failures.push(label);
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}: rel rms ${err.toExponential(2)} ${mustFail ? 'must exceed' : 'limit'} ${limit}`);
  };
  return { failures, report };
}

// engine errors and collected console errors of a page, as failures
export async function pageErrors(page, name, failures) {
  const errs = await page.evaluate(() => window.engine?.errors ?? []);
  for (const e of [...errs, ...page.collectedErrors]) failures.push(`${name} error: ${e}`);
}
