# three.js for the boat

Decide the route, then prove it with one cube that intersects the waves.

- Since the WebGPU port (2026-10-29) the scene is already three.js: a boat is a mesh in the scene of
  `src/three/main.ts`, drawn into the HDR target before post, floated with `src/three/probe.ts`. The old routes
  (a three.js layer on open-water's WebGL2 context, or a rebuild on owenyuwono/poseidon) are moot; GL is in
  `archive/gl/`.

Done when: a cube rides the swell and the water hides its lower half.
