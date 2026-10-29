// three.js WebGPU port of open-water. Renderer, clock, camera, weather, atmosphere, the clear sky (M2) and the water
// (M3). WebGPU only: three's WebGL2 fallback is refused.
import * as THREE from 'three/webgpu';
import { uniform, Fn, max, positionWorldDirection } from 'three/tsl';
import type { Engine } from '../boot';
import { OceanCompute } from './ocean';
import { AtmosphereCompute } from './atmosphere';
import { SkyCompute, skyU } from './sky';
import { PostChain, type PostOptions } from './post';
import { WaterMesh } from './water';
import { FoamTextureCompute } from './foam';
import { OceanProbe } from './probe';
import { atmoU } from './atmosphere';
import { Weather } from '../weather.js';
import { smoothstep } from '../math.js';

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
  const ai = device.adapterInfo as GPUAdapterInfo & { isFallbackAdapter?: boolean };
  const scopes: GPUErrorFilter[] = ['validation', 'out-of-memory', 'internal'];

  renderer.setPixelRatio(RENDER_MODE ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  // camera: same URL keys, defaults and clip planes as src/main.js (eye height h, yaw/pitch in degrees, vertical
  // fov). It rides the waves unless ?float=0 (updateCamera).
  const cam = {
    eye: Number(params.get('h') || 3), base: [0, 0], heave: 0, roll: 0, tilt: 0, float: params.get('float') !== '0',
    yaw: (Number(params.get('yaw') || 200) * Math.PI) / 180, pitch: (Number(params.get('pitch') ?? 1.5) * Math.PI) / 180,
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
  const ocean = new OceanCompute(renderer, q === 'rt' ? [256, 256, 128, 128] : [512, 256, 256, 256]);
  const atmo = new AtmosphereCompute(renderer);
  const sky = new SkyCompute(renderer, atmo);
  const foam = new FoamTextureCompute(renderer);
  const water = new WaterMesh({ ...ocean.textures(), env: sky.env, sky, foamTex: foam.tex }, { angular: q === 'rt' ? 400 : 640 });
  const gustDrift = [0, 0];
  const probe = new OceanProbe(renderer, ocean.textures());
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
    const pitch = cam.pitch + cam.tilt;
    const fwd = new THREE.Vector3(Math.cos(pitch) * Math.cos(cam.yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(cam.yaw));
    const right0 = fwd.clone().cross(camera.up.set(0, 1, 0)).normalize();
    const up0 = right0.clone().cross(fwd);
    // roll: three's lookAt rebuilds the same basis from this up vector
    camera.up.copy(up0.multiplyScalar(Math.cos(cam.roll)).addScaledVector(right0, -Math.sin(cam.roll)));
    camera.lookAt(camera.position.clone().add(fwd));
  };
  const mixv = (a: number[], b: number[], t: number) => a.map((x, i) => x + (b[i] - x) * t);
  // per frame, as the top of src/main.js frame(): ocean, light source, LUTs, environment (no squall front yet: the
  // local weather is the state)
  const updateWorld = async (dt: number): Promise<PostOptions> => {
    weather.update(dt);
    const S = weather.state;
    ocean.lambda = Math.max(S.choppy, weather.choppyFor(S.wind));
    // wind drift of surface foam ~3% of U10 (plus a little Stokes drift)
    const wdr = (S.windDir * Math.PI) / 180;
    ocean.drift = [Math.cos(wdr) * 0.035 * S.wind, Math.sin(wdr) * 0.035 * S.wind];
    ocean.setSpectrum(weather.spectrum());
    ocean.update(elapsed, dt, weather.foam());
    await updateCamera(dt);
    const night = weather.time.sunElev < -7;
    const sun = night ? weather.moonDir() : weather.sunDir();
    atmoU.lightMag.value = night ? -12.7 : -26.74;
    // fraction of direct sun reaching the haze below the clouds (a closed deck lets none through)
    atmoU.hazeSun.value = (1 - smoothstep(0.3, 0.9, S.clouds)) * (1 - 0.85 * S.cloudDark) * 0.97 + 0.03 * (1 - S.cloudDark) * (1 - smoothstep(0.8, 0.9, S.clouds));
    atmo.update(sun, camera.position.y, S.haze);
    skyU.isMoon.value = night ? 1 : 0;
    skyU.pixelAngle.value = (camera.fov * Math.PI) / 180 / canvas.height;
    skyU.time.value = elapsed;
    // water-leaving reflectance: deep blue, greyer with bubbles in a high wind, grey-green in rain
    skyU.envRrs.value.fromArray(mixv(mixv([0.0004, 0.003, 0.0085], [0.0012, 0.0026, 0.0022], 0.8 * smoothstep(5, 24, S.wind)), [0.0013, 0.0024, 0.0025], smoothstep(0.1, 0.8, S.rain)));
    sky.renderEnv();
    // the water's uniforms, as src/main.js waterUniforms (no lightning, rain stipple or cloud shadow yet)
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
    wu.rain.value = S.rain;
    wu.windDir.value.set(Math.cos(wdr), Math.sin(wdr));
    wu.foamStretch.value = Math.min(Math.max((S.wind - 10) / 8, 0), 1);
    // post options, as src/main.js passes them (no squall front or lightning yet)
    // shooting into a low sun a photographer meters the bright sky (scene), not the incident light
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    const fh = Math.hypot(fwd.x, fwd.z) || 1;
    const backlit = night ? 0 : smoothstep(0.55, 0.95, (fwd.x * sun[0] + fwd.z * sun[2]) / fh / (Math.hypot(sun[0], sun[2]) || 1)) * (1 - smoothstep(12, 35, weather.time.sunElev)) * (1 - S.clouds * 0.8);
    // how much of the frame a storm fills
    const stormView = smoothstep(0.7, 0.9, S.clouds) * smoothstep(0.4, 0.8, S.cloudDark);
    return {
      time: elapsed, bloom: 0.012 + 0.006 * backlit + 0.01 * (night ? 1 : 0),
      exposureBias: Number(params.get('ev') || 0) - 0.7 * backlit - 1.0 * S.cloudDark * S.cloudDark * (0.4 + 0.6 * S.rain) + 0.8 * (1 - smoothstep(0.2, 0.4, S.clouds)) * smoothstep(35, 50, weather.time.sunElev) + 0.1 * smoothstep(0.8, 0.95, S.clouds) * (1 - smoothstep(0.4, 0.6, S.cloudDark)) * (1 - S.rain),
      incident: 0.65 * (1 - backlit) * (1 - 0.7 * stormView), fade: 1,
      whiteBalance: params.has('wb') ? Number(params.get('wb')) : (0.1 * smoothstep(0.25, 0.6, S.clouds) + 0.35 * smoothstep(0.8, 0.95, S.clouds)) * (1 - backlit) * (night ? 0 : 1),
      night: night ? 1 : 0,
      look: params.has('look') ? params.get('look')!.split(',').map(Number) : night ? [1.35, 0.4, 1.0, 0.004] : mixv([1.5, 0.4, 1.0, 0.004], [1.6, 0.36, 0.95, 0.03], stormView),
      look2: night ? [1.5, 1.0] : [1.8 - 0.3 * stormView, 1.03 + 0.12 * backlit * (1 - stormView)],
    };
  };

  // the clear sky and the water
  const scene = new THREE.Scene();
  scene.backgroundNode = Fn(() => sky.background(positionWorldDirection))();
  scene.add(water.mesh);

  // the HDR scene (half float, as GL's rgba16f target; no MSAA yet), then open-water's post chain to the canvas.
  // Incident metering: an 18 % grey card under the sun and sky (no cloud shadow yet)
  const hdr = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType });
  const post = new PostChain(renderer, { incidentE: sky.sunIlluminance().mul(max(atmoU.sun.y, 0)).add(sky.skyIrradiance()) });
  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    hdr.setSize(size.x, size.y);
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
    renderer.setRenderTarget(hdr);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    post.render(hdr.texture, dt, postOpts);
    engine.frames++;
    for (let i = 0; i < scopes.length; i++) {
      const popped = device.popErrorScope().then((e) => { if (e) errors.push(e.message); });
      if (RENDER_MODE) pending.push(popped);  // (the live loop never settles, so it keeps no list)
    }
  };
  const settle = async () => {
    await device.queue.onSubmittedWorkDone();
    await Promise.all(pending.splice(0));
  };
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
    ocean,
    atmo,
    sky,
    // a half-float storage texture as a Float32Array, rows in texel order (y = 0 first)
    async readTexture(tex: THREE.Texture) {
      const { width: w, height: h } = tex.image as { width: number; height: number };
      const raw = await backend.copyTextureToBuffer(tex, 0, 0, w, h);
      return Float32Array.from(new (globalThis as any).Float16Array(raw.buffer, raw.byteOffset, w * h * 4));
    },
    // runs fn inside the same error scopes as a frame; errors land in engine.errors
    async scoped<T>(fn: () => Promise<T>) {
      for (const s of scopes) device.pushErrorScope(s);
      const out = await fn();
      for (let i = 0; i < scopes.length; i++) { const e = await device.popErrorScope(); if (e) errors.push(e.message); }
      return out;
    },
  };
  if (!RENDER_MODE) {
    let last = performance.now();
    renderer.setAnimationLoop((now: number) => { frame(Math.min((now - last) / 1000, 0.1)); last = now; });
  }
}

start().catch((e: Error) => {
  document.body.insertAdjacentHTML('beforeend', `<pre class="err">${e.message}</pre>`);
  console.error(e);
});
