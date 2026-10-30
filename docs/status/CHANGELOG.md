# Changelog

Every shipped change, newest first: one line each, with its commits. Add a line when a change lands;
the why and the numbers go in the commit message and the day's `docs/log/` file.

- 2026-10-29 20:25 Cloud sketch pad `tools/cloud-sketch.html`: paint or trace a tower side view, measures height, width profile, puff radii, saves JSON. `4b2321d`
- 2026-10-29 20:05 Default engine is three.js WebGPU (the owner's parity call); GL at `?engine=gl`. `b5ddd9d`
- 2026-10-29 19:58 Distant rain showers under the big fair-weather cells (coverage 0.25-0.9), both engines; new diff scene `showers`. `cd491a5`
- 2026-10-29 19:52 Denser rain: 600k streak drops (was 120k), gain 30 (was 13), both engines.
- 2026-10-29 19:35 Less gale foam: residual decay 0.1 / 0.15 1/s at 18 / 24 m/s (was 0.058 / 0.05); 26 m/s coverage 40% -> 14%. `d5c22e4`
- 2026-10-29 19:23 Sky edge fixed: sine-free `fogHash` (Hoskins, MIT) in both engines; storm step at x 292 -6.6 -> 0. `a0079a9`
- 2026-10-29 19:15 Darker sea: `SEA_GRADE` 0.7 on reflected sky + body, both engines (glints, foam full); sea 13-39% darker. `dedac7b`
- 2026-10-29 19:08 App shell review (Codex + agy, no P0/P1): livetest asserts, live-three counts started thunder, mute-during-init race, three resize guard. `13ceec6`
- 2026-10-29 18:48 Full 60 s film in both engines (PSNR 34.5 dB avg). Sky edge: wrongly closed, reopened 19:13. `0a9c451` `00f8606`
- 2026-10-29 18:50 One shared `liveAudio` (`src/audio/audio.js`) for both engines; `livetest.mjs` and `live-three.mjs` pass. `22687d9`
- 2026-10-29 19:20 Port app shell: shared UI, drag/wheel camera, dynamic resolution, film hooks (`render.mjs --engine three`). `f09ae9e`
- 2026-10-29 19:00 Port review fixes (Codex + agy, no P0): night-flip cloud reset, awaited error scopes, mute key, test gaps. `7b275ef`
- 2026-10-29 18:40 Port parity: 4x MSAA + centroid, thunder audio, live-path test; all 10 diff scenes 37.3-49.8 dB. `da722f8`
- 2026-10-29 17:56 Port M5: rain, spray, lightning in TSL (`rain` 43.1 dB, `storm` 41.2 dB); tag `port-m5`. `a86b523`
- 2026-10-29 17:52 Port M5a: rain, mist, squall curtains, spray haze (`applyFog`); `squall` 32.0 -> 42.0 dB. `5d10346`
- 2026-10-29 17:34 Port M4: cloud lighting matches GL (shafts ported, phantom flash from `Vector4()` w = 1 fixed), `tools/cloud-diff.mjs`; `breeze` 33.9 dB; tag `port-m4`. `cdb4a82`
- 2026-10-29 17:14 Port M4a: volumetric clouds in TSL, wired into sky, env, water, post; lighting not yet matching GL. `cc5a8a8`
- 2026-10-29 17:20 Port M3: water, foam, rain ripples, probe and the floating camera in TSL; `sea` 33.4 dB vs GL; tag `port-m3`. `6c9234c`
- 2026-10-29 16:47 Port M3a: ocean fields as mipmapped half-float textures; the ocean runs per frame. `a0a4f6d`
- 2026-10-29 16:47 Port M2: atmosphere LUTs, clear sky, env, irradiance, post chain in TSL; clear sky 41.6 dB vs GL; tag `port-m2`. `7cce7af` `65fa720` `c8ae6d4`
- 2026-10-29 16:32 Port M1: FFT ocean as TSL compute, matches GL within f16 rounding (`tools/fft-diff.mjs`); tag `port-m1`. `fdc3dc5`
- 2026-10-29 16:24 Ruling: Codex and agy review once at the end of the port; tag `port-m0`. `be44b3d`
- 2026-10-29 16:23 Port M0 review 3 fixes: exact NodeFrame count, RTX 5080 check. `744cd87`
- 2026-10-29 16:18 Port M0 review 2 fixes; warm-up page for Chrome's first-context loss. `74a4a65`
- 2026-10-29 16:08 Port M0 fixes from Codex review 1: own clock, error scopes, locked cameras, strict diff verdict. `4084589`
- 2026-10-29 15:50 Port M0: `?engine=three` WebGPU skeleton, `tools/diff.mjs`, ADR 0001. `8a909a1`
- 2026-10-29 15:55 Squall cell: `frontLen`, `frontDepth`, `sTop` weather keys bound the squall line. `25264e7`
- 2026-10-29 15:40 Fork open-water `3d1adaa` with Vite + TS, `pnpm check` gate, audio in `public/`, repo docs. `1435611`
