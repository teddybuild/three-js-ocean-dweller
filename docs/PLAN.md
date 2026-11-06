# Plan

The design. Change only to record a maintainer decision, with its date. Progress and to-dos go in `status/`.

## Goal

A web successor to an earlier Godot ocean project: cinematic open ocean, later a boat.

## Decisions (2026-10-29)

- First scope: ocean + sky only, no boat yet.
- Stack: Vite + TypeScript, local only (no hosting).
- Base: fork open-water as-is. The earlier Godot project had already ported its sky and clouds from it.
- Renderer: full port to three.js WebGPU, side by side, same feel with freedom to change (`adr/0001-three-webgpu-port.md`).
