# Lessons

Traps past sessions hit, distilled from the handoffs' Gotchas. Loaded every session (`CLAUDE.md`). One line each,
grouped by topic, merged, never appended blindly. A lesson that can be a check becomes a test or hook and leaves this file.

## Harness

- Headless Chrome on Linux needs exactly `--use-angle=vulkan --enable-features=Vulkan --enable-unsafe-webgpu` for a hardware WebGPU adapter; adding `VulkanFromANGLE,DefaultANGLEVulkan` gives none. `navigator.gpu` is missing on `about:blank`.
- Chrome headless on Linux drops the first WebGL context once (~250 ms, Vulkan compositor surface fails): `launch()` burns it on a warm-up page. A blank reference capture passed the old diff with exit 0.
- three's NodeFrame only advances in its own rAF loop: fixed steps must stop `renderer._animation` and call `_nodes.nodeFrame.update()` per frame, or passes update once per capture.
- three catches pipeline validation errors in its own error scopes and only logs them: read them via `THREE.setConsoleFunction`.
- A 2D `drawImage` of the WebGPU canvas (also OffscreenCanvas) reads black in headless Chrome while `toDataURL` works: copy `getCurrentTexture()` (COPY_SRC) to a buffer in the frame's task (`app.pixels()`).
- `node tools/diff.mjs` with no scene runs only breeze: name all 11 (`breeze showers sea calm squall clear rain storm night stormfloat rt`), or a scene's PNG is stale. `page.screenshot` of the WebGPU canvas is black in headless too: shoot GL for looks, `diff.mjs` for three.
- Close an open item only on a check of the scene it was reported in: the 60 s film never frames the storm sky edge, so a film check "closed" it wrongly.
- `git add a b <path already git rm'd>` aborts the whole add: the commit then holds only the staged rm. Check `git show --stat` before pushing.

## Look and shading

- `fract(sin(x) * 43758.5453)` hashes break value noise at lattice indices in the thousands (one ULP gives a corner two values): a straight world-anchored seam. Use the sine-free hash (`fogHash` in `src/sky/atmosphere.js`).
- At the usual camera angles the sea is sky reflection: scaling water-leaving `rrs` (even to 0) moved it 0-1/255. Darken with `SEA_GRADE` (`src/ocean/water.js`).
- Gale foam rows (`uFoamStretch`) hide a saturated foam density: stretch off turns the sea white. Tune coverage with `Weather.foam()` decay, not the stretch.
- Find a world-anchored artifact by elimination: turn one term off per shot (`tools/shot.mjs`), measure column means; guesses at the cause cost two rounds here.

## Porting to TSL/WGSL (Codex, agy, web-ocean-3d)

- Shared uniforms rewritten between compute dispatches overwrite one UBO before submit: one uniform/ComputeNode per FFT stage.
- `r16float` storage writes need `texture-formats-tier1` (use rgba16float); WGSLNodeBuilder drops the mip level in `textureDimensions()` on storage textures; auto-mips only run on a sampled bind-group update, so a store and the first mip-sampling read go in separate `renderer.compute()` calls (`src/three/sky.ts` renderEnv).
- @types/three 0.186 TSL overloads reject long node chains: import `* as TSL` and destructure `as any`, `type Node = any`. Write LUTs and fields texel by texel in compute (row y = v (y+0.5)/h) so orientation matches GL without flips.
- `copyTextureToBuffer` pads rows to 256 bytes and three does not strip them: slice per row on readback.
- three generates mips only for 2D textures: write each 3D level with `textureStore(...).setMipLevel(k)` from a separate plain copy of the level above (`src/three/clouds.ts` volume()). Ping-pong textures in materials: keep one texture node and set `.value` per frame; `.sample()`/`.load()` clones follow the base.
- `?render` selects quality `high`: FFT sizes 512/256/256/256, not 256/256/128/128.
- Test the FFT butterfly on the CPU against an O(N^2) DFT with a stage-0 sign check; a magnitude-only check missed web-ocean-3d's twiddle bug.
- `new THREE.Vector4()` is (0, 0, 0, 1): a vec4 uniform whose w is a switch or intensity (flash, bolt) needs explicit zeros. It lit every near cloud with a phantom flash.
- TSL and GLSL that read the same but render differently: dump the WGSL first (`renderer._nodes.getForCompute(node).computeShader`); six rounds of term bisection found the phantom flash that the WGSL showed at once.
- Reversed-edge `smoothstep` is undefined: use `smoothstep(a, b, x).oneMinus()`. NDC from screen UV is `(2u-1, 1-2v)`. Use TSL `Loop`, not JS `for`.
