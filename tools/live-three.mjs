// Live-path smoke test of the three.js port (no ?render): q=rt, the rAF loop, the floating camera, the shared UI and
// drag input, and thunder audio from a forced strike. Fails on any WebGPU or page error, a stalled loop, or no thunder. node tools/live-three.mjs
import { launch, openApp } from './browser.mjs';

const browser = await launch({ width: 1280, height: 720 });
const failures = [];
try {
  const page = await openApp(browser, 'http://localhost:5173/?engine=three&preset=storm&strikeAt=2&sdist=1500', { width: 1280, height: 720 });
  await page.waitForFunction(() => window.portTest, { timeout: 60000 });
  // count thunder the audio engine schedules; the click is the gesture that starts the AudioContext
  await page.evaluate(() => { const e = portTest.audio.engine, f = e.thunder.bind(e); window.thunders = 0; e.thunder = (...a) => { thunders++; return f(...a); }; });
  // the UI's M key starts the sound; a drag turns the camera
  await page.keyboard.press('m');
  const yaw0 = await page.evaluate(() => app.cam.yaw);
  await page.mouse.move(640, 360); await page.mouse.down(); await page.mouse.move(740, 360, { steps: 5 }); await page.mouse.up();
  if ((await page.evaluate(() => app.cam.yaw)) - yaw0 < 0.1) failures.push('drag did not turn the camera');
  if (!(await page.$('.sound'))) failures.push('no UI');
  const f0 = await page.evaluate(() => engine.frames);
  await new Promise((r) => setTimeout(r, 6000));
  const r = await page.evaluate(() => ({ frames: engine.frames, errors: engine.errors, ctx: portTest.audio.ctx?.state, thunders, buffers: Object.keys(portTest.audio.engine.buffers).filter((k) => k.startsWith('thunder')).length }));
  const fps = (r.frames - f0) / 6;
  console.log(JSON.stringify({ fps: +fps.toFixed(1), audio: r.ctx, thunders: r.thunders, buffers: r.buffers, errors: r.errors.length }));
  if (fps < 5) failures.push(`loop stalled: ${fps.toFixed(1)} fps`);
  if (r.ctx !== 'running') failures.push(`audio context ${r.ctx}`);
  if (r.thunders < 1) failures.push('no thunder from the forced strike');
  if (r.buffers < 1) failures.push('no thunder recording decoded: thunder() returns silently');
  failures.push(...r.errors, ...page.collectedErrors);
} finally {
  await browser.close();
}
for (const f of failures) console.log('FAIL', f);
process.exit(failures.length ? 1 : 0);
