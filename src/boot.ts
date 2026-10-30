// Starts the three.js WebGPU renderer (docs/systems/three-port.md). The WebGL2 engine is archived in archive/gl/
// (tag gl-final runs it). window.engine is for the tools: step(n, dt) runs n fixed frames of the engine's own clock
// and awaits the GPU; capture(dt) runs exactly one more frame and returns it as a PNG data URL. `frames` counts frames
// run. A fresh page is the reset; seeds are fixed in code.

export interface AdapterInfo { vendor: string; architecture: string; description: string; fallback: boolean | null }

export interface Engine {
  name: 'three';
  step(n: number, dt: number): Promise<void>;
  capture(dt: number): Promise<string>;
  frames: number;
  nodeFrame?: number;  // NodeFrame.frameId advances since the engine started; must equal frames
  errors: string[];
  adapter: AdapterInfo;
}

declare global {
  interface Window { engine?: Engine; app?: any; portTest?: any }
}

import('./three/main');
