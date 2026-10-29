// three.js WebGPU port of open-water. Milestone 0: renderer, clock, camera and post chain only; the scene is a
// placeholder until the FFT, sky and water land. WebGPU only: three's WebGL2 fallback is refused.
import * as THREE from 'three/webgpu';
import { pass, color, uniform } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import type { Engine } from '../boot';
import { OceanCompute } from './ocean';
import { AtmosphereCompute } from './atmosphere';

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
  renderer.toneMapping = THREE.AgXToneMapping;

  // camera: same URL keys, defaults and clip planes as src/main.js (eye height h, yaw/pitch in degrees, vertical
  // fov). The GL camera rides the waves unless ?float=0; this one is still until the probe is ported.
  const yaw = (Number(params.get('yaw') || 200) * Math.PI) / 180;
  const pitch = (Number(params.get('pitch') ?? 1.5) * Math.PI) / 180;
  const camera = new THREE.PerspectiveCamera(Number(params.get('fov') || 42), window.innerWidth / window.innerHeight, 0.2, 80000);
  camera.position.set(0, Number(params.get('h') || 3), 0);
  camera.lookAt(camera.position.clone().add(new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw))));

  // placeholder scene: flat sky colour and a flat sea
  const scene = new THREE.Scene();
  scene.backgroundNode = color(0x8fb4d8);
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(160000, 160000), new THREE.MeshBasicNodeMaterial({ color: 0x1b3550 }));
  sea.rotation.x = -Math.PI / 2;
  scene.add(sea);

  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  pipeline.outputNode = scenePass.add(bloom(scenePass, 0.15, 0.4, 0.9));

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  const nodeFrame0 = internals._nodes.nodeFrame.frameId as number;
  const frame = (dt: number) => {
    elapsed += dt;
    uTime.value = elapsed;
    if (RENDER_MODE) { internals.info.reset(); internals._nodes.nodeFrame.update(); }
    for (const s of scopes) device.pushErrorScope(s);
    pipeline.render();
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
    async step(n, dt) { for (let i = 0; i < n; i++) frame(dt); await settle(); },
    // one more frame, read in the same task: the WebGPU canvas texture is only valid until the task ends
    async capture(dt) { frame(dt); const png = canvas.toDataURL('image/png'); await settle(); return png; },
    frames: 0,
    get nodeFrame() { return (internals._nodes.nodeFrame.frameId as number) - nodeFrame0; },
    errors,
    adapter: { vendor: ai.vendor, architecture: ai.architecture, description: ai.description, fallback: typeof ai.isFallbackAdapter === 'boolean' ? ai.isFallbackAdapter : null },
  };
  window.engine = engine;

  // the FFT ocean (milestone 1), not drawn yet; tools/fft-diff.mjs drives it through window.portTest. FFT sizes
  // follow src/main.js: ?q, else 'high' in ?render and 'rt' live.
  const q = params.get('q') || (RENDER_MODE ? 'high' : 'rt');
  const ocean = new OceanCompute(renderer, q === 'rt' ? [256, 256, 128, 128] : [512, 256, 256, 256]);
  const atmo = new AtmosphereCompute(renderer);
  window.portTest = {
    ocean,
    atmo,
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
