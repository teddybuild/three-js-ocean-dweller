# Status

Where the project is right now. Read this first, then the newest handoff.

- **Newest handoff:** none yet.
- [open/](open/README.md): open items and design questions, in priority order.
- [CHANGELOG.md](CHANGELOG.md): every shipped change, newest first, one line each with its commits.
- [lessons.md](lessons.md) and [rulings.md](rulings.md): traps past sessions hit, and the owner's standing calls. Both
  load every session (`CLAUDE.md`).
- Day logs with every step's numbers and reasons: `docs/log/`.

## Right now (2026-10-29)

three.js WebGPU port, milestone 0 done: `?engine=three` skeleton, `tools/diff.mjs`, hardware WebGPU in headless
Chrome. Next: milestone 1, open-water's FFT as TSL compute (`docs/systems/three-port.md`).

## How to update

- End of every session: add `handoffs/YYYY-MM-DD-HHMM.md` (never edit an old one) and delete the one before it
  (only the newest is kept; the rest are in git), point "Newest handoff" above at it, and refresh "Right now".
- Each shipped change: one line at the top of `CHANGELOG.md` (`- YYYY-MM-DD HH:MM what. `sha``). The why and the
  checks go in the commit message and the day's `docs/log/` file.
- New or finished open items: `open/`.
