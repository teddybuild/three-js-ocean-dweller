# Open source we reuse

Every copied or adapted source, its version and license. Hand-written pieces say why nothing fit.

| What | Version | License | Used for |
|---|---|---|---|
| [Leonxlnx/open-water](https://github.com/Leonxlnx/open-water) | `3d1adaa` in upstream (fork base, remote `upstream`; this repo's history was rewritten) | MIT (code); audio see `public/audio/CREDITS.md` | everything in `src/`, `tools/`, `render/` |
| Vite | 8.3.5 | MIT | dev server and build |
| TypeScript | 7.0.2 | Apache-2.0 | `tsc --noEmit` in the gate |
| puppeteer-core | 23.11.1 | Apache-2.0 | upstream `tools/` probes, `tools/diff.mjs` |
| three | 0.186.1 | MIT | WebGPU port (`src/three/`) |
| @types/three | 0.186.0 | MIT | types for the port |
| pixelmatch | 8.0.0 | ISC | mismatch % in `tools/diff.mjs` |
| pngjs | 7.0.0 | MIT | PNG read/write in `tools/diff.mjs` |
| gitleaks | 8.30.1 | MIT | secret and personal-detail scan, in CI and `pnpm check:secrets`. The binary is used directly because `gitleaks-action` has a custom license. |
| Contributor Covenant | 2.1 | CC BY 4.0 | code of conduct, adopted by link |

Local changes to upstream: `src/audio/audio.js` loads MP3s from `audio/` relative to the page (moved from
`assets/audio/` to `public/audio/` so Vite ships them). Debug PNGs and `.claude/launch.json` removed.

Reference only (not copied): [owenyuwono/poseidon](https://github.com/owenyuwono/poseidon) (MIT, three 0.184, TSL
compute FFT; its FFT assumes even log2(N)). Hand-written: `src/boot.ts`, `src/three/`, `tools/diff.mjs` (no tool
diffs two live WebGPU/WebGL pages).
