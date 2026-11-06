// Regression check of the three.js renderer against its own saved frames:
//   node tools/diff.mjs [scene ...|all] [--update] [--self-test]
// Each capture is a fresh page (?render): 89 fixed 1/30 s frames of the engine's clock, then capture(dt) runs frame 90
// and reads it. --update saves the frames as references (tmp/diff/ref/<scene>.png); without it each scene is compared
// to its reference and tmp/diff/<scene>.png is written (reference | now). Exit 1 on any failure (verdict(), or PSNR
// below MIN_PSNR). Make references on a clean commit before a change; a scene the change is meant to alter fails, and
// the sheet shows how. The WebGL2 engine and its gl-vs-three diff are archived in archive/gl/ (tag gl-final).
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { launch, openApp } from './browser.mjs';

// float=0: a fixed camera (no riding the waves)
const SCENES = {
  breeze: 'preset=breeze&float=0',
  calm: 'preset=calm&yaw=60&float=0',
  // distant showers under the big fair-weather cells (yaw 270 faces three of them at t 3 s)
  showers: 'preset=breeze&float=0&yaw=270&pitch=2',
  // congestus towers (yaw 200 faces one, backlit, at t 3 s)
  towers: 'preset=breeze&float=0&yaw=200&pitch=6',
  squall: 'preset=breeze&float=0&front=1&frontDist=15000&frontAz=60&yaw=60&pitch=3&frontLen=8000&frontDepth=4000&frontWidth=1000&sTop=3500&sBase=900',
  // the clear sky alone (milestone 2): no clouds, camera 10 deg up, metrics over the top rows only
  clear: 'preset=breeze&float=0&clouds=0&pitch=10',
  // the water under the clear sky (milestone 3)
  sea: 'preset=breeze&float=0&clouds=0',
  // milestone 5: a downpour with spray (rain streaks, splashes, fog), a storm with a forced ground strike at t 2.9
  rain: 'preset=rain&rain=0.8&wind=20&float=0',
  storm: 'preset=storm&float=0&strikeAt=2.9',
  // night under the moon (sun 12 deg below the horizon), and the storm with the camera riding the waves (the probe)
  night: 'preset=breeze&float=0&elev=-12',
  stormfloat: 'preset=storm&strikeAt=2.9',
  // the live quality tier: 256/256/128/128 FFT, half-resolution checkerboarded clouds, bicubic upsample
  rt: 'preset=breeze&float=0&q=rt',
};
// fraction of rows from the top that the metrics cover: at pitch 10 and fov 42 the horizon is at 73 %
const CROP = { clear: 0.68 };
// re-renders of the same commit measured Infinity dB, squall 75.6 and rt 80.6 (2026-10-29): below this is a change
const MIN_PSNR = 45;
const W = 1280, H = 720, DT = 1 / 30, FRAMES = 90;
// WebGPU redacts the device to vendor + architecture, so that is all the check can match (override for other GPUs)
const EXPECT = { vendor: new RegExp(process.env.EXPECT_GPU_VENDOR || 'nvidia', 'i'), architecture: process.env.EXPECT_GPU_ARCH || 'blackwell' };

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

// Every reason a capture must fail the run. An empty list is a pass.
export function verdict(c) {
  const f = [];
  if (c.img.width !== W || c.img.height !== H) f.push(`capture is ${c.img.width}x${c.img.height}, expected ${W}x${H}`);
  else if (singleColour(c.img)) f.push('capture is a single colour');
  if (c.frames !== FRAMES) f.push(`rendered ${c.frames} frames, expected ${FRAMES}`);
  if (c.nodeFrame !== FRAMES) f.push(`NodeFrame advanced ${c.nodeFrame} times in ${FRAMES} frames`);
  for (const e of c.errors) f.push(`error: ${e}`);
  const a = c.adapter;
  if (!EXPECT.vendor.test(a.vendor) || a.architecture !== EXPECT.architecture) f.push(`adapter ${a.vendor} ${a.architecture}, expected nvidia ${EXPECT.architecture}`);
  if (a.fallback !== false) f.push(`fallback adapter: ${a.fallback}`);
  return f;
}

function singleColour(img) {
  const d = img.data;
  for (let i = 4; i < d.length; i += 4) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) return false;
  return true;
}

// Known-bad checks: verdict() must reject each broken case, and the metrics must see a corrupted image.
function selfTest(img) {
  const ok = { img, errors: [], frames: FRAMES, nodeFrame: FRAMES, adapter: { vendor: 'nvidia', architecture: EXPECT.architecture, fallback: false } };
  const small = new PNG({ width: 64, height: 64 });
  const flat = new PNG({ width: img.width, height: img.height });
  const noisy = new PNG({ width: img.width, height: img.height });
  img.data.copy(noisy.data);
  for (let i = 0; i < noisy.data.length; i += 4) noisy.data[i] = (noisy.data[i] + 40) % 256;
  const cases = [
    ['clean capture passes', verdict(ok).length === 0],
    ['WebGPU error fails', verdict({ ...ok, errors: ['x'] }).length > 0],
    ['wrong size fails', verdict({ ...ok, img: small }).length > 0],
    ['other vendor fails', verdict({ ...ok, adapter: { ...ok.adapter, vendor: 'intel' } }).length > 0],
    ['other architecture fails', verdict({ ...ok, adapter: { ...ok.adapter, architecture: 'ampere' } }).length > 0],
    ['fallback adapter fails', verdict({ ...ok, adapter: { ...ok.adapter, fallback: true } }).length > 0],
    ['unknown fallback flag fails', verdict({ ...ok, adapter: { ...ok.adapter, fallback: null } }).length > 0],
    ['single-colour capture fails', verdict({ ...ok, img: flat }).length > 0],
    ['wrong frame count fails', verdict({ ...ok, frames: FRAMES + 1 }).length > 0],
    ...[1, 1000, NaN, undefined].map((n) => [`NodeFrame ${n} fails`, verdict({ ...ok, nodeFrame: n }).length > 0]),
    ['identical image: PSNR Infinity, 0 % mismatch', (() => { const r = compare(img, img); return r.psnr === Infinity && r.mismatch === 0; })()],
    ['noisy image: PSNR below the floor, mismatch > 50 %', (() => { const r = compare(img, noisy); return r.psnr < MIN_PSNR && r.mismatch > 50; })()],
  ];
  for (const [name, pass] of cases) console.log(`self-test ${pass ? 'ok  ' : 'FAIL'} ${name}`);
  return cases.every(([, pass]) => pass);
}

// inject: run in the page after load (beforeLoad: before its scripts); both only for the self-test
async function capture(browser, query, { inject, beforeLoad } = {}) {
  const page = await openApp(browser, `http://localhost:5173/?render&${query}`, { width: W, height: H, beforeLoad });
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
let names = args.filter((a) => !a.startsWith('--'));
if (!names.length) names = ['breeze'];
if (names.includes('all')) names = Object.keys(SCENES);
const update = args.includes('--update');
await mkdir('tmp/diff/ref', { recursive: true });
const browser = await launch({ width: W, height: H });
let ok = true;
try {
  for (const name of names) {
    const q = SCENES[name] ?? (name.includes('float=') ? name : `${name}&float=0`);
    const now = await capture(browser, q);
    const failures = verdict(now);
    if (args.includes('--self-test')) {
      if (!selfTest(now.img)) ok = false;
      // live known-bad: errors injected into real pages must reach verdict()
      for (const [label, opts, needle] of [
        ['error after load', { inject: () => console.error('THREE.selfTest injected') }, 'injected'],
        ['error during startup', { beforeLoad: () => console.error('selfTest startup injected') }, 'startup injected'],
      ]) {
        const caught = verdict(await capture(browser, q, opts)).some((f) => f.includes(needle));
        console.log(`self-test ${caught ? 'ok  ' : 'FAIL'} ${label} fails the run`);
        if (!caught) ok = false;
      }
    }
    const refPath = `tmp/diff/ref/${name}.png`;
    let r = { psnr: NaN, mismatch: NaN };
    if (update) {
      if (!failures.length) await writeFile(refPath, PNG.sync.write(now.img));
    } else if (!existsSync(refPath)) {
      failures.push(`no reference: run with --update on a clean commit first`);
    } else {
      const ref = PNG.sync.read(await readFile(refPath));
      r = compare(ref, now.img, CROP[name]);
      if (!(r.psnr >= MIN_PSNR)) failures.push(`PSNR ${r.psnr.toFixed(2)} below the floor ${MIN_PSNR}`);
      await writeFile(`tmp/diff/${name}.png`, sideBySide(ref, now.img));
    }
    if (failures.length) ok = false;
    console.log(JSON.stringify({ scene: name, update, psnr: Number(r.psnr.toFixed(2)), mismatchPct: Number(r.mismatch.toFixed(1)), adapter: now.adapter, failures }));
  }
} catch (e) {
  console.log('capture failed:', e.message);
  ok = false;
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
