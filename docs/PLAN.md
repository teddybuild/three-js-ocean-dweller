# Plan

The design. Change only to record a decision the owner made, with its date. Progress and to-dos go in `status/`.

## Goal

A web successor to an earlier Godot ocean project: cinematic open ocean, later a boat.

## Decisions (owner, 2026-10-29)

- First scope: ocean + sky only, no boat yet.
- Stack: Vite + TypeScript, local only (no hosting).
- Base: fork open-water as-is ("no preference" on the base question; the default was taken). The Godot repo had
  already ported its sky and clouds from it.
- Renderer: full port to three.js WebGPU, side by side, "same feel, freedom to change" (`adr/0001-three-webgpu-port.md`).
