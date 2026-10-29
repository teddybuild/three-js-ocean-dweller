// Picks the renderer: ?engine=three is the three.js WebGPU port (docs/systems/three-port.md),
// anything else the open-water WebGL2 reference in src/main.js.
// Both expose window.engine for tools/diff.mjs: step(n, dt) runs n fixed steps of the engine's own clock and awaits
// the GPU; capture() renders once and returns a PNG data URL. A fresh page is the reset; seeds are fixed in code.

export interface AdapterInfo { vendor: string; architecture: string; description: string; fallback: boolean }

export interface Engine {
  name: 'gl' | 'three';
  step(n: number, dt: number): Promise<void>;
  capture(): Promise<string>;
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
    window.engine = {
      name: 'gl',
      async step(n, dt) { for (let i = 0; i < n; i++) app.frame(dt); gl.finish(); },
      async capture() { return app.canvas.toDataURL('image/png'); },
      errors: [],
      adapter: { vendor: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?', architecture: '', description: 'WebGL2', fallback: false },
    };
  });
}
