# Contributing

Bug reports, fixes and new effects are welcome. Open an issue before large work, so the design can be agreed first.

## Setup

```bash
git clone https://github.com/teddybuild/three-js-ocean-dweller.git
cd three-js-ocean-dweller
pnpm install
pnpm dev
```

## Before you open a pull request

1. Run `pnpm check`. CI runs the same gate and blocks the merge if it fails.
2. For a visual change, compare frames. Run these with `pnpm dev` running:
   ```bash
   git stash
   node tools/diff.mjs all --update
   git stash pop
   node tools/diff.mjs all
   ```
   The sheets land in `tmp/diff/<scene>.png`, with the reference on the left. Attach the relevant ones to the pull request.
3. Run `node tools/live-three.mjs` if you touched the render loop, interface or audio.
4. Run `pnpm check:secrets` if you have [gitleaks](https://github.com/gitleaks/gitleaks) installed. CI runs it too.

The headless tools need Chrome and a hardware WebGPU adapter, so CI cannot run them. Say in the pull request which ones
you ran.

## Project rules

- New rendering work goes in `src/three/`. WebGPU is the only target, so please do not add a WebGL fallback.
- `archive/gl/` is reference only. Do not edit it or import from it.
- Every file has one home. See the table in [AGENTS.md](AGENTS.md), and add a row to it and to `docs-layout.json` for a new location.
- Check [docs/OSS.md](docs/OSS.md) before writing something new. Add a row there for anything you reuse, with its version and license.
- Update the system's spec in `docs/systems/` when you change how it works. Add a line to `docs/status/CHANGELOG.md`.
- Read `docs/status/lessons.md` before writing TSL. It lists WebGPU and three.js traps that look like correct code.

## Public repo hygiene

Everything committed here is public, including history. Do not commit personal email addresses, real names, private
hostnames or IPs, absolute home paths, tokens or API keys. Use a
[GitHub noreply email](https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-email-preferences/setting-your-commit-email-address)
for your commits. `.gitleaks.toml` holds the rules CI enforces.

## License

Contributions are licensed under the [MIT License](LICENSE). Recorded audio must carry an open license and a row in
[public/audio/CREDITS.md](public/audio/CREDITS.md).
