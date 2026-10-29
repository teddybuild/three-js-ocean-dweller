// Picks the renderer: ?engine=three is the three.js WebGPU port (docs/systems/three-port.md),
// anything else the open-water WebGL2 reference in src/main.js.
// Both expose window.engine for tools/diff.mjs: step(n, dt) runs n fixed frames of the engine's own clock and awaits
// the GPU; capture(dt) runs exactly one more frame and returns it as a PNG data URL, so both engines render the same
// frame count. `frames` counts frames run. A fresh page is the reset; seeds are fixed in code.

export interface AdapterInfo { vendor: string; architecture: string; description: string; fallback: boolean | null }

export interface Engine {
  name: 'gl' | 'three';
  step(n: number, dt: number): Promise<void>;
  capture(dt: number): Promise<string>;
  frames: number;
  nodeFrame?: number;  // three only: NodeFrame.frameId advances since the engine started; must equal frames
  errors: string[];
  adapter: AdapterInfo;
}

declare global {
  interface Window { engine?: Engine; app?: any }
}

if (new URLSearchParams(location.search).get('engine') === 'three') {
  import('./three/main');
} else {
  import('./main.js').then(() => {
    const app = window.app;
    if (!app) return;
    const gl: WebGL2RenderingContext = app.gl;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const errors: string[] = [];
    app.canvas.addEventListener('webglcontextlost', () => errors.push('WebGL context lost'));
    // the GL error flag is sticky: one check per frame catches any invalid call made during it
    const frame = (dt: number) => {
      app.frame(dt);
      engine.frames++;
      const e = gl.getError();
      if (e !== gl.NO_ERROR) errors.push(`WebGL error 0x${e.toString(16)} in frame ${engine.frames}`);
    };
    const engine: Engine = {
      name: 'gl',
      async step(n, dt) { for (let i = 0; i < n; i++) frame(dt); gl.finish(); },
      async capture(dt) { frame(dt); return app.canvas.toDataURL('image/png'); },
      frames: 0,
      errors,
      adapter: { vendor: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?', architecture: '', description: 'WebGL2', fallback: false },
    };
    window.engine = engine;
  });
}
