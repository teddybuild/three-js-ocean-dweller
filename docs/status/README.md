# Status

Where the project is right now. Read this first, then the newest handoff.

- **Newest handoff:** the newest file in `docs/status/handoffs/`. Handoffs are session notes and stay local (gitignored).
- [open/](open/README.md): open items and design questions, in priority order.
- [CHANGELOG.md](CHANGELOG.md): every shipped change, newest first, one line each with its commits.
- [lessons.md](lessons.md) and [rulings.md](rulings.md): traps past sessions hit, and the owner's standing calls. Both
  load every session (`CLAUDE.md`).
- Day logs with every step's numbers and reasons: `docs/log/`.

## Right now (2026-11-06)

three.js WebGPU is the only engine; the WebGL2 engine is archived in `archive/gl/` (tag `gl-final`). Checks:
`tools/diff.mjs` (three vs its saved frames), `tools/shot.mjs` (one frame), `tools/live-three.mjs`. Congestus towers
fitted to the owner's sketch, approved by the owner 2026-11-01. Spec: `docs/systems/three-port.md`.
Public-repo prep is done and waits on the owner's go.

## How to update

- End of every session: add `handoffs/YYYY-MM-DD-HHMM.md` and delete the one before it. Do not commit it: the folder is
  gitignored. Move lasting gotchas and decisions to `lessons.md` and `rulings.md`, and refresh "Right now".
- Each shipped change: one line at the top of `CHANGELOG.md` (`- YYYY-MM-DD HH:MM what. `sha``). The why and the
  checks go in the commit message and the day's `docs/log/` file.
- New or finished open items: `open/`.
