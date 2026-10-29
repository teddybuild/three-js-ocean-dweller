// Renders one scene in both engines and compares them: node tools/diff.mjs [scene ...] [--self-test]
// Each capture is a fresh page (?render, fixed 1/30 s steps from t = 0), so both engines run the same frame
// sequence. Writes tmp/diff/<scene>.png (gl | three) and prints PSNR, pixelmatch mismatch %, adapters, errors.
// Exit 1 when the three engine reports a WebGPU error, runs on a fallback or non-NVIDIA adapter, or a capture fails.
import { writeFile, mkdir } from 'node:fs/promises';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { launch, openApp } from './browser.mjs';

const SCENES = {
  breeze: 'preset=breeze',
  calm: 'preset=calm&yaw=60',
  squall: 'preset=breeze&front=1&frontDist=15000&frontAz=60&yaw=60&pitch=3&frontLen=8000&frontDepth=4000&frontWidth=1000&sTop=3500&sBase=900',
};
const W = 1280, H = 720, WARM = 3, DT = 1 / 30;

export function psnr(a, b) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { const d = a[i + c] - b[i + c]; se += d * d; n++; }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / n));
}

async function capture(browser, engine, query) {
  const page = await openApp(browser, `http://localhost:5173/?render&engine=${engine}&${query}`, { width: W, height: H });
  await page.waitForFunction(() => window.engine, { timeout: 60000 });
  const out = await page.evaluate(async (n, dt) => {
    await window.engine.step(n, dt);
    return { png: window.engine.capture(), errors: window.engine.errors, adapter: window.engine.adapter };
  }, Math.round(WARM / DT), DT);
  await page.close();
  return { ...out, img: PNG.sync.read(Buffer.from(out.png.split(',')[1], 'base64')) };
}

function sideBySide(a, b) {
  const out = new PNG({ width: a.width + b.width, height: Math.max(a.height, b.height) });
  PNG.bitblt(a, out, 0, 0, a.width, a.height, 0, 0);
  PNG.bitblt(b, out, 0, 0, b.width, b.height, a.width, 0);
  return PNG.sync.write(out);
}

function compare(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { psnr: NaN, mismatch: NaN, note: `size ${a.width}x${a.height} vs ${b.width}x${b.height}` };
  const bad = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 });
  return { psnr: psnr(a.data, b.data), mismatch: (100 * bad) / (a.width * a.height) };
}

// known-bad check: identical images must give PSNR = Infinity, a noisy copy must fall below 40 dB
function selfTest(img) {
  const noisy = new PNG({ width: img.width, height: img.height });
  img.data.copy(noisy.data);
  for (let i = 0; i < noisy.data.length; i += 4) noisy.data[i] = (noisy.data[i] + 40) % 256;
  const same = compare(img, img).psnr, off = compare(img, noisy).psnr;
  console.log(`self-test: same ${same} dB, noisy ${off.toFixed(1)} dB`);
  return same === Infinity && off < 40;
}

const args = process.argv.slice(2);
const names = args.filter((a) => !a.startsWith('--'));
const scenes = names.length ? names : ['breeze'];
await mkdir('tmp/diff', { recursive: true });
const browser = await launch({ width: W, height: H });
let ok = true;
try {
  for (const name of scenes) {
    const q = SCENES[name] ?? name;
    const gl = await capture(browser, 'gl', q);
    const three = await capture(browser, 'three', q);
    if (args.includes('--self-test') && !selfTest(gl.img)) { console.log('self-test FAILED'); ok = false; }
    const r = compare(gl.img, three.img);
    await writeFile(`tmp/diff/${name}.png`, sideBySide(gl.img, three.img));
    const hw = /nvidia/i.test(three.adapter);
    if (three.errors.length || !hw) ok = false;
    console.log(JSON.stringify({ scene: name, psnr: Number(r.psnr.toFixed(2)), mismatchPct: Number(r.mismatch.toFixed(1)), note: r.note, gl: gl.adapter, three: three.adapter, threeErrors: three.errors }));
  }
} catch (e) {
  console.log('capture failed:', e.message);
  ok = false;
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
