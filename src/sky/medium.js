// The atmosphere's medium for a haze level, split out of the archived WebGL2 atmosphere
// (archive/gl/src/sky/atmosphere.js) for the three.js port (src/three/atmosphere.ts).
const params_mie = Number(new URLSearchParams(globalThis.location?.search || '').get('mie')) || 0;

// Medium of the atmosphere for a haze level.
// haze: multiplier of sea-level aerosol density (marine boundary layer)
export function mediumFor(haze) {
  // maritime aerosol: ~0.025/km at haze 1 (visibility ~100 km, AOD ~0.03); 'haze' scales it
  const mieScat = (params_mie || 0.025) * haze;
  const mieExt = mieScat / 0.9; // sea-salt aerosols are bright: single scattering albedo ~0.9
  const R = [5.802e-3, 13.558e-3, 33.1e-3];
  return {
    // extinction of the sea-level medium relative to its green channel
    extRatio: R.map((r) => (r + mieExt) / (R[1] + mieExt)),
    uniforms: { uRayleigh: R, uMie: [mieScat, mieExt], uMieH: 1.2, uOzone: [0.65e-3, 1.881e-3, 0.085e-3], uMieG: 0.85 },
  };
}
