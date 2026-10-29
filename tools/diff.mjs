// Renders scenes in both engines and compares them: node tools/diff.mjs [scene ...] [--self-test]
// Each capture is a fresh page (?render, 90 fixed 1/30 s steps of the engine's own clock), so both engines run the
// same frame sequence from the same seeds. Writes tmp/diff/<scene>.png (gl | three); prints PSNR, pixelmatch %,
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
};
const W = 1280, H = 720, WARM = 3, DT = 1 / 30;
const EXPECT = { vendor: /nvidia/i, architecture: process.env.EXPECT_GPU_ARCH || 'blackwell' };

export function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { const d = a[i + c] - b[i + c]; se += d * d; n++; }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / n));
}

function compare(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { psnr: NaN, mismatch: NaN };
  const bad = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 });
  return { psnr: psnr(a.data, b.data), mismatch: (100 * bad) / (a.width * a.height) };
}

// Every reason a gl/three pair must fail the run. An empty list is a pass.
export function verdict(gl, three) {
  const f = [];
  for (const [name, c] of [['gl', gl], ['three', three]]) {
    if (c.img.width !== W || c.img.height !== H) f.push(`${name} capture is ${c.img.width}x${c.img.height}, expected ${W}x${H}`);
    for (const e of c.errors) f.push(`${name} error: ${e}`);
  }
  const a = three.adapter;
  if (!EXPECT.vendor.test(a.vendor) || a.architecture !== EXPECT.architecture) f.push(`three adapter ${a.vendor} ${a.architecture}, expected nvidia ${EXPECT.architecture}`);
  if (a.fallback) f.push('three runs on a fallback adapter');
  return f;
}

// Known-bad checks: verdict() must reject each broken case, and the metrics must see a corrupted image.
function selfTest(img) {
  const ok = { img, errors: [], adapter: { vendor: 'nvidia', architecture: EXPECT.architecture, fallback: false } };
  const small = new PNG({ width: 64, height: 64 });
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
    ['identical image: PSNR Infinity, 0 % mismatch', (() => { const r = compare(img, img); return r.psnr === Infinity && r.mismatch === 0; })()],
    ['noisy image: PSNR < 40, mismatch > 50 %', (() => { const r = compare(img, noisy); return r.psnr < 40 && r.mismatch > 50; })()],
  ];
  for (const [name, pass] of cases) console.log(`self-test ${pass ? 'ok  ' : 'FAIL'} ${name}`);
  return cases.every(([, pass]) => pass);
}

async function capture(browser, engine, query, inject) {
  const page = await openApp(browser, `http://localhost:5173/?render&engine=${engine}&${query}`, { width: W, height: H });
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.waitForFunction(() => window.engine, { timeout: 60000 });
  if (inject) await page.evaluate(inject);
  const out = await page.evaluate(async (n, dt) => {
    await window.engine.step(n, dt);
    const png = await window.engine.capture();
    return { png, errors: window.engine.errors, adapter: window.engine.adapter };
  }, Math.round(WARM / DT), DT);
  await page.close();
  return { ...out, errors: [...out.errors, ...pageErrors], img: PNG.sync.read(Buffer.from(out.png.split(',')[1], 'base64')) };
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
    const q = SCENES[name] ?? name;
    const gl = await capture(browser, 'gl', q);
    const three = await capture(browser, 'three', q);
    if (args.includes('--self-test')) {
      if (!selfTest(gl.img)) ok = false;
      // live known-bad: an error logged on a real three page must reach verdict()
      const bad = await capture(browser, 'three', q, () => console.error('THREE.selfTest injected error'));
      const caught = verdict(gl, bad).some((f) => f.includes('injected'));
      console.log(`self-test ${caught ? 'ok  ' : 'FAIL'} injected page error fails the run`);
      if (!caught) ok = false;
    }
    const r = compare(gl.img, three.img);
    const failures = verdict(gl, three);
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
