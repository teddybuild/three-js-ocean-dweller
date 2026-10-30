// Milestone 4 check of the three.js clouds (src/three/clouds.ts): node tools/cloud-diff.mjs [--self-test]
// Runs the breeze scene 90 fixed frames in both engines, then compares the cloud inputs and outputs: shape and detail
// volumes (three z slices of every mip), the weather map (every mip), the shadow map, the env clouds and the screen
// buffer with its distance. Prints relative RMS and the three/GL ratio of the channel means, so a lighting error
// shows its direction. --self-test also checks that a shape slice against another slice fails. Exit 1 on any failure
// or page error. Needs the dev server on :5173.
import { launch, openApp } from './browser.mjs';
import { B64, toF32, relRms, reporter, pageErrors } from './compare.mjs';

const W = 1280, H = 720, FRAMES = 90, DT = 1 / 30;
const QUERY = 'render&preset=breeze&float=0';
// [key, levels]: z slices 0, mid and last of each level; 2D textures have one slice
const VOLS = [['shape', 8], ['detail', 6]];
// relative RMS, about 2-6x the 2026-10-29 run (worst: volumes 3.1e-3, weather 6.7e-3, shadow 1.8e-2, env rgb 4.3e-2,
// screen rgb 5.3e-2, alpha 9.8e-3, depth 2.9e-3). The flash bug of that day put env rgb at 0.37.
const LIMIT = { shape: 2e-2, detail: 2e-2, weather: 2e-2, shadow: 4e-2, env: 0.1, screen: 0.1, depth: 0.05 };
// a screen pixel (x, y from the top) printed as values: the backlit cloud near the sun (handoff 2026-10-29)
const PROBES = [[540, 100]];
const selfTest = process.argv.includes('--self-test');
const { failures, report } = reporter();

// the slices to compare: { name, key, level, z }
const slices = [];
for (const [key, levels] of VOLS) for (let l = 0; l < levels; l++) {
  const s = (key === 'shape' ? 128 : 32) >> l;
  for (const z of [...new Set([0, s >> 1, s - 1])]) slices.push({ name: `${key} mip ${l} z ${z}`, key, level: l, z });
}
for (let l = 0; l < 10; l++) slices.push({ name: `weather mip ${l}`, key: 'weather', level: l, z: 0 });
for (const key of ['shadow', 'env', 'screen', 'depth']) slices.push({ name: key, key, level: 0, z: 0 });

const browser = await launch({ width: W, height: H });
try {
  const gl = await openApp(browser, `http://localhost:5173/?${QUERY}&engine=gl`, { width: W, height: H });
  await gl.waitForFunction(() => window.engine, { timeout: 60000 });
  const ref = await gl.evaluate(async (slices, B64, n, dt) => {
    const enc = eval(B64);
    await window.engine.step(n, dt);
    const c = window.app.clouds, g = window.app.gl;
    const tex = { shape: c.shape, detail: c.detail, weather: c.weatherMap, shadow: c.shadow, env: c.env, screen: c.screen, depth: c.depth };
    const read = (t, level, z) => {
      const w = Math.max(t.w >> level, 1), h = Math.max(t.h >> level, 1);
      const fb = g.createFramebuffer();
      g.bindFramebuffer(g.FRAMEBUFFER, fb);
      if (t.d) g.framebufferTextureLayer(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, t.tex, level, z);
      else g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, t.tex, level);
      let out;
      if (t.type === g.UNSIGNED_BYTE) {
        const b = new Uint8Array(w * h * 4);
        g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, b);
        out = Float32Array.from(b, (v) => v / 255);
      } else {
        out = new Float32Array(w * h * 4);
        g.readPixels(0, 0, w, h, g.RGBA, g.FLOAT, out);
      }
      g.bindFramebuffer(g.FRAMEBUFFER, null);
      g.deleteFramebuffer(fb);
      return enc(out);
    };
    const out = slices.map((s) => read(tex[s.key], s.level, s.z));
    return { out, glError: g.getError(), engineErrors: window.engine.errors };
  }, slices, B64, FRAMES, DT);
  if (ref.glError) failures.push(`gl error 0x${ref.glError.toString(16)}`);
  failures.push(...ref.engineErrors.map((e) => `gl ${e}`));
  await gl.close();

  const three = await openApp(browser, `http://localhost:5173/?${QUERY}&engine=three`, { width: W, height: H });
  await three.waitForFunction(() => window.portTest, { timeout: 60000 });
  const got = await three.evaluate(async (slices, B64, n, dt) => {
    const enc = eval(B64);
    await window.engine.step(n, dt);
    const T = window.portTest, c = T.clouds;
    const tex = { shape: c.shape, detail: c.detail, weather: c.weatherMap, shadow: c.shadow, env: c.env, screen: c.screen, depth: c.depth };
    return T.scoped(async () => {
      const out = [];
      for (const s of slices) out.push(enc(await T.readTexture(tex[s.key], s.level, s.z)));
      return out;
    });
  }, slices, B64, FRAMES, DT);

  const mean = (a) => { const m = [0, 0, 0, 0]; for (let i = 0; i < a.length; i++) m[i & 3] += a[i]; return m.map((v) => (v * 4) / a.length); };
  slices.forEach((s, i) => {
    const g = toF32(ref.out[i]), t = toF32(got[i]);
    if (g.length !== t.length) { failures.push(`${s.name}: size ${t.length} vs GL ${g.length}`); return; }
    // the shadow map and the distance are single channel (GL r16f)
    // radiance and transmittance apart: the alpha (~0.7) would hide an rgb (~0.02) error
    const ch = s.key === 'shadow' || s.key === 'depth' ? [0] : s.key === 'env' || s.key === 'screen' ? [0, 1, 2] : [0, 1, 2, 3];
    const mg = mean(g), mt = mean(t);
    report(s.name, relRms(t, g, 4, ch), LIMIT[s.key]);
    if (ch.length === 3) report(`${s.name} alpha`, relRms(t, g, 4, [3]), LIMIT.depth);
    console.log(`     mean three/GL ${ch.map((c) => `${mt[c].toPrecision(3)}/${mg[c].toPrecision(3)}`).join(' ')}`);
    if (s.key === 'screen') for (const [x, y] of PROBES) {
      const i = ((H - 1 - y) * W + x) * 4;
      console.log(`     pixel (${x}, ${y}) three ${[...t.subarray(i, i + 4)].map((v) => v.toPrecision(3))} GL ${[...g.subarray(i, i + 4)].map((v) => v.toPrecision(3))}`);
    }
  });
  if (selfTest) {
    const a = slices.findIndex((s) => s.key === 'shape' && s.level === 0 && s.z === 0);
    const b = slices.findIndex((s) => s.key === 'shape' && s.level === 0 && s.z === 64);
    report('self-test shape slice 0 against slice 64', relRms(toF32(got[a]), toF32(ref.out[b])), LIMIT.shape, true);
  }
  await pageErrors(three, 'three', failures);
  failures.push(...gl.collectedErrors.map((e) => `gl error: ${e}`));
} finally {
  await browser.close();
}
console.log(failures.length ? `FAILED: ${failures.length}\n${failures.join('\n')}` : 'all ok');
process.exit(failures.length ? 1 : 0);
