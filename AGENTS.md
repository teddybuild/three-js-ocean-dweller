# three-js-ocean-dweller - Agent Index

> Pointer index for any agent working here. Keep this file lean. Load the linked docs on demand.
> Details belong in `docs/`, not here.

## Overview

Endless cinematic ocean in the browser, the web successor to an earlier Godot project (the owner
dropped Godot on 2026-10-29). Started as a fork of [Leonxlnx/open-water](https://github.com/Leonxlnx/open-water) (MIT, WebGL2):
FFT ocean, atmosphere, volumetric clouds, rain, lightning, sound, now ported to three.js on WebGPU (TSL shaders,
`src/three/`); the WebGL2 original is archived in `archive/gl/`. Vite + TypeScript. Runs locally in Chrome. Repo: GitHub `teddybuild/three-js-ocean-dweller` (origin); `upstream` = Leonxlnx/open-water.

## Public repo

Everything committed here is public, history included: docs, logs, handoffs, commit messages and comments.

- Never write a real name, personal email, private host or IP, absolute home path, vault key name or token. Say "the owner".
- Commits use the GitHub noreply identity (`git config user.email`). Check `git log -1 --format=%ae` before a push.
- Working notes stay local and gitignored: `docs/log/`, `docs/status/rulings.md`, `docs/status/handoffs/`, `CLAUDE.local.md`.
- Run `pnpm check:secrets` before a push (`.gitleaks.toml`). CI runs it on every push and pull request.
- `origin` is GitHub. Contributors work through pull requests (`CONTRIBUTING.md`).

## Pointers

- `docs/status/` - where the project is right now. Read `docs/status/README.md` first, then the newest handoff in
  `docs/status/handoffs/` (local only, gitignored: never `git add` a handoff). `CHANGELOG.md` (one line per shipped change) and `open/` hold the rest.
- `docs/PLAN.md` - the design. Change it only to record a decision the owner made, with its date.
- `docs/ARCHITECTURE.md` - module contracts, data flow, and the invariants every change must keep.
- `docs/OSS.md` - what we reuse and its licenses. Check before writing anything.
- `docs/systems/` - one spec per system. Read the one you're touching; write one before coding a system that has none.
- `docs/adr/` - decision records (`README.md` is the index). Read before reversing a big choice.
- `docs/log/` - dated notes, `YYYY-MM-DD-topic.md` (local only, gitignored). Append, don't rewrite.

## Where things go

Every file has one home. If a new file fits none of these, add a row here (and to `docs-layout.json`, which the gate
checks) before creating it.

| Path | What lives there |
|---|---|
| repo root | config only, plus `README.md`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`. No notes, scripts or scratch. |
| `docs/*.md` | the standing references only: PLAN, ARCHITECTURE, OSS |
| `docs/systems/` | one spec per system: how it works now |
| `docs/adr/` | one decision per file, `NNNN-slug.md`, indexed in `README.md` |
| `docs/status/` | `README.md`, `CHANGELOG.md`, `handoffs/` (newest only, gitignored), `open/`, `lessons.md`, `rulings.md` (local only, gitignored) |
| `docs/log/` | dated work notes and research, `YYYY-MM-DD-topic.md` (local only, gitignored) |
| `src/` | the app: `boot.ts`, shared plain-JS modules (weather, UI, film, audio, math, ocean spectrum, sky medium) |
| `src/three/` | the three.js WebGPU renderer (TS, TSL shaders), `docs/systems/three-port.md`; all rendering work goes here |
| `archive/gl/` | the archived open-water WebGL2 engine and its GL-based tools. Reference only: never edit, never import. Tag `gl-final` runs it |
| `public/audio/` | recorded rain and thunder (`CREDITS.md`), served at `/audio/` |
| `tools/`, `render/` | upstream puppeteer probes and the offline film renderer; they expect the dev server on :5173 |
| `media/` | README images: `now-*.jpg` from this engine, the rest from upstream. Video stays out of git (`*.mp4` is ignored). |
| `.github/` | CI workflow, Dependabot, issue and pull request templates |
| `tmp/` (gitignored) | scratch. Never the only copy of anything worth keeping |

**When a file becomes a folder.** Split a doc into `name/README.md` (the index) plus topic files when it gains an
entry every session or change, or when it passes 400 lines (the gate fails it): 4-8 files of roughly 50-250 lines,
never one file per heading. Do the split as its own commit, fix every pointer (`git grep`).

**Specs say what is, logs say what happened.** Edit specs in place (keep the owner's quote and date on decisions);
history and numbers go in the commit message and the day's local `docs/log/` file.

## Commands

- `pnpm check` - the gate (`tsc --noEmit && vite build`). Must pass before any push.
- `pnpm check:secrets` - gitleaks over all history with `.gitleaks.toml`. CI runs it too.
- `pnpm dev` - dev server on http://localhost:5173 (port fixed for `tools/`). `pnpm preview` serves `dist/` on :4173.
- URL flags: see `src/three/main.ts` (`?render`, presets, `yaw`, `pitch`, `elev`, any weather key).
- `node tools/shot.mjs "<query>" out.png [w h seconds]` - one three.js frame to a PNG (headless, deterministic).
- `node tools/diff.mjs [scene ...|all] [--update] [--self-test]` - each scene against its saved reference frame
  (`tmp/diff/ref/`): `--update` on a clean commit first, then the change; writes `tmp/diff/<scene>.png` (ref | now).
- `node tools/live-three.mjs` - the live path: loop, UI, drag, errors, thunder audio.
- `node render/render.mjs [--from s --to s --w --h --fps --out]` - the offline film (dev server on :5173).
- http://localhost:5173/tools/cloud-sketch.html - paint a cloud side view in metres (or trace a photo); measures
  height, width profile and puff radii, saves JSON + PNG for fitting the cloud shader.

## Workflow

- While working, run only the checks touching the change; run the full gate once when the ask is done.
- Every owner decision is recorded with their words and the date (spec, ADR, or the local `docs/status/rulings.md`).
