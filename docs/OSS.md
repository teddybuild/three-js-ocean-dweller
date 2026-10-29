# Open source we reuse

Every copied or adapted source, its version and license. Hand-written pieces say why nothing fit.

| What | Version | License | Used for |
|---|---|---|---|
| [Leonxlnx/open-water](https://github.com/Leonxlnx/open-water) | `3d1adaa` (fork base, remote `upstream`) | MIT (code); audio see `public/audio/CREDITS.md` | everything in `src/`, `tools/`, `render/` |
| Vite | 8.3.5 | MIT | dev server and build |
| TypeScript | 7.0.2 | Apache-2.0 | `tsc --noEmit` in the gate |
| puppeteer-core | 23.11.1 | Apache-2.0 | upstream `tools/` probes |

Local changes to upstream: `src/audio/audio.js` loads MP3s from `audio/` relative to the page (moved from
`assets/audio/` to `public/audio/` so Vite ships them). Debug PNGs and `.claude/launch.json` removed.

Candidates for the three.js/WebGPU route: [owenyuwono/poseidon](https://github.com/owenyuwono/poseidon) (MIT, three
0.184, TSL compute FFT), [reed-soul/SeedOcean](https://github.com/reed-soul/SeedOcean) (MIT, TS, buoyancy).
