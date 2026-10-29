# three.js WebGPU port

How the port is built and checked. Decision: `docs/adr/0001-three-webgpu-port.md`.

## Layout

- `src/boot.ts` picks the engine. `?engine=three` loads `src/three/main.ts`; anything else loads `src/main.js`.
- Both engines set `window.engine` = `{ name, step(n, dt), capture(), errors, adapter }`. `step` runs `n` fixed
  steps of the engine's own clock and awaits the GPU and pending error scopes; `capture` renders once and returns a
  PNG data URL read in the same task. A fresh page is the reset; seeds are fixed in code.
- Clock: the three engine owns `elapsed` and the `uTime` uniform (`src/three/main.ts`). Every animated node reads
  `uTime`; three's `time` node and NodeFrame follow the wall clock and are never used (Codex M0 review, P1).
- Errors (three): `uncapturederror`, device loss, a validation error scope around every frame, and three's own
  logged errors via `THREE.setConsoleFunction` (three catches pipeline errors in its own scopes and only logs them).
- Reused unchanged by both engines: `src/weather.js`, `src/film.js`, `src/ui.js`, `src/audio/`.

## Checks

- `node tools/diff.mjs [scene ...] [--self-test]` (dev server on :5173). Fresh page per capture, `?render`, 90 steps
  of 1/30 s at 1280x720, `float=0` so the GL camera holds still. Writes `tmp/diff/<scene>.png` (gl left, three
  right), prints PSNR and pixelmatch mismatch %. `verdict()` fails the run on: any page or WebGPU error in either
  engine, a capture that is not 1280x720, an adapter that is not nvidia/blackwell (`EXPECT_GPU_ARCH` overrides),
  a fallback adapter, or a failed capture. Low PSNR is progress, not failure. `--self-test` checks that verdict()
  rejects 6 broken cases, that the metrics see a corrupted image, and that an error injected into a live three page
  fails the run. Scenes: `breeze`, `calm`, `squall`, or any raw query string.
- Headless Chrome 156 on Linux gets a hardware WebGPU adapter (nvidia blackwell) only with `--use-angle=vulkan
  --enable-features=Vulkan --enable-unsafe-webgpu` (`tools/browser.mjs`).

## Resource contracts

Fill one row per GPU resource as it is ported. The GL column comes from the 2026-10-29 inventory.

| Resource | GL (src/) | three | Owner | Notes |
|---|---|---|---|---|
| HDR scene | MSTarget rgba16f/r11g11b10f, MSAA, blit resolve | `pass()` in `RenderPipeline` | `src/three/main.ts` | M0 |
| Tone map | AgX in `src/fx/post.js` | `AgXToneMapping` | `src/three/main.ts` | M0 placeholder; compare against post.js at M2 |

## Rules for ported shaders

- Projection: three's camera matrices use WebGPU NDC (z 0..1, Y down in framebuffer space). Never reuse
  `src/math.js` `perspective()` or rays rebuilt from its inverse in a three shader.
- No derivatives or implicit-LOD samples inside non-uniform branches (WGSL uniformity).
- `isnan`, `isinf`, `inverse(mat2)` do not exist in WGSL: write helpers once in `src/three/`.
- `frontCurve` gets one copy, shared by the CPU and the shaders.
