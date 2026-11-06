# Architecture

Module contracts, data flow, and the invariants every change must keep.

## Modules

- `src/boot.ts` starts `src/three/main.ts`, which owns the WebGPU renderer, frame loop and camera and wires the rest.
- `src/three/` - `ocean.ts` 4-cascade Tessendorf FFT (compute); `water.ts` surface; `foam.ts`; `probe.ts` height and
  slope under a footprint; `atmosphere.ts` LUTs; `clouds.ts` volumetric clouds; `sky.ts` sky, env and fog; `rain.ts`,
  `spray.ts`, `lightning.ts`; `post.ts` (bloom, eye adaptation, AgX). Spec: `docs/systems/three-port.md`.
- Shared plain JS: `src/weather.js` presets and transitions; `src/film.js` the scripted 60 s film; `src/ui.js`;
  `src/audio/`; `src/math.js`; `src/ocean/spectrum.js` (cascades, CPU spectrum stats); `src/sky/medium.js` (haze).
- `archive/gl/` - the upstream WebGL2 engine, archived 2026-10-29. Reference only; tag `gl-final` runs it.

## Data flow

Weather -> ocean spectrum + cloud parameters -> HDR scene targets (offscreen, with depth) -> post resolve to the
canvas (colour only).

## Invariants

- The canvas context has `depth: false`; depth lives in the offscreen targets. Anything drawn in the scene (a boat)
  must render into those targets before the resolve, or the ocean will not occlude it.
