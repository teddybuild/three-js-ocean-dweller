# Architecture Decision Records

Use ADRs for expensive or hard-to-reverse technical and design choices. Tuning numbers, wording and bug fixes stay in
`docs/PLAN.md`, `docs/systems/` and `docs/log/`.

## Writing a new one

- Next free number, file `NNNN-short-slug.md`, title `# ADR NNNN: <Title>`. Start from `TEMPLATE.md`.
- Never rewrite an accepted ADR's decision. A reversal is a new ADR; mark the old one
  "Superseded on <date> by ADR NNNN" and link both ways.

## Index

| ADR | Date | Decision | Status |
|-----|------|----------|--------|
| [0001](0001-three-webgpu-port.md) | 2026-10-29 | Port to three.js WebGPU, side by side | Accepted |
