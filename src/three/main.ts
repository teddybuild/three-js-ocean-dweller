// three.js WebGPU port of open-water. Milestone 0: renderer, camera and post chain only; the scene is a
// placeholder until the FFT, sky and water land. WebGPU only: three's WebGL2 fallback is refused.
import * as THREE from 'three/webgpu';
import { pass, color } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import type { Engine } from '../boot';

const params = new URLSearchParams(location.search);
const RENDER_MODE = params.has('render');
const canvas = document.getElementById('c') as HTMLCanvasElement;

function fail(msg: string): never {
  document.body.insertAdjacentHTML('beforeend', `<pre class="err">${msg}</pre>`);
  throw new Error(msg);
}

async function start() {
  if (!navigator.gpu || !(await navigator.gpu.requestAdapter())) fail('WebGPU is not available in this browser');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  const backend = renderer.backend as any;
  if (!backend.isWebGPUBackend) fail('three fell back to WebGL2; this port needs WebGPU');
  const device: GPUDevice = backend.device;
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  device.lost.then((info) => errors.push(`device lost: ${info.message}`));
  const ai = device.adapterInfo;

  renderer.setPixelRatio(RENDER_MODE ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.AgXToneMapping;

  // camera: same URL keys and defaults as src/main.js (yaw/pitch in degrees, h in metres, vertical fov)
  const yaw = (Number(params.get('yaw') || 200) * Math.PI) / 180;
  const pitch = (Number(params.get('pitch') ?? 1.5) * Math.PI) / 180;
  const camera = new THREE.PerspectiveCamera(Number(params.get('fov') || 42), window.innerWidth / window.innerHeight, 0.1, 200000);
  camera.position.set(0, Number(params.get('h') || 4), 0);
  camera.lookAt(camera.position.clone().add(new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw))));

  // placeholder scene: flat sky colour and a flat sea
  const scene = new THREE.Scene();
  scene.backgroundNode = color(0x8fb4d8);
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(400000, 400000), new THREE.MeshBasicNodeMaterial({ color: 0x1b3550 }));
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

  const frame = () => pipeline.render();
  const engine: Engine = {
    name: 'three',
    async step(n) { for (let i = 0; i < n; i++) frame(); await device.queue.onSubmittedWorkDone(); },
    // render and read in the same task: the WebGPU canvas texture is only valid until the task ends
    capture() { frame(); return canvas.toDataURL('image/png'); },
    errors,
    adapter: `${ai.vendor} ${ai.architecture} ${ai.description}`.trim(),
  };
  window.engine = engine;
  if (!RENDER_MODE) renderer.setAnimationLoop(frame);
}

start();
