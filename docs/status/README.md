# Status

Where the project is right now. Read this first, then the newest handoff.

- **Newest handoff:** the newest file in `docs/status/handoffs/`. Handoffs are session notes and stay local (gitignored).
- [open/](open/README.md): open items and design questions, in priority order.
- [CHANGELOG.md](CHANGELOG.md): every shipped change, newest first, one line each with its commits.
- [lessons.md](lessons.md): traps past sessions hit. It loads every session (`CLAUDE.md`).

## Right now (2026-11-06)

three.js WebGPU is the only engine; the WebGL2 engine is archived in `archive/gl/` (tag `gl-final`). Checks:
`tools/diff.mjs` (three vs its saved frames), `tools/shot.mjs` (one frame), `tools/live-three.mjs`. Congestus towers
fitted to a hand-drawn sketch. Spec: `docs/systems/three-port.md`.

## How to update

- End of every session: add `handoffs/YYYY-MM-DD-HHMM.md` and delete the one before it. Do not commit it: the folder is
  gitignored. Move lasting gotchas to `lessons.md` and decisions to the local `rulings.md`, and refresh "Right now".
- Each shipped change: one line at the top of `CHANGELOG.md` (`- YYYY-MM-DD HH:MM what. `sha``). The why and the
  checks go in the commit message.
- New or finished open items: `open/`.
