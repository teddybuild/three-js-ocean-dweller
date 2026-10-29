# Architecture

Module contracts, data flow, and the invariants every change must keep.

## Modules

- `src/main.js` - creates the WebGL2 context, owns the frame loop and camera, wires every module below.
- `src/gl.js` - minimal WebGL2 toolkit: programs, textures, targets, fullscreen passes.
- `src/ocean/` - `ocean.js` 4-cascade Tessendorf FFT; `water.js` surface mesh and shading; `foam.js`; `probe.js`
  samples height and slope under a boat-sized footprint without stalling (the hook for a boat later).
- `src/sky/` - `atmosphere.js` LUTs, `clouds.js` volumetric clouds, `sky.js`.
- `src/fx/` - rain, ripples, spray, lightning, `post.js` (bloom, eye adaptation, AgX).
- `src/weather.js` presets and transitions; `src/film.js` the scripted 60 s film; `src/ui.js`; `src/audio/`.

## Data flow

Weather -> ocean spectrum + cloud parameters -> HDR scene targets (offscreen, with depth) -> post resolve to the
canvas (colour only).

## Invariants

- The canvas context has `depth: false`; depth lives in the offscreen targets. Anything drawn in the scene (a boat)
  must render into those targets before the resolve, or the ocean will not occlude it (Codex review, 2026-10-29).
