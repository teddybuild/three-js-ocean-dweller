# Changelog

Every shipped change, newest first: one line each, with its commits. Add a line when a change lands;
the why and the numbers go in the commit message and the day's `docs/log/` file.

- 2026-10-29 16:32 Port M1: FFT ocean as TSL compute, matches GL within f16 rounding (`tools/fft-diff.mjs`); tag `port-m1`. `fdc3dc5`
- 2026-10-29 16:24 Ruling: Codex and agy review once at the end of the port; tag `port-m0`. `be44b3d`
- 2026-10-29 16:23 Port M0 review 3 fixes: exact NodeFrame count, RTX 5080 check. `744cd87`
- 2026-10-29 16:18 Port M0 review 2 fixes; warm-up page for Chrome's first-context loss. `74a4a65`
- 2026-10-29 16:08 Port M0 fixes from Codex review 1: own clock, error scopes, locked cameras, strict diff verdict. `4084589`
- 2026-10-29 15:50 Port M0: `?engine=three` WebGPU skeleton, `tools/diff.mjs`, ADR 0001. `8a909a1`
- 2026-10-29 15:55 Squall cell: `frontLen`, `frontDepth`, `sTop` weather keys bound the squall line. `25264e7`
- 2026-10-29 15:40 Fork open-water `3d1adaa` with Vite + TS, `pnpm check` gate, audio in `public/`, repo docs. `1435611`
