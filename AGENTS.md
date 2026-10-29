# three-js-ocean-dweller - Agent Index

> Pointer index for any agent working here. Keep this file lean. Load the linked docs on demand.
> Details belong in `docs/`, not here.

## Overview

Endless cinematic ocean in the browser, the web successor to an earlier Godot project (the owner
dropped Godot on 2026-10-29). A fork of [Leonxlnx/open-water](https://github.com/Leonxlnx/open-water) (MIT, pure
WebGL2): FFT ocean, atmosphere, volumetric clouds, rain, lightning, sound. Vite + TypeScript around it; three.js
comes in with the boat. Runs locally in Chrome. Repo: GitHub `teddybuild/three-js-ocean-dweller` (origin); `upstream` = Leonxlnx/open-water.

## Pointers

- `docs/status/` - where the project is right now. Read `docs/status/README.md` first, then the newest handoff in
  `docs/status/handoffs/`. `CHANGELOG.md` (one line per shipped change) and `open/` hold the rest.
- `docs/PLAN.md` - the design. Change it only to record a decision the owner made, with its date.
- `docs/ARCHITECTURE.md` - module contracts, data flow, and the invariants every change must keep.
- `docs/OSS.md` - what we reuse and its licenses. Check before writing anything.
- `docs/systems/` - one spec per system. Read the one you're touching; write one before coding a system that has none.
- `docs/adr/` - decision records (`README.md` is the index). Read before reversing a big choice.
- `docs/log/` - dated notes, `YYYY-MM-DD-topic.md`. Append, don't rewrite.

## Where things go

Every file has one home. If a new file fits none of these, add a row here (and to `docs-layout.json`, which the gate
checks) before creating it.

| Path | What lives there |
|---|---|
| repo root | config only, plus `README.md`, `AGENTS.md`, `CLAUDE.md`. No notes, scripts or scratch. |
| `docs/*.md` | the standing references only: PLAN, ARCHITECTURE, OSS |
| `docs/systems/` | one spec per system: how it works now |
| `docs/adr/` | one decision per file, `NNNN-slug.md`, indexed in `README.md` |
| `docs/status/` | `README.md`, `CHANGELOG.md`, `handoffs/` (newest only), `open/`, `lessons.md`, `rulings.md` |
| `docs/log/` | dated work notes and research, `YYYY-MM-DD-topic.md` |
| `src/` | upstream open-water modules (plain JS, embedded GLSL); new code is TS |
| `src/three/` | the three.js WebGPU port (TS), `docs/systems/three-port.md` |
| `public/audio/` | recorded rain and thunder (`CREDITS.md`), served at `/audio/` |
| `tools/`, `render/` | upstream puppeteer probes and the offline film renderer; they expect the dev server on :5173 |
| `media/` | upstream README images and film |
| `tmp/` (gitignored) | scratch. Never the only copy of anything worth keeping |

**When a file becomes a folder.** Split a doc into `name/README.md` (the index) plus topic files when it gains an
entry every session or change, or when it passes 400 lines (the gate fails it): 4-8 files of roughly 50-250 lines,
never one file per heading. Do the split as its own commit, fix every pointer (`git grep`).

**Specs say what is, logs say what happened.** Edit specs in place (keep the owner's quote and date on decisions);
history and numbers go in the day's `docs/log/` file.

## Commands

- `pnpm check` - the gate (`tsc --noEmit && vite build`). Must pass before any push.
- `pnpm dev` - dev server on http://localhost:5173 (port fixed for `tools/`). `pnpm preview` serves `dist/` on :4173.
- URL flags: see `src/main.js` (`?render`, presets). `?engine=three` runs the WebGPU port.
- `node tools/diff.mjs [scene ...] [--self-test]` - renders both engines, writes `tmp/diff/<scene>.png`, prints PSNR.
- `node tools/fft-diff.mjs [--self-test]` - the three.js FFT ocean against a CPU DFT and against the GL ocean.
- `node tools/lut-diff.mjs [--self-test]` - the three.js atmosphere LUTs, env and irradiance against GL.
- `node tools/live-three.mjs` - the three.js live path: loop, errors, thunder audio.
- `node tools/cloud-diff.mjs [--self-test]` - the three.js cloud volumes, weather, shadow, env and screen against GL.

## Workflow

- While working, run only the checks touching the change; run the full gate once when the ask is done.
- Every owner decision is recorded with their words and the date (spec, ADR, or `docs/status/rulings.md`).
