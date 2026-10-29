# three.js for the boat

Decide the route, then prove it with one cube that intersects the waves.

- Route A (smallest): `new THREE.WebGLRenderer({ canvas, context: gl })` on open-water's context. Draw into its HDR
  target with its depth before the post resolve, `autoClear = false`, `renderer.resetState()` after, matching camera
  matrices from `src/main.js`. Float with `src/ocean/probe.js`.
- Route B: WebGPU rebuild on owenyuwono/poseidon, porting open-water's sky and clouds to TSL. Days of work.

Done when: a cube rides the swell and the water hides its lower half.
