# Changelog

Every shipped change, newest first: one line each, with its commits. Add a line when a change lands;
the why and the numbers go in the commit message.

- 2026-11-06 10:10 three.js 0.187: fixed-step render path keeps its animation loop stopped; all scenes pixel-identical.
- 2026-11-06 09:30 Ready for public release: README, contributor files, gitleaks rules, CI, session notes gitignored.
- 2026-11-01 10:08 Film render checked after the GL removal: 5 s, 300 frames, audio, no black frames.
- 2026-11-01 10:05 Cloud towers finished. `1633e80` `31c42b7`
- 2026-10-29 22:30 Towers: forward smoothstep at the edge, cloud shadow 32 steps so towers cast shadows. `31c42b7`
- 2026-10-29 20:50 Distant showers no longer paint over wave crests seen from a trough. `20ac61f`
- 2026-10-29 20:50 WebGL2 engine archived in `archive/gl/` (tag `gl-final`); diff.mjs compares three.js to saved frames; tools/shot.mjs for three. `faa36aa`
- 2026-10-29 20:50 Congestus towers fitted to a hand-drawn sketch. `1633e80`
- 2026-10-29 20:25 Cloud sketch pad `tools/cloud-sketch.html`: paint or trace a tower side view, measures height, width profile, puff radii, saves JSON. `e461887`
- 2026-10-29 20:05 Default engine is three.js WebGPU; GL at `?engine=gl`. `e6c4116`
- 2026-10-29 19:58 Distant rain showers under the big fair-weather cells (coverage 0.25-0.9), both engines; new diff scene `showers`. `d99c8ce`
- 2026-10-29 19:52 Denser rain: 600k streak drops (was 120k), gain 30 (was 13), both engines.
- 2026-10-29 19:35 Less gale foam: residual decay 0.1 / 0.15 1/s at 18 / 24 m/s (was 0.058 / 0.05); 26 m/s coverage 40% -> 14%. `7d9bfa5`
- 2026-10-29 19:23 Sky edge fixed: sine-free `fogHash` (Hoskins, MIT) in both engines; storm step at x 292 -6.6 -> 0. `a5a4ad8`
- 2026-10-29 19:15 Darker sea: `SEA_GRADE` 0.7 on reflected sky + body, both engines (glints, foam full); sea 13-39% darker. `8a77a06`
- 2026-10-29 19:08 App shell review fixes: livetest asserts, live-three counts started thunder, mute-during-init race, three resize guard. `adbb467`
- 2026-10-29 18:48 Full 60 s film in both engines (PSNR 34.5 dB avg). Sky edge: wrongly closed, reopened 19:13. `ba56b4e` `48b6cfb`
- 2026-10-29 18:50 One shared `liveAudio` (`src/audio/audio.js`) for both engines; `livetest.mjs` and `live-three.mjs` pass. `7837218`
- 2026-10-29 19:20 Port app shell: shared UI, drag/wheel camera, dynamic resolution, film hooks (`render.mjs --engine three`). `4291f45`
- 2026-10-29 19:00 Port review fixes: night-flip cloud reset, awaited error scopes, mute key, test gaps. `bf10503`
- 2026-10-29 18:40 Port parity: 4x MSAA + centroid, thunder audio, live-path test; all 10 diff scenes 37.3-49.8 dB. `63453d6`
- 2026-10-29 17:56 Port M5: rain, spray, lightning in TSL (`rain` 43.1 dB, `storm` 41.2 dB); tag `port-m5`. `9aaecd5`
- 2026-10-29 17:52 Port M5a: rain, mist, squall curtains, spray haze (`applyFog`); `squall` 32.0 -> 42.0 dB. `0874b1a`
- 2026-10-29 17:34 Port M4: cloud lighting matches GL (shafts ported, phantom flash from `Vector4()` w = 1 fixed), `tools/cloud-diff.mjs`; `breeze` 33.9 dB; tag `port-m4`. `3cba0d4`
- 2026-10-29 17:14 Port M4a: volumetric clouds in TSL, wired into sky, env, water, post; lighting not yet matching GL. `939b1e6`
- 2026-10-29 17:20 Port M3: water, foam, rain ripples, probe and the floating camera in TSL; `sea` 33.4 dB vs GL; tag `port-m3`. `8b850c9`
- 2026-10-29 16:47 Port M3a: ocean fields as mipmapped half-float textures; the ocean runs per frame. `d876920`
- 2026-10-29 16:47 Port M2: atmosphere LUTs, clear sky, env, irradiance, post chain in TSL; clear sky 41.6 dB vs GL; tag `port-m2`. `8873384` `634f961` `2eba54e`
- 2026-10-29 16:32 Port M1: FFT ocean as TSL compute, matches GL within f16 rounding (`tools/fft-diff.mjs`); tag `port-m1`. `e0af200`
- 2026-10-29 16:24 Reviews moved to the end of the port; tag `port-m0`. `eaac5f2`
- 2026-10-29 16:23 Port M0 review 3 fixes: exact NodeFrame count, GPU check. `1a3a9ce`
- 2026-10-29 16:18 Port M0 review 2 fixes; warm-up page for Chrome's first-context loss. `4c9c052`
- 2026-10-29 16:08 Port M0 review 1 fixes: own clock, error scopes, locked cameras, strict diff verdict. `1e76924`
- 2026-10-29 15:50 Port M0: `?engine=three` WebGPU skeleton, `tools/diff.mjs`, ADR 0001. `9bcafc9`
- 2026-10-29 15:55 Squall cell: `frontLen`, `frontDepth`, `sTop` weather keys bound the squall line. `0e4554b`
- 2026-10-29 15:40 Fork open-water `3d1adaa` with Vite + TS, `pnpm check` gate, audio in `public/`, repo docs. `3b50a7b`
