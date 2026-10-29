# Plan

The design. Change only to record a decision the owner made, with its date. Progress and to-dos go in `status/`.

## Goal

A web successor to an earlier Godot ocean project: cinematic open ocean, later a boat.

## Decisions (owner, 2026-10-29)

- First scope: ocean + sky only, no boat yet.
- Stack: Vite + TypeScript, local only (no hosting).
- Base: fork open-water as-is ("no preference" on the base question; the default was taken). The Godot repo had
  already ported its sky and clouds from it.
- Renderer: WebGPU was picked before open-water turned out to be WebGL2. Open: three.js WebGLRenderer on the shared
  WebGL2 context for the boat, or a WebGPU rebuild (see `status/open/`).
