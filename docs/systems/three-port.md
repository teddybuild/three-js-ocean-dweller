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
- Reused unchanged by both engines: `src/weather.js`, `src/film.js`, `src/ui.js`, `src/audio/`; from
  `src/ocean/ocean.js`, `cascadesFor()` (bands) and `computeStats()` (foam threshold stats).
- Ocean (`src/three/ocean.ts`, M1): open-water's spectrum, evolve, Stockham FFT and assemble as TSL compute over
  f32 storage buffers indexed `y * N + x`. One ComputeNode per cascade, FFT stage and ping-pong direction, all
  uniforms set before the frame's one `renderer.compute([...])`. Not drawn yet; `window.portTest` drives it.
- Atmosphere and sky (`src/three/atmosphere.ts`, `src/three/sky.ts`, M2): the 4 LUTs, the environment map and its
  irradiance are compute kernels writing half-float storage textures texel by texel (row y is v = (y + 0.5) / h, as
  in GL). The environment gets its mips from three's storage-texture auto-mips, which run when the texture is next
  sampled, so the irradiance pass is a separate `compute()` call. The background is the clear-sky branch of
  `SKY_FS` (`scene.backgroundNode`) with the clouds (M4), the crepuscular rays (`sky.withShafts`, M4) and the rain, mist, squall curtains and spray
  haze (`sky.fog(dir, dist)` -> `{ T, Lf }`, `applyFog` = col T + Lf, M5). The background fogs sky and clouds
  separately, the clouds only to their mean distance (`sky.cloudDepth`). `src/sky/atmosphere.js` exports
  `mediumFor()` for both engines.
- Post (`src/three/post.ts`, M2): open-water's bloom pyramid, metering, eye adaptation and AgX composite as QuadMesh
  passes; the scene renders into a half-float target first. The composite runs with `NoToneMapping` and the working
  colour space so three adds no second tone map or sRGB encode. NaN/Inf tests are bit tests (`src/three/tsl-util.ts`).
- Water (`src/three/water.ts`, `foam.ts`, `probe.ts`, M3): the polar grid as a NodeMaterial whose `vertexNode`
  outputs clip space from world positions (no model matrix, never culled). The fragment shader is `water.js` FS plus
  `RAIN_SURFACE_GLSL` and `FOAM_GLSL`; every derivative and implicit-LOD sample is taken before the first `If`. The
  foam texture is a compute kernel. Stubs until M4/M5: sun visibility is `atmoU.hazeSun` (GL's value outside the
  cloud-shadow rect); shafts and fog as GL (after the aerial perspective), lightning flash and ground-strike reflection (`bolt`). The camera floats on `OceanProbe` as GL's `updateCamera`;
  `?render` awaits each probe read, live uses the last finished one.
- Clouds (`src/three/clouds.ts`, M4): noise volumes, weather map, shadow map, env and
  screen passes as compute kernels writing GL's texel layout (v up). 3D mips are written level by level (three only
  generates 2D mips). The screen pass builds rays from the camera basis and reprojects with the previous basis.
  `sky.backgroundWithClouds` composites them, then the shafts darken the haze in the clouds' shadow (sun-ward this
  is most of the light: without them the backlit clouds read 2.4x GL). Texture nodes `sky.clouds`, `sky.cloudsEnv`
  and `sky.shaftShadow` are re-pointed per frame. `THREE.Vector4()` defaults w to 1: every vec4 uniform whose w is a
  switch (`cloudU.flash`, water `bolt`) is created with an explicit 0.
- Weather effects (`src/three/rain.ts`, `spray.ts`, `lightning.ts`, M5): instanced quads in NodeMaterials drawn
  after the water (renderOrder 1-4: bolt, spray, splashes, streaks) with GL's blend factors; the vertex shaders
  output clip space. Seeds and the lightning CPU model (rng(7), trigger, buildBolt, update) are GL's, so both engines
  strike at the same place and time (`?strikeAt=t`). Not ported: thunder audio (`lightning.events` is dropped),
  MSAA (and with it GL's `centroid` interpolation).

## Checks

- `node tools/diff.mjs [scene ...] [--self-test]` (dev server on :5173). Fresh page per capture, `?render`, 90 steps
  of 1/30 s at 1280x720, `float=0` so the GL camera holds still. Writes `tmp/diff/<scene>.png` (gl left, three
  right), prints PSNR and pixelmatch mismatch %. `verdict()` fails the run on: any page, WebGL or WebGPU error, a
  capture that is not 1280x720 or is one colour, a frame count or NodeFrame count other than 90, a GL renderer that
  is not the RTX 5080 (`EXPECT_GPU`), a WebGPU adapter that is not nvidia/blackwell (`EXPECT_GPU_ARCH`) or is a
  fallback. Low PSNR is progress, not failure. `--self-test` runs 18 synthetic known-bad cases and 3 live ones.
  Scenes: `breeze`, `calm`, `squall`, or any raw query string.
- `node tools/fft-diff.mjs [--self-test]`: the bare FFT at 128/256/512 against a CPU DFT (impulse, single mode,
  noise), then every cascade's h0, disp, foam, slope and active buffers against a fresh GL `Ocean` after 3 steps of
  the breeze spectrum. Limits are relative RMS: 1e-5 for f32 against f32, 2e-3 (5e-3 foam) against GL's f16 targets.
  `--self-test` adds a forward-transform reference and a swapped cascade, which must fail.
- `node tools/lut-diff.mjs [--self-test]`: the 4 LUTs, env, envDeck and irradiance against fresh GL objects at sun
  11/45/2/-4 deg, relative RMS limit 1e-3. An all-zero reference fails (`tools/compare.mjs`).
- `node tools/cloud-diff.mjs [--self-test]`: 90 breeze frames in both engines, then the shape and detail volumes (3
  z slices per mip), every weather-map mip, the shadow map, env clouds and the screen buffer with its distance.
  Relative RMS with rgb and alpha apart, plus the three/GL ratio of the channel means. `--self-test`: a shape slice
  against another slice must fail.
- `diff.mjs` scene `clear` (no clouds, pitch 10) compares the top 68 % of rows and fails below 38 dB PSNR; scenes
  `sea` (no clouds, pitch 1.5, mostly water) and `breeze` (clouds) fail below 30 dB; `squall`, `rain` (downpour,
  wind 20) and `storm` (forced ground strike) below 35 dB.
- Headless Chrome 156 on Linux gets a hardware WebGPU adapter (nvidia blackwell) only with `--use-angle=vulkan
  --enable-features=Vulkan --enable-unsafe-webgpu` (`tools/browser.mjs`).

## Resource contracts

Fill one row per GPU resource as it is ported. The GL column comes from the 2026-10-29 inventory.

| Resource | GL (src/) | three | Owner | Notes |
|---|---|---|---|---|
| HDR scene | MSTarget rgba16f/r11g11b10f, MSAA, blit resolve | half-float RenderTarget, no MSAA yet | `src/three/main.ts` | M2 |
| Tone map | AgX in `src/fx/post.js` | same AgX + look in TSL | `src/three/post.ts` | M2 |
| Noise, h0 | rgba32f per cascade | vec4 f32 buffer per cascade | `src/three/ocean.ts` | M1; rng(1337), same draw order |
| FFT ping-pong | 2 MRT pairs rgba32f per size | 2 x 2 vec4 buffers per size | `src/three/ocean.ts` | M1; shared by cascades of one size, result in A |
| disp + foam, slope | rgba16f x2, mips | vec4 f32 buffers x2 per cascade, copied to half-float textures with mips | `src/three/ocean.ts` | M1, M3a |
| foam structure | rgba8 1024^2, mips, aniso 8 | StorageTexture rgba8, auto-mips, aniso 8 | `src/three/foam.ts` | M3 |
| shape, detail volumes | rgba8 3D 128^3 / 32^3, mips | Storage3DTexture rgba8, mips written by hand | `src/three/clouds.ts` | M4 |
| clouds screen, depth, env, shadow | rgba16f / r16f, history pairs | half-float StorageTextures (rgba16f: r16f storage needs a feature) | `src/three/clouds.ts` | M4 |
| probe | rgba32f 2x1 + PBO/fence | vec4 storage buffer x2, `getArrayBufferAsync` | `src/three/probe.ts` | M3 |
| active breaking | r16f x2, mips | float f32 buffers x2 per cascade | `src/three/ocean.ts` | M1 |
| Atmosphere LUTs | rgba16f 256x64, 32x32, 256x128, 64x64 | half-float StorageTextures, same sizes | `src/three/atmosphere.ts` | M2 |
| env, envDeck | rgba16f 512x256, mips, env wraps in s | half-float StorageTextures, auto-mips | `src/three/sky.ts` | M2; envDeck = env until fog lands |
| irradiance | rgba16f 2x1 | half-float StorageTexture 2x1 | `src/three/sky.ts` | M2 |
| bloom, lum, adapt | rgba16f pyramid, 256x256 mips, rgba32f 1x1 x2 | RenderTargets, same formats | `src/three/post.ts` | M2 |

## Rules for ported shaders

- Projection: three's camera matrices use WebGPU NDC (z 0..1, Y down in framebuffer space). Never reuse
  `src/math.js` `perspective()` or rays rebuilt from its inverse in a three shader.
- No derivatives or implicit-LOD samples inside non-uniform branches (WGSL uniformity).
- `isnan`, `isinf`, `inverse(mat2)` do not exist in WGSL: write helpers once in `src/three/`.
- `frontCurve` gets one copy, shared by the CPU and the shaders.
