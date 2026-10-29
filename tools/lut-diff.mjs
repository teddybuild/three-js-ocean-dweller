// Milestone 2 check of the three.js atmosphere (src/three/atmosphere.ts): node tools/lut-diff.mjs [--self-test]
// Builds the transmittance, multiple-scattering, sky-view and aerial LUTs, then the clear-sky environment map and its
// irradiance, in both engines for several sun elevations, and compares them texel for texel (all half float). --self-test also checks that one case's sky-view
// LUT against another case's fails. Exit 1 on any failure or page error. Needs the dev server on :5173.
import { launch, openApp } from './browser.mjs';
import { B64, toF32, relRms, reporter, pageErrors } from './compare.mjs';

const W = 1280, H = 720, CAM_H = 3, HAZE = 1.3, AZ = 200;
const ELEVS = [11, 45, 2, -4]; // breeze default, high sun, sunset, twilight
const LUTS = ['transmittance', 'multiScatter', 'skyView', 'aerialL'];
const ENV = ['env', 'envDeck', 'irradiance'];
const RRS = [0.0004, 0.003, 0.0085];
// relative RMS, about 20x the 2026-10-29 run (worst 4.7e-5)
const LIMIT = { transmittance: 1e-3, multiScatter: 1e-3, skyView: 1e-3, aerialL: 1e-3, env: 1e-3, envDeck: 1e-3, irradiance: 1e-3 };
const selfTest = process.argv.includes('--self-test');
const sunDir = (e, a) => [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
const { failures, report } = reporter();

const browser = await launch({ width: W, height: H });
try {
  const gl = await openApp(browser, 'http://localhost:5173/?render&engine=gl&preset=breeze&float=0', { width: W, height: H });
  await gl.waitForFunction(() => window.engine, { timeout: 60000 });
  const three = await openApp(browser, 'http://localhost:5173/?render&engine=three', { width: W, height: H });
  await three.waitForFunction(() => window.portTest, { timeout: 60000 });
  const results = [];
  for (const elev of ELEVS) {
    const sun = sunDir((elev * Math.PI) / 180, (AZ * Math.PI) / 180);
    const ref = await gl.evaluate((sun, camH, haze, LUTS, B64, ENV, RRS) => {
      const enc = eval(B64);
      const app = window.app, g = app.gl;
      const atmo = new app.atmo.constructor(g); // fresh: no cached haze key
      atmo.update(sun, camH, haze);
      // clear sky: clouds off, no fog, rain, front or spray (applyFog is then the identity)
      const sky = new app.sky.constructor(g);
      const U = {
        uSkyView: atmo.skyView, uAerialL: atmo.aerialL, uExtRatio: atmo.extRatio, uTransmittance: atmo.transmittance, uSunDir: sun,
        uAerialMax: atmo.maxDist, uIrradiance: sky.irradiance, uCamHkm: camH / 1000, uLightScale: 1, uLightMag: -26.74, uHazeSun: 1,
        uFogDensity: 0, uFogTop: 1300, uFogFront: [1, 0, 0, 0], uFogCell: [0, 0], uFogStorm: [0, 0.3, 0], uFogCam: [0, 0],
        uRainCell: [0, 0, 0], uFlashFog: [0, 0, 0], uFlashDir: [0, 1, 0], uSprayHaze: [0, camH],
        uCloudsEnv: app.clouds.env, uCloudsOn: 0, uSunVis: 1, uEnvRrs: RRS,
      };
      // twice: the sea half of the environment reads the irradiance of the previous pass
      sky.renderEnv(U);
      sky.renderEnv(U);
      for (const k of ENV) atmo[k] = sky[k];
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
      const out = Object.fromEntries([...LUTS, ...ENV].map((k) => [k, read(atmo[k])]));
      return { out, glError: g.getError() };
    }, sun, CAM_H, HAZE, LUTS, B64, ENV, RRS);
    if (ref.glError) failures.push(`gl error 0x${ref.glError.toString(16)} at elevation ${elev}`);
    const got = await three.evaluate(async (sun, camH, haze, LUTS, B64, ENV) => {
      const enc = eval(B64);
      const T = window.portTest;
      return T.scoped(async () => {
        T.atmo.update(sun, camH, haze);
        T.sky.renderEnv();
        T.sky.renderEnv();
        const out = {};
        for (const k of LUTS) out[k] = enc(await T.readTexture(T.atmo[k]));
        for (const k of ENV) out[k] = enc(await T.readTexture(T.sky[k]));
        return out;
      });
    }, sun, CAM_H, HAZE, LUTS, B64, ENV);
    const g = Object.fromEntries([...LUTS, ...ENV].map((k) => [k, toF32(ref.out[k])]));
    const t = Object.fromEntries([...LUTS, ...ENV].map((k) => [k, toF32(got[k])]));
    for (const k of [...LUTS, ...ENV]) report(`sun ${elev} deg ${k}`, relRms(t[k], g[k]), LIMIT[k]);
    results.push({ g, t });
  }
  if (selfTest) report('self-test sky-view at 11 deg against 45 deg', relRms(results[0].t.skyView, results[1].g.skyView), LIMIT.skyView, true);
  await pageErrors(three, 'three', failures);
  await pageErrors(gl, 'gl', failures);
} finally {
  await browser.close();
}
console.log(failures.length ? `FAILED: ${failures.length}\n${failures.join('\n')}` : 'all ok');
process.exit(failures.length ? 1 : 0);
