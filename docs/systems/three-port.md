# three.js WebGPU port

How the port is built and checked. Decision: `docs/adr/0001-three-webgpu-port.md`.

## Layout

- `src/boot.ts` loads `src/three/main.ts`, the only engine. The WebGL2 engine and its parity tools are in
  `archive/gl/` (2026-10-29); tag `gl-final` runs it.
- The engine sets `window.engine` = `{ name, step(n, dt), capture(), errors, adapter }`. `step` runs `n` fixed
  steps of the engine's own clock and awaits the GPU and pending error scopes; `capture` renders once and returns a
  PNG data URL read in the same task. A fresh page is the reset; seeds are fixed in code.
- Clock: the three engine owns `elapsed` and the `uTime` uniform (`src/three/main.ts`). Every animated node reads
  `uTime`; three's `time` node and NodeFrame follow the wall clock and are never used.
- Errors (three): `uncapturederror`, device loss, a validation error scope around every frame, and three's own
  logged errors via `THREE.setConsoleFunction` (three catches pipeline errors in its own scopes and only logs them).
- Shared plain JS: `src/weather.js`, `src/film.js`, `src/ui.js`, `src/audio/`; `src/ocean/spectrum.js`,
  `cascadesFor()` (bands) and `computeStats()` (foam threshold stats).
- Ocean (`src/three/ocean.ts`, M1): open-water's spectrum, evolve, Stockham FFT and assemble as TSL compute over
  f32 storage buffers indexed `y * N + x`. One ComputeNode per cascade, FFT stage and ping-pong direction, all
  uniforms set before the frame's one `renderer.compute([...])`. Not drawn yet; `window.portTest` drives it.
- Atmosphere and sky (`src/three/atmosphere.ts`, `src/three/sky.ts`, M2): the 4 LUTs, the environment map and its
  irradiance are compute kernels writing half-float storage textures texel by texel (row y is v = (y + 0.5) / h, as
  in GL). The environment gets its mips from three's storage-texture auto-mips, which run when the texture is next
  sampled, so the irradiance pass is a separate `compute()` call. The background is the clear-sky branch of
  `SKY_FS` (`scene.backgroundNode`) with the clouds (M4), the crepuscular rays (`sky.withShafts`, M4) and the rain, mist, squall curtains, distant showers and spray
  haze (`sky.fog(dir, dist)` -> `{ T, Lf }`, `applyFog` = col T + Lf, M5). The background fogs sky and clouds
  separately, the clouds only to their mean distance (`sky.cloudDepth`). `src/sky/medium.js` exports
  `mediumFor()`.
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
  strike at the same place and time (`?strikeAt=t`). Their `vUv` (and the bolt's `vClip`) use
  `centroidVarying` (`tsl-util.ts`), GL's `centroid`: three's `varyingProperty` takes no interpolation, so the helper
  sets it on the builder's varying, which WGSL emits as `@interpolate(perspective, centroid)`.
- Audio (`src/three/main.ts` `audio`): GL's live `audio` object around the shared `src/audio/audio.js`, fed
  `lightning.events` for thunder. The shared UI's sound button and M key start and mute it.
- App shell (`src/three/main.ts` `app` = `window.app`): the part of GL's `App` that `src/ui.js` and `render/` use
  (`cam`, `weather`, `lightning`, `stats`, `time`, `w`/`h`, `fade`, `filmFrame`, `warmSea`, `filmAudio`). Live: the
  shared UI, drag/wheel camera, `?scale` and GL's dynamic resolution (0.5 to the device ratio, 1.5 max).
  `filmFrame` and `warmSea` are async; `pixels()` copies the canvas texture (COPY_SRC) to a buffer, because a 2D
  `drawImage` of the WebGPU canvas reads black in headless Chrome. The soundtrack is `filmAudio()` in `src/film.js`,
  shared. Not ported: `measureFoam` (debug).

## Checks

- `node tools/diff.mjs [scene ...|all] [--update] [--self-test]` (dev server on :5173). Fresh page per capture,
  `?render`, 90 steps of 1/30 s at 1280x720, `float=0` except `stormfloat`. `--update` saves each frame as the
  scene's reference (`tmp/diff/ref/`); without it each frame is compared to its reference, `tmp/diff/<scene>.png` is
  ref | now, and PSNR under 45 dB fails. `verdict()` also fails on: any page or WebGPU error, a capture that is not
  1280x720 or is one colour, a frame or NodeFrame count other than 90, an adapter that is not nvidia/blackwell
  (`EXPECT_GPU_VENDOR`, `EXPECT_GPU_ARCH`) or is a fallback. `--self-test` runs 15 synthetic known-bad cases and 2 live ones. Scenes: the
  `SCENES` table (incl. `showers`, `towers`, `night` at elev -12, `rt` the live tier), or any raw query string.
- `node tools/shot.mjs "<query>" out.png [w h seconds]`: one frame after `seconds` of fixed steps, for looking.
- `node tools/live-three.mjs`: the live path (no `?render`, q=rt, rAF loop) for 6 s in a storm with a strike at 2 s;
  fails on errors, under 5 fps, a stopped AudioContext, or no thunder.
- Archived with GL (`archive/gl/tools/`): the gl-vs-three `diff.mjs`, `fft-diff`, `lut-diff`, `cloud-diff`.
- Headless Chrome 156 on Linux gets a hardware WebGPU adapter (nvidia blackwell) only with `--use-angle=vulkan
  --enable-features=Vulkan --enable-unsafe-webgpu` (`tools/browser.mjs`).

## Resource contracts

Fill one row per GPU resource. The GL column comes from the 2026-10-29 inventory (GL now in `archive/gl/`).

| Resource | GL (archive/gl/src/) | three | Owner | Notes |
|---|---|---|---|---|
| HDR scene | MSTarget rgba16f/r11g11b10f, MSAA, blit resolve | half-float RenderTarget, 4x MSAA (`?msaa`), resolved by the pass | `src/three/main.ts` | M2 |
| Tone map | AgX in `fx/post.js` | same AgX + look in TSL | `src/three/post.ts` | M2 |
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
