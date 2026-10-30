# Cloud towers (congestus)

Owner, 2026-10-29: "10% of random clouds need to have random tallness towers", "or groupings need similar
tallness", "they need to be puffier lol". References: two Pexels photos (pexels-lu62-13399746.jpg,
pexels-paul-voie-14084753.jpg): piles of rounded bubbles at several sizes, broad bases, shadowed crevices.

- Tries and why they failed: `docs/log/2026-10-29-three-port.md` "Cloud towers". Codex + agy advice:
  `tmp/tower/codex.md`, `tmp/tower/agy.md` (local only; summary in the log).
- WIP: LOCAL branch `towers-wip` (`98c5f47`): weather map alpha = tower footprint, shell top + 3 km, tower coverage
  from rescaled inverted-Worley bubbles biased by the 2D envelope, sky-light `max(1 - hf, 0)` fix. GL only is
  current; `src/three/clouds.ts` there is an older column version (out of parity). Last GL shots: bubbles but
  frayed, floating fragments above the towers (`tmp/tower/sheet.png`).
- Plan: Owner draws towers in http://localhost:5173/tools/cloud-sketch.html (or traces the photos) and saves JSON to
  `cloud-sketch-*.json`. Fit from it: width vs height profile -> footprint radius vs height, puff radius
  median -> bubble noise scale, aspect -> tower height. Then port to three, `cloud-diff`, diff all 11.
- Done: towers on ~10% of clouds in breeze, puffy (rounded lobes with shading), grouped heights, both engines,
  diff scenes pass.
