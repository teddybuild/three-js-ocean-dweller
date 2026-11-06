# Changelog

Every shipped change, newest first: one line each, with its commits. Add a line when a change lands;
the why and the numbers go in the commit message and the day's `docs/log/` file.

- 2026-11-06 08:30 Public-repo prep: history rewritten, film removed from git, README and contributor files, gitleaks rules, CI. `docs/log/2026-11-06-public-repo.md`
- 2026-11-01 10:08 Film render checked after the GL removal: 5 s, 300 frames, audio, no black frames. `docs/log/2026-11-01-towers-perf.md`
- 2026-11-01 10:05 Cloud towers closed: Owner, live in breeze at yaw 200, "cloud towers look ok". `c025d50` `7560700`
- 2026-10-29 22:30 Towers: forward smoothstep at the edge, cloud shadow 32 steps so towers cast shadows (Sol review). `7560700`
- 2026-10-29 20:50 Distant showers no longer paint over wave crests seen from a trough. `efbd0d1`
- 2026-10-29 20:50 WebGL2 engine archived in `archive/gl/` (tag `gl-final`); diff.mjs compares three.js to saved frames; tools/shot.mjs for three. `68ed451`
- 2026-10-29 20:50 Congestus towers fitted to the owner's sketch. `c025d50`
- 2026-10-29 20:25 Cloud sketch pad `tools/cloud-sketch.html`: paint or trace a tower side view, measures height, width profile, puff radii, saves JSON. `4728aa6`
- 2026-10-29 20:05 Default engine is three.js WebGPU (the owner's parity call); GL at `?engine=gl`. `58bc3e0`
- 2026-10-29 19:58 Distant rain showers under the big fair-weather cells (coverage 0.25-0.9), both engines; new diff scene `showers`. `f70fe9a`
- 2026-10-29 19:52 Denser rain: 600k streak drops (was 120k), gain 30 (was 13), both engines.
- 2026-10-29 19:35 Less gale foam: residual decay 0.1 / 0.15 1/s at 18 / 24 m/s (was 0.058 / 0.05); 26 m/s coverage 40% -> 14%. `0c168a7`
- 2026-10-29 19:23 Sky edge fixed: sine-free `fogHash` (Hoskins, MIT) in both engines; storm step at x 292 -6.6 -> 0. `b056bb5`
- 2026-10-29 19:15 Darker sea: `SEA_GRADE` 0.7 on reflected sky + body, both engines (glints, foam full); sea 13-39% darker. `7ab4382`
- 2026-10-29 19:08 App shell review (Codex + agy, no P0/P1): livetest asserts, live-three counts started thunder, mute-during-init race, three resize guard. `a7c0175`
- 2026-10-29 18:48 Full 60 s film in both engines (PSNR 34.5 dB avg). Sky edge: wrongly closed, reopened 19:13. `b8ad523` `d3f27cb`
- 2026-10-29 18:50 One shared `liveAudio` (`src/audio/audio.js`) for both engines; `livetest.mjs` and `live-three.mjs` pass. `bbc9af3`
- 2026-10-29 19:20 Port app shell: shared UI, drag/wheel camera, dynamic resolution, film hooks (`render.mjs --engine three`). `9377ffe`
- 2026-10-29 19:00 Port review fixes (Codex + agy, no P0): night-flip cloud reset, awaited error scopes, mute key, test gaps. `07a91fe`
- 2026-10-29 18:40 Port parity: 4x MSAA + centroid, thunder audio, live-path test; all 10 diff scenes 37.3-49.8 dB. `6e1849d`
- 2026-10-29 17:56 Port M5: rain, spray, lightning in TSL (`rain` 43.1 dB, `storm` 41.2 dB); tag `port-m5`. `a012767`
- 2026-10-29 17:52 Port M5a: rain, mist, squall curtains, spray haze (`applyFog`); `squall` 32.0 -> 42.0 dB. `21e7e62`
- 2026-10-29 17:34 Port M4: cloud lighting matches GL (shafts ported, phantom flash from `Vector4()` w = 1 fixed), `tools/cloud-diff.mjs`; `breeze` 33.9 dB; tag `port-m4`. `c74f5b2`
- 2026-10-29 17:14 Port M4a: volumetric clouds in TSL, wired into sky, env, water, post; lighting not yet matching GL. `9b4377c`
- 2026-10-29 17:20 Port M3: water, foam, rain ripples, probe and the floating camera in TSL; `sea` 33.4 dB vs GL; tag `port-m3`. `5488b99`
- 2026-10-29 16:47 Port M3a: ocean fields as mipmapped half-float textures; the ocean runs per frame. `0f1d28e`
- 2026-10-29 16:47 Port M2: atmosphere LUTs, clear sky, env, irradiance, post chain in TSL; clear sky 41.6 dB vs GL; tag `port-m2`. `ca3fce9` `5f2d660` `5236440`
- 2026-10-29 16:32 Port M1: FFT ocean as TSL compute, matches GL within f16 rounding (`tools/fft-diff.mjs`); tag `port-m1`. `02fe1a2`
- 2026-10-29 16:24 Ruling: Codex and agy review once at the end of the port; tag `port-m0`. `e98fb4b`
- 2026-10-29 16:23 Port M0 review 3 fixes: exact NodeFrame count, RTX 5080 check. `2a7badc`
- 2026-10-29 16:18 Port M0 review 2 fixes; warm-up page for Chrome's first-context loss. `4c0ce9d`
- 2026-10-29 16:08 Port M0 fixes from Codex review 1: own clock, error scopes, locked cameras, strict diff verdict. `d52ea13`
- 2026-10-29 15:50 Port M0: `?engine=three` WebGPU skeleton, `tools/diff.mjs`, ADR 0001. `1397fbd`
- 2026-10-29 15:55 Squall cell: `frontLen`, `frontDepth`, `sTop` weather keys bound the squall line. `e5725e9`
- 2026-10-29 15:40 Fork open-water `3d1adaa` with Vite + TS, `pnpm check` gate, audio in `public/`, repo docs. `1b25c2c`
