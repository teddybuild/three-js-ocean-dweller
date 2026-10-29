# Lessons

Traps past sessions hit, distilled from the handoffs' Gotchas. Loaded every session (`CLAUDE.md`). One line each,
grouped by topic, merged, never appended blindly. A lesson that can be a check becomes a test or hook and leaves this file.

## Harness

- Headless Chrome on Linux needs exactly `--use-angle=vulkan --enable-features=Vulkan --enable-unsafe-webgpu` for a hardware WebGPU adapter; adding `VulkanFromANGLE,DefaultANGLEVulkan` gives none. `navigator.gpu` is missing on `about:blank`.
- three's NodeFrame only advances in its own rAF loop: fixed steps must stop `renderer._animation` and call `_nodes.nodeFrame.update()` per frame, or passes update once per capture.
- three catches pipeline validation errors in its own error scopes and only logs them: read them via `THREE.setConsoleFunction`.

## Porting to TSL/WGSL (Codex, agy, web-ocean-3d)

- Shared uniforms rewritten between compute dispatches overwrite one UBO before submit: one uniform/ComputeNode per FFT stage.
- `r16float` storage writes need `texture-formats-tier1`; WGSLNodeBuilder drops the mip level in `textureDimensions()` on storage textures; auto-mips only run on a sampled bind-group update.
- `copyTextureToBuffer` pads rows to 256 bytes and three does not strip them: slice per row on readback.
- `?render` selects quality `high`: FFT sizes 512/256/256/256, not 256/256/128/128.
- Test the FFT butterfly on the CPU against an O(N^2) DFT with a stage-0 sign check; a magnitude-only check missed web-ocean-3d's twiddle bug.
- Reversed-edge `smoothstep` is undefined: use `smoothstep(a, b, x).oneMinus()`. NDC from screen UV is `(2u-1, 1-2v)`. Use TSL `Loop`, not JS `for`.
