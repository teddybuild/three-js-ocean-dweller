// The ocean's cascades and the CPU side of its spectrum (Hs, slope variance per band), split out of the archived
// WebGL2 ocean (archive/gl/src/ocean/ocean.js) for the three.js port (src/three/ocean.ts).
export const CASCADES = [
  { L: 1800, },
  { L: 117, },
  { L: 21, },
  { L: 3.7, },
];

const G = 9.81;
const SIGMA_RHO = 7.4e-5; // surface tension / density (m^3/s^2): capillary term of the dispersion

// Cascades with FFT size N, band limits and texel size.
export function cascadesFor(res) {
  const cascades = CASCADES.map((c, i) => ({ ...c, N: res[i] }));
  const dk = (L) => (2 * Math.PI) / L;
  // band limits: cascade i covers [6*dk_i, 6*dk_{i+1})
  for (let i = 0; i < cascades.length; i++) {
    const c = cascades[i];
    c.kmin = i === 0 ? dk(c.L) * 0.5 : 6 * dk(c.L);
    c.kmax = i === cascades.length - 1 ? 1e9 : 6 * dk(cascades[i + 1].L);
    c.texel = c.L / c.N;
  }
  return cascades;
}

function elfouhailyCPU(k, U, fetch) {
  const ko = G / (U * U);
  const Om = Math.min(Math.max(0.84 * Math.pow(Math.tanh(Math.pow((ko * fetch) / 2.2e4, 0.4)), -0.75), 0.84), 5);
  const kp = ko * Om * Om, cp = Math.sqrt(G / kp), km = 370, cm = 0.23;
  const c = Math.sqrt((G / k) * (1 + (k / km) ** 2));
  const Lpm = Math.exp(-1.25 * (kp / k) ** 2);
  const gamma = Om <= 1 ? 1.7 : 1.7 + 6 * Math.log10(Om);
  const sigma = 0.08 * (1 + 4 / Om ** 3);
  const r = Math.sqrt(k / kp) - 1;
  const Jp = Math.pow(gamma, Math.exp((-r * r) / (2 * sigma * sigma)));
  const Bl = 0.5 * 0.006 * Math.pow(Om, 0.55) * (cp / c) * Lpm * Jp * Math.exp((-Om / Math.sqrt(10)) * r);
  const ustar = 0.03795 * U;
  const am = Math.max(ustar <= cm ? 0.01 * (1 + Math.log(ustar / cm)) : 0.01 * (1 + 3 * Math.log(ustar / cm)), 0);
  const Bh = 0.5 * am * (cm / c) * Lpm * Jp * Math.exp(-0.25 * (k / km - 1) ** 2);
  return { S: (Bl + Bh) / k ** 3, kp };
}
function swellCPU(w, Hs, Tp) {
  if (Hs <= 0) return 0;
  const wp = (2 * Math.PI) / Tp, gamma = 5;
  const sigma = w <= wp ? 0.07 : 0.09;
  const d = (w - wp) / (sigma * wp);
  return (5 / 16) * Hs * Hs * Math.pow(wp, 4) / Math.pow(w, 5) * Math.exp(-1.25 * Math.pow(wp / w, 4)) *
    (1 - 0.287 * Math.log(gamma)) * Math.pow(gamma, Math.exp(-0.5 * d * d));
}
export function computeStats(p, cascades) {
  const U = Math.max(p.wind, 0.3);
  const kminAll = cascades[0].kmin;
  const last = cascades[cascades.length - 1];
  const kmaxAll = (Math.PI * last.N) / last.L;
  let m0 = 0, mss = 0;
  const band = cascades.map(() => 0);
  const steps = 4000;
  const lk0 = Math.log(kminAll), lk1 = Math.log(kmaxAll);
  for (let i = 0; i < steps; i++) {
    const lk = lk0 + ((i + 0.5) / steps) * (lk1 - lk0);
    const k = Math.exp(lk);
    const dkk = k * ((lk1 - lk0) / steps);
    const w = Math.sqrt(G * k + SIGMA_RHO * k * k * k);
    const dwdk = (G + 3 * SIGMA_RHO * k * k) / (2 * w);
    const S = elfouhailyCPU(k, U, p.fetch).S * p.scale + swellCPU(w, p.swellHs, p.swellT) * dwdk;
    const Sk = S * Math.exp(-k * k * 0.004 * 0.004);
    m0 += Sk * dkk;
    mss += k * k * Sk * dkk;
    for (let c = 0; c < cascades.length; c++) if (k >= cascades[c].kmin && k < cascades[c].kmax) band[c] += k * k * Sk * dkk;
  }
  const coxMunk = 0.003 + 0.00512 * U;
  return { hs: 4 * Math.sqrt(m0), resolvedMss: mss, coxMunk, unresolved: Math.max(coxMunk - mss, 0.002), bandMss: band };
}
