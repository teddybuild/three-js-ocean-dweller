// Renders scenes in both engines and compares them: node tools/diff.mjs [scene ...] [--self-test]
// Each capture is a fresh page (?render): 89 fixed 1/30 s frames of the engine's own clock, then capture(dt) runs
// frame 90 and reads it, so both engines render the same frame sequence from the same seeds. Writes tmp/diff/<scene>.png (gl | three); prints PSNR, pixelmatch %,
// adapters and every failure. Exit 1 on any failure (see verdict()). Low PSNR alone is not a failure: it is the
// port's progress, read off the sheet.
import { writeFile, mkdir } from 'node:fs/promises';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { launch, openApp } from './browser.mjs';

// float=0: the GL camera does not ride the waves, so both engines use the same fixed camera
const SCENES = {
  breeze: 'preset=breeze&float=0',
  calm: 'preset=calm&yaw=60&float=0',
  squall: 'preset=breeze&float=0&front=1&frontDist=15000&frontAz=60&yaw=60&pitch=3&frontLen=8000&frontDepth=4000&frontWidth=1000&sTop=3500&sBase=900',
  // the clear sky alone (milestone 2): no clouds, camera 10 deg up, metrics over the top rows only
  clear: 'preset=breeze&float=0&clouds=0&pitch=10',
  // the water under the clear sky (milestone 3)
  sea: 'preset=breeze&float=0&clouds=0',
};
// fraction of rows from the top that the metrics cover: at pitch 10 and fov 42 the horizon is at 73 %
const CROP = { clear: 0.68 };
// PSNR floors of ported scenes: below it the run fails (2026-10-29: clear sky 48.5 dB, sea 33.4 dB, breeze 33.9 dB)
const MIN_PSNR = { clear: 38, sea: 30, breeze: 30 };
const W = 1280, H = 720, WARM = 3, DT = 1 / 30, FRAMES = Math.round(WARM / DT);
// GL names the device; WebGPU redacts it to vendor + architecture, which on this one-GPU box is the 5080
const EXPECT = { vendor: /nvidia/i, device: process.env.EXPECT_GPU || 'RTX 5080', architecture: process.env.EXPECT_GPU_ARCH || 'blackwell' };

export function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { const d = a[i + c] - b[i + c]; se += d * d; n++; }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / n));
}

function compare(a, b, crop = 1) {
  if (a.width !== b.width || a.height !== b.height) return { psnr: NaN, mismatch: NaN };
  const rows = Math.round(a.height * crop), n = rows * a.width * 4;
  const bad = pixelmatch(a.data.subarray(0, n), b.data.subarray(0, n), null, a.width, rows, { threshold: 0.1 });
  return { psnr: psnr(a.data.subarray(0, n), b.data.subarray(0, n)), mismatch: (100 * bad) / (a.width * rows) };
}

// Every reason a gl/three pair must fail the run. An empty list is a pass.
export function verdict(gl, three) {
  const f = [];
  for (const [name, c] of [['gl', gl], ['three', three]]) {
    if (c.img.width !== W || c.img.height !== H) f.push(`${name} capture is ${c.img.width}x${c.img.height}, expected ${W}x${H}`);
    else if (singleColour(c.img)) f.push(`${name} capture is a single colour`);
    if (c.frames !== FRAMES) f.push(`${name} rendered ${c.frames} frames, expected ${FRAMES}`);
    for (const e of c.errors) f.push(`${name} error: ${e}`);
  }
  if (three.nodeFrame !== FRAMES) f.push(`three NodeFrame advanced ${three.nodeFrame} times in ${FRAMES} frames`);
  if (!gl.adapter.vendor.includes(EXPECT.device)) f.push(`gl adapter ${gl.adapter.vendor}, expected ${EXPECT.device}`);
  const a = three.adapter;
  if (!EXPECT.vendor.test(a.vendor) || a.architecture !== EXPECT.architecture) f.push(`three adapter ${a.vendor} ${a.architecture}, expected nvidia ${EXPECT.architecture}`);
  if (a.fallback !== false) f.push(`three fallback adapter: ${a.fallback}`);
  return f;
}

function singleColour(img) {
  const d = img.data;
  for (let i = 4; i < d.length; i += 4) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) return false;
  return true;
}

// Known-bad checks: verdict() must reject each broken case, and the metrics must see a corrupted image.
function selfTest(img) {
  const ok = { img, errors: [], frames: FRAMES, nodeFrame: FRAMES, adapter: { vendor: `NVIDIA GeForce ${EXPECT.device}`, architecture: EXPECT.architecture, fallback: false } };
  const small = new PNG({ width: 64, height: 64 });
  const flat = new PNG({ width: img.width, height: img.height });
  const noisy = new PNG({ width: img.width, height: img.height });
  img.data.copy(noisy.data);
  for (let i = 0; i < noisy.data.length; i += 4) noisy.data[i] = (noisy.data[i] + 40) % 256;
  const cases = [
    ['clean pair passes', verdict(ok, ok).length === 0],
    ['three WebGPU error fails', verdict(ok, { ...ok, errors: ['x'] }).length > 0],
    ['gl page error fails', verdict({ ...ok, errors: ['x'] }, ok).length > 0],
    ['wrong size fails', verdict(ok, { ...ok, img: small }).length > 0],
    ['other vendor fails', verdict(ok, { ...ok, adapter: { ...ok.adapter, vendor: 'intel' } }).length > 0],
    ['other architecture fails', verdict(ok, { ...ok, adapter: { ...ok.adapter, architecture: 'ampere' } }).length > 0],
    ['fallback adapter fails', verdict(ok, { ...ok, adapter: { ...ok.adapter, fallback: true } }).length > 0],
    ['unknown fallback flag fails', verdict(ok, { ...ok, adapter: { ...ok.adapter, fallback: null } }).length > 0],
    ['gl on another GPU fails', verdict({ ...ok, adapter: { ...ok.adapter, vendor: 'SwiftShader' } }, ok).length > 0],
    ['single-colour capture fails', verdict(ok, { ...ok, img: flat }).length > 0],
    ['wrong frame count fails', verdict({ ...ok, frames: FRAMES + 1 }, ok).length > 0],
    ['gl on another NVIDIA GPU fails', verdict({ ...ok, adapter: { ...ok.adapter, vendor: 'NVIDIA GeForce RTX 5070' } }, ok).length > 0],
    ...[1, 1000, NaN, undefined].map((n) => [`NodeFrame ${n} fails`, verdict(ok, { ...ok, nodeFrame: n }).length > 0]),
    ['identical image: PSNR Infinity, 0 % mismatch', (() => { const r = compare(img, img); return r.psnr === Infinity && r.mismatch === 0; })()],
    ['noisy image: PSNR < 40, mismatch > 50 %', (() => { const r = compare(img, noisy); return r.psnr < 40 && r.mismatch > 50; })()],
  ];
  for (const [name, pass] of cases) console.log(`self-test ${pass ? 'ok  ' : 'FAIL'} ${name}`);
  return cases.every(([, pass]) => pass);
}

// inject: run in the page after load (beforeLoad: before its scripts); both only for the self-test
async function capture(browser, engine, query, { inject, beforeLoad } = {}) {
  const page = await openApp(browser, `http://localhost:5173/?render&engine=${engine}&${query}`, { width: W, height: H, beforeLoad });
  await page.waitForFunction(() => window.engine, { timeout: 60000 });
  if (inject) await page.evaluate(inject);
  const out = await page.evaluate(async (n, dt) => {
    await window.engine.step(n - 1, dt);
    const png = await window.engine.capture(dt);
    const e = window.engine;
    return { png, frames: e.frames, nodeFrame: e.nodeFrame, errors: e.errors, adapter: e.adapter };
  }, FRAMES, DT);
  await page.close();
  return { ...out, errors: [...out.errors, ...page.collectedErrors], img: PNG.sync.read(Buffer.from(out.png.split(',')[1], 'base64')) };
}

function sideBySide(a, b) {
  const out = new PNG({ width: a.width + b.width, height: Math.max(a.height, b.height) });
  PNG.bitblt(a, out, 0, 0, a.width, a.height, 0, 0);
  PNG.bitblt(b, out, 0, 0, b.width, b.height, a.width, 0);
  return PNG.sync.write(out);
}

const args = process.argv.slice(2);
const names = args.filter((a) => !a.startsWith('--'));
await mkdir('tmp/diff', { recursive: true });
const browser = await launch({ width: W, height: H });
let ok = true;
try {
  for (const name of names.length ? names : ['breeze']) {
    const q = SCENES[name] ?? (name.includes('float=') ? name : `${name}&float=0`);
    const gl = await capture(browser, 'gl', q);
    const three = await capture(browser, 'three', q);
    if (args.includes('--self-test')) {
      if (!selfTest(gl.img)) ok = false;
      // live known-bad: errors injected into real pages must reach verdict()
      const live = [
        ['three error after load', 'three', { inject: () => console.error('THREE.selfTest injected') }, 'injected'],
        ['three error during startup', 'three', { beforeLoad: () => console.error('selfTest startup injected') }, 'startup injected'],
        ['gl invalid call', 'gl', { inject: () => window.app.gl.bindBuffer(0x1234, null) }, 'WebGL error 0x500'],
      ];
      for (const [label, eng, opts, needle] of live) {
        const bad = await capture(browser, eng, q, opts);
        const caught = (eng === 'gl' ? verdict(bad, three) : verdict(gl, bad)).some((f) => f.includes(needle));
        console.log(`self-test ${caught ? 'ok  ' : 'FAIL'} ${label} fails the run`);
        if (!caught) ok = false;
      }
    }
    const r = compare(gl.img, three.img, CROP[name]);
    const failures = verdict(gl, three);
    if (MIN_PSNR[name] && !(r.psnr >= MIN_PSNR[name])) failures.push(`PSNR ${r.psnr.toFixed(2)} below the floor ${MIN_PSNR[name]}`);
    if (failures.length) ok = false;
    await writeFile(`tmp/diff/${name}.png`, sideBySide(gl.img, three.img));
    console.log(JSON.stringify({ scene: name, psnr: Number(r.psnr.toFixed(2)), mismatchPct: Number(r.mismatch.toFixed(1)), gl: gl.adapter.vendor, three: three.adapter, failures }));
  }
} catch (e) {
  console.log('capture failed:', e.message);
  ok = false;
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
