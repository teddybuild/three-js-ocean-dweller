# ADR 0001: Port open-water to three.js WebGPU, side by side

## Status

Accepted 2026-10-29. Owner: "ok i want the full port"; port location "Same repo, side by side"; fidelity "Same feel,
freedom to change"; "after each milestone you need to have codex and agy check" (reversed 2026-10-29: "new rule just
iterate fast and then at end have reviews done").

## Context

The repo runs open-water's own WebGL2 renderer (29 GPU programs, 2,510 GLSL lines). Owner wants one three.js engine
for browser and Electron, on WebGPU.

## Decision

- three `0.186.1` (MIT), `WebGPURenderer` + TSL + `RenderPipeline`. `@types/three` `0.186.0` (MIT).
- WebGPU only. The renderer refuses three's WebGL2 fallback (`src/three/main.ts`).
- New code in `src/three/` (TS). `src/boot.ts` picks the engine: the WebGPU port, or `?engine=gl` for the WebGL2
  reference. The default flipped to three on 2026-10-29: Owner approved parity ("Yes, merge flip").
- Hand port, milestone order from the Codex plan review: harness, FFT alone, atmosphere + sky + exposure, water,
  clouds, weather fx, parity (`docs/systems/three-port.md`).
- Each milestone ends with `pnpm check` and `node tools/diff.mjs`, then a `port-m<N>` tag. Independent Codex and agy
  reviews run once, at the end of the port.

## Why

- Side by side keeps a working reference for every diff sheet.
- No converter handles GLSL ES 300 (naga needs GLSL 440+; Tint reads no GLSL), so a hand port is unavoidable.
- open-water's Stockham FFT supports its mixed 128/256/512 cascades; Poseidon's FFT assumes even log2(N).

## Alternatives

- Light port to three.js WebGL with the GLSL copied: identical look, but no WebGPU.
- Poseidon ocean + three's sky: faster, but no volumetric clouds or weather.

## Consequences

- Browsers without WebGPU get an error page, not the ocean.
- Two renderers live in the repo until parity; `src/` upstream files stay untouched apart from local patches.

## Update 2026-10-29

- GL archived: "stop working on GL", "archive GL in a folder and stop touching it" (owner). `archive/gl/`, tag
  `gl-final`; `?engine=gl` is gone. The regression check compares three.js against its own saved frames.

## Evidence

- Plan and research: kept outside the repo.
