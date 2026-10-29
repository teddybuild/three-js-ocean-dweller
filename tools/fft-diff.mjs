// Milestone 1 check of the three.js FFT ocean (src/three/ocean.ts): node tools/fft-diff.mjs [--self-test]
// 1. The bare inverse FFT at 128/256/512 against an O(N^2)-per-row CPU DFT: impulse, single mode, seeded noise.
// 2. Every cascade's h0, displacement + foam, slope and active-breaking buffers against open-water's GL ocean after
//    STEPS updates with the breeze preset's spectrum. GL stores disp/slope/active as half floats, hence the looser
//    limits. --self-test also checks that a forward-transform reference and a swapped cascade fail.
// Exit 1 on any failure or page error. Needs the dev server on :5173.
import { launch, openApp } from './browser.mjs';
import { B64, toF32, relRms, reporter, pageErrors } from './compare.mjs';

const W = 1280, H = 720, STEPS = 3, DT = 1 / 30, T0 = 37.3;
const SIZES = [128, 256, 512];
// relative RMS error limits, about 5-20x the 2026-10-29 run: f32 against f32, and f32 against GL's f16 render targets
const LIMIT = { fft: 1e-5, h0: 1e-5, disp: 2e-3, slope: 2e-3, foam: 5e-3, active: 5e-3 };
const selfTest = process.argv.includes('--self-test');

// 2D inverse DFT, out[x] = sum_k in[k] e^{+2 pi i k x / n} (sign < 0: forward), of the 4 complex signals packed in a
// vec4 pair, one row then one column at a time
function idft2(n, d0, d1, sign = 1) {
  const cs = new Float64Array(n), sn = new Float64Array(n);
  for (let k = 0; k < n; k++) { cs[k] = Math.cos((2 * Math.PI * k) / n); sn[k] = sign * Math.sin((2 * Math.PI * k) / n); }
  const out = [new Float32Array(d0.length), new Float32Array(d1.length)];
  const re = new Float64Array(n), im = new Float64Array(n), tr = new Float64Array(n * n), ti = new Float64Array(n * n);
  for (let s = 0; s < 4; s++) {
    const src = s < 2 ? d0 : d1, dst = out[s >> 1], o = (s & 1) * 2;
    for (let pass = 0; pass < 2; pass++) {
      for (let line = 0; line < n; line++) {
        const at = (t) => (pass === 0 ? line * n + t : t * n + line);
        for (let t = 0; t < n; t++) {
          if (pass === 0) { re[t] = src[at(t) * 4 + o]; im[t] = src[at(t) * 4 + o + 1]; } else { re[t] = tr[at(t)]; im[t] = ti[at(t)]; }
        }
        for (let x = 0; x < n; x++) {
          let a = 0, b = 0;
          for (let k = 0, kx = 0; k < n; k++, kx = (kx + x) % n) { a += re[k] * cs[kx] - im[k] * sn[kx]; b += re[k] * sn[kx] + im[k] * cs[kx]; }
          if (pass === 0) { tr[at(x)] = a; ti[at(x)] = b; } else { dst[at(x) * 4 + o] = a; dst[at(x) * 4 + o + 1] = b; }
        }
      }
    }
  }
  return out;
}

function fftCases(n) {
  const mk = () => [new Float32Array(n * n * 4), new Float32Array(n * n * 4)];
  const impulse = mk();
  impulse[0][0] = 1; impulse[0][3] = -2; impulse[1][1] = 0.5; impulse[1][2] = 3;
  // one mode per signal at different (kx, ky), so a swapped axis or a wrong twiddle shows
  const mode = mk();
  [[3, 5], [n - 7, 2], [1, n / 2 + 1], [n / 2, 9]].forEach(([kx, ky], s) => { mode[s >> 1][(ky * n + kx) * 4 + (s & 1) * 2] = 1; });
  const noise = mk();
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) - 0.5;
  for (const d of noise) for (let i = 0; i < d.length; i++) d[i] = rnd();
  return { impulse, mode, noise };
}

const { failures, report } = reporter();

const browser = await launch({ width: W, height: H });
try {
  const three = await openApp(browser, 'http://localhost:5173/?render&engine=three', { width: W, height: H });
  await three.waitForFunction(() => window.portTest, { timeout: 60000 });

  // 1. bare FFT against the CPU DFT
  for (const n of SIZES) {
    for (const [name, [d0, d1]] of Object.entries(fftCases(n))) {
      const got = await three.evaluate(async (n, a, b, B64) => {
        const enc = eval(B64);
        const dec = (s) => { const u = Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); return new Float32Array(u.buffer); };
        const T = window.portTest;
        return (await T.scoped(() => T.ocean.fftOnly(n, dec(a), dec(b)))).map(enc);
      }, n, Buffer.from(d0.buffer).toString('base64'), Buffer.from(d1.buffer).toString('base64'), B64);
      const [g0, g1] = got.map(toF32);
      const [w0, w1] = idft2(n, d0, d1);
      const err = Math.hypot(relRms(g0, w0), relRms(g1, w1)) / Math.SQRT2;
      report(`fft ${n} ${name}`, err, LIMIT.fft);
      if (selfTest && name === 'noise') {
        const [f0, f1] = idft2(n, d0, d1, -1);
        report(`self-test fft ${n} forward-transform reference`, Math.hypot(relRms(g0, f0), relRms(g1, f1)) / Math.SQRT2, LIMIT.fft, true);
      }
    }
  }

  // 2. the full ocean against GL, same spectrum, foam parameters and steps
  const gl = await openApp(browser, 'http://localhost:5173/?render&engine=gl&preset=breeze&float=0', { width: W, height: H });
  await gl.waitForFunction(() => window.engine, { timeout: 60000 });
  const ref = await gl.evaluate((STEPS, DT, T0, B64) => {
    const enc = eval(B64);
    const app = window.app, g = app.gl, W = app.weather, S = W.state;
    const wdr = (S.windDir * Math.PI) / 180;
    const P = {
      spectrum: W.spectrum(), foam: W.foam(), lambda: Math.max(S.choppy, W.choppyFor(S.wind)),
      drift: [Math.cos(wdr) * 0.035 * S.wind, Math.sin(wdr) * 0.035 * S.wind], res: app.ocean.cascades.map((c) => c.N),
    };
    const oc = new app.ocean.constructor(g, P.res); // a fresh Ocean: same seed, empty foam history
    oc.lambda = P.lambda; oc.drift = P.drift;
    oc.setSpectrum(P.spectrum);
    for (let i = 0; i < STEPS; i++) oc.update(T0 + i * DT, DT, P.foam);
    const read = (t) => {
      const fb = g.createFramebuffer();
      g.bindFramebuffer(g.FRAMEBUFFER, fb);
      g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, t.tex, 0);
      const out = new Float32Array(t.w * t.h * 4);
      g.readPixels(0, 0, t.w, t.h, g.RGBA, g.FLOAT, out);
      g.bindFramebuffer(g.FRAMEBUFFER, null);
      g.deleteFramebuffer(fb);
      return enc(out);
    };
    const fields = oc.cascades.map((c) => ({ h0: read(c.h0), disp: read(c.disp[c.cur]), slope: read(c.slope[c.cur]), active: read(c.active[c.cur]) }));
    const e = g.getError();
    return { P, fields, glError: e };
  }, STEPS, DT, T0, B64);
  if (ref.glError) failures.push(`gl error 0x${ref.glError.toString(16)} during the GL ocean run`);

  const got = await three.evaluate(async (P, STEPS, DT, T0, B64) => {
    const enc = eval(B64);
    const T = window.portTest, o = T.ocean;
    return T.scoped(async () => {
      o.lambda = P.lambda; o.drift = P.drift;
      o.setSpectrum(P.spectrum);
      for (let i = 0; i < STEPS; i++) o.update(T0 + i * DT, DT, P.foam);
      const out = [];
      for (let ci = 0; ci < o.cascades.length; ci++) {
        const f = o.fields(ci), r = {};
        for (const k of ['h0', 'disp', 'slope', 'active']) r[k] = enc(await o.read(f[k]));
        out.push(r);
      }
      return { res: o.cascades.map((c) => c.N), fields: out };
    });
  }, ref.P, STEPS, DT, T0, B64);
  if (got.res.join() !== ref.P.res.join()) failures.push(`FFT sizes differ: three ${got.res}, gl ${ref.P.res}`);

  const dec = (fs) => fs.map((f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, toF32(v)])));
  const G = dec(ref.fields), T = dec(got.fields);
  G.forEach((g, ci) => {
    const t = T[ci];
    report(`cascade ${ci} (${ref.P.res[ci]}) h0`, relRms(t.h0, g.h0), LIMIT.h0);
    report(`cascade ${ci} disp`, relRms(t.disp, g.disp, 4, [0, 1, 2]), LIMIT.disp);
    report(`cascade ${ci} foam`, relRms(t.disp, g.disp, 4, [3]), LIMIT.foam);
    report(`cascade ${ci} slope`, relRms(t.slope, g.slope), LIMIT.slope);
    report(`cascade ${ci} active`, relRms(t.active, g.active, 4, [0], 1, [0]), LIMIT.active);
  });
  if (selfTest) report('self-test cascade 1 disp against cascade 2', relRms(T[1].disp, G[2].disp, 4, [0, 1, 2]), LIMIT.disp, true);

  await pageErrors(three, 'three', failures);
  await pageErrors(gl, 'gl', failures);
} finally {
  await browser.close();
}
console.log(failures.length ? `FAILED: ${failures.length}\n${failures.join('\n')}` : 'all ok');
process.exit(failures.length ? 1 : 0);
