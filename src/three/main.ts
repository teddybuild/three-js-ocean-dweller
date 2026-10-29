// three.js WebGPU port of open-water. Renderer, clock, camera, weather, atmosphere, the clear sky (M2) and the water
// (M3). WebGPU only: three's WebGL2 fallback is refused.
import * as THREE from 'three/webgpu';
import { uniform, Fn, max, positionWorldDirection, screenUV, texture, vec2, cameraPosition } from 'three/tsl';
import type { Engine } from '../boot';
import { OceanCompute } from './ocean';
import { AtmosphereCompute } from './atmosphere';
import { SkyCompute, skyU, fogU } from './sky';
import { PostChain, type PostOptions } from './post';
import { WaterMesh } from './water';
import { FoamTextureCompute } from './foam';
import { CloudsCompute, cloudU, frontCurve } from './clouds';
import { OceanProbe } from './probe';
import { Rain } from './rain';
import { Spray } from './spray';
import { Lightning } from './lightning';
import { atmoU } from './atmosphere';
import { Weather } from '../weather.js';
import { AudioEngine } from '../audio/audio.js';
import { UI, UI_CSS } from '../ui.js';
import { film, filmAudio } from '../film.js';
import { smoothstep, clamp } from '../math.js';

const params = new URLSearchParams(location.search);
const RENDER_MODE = params.has('render');
const canvas = document.getElementById('c') as HTMLCanvasElement;

// The engine's own clock. Every animated node reads uTime; three's `time` node and NodeFrame are never used,
// because they follow the wall clock, not the fixed steps of a capture.
let elapsed = Number(params.get('t') || 0);
export const uTime = uniform(elapsed);

function fail(msg: string): never {
  throw new Error(msg);
}

// Live audio, as src/main.js `audio`: wind, rain and sea from the weather, thunder from lightning.events. Browsers
// block autoplay, so the context is made on the first gesture; ?render never makes one.
const audio = {
  engine: new AudioEngine(),
  ctx: null as AudioContext | null,
  async enable(on: boolean) {
    if (on && !this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      await this.engine.init(this.ctx);
    }
    if (this.ctx) await (on ? this.ctx.resume() : this.ctx.suspend());
  },
  update(S: any, hs: number) {
    if (!this.ctx) return;
    this.engine.set({
      wind: S.wind, rain: S.rain, hs,
      tp: (2 * Math.PI * Math.max(S.wind, 1)) / (0.855 * 9.81),
      foam: Math.min(2 * 3.84e-6 * Math.pow(S.wind, 3.41), 0.4),
    });
    this.engine.tick();
  },
  // a muted (suspended) context drops thunder instead of queueing it for the unmute
  thunder(events: { dist: number; power: number }[]) {
    if (this.ctx?.state === 'running') for (const ev of events) this.engine.thunder(this.ctx.currentTime, ev.dist, ev.power);
  },
};

async function start() {
  if (!navigator.gpu || !(await navigator.gpu.requestAdapter())) fail('WebGPU is not available in this browser');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  const backend = renderer.backend as any;
  if (!backend.isWebGPUBackend) fail('three fell back to WebGL2; this port needs WebGPU');
  const device: GPUDevice = backend.device;
  // fixed steps own three's frame lifecycle in ?render: its own rAF loop would advance NodeFrame on the wall clock,
  // and without it passes like bloom update once per capture instead of once per frame (Codex M0 re-review, P1)
  const internals = renderer as any;
  if (RENDER_MODE) internals._animation.stop();

  // WebGPU errors: uncaptured ones, a validation scope per frame, and the ones three catches in its own error
  // scopes and only logs (pipeline creation), via its console hook
  const errors: string[] = [];
  const pending: Promise<void>[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  device.lost.then((info) => errors.push(`device lost: ${info.message}`));
  THREE.setConsoleFunction((type: 'log' | 'warn' | 'error', message: string, ...rest: unknown[]) => {
    if (type === 'error') errors.push([message, ...rest].map(String).join(' '));
    console[type](message, ...rest);
  });
  // every popErrorScope promise, three's own pipeline scopes included, so settle() waits for their error reports
  // (the extra .then hop lets the caller's own handler push the error before Promise.all sees the scope settle)
  const pop = device.popErrorScope.bind(device);
  device.popErrorScope = () => { const p = pop(); if (RENDER_MODE) pending.push(p.then(() => {})); return p; };
  const ai = device.adapterInfo as GPUAdapterInfo & { isFallbackAdapter?: boolean };
  const scopes: GPUErrorFilter[] = ['validation', 'out-of-memory', 'internal'];

  // drawing-buffer scale, as src/main.js: ?scale, else the device ratio up to 1.5 (live adjusts it to the frame time)
  let scale = Number(params.get('scale') || (RENDER_MODE ? 1 : Math.min(window.devicePixelRatio || 1, 1.5)));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  // camera: same URL keys, defaults and clip planes as src/main.js (eye height h, yaw/pitch in degrees, vertical
  // fov). It rides the waves unless ?float=0 (updateCamera).
  const cam = {
    eye: Number(params.get('h') || 3), base: [0, 0], heave: 0, roll: 0, tilt: 0, float: params.get('float') !== '0',
    yaw: (Number(params.get('yaw') || 200) * Math.PI) / 180, pitch: (Number(params.get('pitch') ?? 1.5) * Math.PI) / 180,
    fov: (Number(params.get('fov') || 42) * Math.PI) / 180, pos: [0, 0, 0],
  };
  const camera = new THREE.PerspectiveCamera(Number(params.get('fov') || 42), window.innerWidth / window.innerHeight, 0.2, 80000);
  camera.position.set(0, cam.eye, 0);

  // weather: same preset, URL keys and snap as src/main.js
  const weather = new Weather(params.get('preset') || 'breeze');
  if (params.has('elev')) weather.set('sunElev', Number(params.get('elev')));
  if (params.has('az')) weather.set('sunAz', Number(params.get('az')));
  for (const k of Object.keys(weather.target)) if (params.has(k)) weather.set(k, Number(params.get(k)));
  weather.snap();
  // FFT sizes follow src/main.js: ?q, else 'high' in ?render and 'rt' live
  const q = params.get('q') || (RENDER_MODE ? 'high' : 'rt');
  // src/main.js QUALITY, the cloud part (rt: a half-resolution, checkerboarded buffer)
  const CQ = q === 'rt'
    ? { div: 2, detailFoot: 50, steps: 80, lightSteps: 5, lightDetail: 2, blend: 0.14, check: true, upSteps: 2 }
    : { div: 1, detailFoot: 25, steps: q === 'ultra' ? 128 : 96, lightSteps: 6, lightDetail: 3, blend: 0.08, check: false, upSteps: 4 };
  const ocean = new OceanCompute(renderer, q === 'rt' ? [256, 256, 128, 128] : [512, 256, 256, 256]);
  const atmo = new AtmosphereCompute(renderer);
  const sky = new SkyCompute(renderer, atmo);
  const foam = new FoamTextureCompute(renderer);
  const clouds = new CloudsCompute(renderer, sky);
  const windOffset = [Number(params.get('cx') || 0), 0, Number(params.get('cz') || 0)];
  let prevFrontDist: number | undefined, wasNight: boolean | undefined;
  const water = new WaterMesh({ ...ocean.textures(), env: sky.env, sky, foamTex: foam.tex, shadow: clouds.shadow, shadowRect: clouds.shadowRect }, { angular: q === 'rt' ? 400 : 640 });
  const gustDrift = [0, 0];
  const probe = new OceanProbe(renderer, ocean.textures());
  // weather effects drawn after the water (src/fx): lightning channel, spray, rain
  const lightning = new Lightning(renderer);
  const spray = new Spray(renderer, sky, ocean.textures());
  const rain = new Rain(renderer, sky, ocean.textures());
  const rainDrift = [0, 0];
  let boltT = 1, forcedStrike = false;
  // Floating camera, as src/main.js updateCamera + cameraMatrices: heave, pitch and roll with the sea (a small boat
  // responds to waves longer than itself, so the probe samples a mip level matching an ~8 m hull). ?render waits
  // for the probe (GL's sync readback); live uses the last finished one.
  const updateCamera = async (dt: number) => {
    const r = !cam.float ? probe.result : RENDER_MODE ? await probe.read(cam.base, 8) : probe.run(cam.base, 8);
    const f = cam.float ? 1 - Math.min(Math.max((cam.eye - 12) / 28, 0), 1) : 0;
    const k = 1 - Math.exp(-dt * 5);
    cam.heave += (r.height * f - cam.heave) * k;
    const fx = Math.cos(cam.yaw), fz = Math.sin(cam.yaw);
    const along = r.sx * fx + r.sz * fz, across = -r.sx * fz + r.sz * fx;
    cam.tilt += (Math.atan(along) * 0.55 * f - cam.tilt) * k;
    cam.roll += (Math.atan(across) * 0.55 * f - cam.roll) * k;
    camera.position.set(cam.base[0] + r.dx * f * 0.8, cam.eye + cam.heave, cam.base[1] + r.dz * f * 0.8);
    cam.pos = camera.position.toArray();
    const fovDeg = (cam.fov * 180) / Math.PI;
    if (camera.fov !== fovDeg) { camera.fov = fovDeg; camera.updateProjectionMatrix(); }
    const pitch = cam.pitch + cam.tilt;
    const fwd = new THREE.Vector3(Math.cos(pitch) * Math.cos(cam.yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(cam.yaw));
    const right0 = fwd.clone().cross(camera.up.set(0, 1, 0)).normalize();
    const up0 = right0.clone().cross(fwd);
    // roll: three's lookAt rebuilds the same basis from this up vector
    camera.up.copy(up0.multiplyScalar(Math.cos(cam.roll)).addScaledVector(right0, -Math.sin(cam.roll)));
    camera.lookAt(camera.position.clone().add(fwd));
    camera.updateMatrixWorld();
  };
  const mixv = (a: number[], b: number[], t: number) => a.map((x, i) => x + (b[i] - x) * t);
  // per frame, as the top of src/main.js frame(): ocean, camera, light source, LUTs, squall front, clouds, environment
  const updateSea = (dt: number) => {
    weather.update(dt);
    const S = weather.state;
    ocean.lambda = Math.max(S.choppy, weather.choppyFor(S.wind));
    // wind drift of surface foam ~3% of U10 (plus a little Stokes drift)
    const wdr = (S.windDir * Math.PI) / 180;
    ocean.drift = [Math.cos(wdr) * 0.035 * S.wind, Math.sin(wdr) * 0.035 * S.wind];
    ocean.setSpectrum(weather.spectrum());
    ocean.update(elapsed, dt, weather.foam());
  };
  const updateWorld = async (dt: number): Promise<PostOptions> => {
    updateSea(dt);
    const S = weather.state;
    const wdr = (S.windDir * Math.PI) / 180;
    await updateCamera(dt);
    const night = weather.time.sunElev < -7;
    const sun = night ? weather.moonDir() : weather.sunDir();
    // the light source switched (sun <-> moon): temporal cloud history is meaningless now (as src/main.js)
    if (wasNight !== undefined && wasNight !== night) clouds.reset = true;
    wasNight = night;
    atmoU.lightMag.value = night ? -12.7 : -26.74;
    atmo.update(sun, camera.position.y, S.haze);
    // squall front: world-space line ahead of the camera; weather blends across it
    const cp = camera.position;
    const fOn = S.front > 0.5;
    const faz = (S.frontAz * Math.PI) / 180;
    const fn = [Math.cos(faz), Math.sin(faz)];
    const fz = cp.x * fn[0] + cp.z * fn[1] + S.frontDist;
    const fAlong = -cp.x * fn[1] + cp.z * fn[0];
    const fCurve = frontCurve(fAlong);
    // squall cell: half-length along the line (centred on along = 0) and depth behind it (0 = endless)
    const fCell = [S.frontLen / 2, S.frontDepth];
    const sCam = -S.frontDist - fCurve;
    const mCam = fOn ? smoothstep(-S.frontWidth, S.frontWidth, Math.min(sCam, (fCell[1] || 1e7) - sCam, (fCell[0] || 1e7) - Math.abs(fAlong))) : 0;
    const L = {
      rain: S.rain + (S.sRain - S.rain) * mCam,
      clouds: S.clouds + (S.sClouds - S.clouds) * mCam,
      dark: S.cloudDark + (S.sDark - S.cloudDark) * mCam,
      mist: S.mist + (S.sMist - S.mist) * mCam,
    };
    // fraction of direct sun reaching the haze below the clouds (a closed deck lets none through)
    atmoU.hazeSun.value = (1 - smoothstep(0.3, 0.9, L.clouds)) * (1 - 0.85 * L.dark) * 0.97 + 0.03 * (1 - L.dark) * (1 - smoothstep(0.8, 0.9, L.clouds));
    // lightning: flash intensity drives cloud emission, sky/sea illumination and thunder (as src/main.js)
    const lcam = { pos: cp, yaw: cam.yaw };
    if (params.has('strikeAt') && elapsed >= Number(params.get('strikeAt')) && !forcedStrike) {
      forcedStrike = true;
      lightning.trigger(lcam, { dist: Number(params.get('sdist') || 3500), az: cam.yaw + Number(params.get('saz') || 0.15), ground: true, base: S.cloudBase });
    }
    const flash = lightning.update(dt, S.lightning, lcam, S.cloudBase);
    audio.thunder(lightning.events.splice(0));
    const lp = lightning.pos;
    const ldist = Math.hypot(lp[0] - cp.x, lp[2] - cp.z);
    // illuminance of a stroke ~ I / d^2 with I ~ 1e8 cd, relative to the light source (sun ~1e5 lux, moon ~0.25)
    const flashE = Math.min((flash * 1e8) / (ldist * ldist + 300 * 300) / (night ? 0.25 : 1e5), 6);
    const flashRGB = [0.8 * flashE, 0.85 * flashE, flashE];
    const lv = new THREE.Vector3(lp[0] - cp.x, (night ? lp[1] * 0.3 : lp[1] * 0.5) - cp.y, lp[2] - cp.z);
    fogU.flashFog.value.fromArray(flashRGB.map((x) => x * 0.25));
    fogU.flashDir.value.copy(lv).normalize();
    // rain and mist (as src/main.js fogU): rain extinction takes visibility from >20 km to ~1.5 km in a downpour
    const rainBeta = (r: number) => (r > 0.002 ? 0.336e-3 * Math.pow(r * 50, 0.63) : 0);
    const fogDensity = S.mist * 1.2e-3 + rainBeta(S.rain);
    const stormFog = S.sMist * 1.2e-3 + rainBeta(S.sRain);
    const fogTop = fOn ? (S.cloudBase + S.sBase) * 0.5 + 100 : S.cloudBase + 100;
    fogU.density.value = fogDensity;
    fogU.top.value = fogTop;
    fogU.front.value.fromArray(fOn ? [fn[0], fn[1], fz, S.frontWidth] : [1, 0, 0, 0]);
    fogU.cell.value.fromArray(fCell);
    fogU.storm.value.set(stormFog, (night ? 0.4 : 0.3) + ((night ? 0.5 : 0.6) - (night ? 0.4 : 0.3)) * mCam, (fogDensity + mCam * Math.max(stormFog - fogDensity, 0)) * fogTop);
    fogU.cam.value.set(cp.x, cp.z);
    fogU.rainCell.value.set(fOn ? 0 : rainBeta(S.rain), Math.cos(wdr) * S.wind * 0.8 * elapsed, Math.sin(wdr) * S.wind * 0.8 * elapsed);
    // spray haze from breaking crests: grows from a near gale (~14 m/s) upwards
    fogU.sprayHaze.value.set(smoothstep(14, 24, S.wind) * 1.8e-3, Math.max(cp.y, 0.5));
    // the bolt seen through the rain: base fog plus the storm side's curtains along the path (the water reads last
    // frame's value, as GL)
    const boltWater = lightning.ground && lightning.bolt > 0.01 && lightning.strike?.ground
      ? [lightning.ground[0], lightning.ground[1], lightning.ground[2], lightning.bolt * 2600 * boltT] : [0, 0, 0, 0];
    {
      const s0 = -S.frontDist - fCurve, sB = s0 + (lv.x * fn[0] + lv.z * fn[1]);
      const inside = fOn ? (sB === s0 ? (s0 > 0 ? 1 : 0) : Math.min(Math.max((Math.max(sB, 0) - Math.max(s0, 0)) / (sB - s0), 0), 1)) : 0;
      boltT = Math.exp(-(fogDensity * ldist + Math.max(stormFog - fogDensity, 0) * ldist * inside * 0.8));
    }
    skyU.isMoon.value = night ? 1 : 0;
    skyU.pixelAngle.value = (camera.fov * Math.PI) / 180 / canvas.height;
    skyU.time.value = elapsed;
    // clouds advect with the wind aloft (~1.6x surface wind), detail evolves slowly
    const aloft = 4 + S.wind * 1.6;
    windOffset[0] += Math.cos(wdr) * aloft * dt;
    windOffset[2] += Math.sin(wdr) * aloft * dt;
    windOffset[1] += dt * (3 + S.wind * 0.6);
    // the film's squall front sweeps in time-lapse (km per second): a long cloud history lags behind it as echo bands,
    // so the history shortens with the front's motion per frame
    const frontStep = fOn && prevFrontDist !== undefined ? Math.abs(S.frontDist - prevFrontDist) : 0;
    prevFrontDist = S.frontDist;
    const cu = cloudU;
    cu.windOffset.value.fromArray(windOffset);
    cu.coverage.value = S.clouds; cu.base.value = S.cloudBase; cu.top.value = S.cloudBase + 1800 + S.cloudDark * 5200;
    cu.density.value = 0.11 - S.cloudDark * 0.05; cu.dark.value = S.cloudDark;
    cu.front.value.fromArray(fOn ? [fn[0], fn[1], fz, S.frontWidth] : [1, 0, 0, 0]);
    cu.frontCell.value.fromArray(fCell);
    cu.stormA.value.set(S.sClouds, S.sDark, 0.11 + S.sDark * 0.17, S.sBase);
    cu.stormTop.value = S.sTop > 0 ? S.sTop : S.sBase + 2500 + S.sDark * 8000; // cumulonimbus tops ~9-10 km
    cu.shapeLod.value = params.has('shapelod') ? Number(params.get('shapelod')) : -1;
    cu.flash.value.set(lp[0], lp[1], lp[2], flash * (night ? 30 : 0.025));
    // a flash changes the cloud light within a frame, so most of the history is dropped; the offline tiers then average
    // two independently jittered passes
    const blend = Math.max(CQ.blend + (0.85 - CQ.blend) * smoothstep(0.02, 0.3, flash), 0.25 * smoothstep(3, 40, frontStep));
    const cloudPasses = flash > 0.02 && !CQ.check ? 2 : 1;
    for (let k = 0; k < cloudPasses; k++) clouds.render(camera, { ...CQ, blend: blend / (1 + k * blend) });
    sky.clouds.value = clouds.screen;
    sky.cloudsEnv.value = clouds.env;
    skyU.cloudsOn.value = 1;
    skyU.cloudSize.value.set(clouds.w, clouds.h);
    // crepuscular rays in the haze below the cloud base (as src/main.js uShaft)
    sky.shaftShadow.value = clouds.shadow;
    sky.cloudDepth.value = clouds.depth;
    skyU.shaftRect.value.copy(clouds.shadowRect.value);
    skyU.shaft.value.set(atmoU.mie.value.x * 1e-3, Math.min(S.cloudBase, fOn ? S.sBase : 1e9), S.clouds > 0.05 ? 1 : 0, (elapsed * 0.618) % 1);
    // water-leaving reflectance: deep blue, greyer with bubbles in a high wind, grey-green in rain
    skyU.envRrs.value.fromArray(mixv(mixv([0.0004, 0.003, 0.0085], [0.0012, 0.0026, 0.0022], 0.8 * smoothstep(5, 24, S.wind)), [0.0013, 0.0024, 0.0025], smoothstep(0.1, 0.8, L.rain)));
    sky.renderEnv();
    // the water's uniforms, as src/main.js waterUniforms
    const st = ocean.stats, wu = water.u;
    gustDrift[0] += Math.cos(wdr) * S.wind * 0.9 * dt;
    gustDrift[1] += Math.sin(wdr) * S.wind * 0.9 * dt;
    wu.camPos.value.copy(camera.position);
    wu.longSlope.value = Math.max(Math.sqrt(st.bandMss[0] * 0.6), 0.01);
    wu.glintExp.value = night ? 15 : 1;
    wu.unresolved.value = st.unresolved;
    wu.mssTotal.value = Math.max(st.coxMunk, st.resolvedMss + st.unresolved);
    wu.hs.value = st.hs;
    wu.rrs.value.copy(skyU.envRrs.value);
    wu.gust.value.set(0.25 + 0.4 * smoothstep(1.5, 4, S.wind) * (1 - smoothstep(6, 12, S.wind)), gustDrift[0], gustDrift[1]);
    wu.foamAmount.value = params.has('nofoam') ? 0 : 1;
    wu.foamLace.value = smoothstep(14, 22, S.wind) * 0.45;
    wu.dbgMask.value.fromArray((params.get('dbg') || '1,1,1').split(',').map(Number));
    wu.time.value = elapsed;
    wu.rain.value = L.rain;
    wu.flash.value.fromArray(flashRGB);
    wu.bolt.value.fromArray(boltWater);
    wu.windDir.value.set(Math.cos(wdr), Math.sin(wdr));
    wu.foamStretch.value = Math.min(Math.max((S.wind - 10) / 8, 0), 1);
    // the effects (as src/main.js draws them)
    const fxU = { camPos: cp, pixelAngle: skyU.pixelAngle.value };
    lightning.draw({ ...fxU, fogDensity: 0, transmit: boltT, base: fOn ? Math.min(S.cloudBase, S.sBase) : S.cloudBase });
    spray.update({ ...fxU, anchor: cam.base, time: elapsed, wind: S.wind, windVec: [Math.cos(wdr) * S.wind, Math.sin(wdr) * S.wind], flash: flashRGB });
    rainDrift[0] += Math.cos(wdr) * S.wind * 0.8 * dt;
    rainDrift[1] += Math.sin(wdr) * S.wind * 0.8 * dt;
    rain.update({ ...fxU, rain: L.rain, time: elapsed, exposure: 1 / 60, wind: [Math.cos(wdr) * S.wind * 0.8, Math.sin(wdr) * S.wind * 0.8], drift: rainDrift, flash: flashRGB });
    // post options, as src/main.js passes them
    // shooting into a low sun a photographer meters the bright sky (scene), not the incident light
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    const fh = Math.hypot(fwd.x, fwd.z) || 1;
    const backlit = night ? 0 : smoothstep(0.55, 0.95, (fwd.x * sun[0] + fwd.z * sun[2]) / fh / (Math.hypot(sun[0], sun[2]) || 1)) * (1 - smoothstep(12, 35, weather.time.sunElev)) * (1 - L.clouds * 0.8);
    // how much of the frame a storm fills (overhead, or a squall line in view)
    const stormView = Math.max(smoothstep(0.7, 0.9, L.clouds) * smoothstep(0.4, 0.8, L.dark), fOn ? smoothstep(15000, 3000, S.frontDist) : 0);
    return {
      time: elapsed, bloom: 0.012 + 0.006 * backlit + 0.01 * (night ? 1 : 0),
      exposureBias: Number(params.get('ev') || 0) - 0.7 * backlit - 1.0 * L.dark * L.dark * (0.4 + 0.6 * L.rain) + 0.8 * (1 - smoothstep(0.2, 0.4, L.clouds)) * smoothstep(35, 50, weather.time.sunElev) + 0.1 * smoothstep(0.8, 0.95, L.clouds) * (1 - smoothstep(0.4, 0.6, L.dark)) * (1 - L.rain),
      incident: 0.65 * (1 - backlit) * (1 - 0.7 * stormView), fade: app.fade,
      whiteBalance: params.has('wb') ? Number(params.get('wb')) : (0.1 * smoothstep(0.25, 0.6, L.clouds) + 0.35 * smoothstep(0.8, 0.95, L.clouds)) * (1 - backlit) * (night ? 0 : 1),
      night: night ? 1 : 0,
      look: params.has('look') ? params.get('look')!.split(',').map(Number) : night ? [1.35, 0.4, 1.0, 0.004] : mixv([1.5, 0.4, 1.0, 0.004], [1.6, 0.36, 0.95, 0.03], stormView),
      look2: night ? [1.5, 1.0] : [1.8 - 0.3 * stormView, 1.03 + 0.12 * backlit * (1 - stormView)],
    };
  };

  // the sky with the clouds, and the water
  const scene = new THREE.Scene();
  scene.backgroundNode = Fn(() => sky.backgroundWithClouds(positionWorldDirection, vec2(screenUV.x, screenUV.y.oneMinus()), cameraPosition))();
  scene.add(water.mesh, lightning.mesh, spray.mesh, rain.mesh);

  // the HDR scene (half float, as GL's rgba16f target, 4x MSAA resolved at the end of the pass as GL's blit, ?msaa
  // overrides), then open-water's post chain to the canvas.
  // Incident metering: an 18 % grey card under the sun (through the clouds over the camera) and sky
  const hdr = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, samples: Number(params.get('msaa') || 4) });
  const vis = (texture as any)(clouds.shadow, (vec2 as any)(0.5)).level(0).r;
  const post = new PostChain(renderer, { incidentE: sky.sunIlluminance().mul(vis).mul(max(atmoU.sun.y, 0)).add(sky.skyIrradiance()) });
  const resize = () => {
    renderer.setPixelRatio(scale);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    hdr.setSize(size.x, size.y);
    clouds.resize(size.x, size.y, CQ.div);
    post.resize(size.x, size.y);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  const nodeFrame0 = internals._nodes.nodeFrame.frameId as number;
  const frame = async (dt: number) => {
    elapsed += dt;
    uTime.value = elapsed;
    if (RENDER_MODE) { internals.info.reset(); internals._nodes.nodeFrame.update(); }
    for (const s of scopes) device.pushErrorScope(s);
    const postOpts = await updateWorld(dt);
    audio.update(weather.state, ocean.stats.hs);
    renderer.setRenderTarget(hdr);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    post.render(hdr.texture, dt, postOpts);
    engine.frames++;
    // (popErrorScope adds each to `pending` in ?render; the live loop never settles, so it keeps no list)
    for (let i = 0; i < scopes.length; i++) device.popErrorScope().then((e) => { if (e) errors.push(e.message); });
  };
  const settle = async () => {
    await device.queue.onSubmittedWorkDone();
    await Promise.all(pending.splice(0));
  };
  // one mip level (and z slice) of a texture as packed rows in texel order (y = 0 first): copyTextureToBuffer pads
  // rows to 256 bytes and three does not strip them. The copy is encoded before the first await.
  const readRows = async (gpuTex: GPUTexture, bpt: number, level = 0, z = 0) => {
    const G = globalThis as any;
    const w = Math.max(gpuTex.width >> level, 1), h = Math.max(gpuTex.height >> level, 1);
    const row = Math.ceil((w * bpt) / 256) * 256;
    const buf = device.createBuffer({ size: row * h, usage: G.GPUBufferUsage.COPY_DST | G.GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: gpuTex, mipLevel: level, origin: { x: 0, y: 0, z } }, { buffer: buf, bytesPerRow: row }, { width: w, height: h });
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(G.GPUMapMode.READ);
    const raw = new Uint8Array(buf.getMappedRange()), out = new Uint8Array(w * h * bpt);
    for (let y = 0; y < h; y++) out.set(raw.subarray(y * row, y * row + w * bpt), y * w * bpt);
    buf.destroy();
    return out;
  };

  // window.app: the part of src/main.js's App that the shared UI (src/ui.js) and the film renderer (render/) use
  let filmAct: number | undefined, filmPrevT: number | undefined;
  const app = {
    canvas, cam, weather, lightning, fade: 1, filmAudio,
    get stats() { return ocean.stats; },
    get time() { return elapsed; },
    get w() { return canvas.width; },
    get h() { return canvas.height; },
    // the sea alone for `seconds` (foam history before a shot), as src/main.js warmSea
    async warmSea(seconds: number, dt = 1 / 30) {
      for (let i = 0; i < Math.round(seconds / dt); i++) {
        elapsed += dt;
        updateSea(dt);
        if (i % 30 === 29) await settle();
      }
    },
    // the film at time t (src/film.js), as src/main.js filmFrame; hold samples the timeline there while the clock runs on t
    async filmFrame(t: number, dt: number, hold?: number) {
      const tl = Math.max(hold ?? t, 0);
      const act = film.actAt(tl);
      if (filmAct !== undefined && act !== filmAct) {
        // new shot: settle foam, clouds and camera filters off-screen (during the dip to black)
        filmAct = act;
        const t0 = film.acts[act].start;
        await app.filmFrame(t0 - 28, dt, t0);
        await app.warmSea(25, dt);
        for (let w = t0 - 3; w < t0 - dt / 2; w += dt) await app.filmFrame(w, dt, t0);
      }
      filmAct = act;
      app.fade = film.fadeAt(tl);
      const w = film.weatherAt(tl) as Record<string, number>;
      // debug: ?fo=clouds:0.1,haze:1 overrides timeline values
      if (params.has('fo')) for (const kv of params.get('fo')!.split(',')) { const [k, v] = kv.split(':'); w[k] = Number(v); }
      const W = weather as any;
      for (const k in w) {
        if (k in W.time) { W.time[k] = w[k]; W.timeTarget[k] = w[k]; }
        else { W.state[k] = w[k]; W.target[k] = w[k]; }
      }
      W.transition = 1e-6;
      const c = film.cameraAt(tl) as any;
      cam.yaw = (c.yaw * Math.PI) / 180;
      cam.pitch = (c.pitch * Math.PI) / 180;
      cam.eye = c.eye;
      cam.fov = (c.fov * Math.PI) / 180;
      // strikes fire once when the timeline passes them
      const prev = filmPrevT ?? t - dt;
      if (hold === undefined) filmPrevT = t;
      for (const s of film.strikes) {
        if (hold === undefined && s.t > prev && s.t <= t) lightning.trigger(cam, { dist: s.dist, az: cam.yaw + s.rel, ground: s.ground, base: W.state.cloudBase });
      }
      elapsed = t - dt;
      await settle(); // the previous frame drains first (GL's gl.finish), so a read after this frame stays in its task
      await frame(dt);
    },
    // the canvas as top-down RGBA rows. Call it in the task of the frame: the canvas texture expires after it (a 2D
    // drawImage of the WebGPU canvas reads black in headless Chrome, so the texture is copied)
    async pixels() {
      const tex = (canvas.getContext('webgpu') as GPUCanvasContext).getCurrentTexture();
      const px = await readRows(tex, 4);
      if (tex.format.startsWith('bgra')) for (let i = 0; i < px.length; i += 4) [px[i], px[i + 2]] = [px[i + 2], px[i]];
      return px;
    },
  };
  window.app = app;

  const engine: Engine = {
    name: 'three',
    async step(n, dt) { for (let i = 0; i < n; i++) await frame(dt); await settle(); },
    // one more frame, read in the same task: the WebGPU canvas texture is only valid until the task ends
    async capture(dt) { await frame(dt); const png = canvas.toDataURL('image/png'); await settle(); return png; },
    frames: 0,
    get nodeFrame() { return (internals._nodes.nodeFrame.frameId as number) - nodeFrame0; },
    errors,
    adapter: { vendor: ai.vendor, architecture: ai.architecture, description: ai.description, fallback: typeof ai.isFallbackAdapter === 'boolean' ? ai.isFallbackAdapter : null },
  };
  window.engine = engine;

  window.portTest = {
    audio,
    device,
    ocean,
    atmo,
    sky,
    clouds,
    // one mip level (and z slice of a 3D texture) of an rgba16f or rgba8 texture as a Float32Array, rows in texel
    // order (y = 0 first), the 256-byte row padding stripped
    async readTexture(tex: THREE.Texture, level = 0, z = 0) {
      const { texture: gpuTex, textureDescriptorGPU: desc } = backend.get(tex);
      if (desc.format !== 'rgba16float' && desc.format !== 'rgba8unorm') throw new Error(`readTexture: format ${desc.format}`);
      const half = desc.format === 'rgba16float';
      const raw = await readRows(gpuTex, half ? 8 : 4, level, z);
      return Float32Array.from(half ? new (globalThis as any).Float16Array(raw.buffer) : raw, (v: number) => (half ? v : v / 255));
    },
    // runs fn inside the same error scopes as a frame; errors land in engine.errors
    async scoped<T>(fn: () => Promise<T>) {
      for (const s of scopes) device.pushErrorScope(s);
      const out = await fn();
      for (let i = 0; i < scopes.length; i++) device.popErrorScope().then((e) => { if (e) errors.push(e.message); });
      await settle();
      return out;
    },
  };
  if (!RENDER_MODE) {
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    document.head.appendChild(style);
    new UI(app, audio); // presets, sliders, sound (M), strike (L), night (N)
    // drag to look, wheel for eye height (src/main.js bindInput)
    let drag: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const k = 0.0035 * (cam.fov / 0.73);
      cam.yaw += (e.clientX - drag.x) * k;
      cam.pitch = clamp(cam.pitch - (e.clientY - drag.y) * k, -1.2, 1.2);
      drag = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('wheel', (e) => { cam.eye = clamp(cam.eye * Math.exp(e.deltaY * 0.001), 1.5, 400); }, { passive: true });
    // dynamic resolution, as src/main.js: keep the frame time near 30 fps on slow GPUs, sharpen on fast ones. A frame
    // still running skips the rAF tick instead of overlapping it.
    let last = performance.now(), busy = false, avg = 1 / 60, settleT = 0;
    const maxScale = params.has('scale') ? scale : Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.setAnimationLoop(async (now: number) => {
      if (busy) return;
      busy = true;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      try { await frame(dt); } finally { busy = false; }
      avg += (dt - avg) * 0.05;
      if (!params.has('scale') && (settleT += dt) > 2.5 && !document.hidden) {
        const next = avg > 1 / 26 ? Math.max(scale * 0.88, 0.5) : avg < 1 / 50 ? Math.min(scale * 1.08, maxScale) : scale;
        if (Math.abs(next - scale) > 0.02) { scale = next; resize(); settleT = 0; }
      }
    });
  }
}

start().catch((e: Error) => {
  document.body.insertAdjacentHTML('beforeend', `<pre class="err">${e.message}</pre>`);
  console.error(e);
});
