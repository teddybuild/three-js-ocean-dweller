// One three.js frame to a PNG: node tools/shot.mjs "<query>" out.png [width height seconds]
// A fresh page (?render), `seconds` of fixed 1/30 s frames, then the next frame captured (window.engine, src/boot.ts).
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { launch, openApp } from './browser.mjs';

const [query = '', out = 'tmp/shot.png', w = '1600', h = '900', secs = '6'] = process.argv.slice(2);
const width = Number(w), height = Number(h), dt = 1 / 30;
const browser = await launch({ width, height });
try {
  const page = await openApp(browser, `http://localhost:5173/?render&${query}`, { width, height });
  await page.waitForFunction(() => window.engine, { timeout: 60000 });
  const r = await page.evaluate(async (n, dt) => {
    const t0 = performance.now();
    await window.engine.step(n, dt);
    const ms = (performance.now() - t0) / n;
    return { png: await window.engine.capture(dt), msPerFrame: ms.toFixed(1), errors: window.engine.errors };
  }, Math.round(Number(secs) / dt), dt);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(r.png.split(',')[1], 'base64'));
  const errors = [...r.errors, ...page.collectedErrors];
  console.log(JSON.stringify({ out, msPerFrame: r.msPerFrame, errors }));
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
