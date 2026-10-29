// open-water's FFT ocean (src/ocean/ocean.js) as TSL compute: the same 4 cascades, spectrum, evolve, radix-2
// Stockham inverse FFT and assemble. Every field is an f32 storage buffer indexed y * N + x, the GL texel order, so
// tools/fft-diff.mjs compares the two engines buffer for buffer. Each kernel bakes in its cascade, stage and
// direction: a uniform rewritten between dispatches is overwritten before submit (docs/status/lessons.md).
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { cascadesFor, computeStats } from '../ocean/ocean.js';
import { rng } from '../math.js';

type Node = any; // @types/three's TSL overloads reject long node chains, so nodes and TSL functions are untyped
const {
  Fn, instancedArray, instanceIndex, uniform, float, int, vec2, vec4, select, sqrt, pow, exp, tanh, cosh, atan, log,
  abs, cos, sin, clamp, mix, smoothstep, max, min, floor, length,
} = TSL as any;

const PI = Math.PI, G = 9.81, SIGMA_RHO = 7.4e-5;

const omegaOf = (k: Node) => sqrt(k.mul(G).add(k.mul(k).mul(k).mul(SIGMA_RHO)));
const domegadk = (k: Node) => k.mul(k).mul(3 * SIGMA_RHO).add(G).div(omegaOf(k).mul(2));
const cmul = (a: Node, b: Node) => vec2(a.x.mul(b.x).sub(a.y.mul(b.y)), a.x.mul(b.y).add(a.y.mul(b.x)));
const wrapAngle = (a: Node) => a.add(PI).mod(2 * PI).sub(PI);

// Elfouhaily et al. (1997) unified spectrum S(k) (m^3), its peak kp and the ECKV spreading delta
function elfouhaily(k: Node, U: Node, fetch: Node) {
  const ko = float(G).div(U.mul(U)).toVar();
  const Om = clamp(pow(tanh(pow(ko.mul(fetch).div(2.2e4), 0.4)), -0.75).mul(0.84), 0.84, 5.0).toVar();
  const kp = ko.mul(Om).mul(Om).toVar();
  const cp = sqrt(float(G).div(kp)).toVar();
  const km = 370, cm = 0.23;
  const c = sqrt(float(G).div(k).mul(k.div(km).mul(k.div(km)).add(1))).toVar();
  const Lpm = exp(kp.div(k).mul(kp.div(k)).mul(-1.25)).toVar();
  const gamma = select(Om.lessThanEqual(1), float(1.7), log(Om).div(Math.log(10)).mul(6).add(1.7));
  const sigma = float(4).div(Om.mul(Om).mul(Om)).add(1).mul(0.08);
  const r = sqrt(k.div(kp)).sub(1).toVar();
  const Jp = pow(gamma, exp(r.mul(r).negate().div(sigma.mul(sigma).mul(2)))).toVar();
  const Fp = Lpm.mul(Jp).mul(exp(Om.negate().div(Math.sqrt(10)).mul(r)));
  const Bl = pow(Om, 0.55).mul(0.5 * 0.006).mul(cp.div(c)).mul(Fp);
  const ustar = U.mul(0.03795).toVar(); // sqrt(Cd10N = 0.00144) * U10
  // clamped: no capillary-gravity energy below ~2.2 m/s (the fit goes negative there)
  const lu = log(ustar.div(cm));
  const alpham = max(select(ustar.lessThanEqual(cm), lu.add(1).mul(0.01), lu.mul(3).add(1).mul(0.01)), 0);
  const Fm = Lpm.mul(Jp).mul(exp(k.div(km).sub(1).mul(k.div(km).sub(1)).mul(-0.25)));
  const Bh = alpham.mul(0.5).mul(float(cm).div(c)).mul(Fm);
  const delta = tanh(pow(c.div(cp), 2.5).mul(4).add(0.1733).add(ustar.div(cm).mul(0.13).mul(pow(float(cm).div(c), 2.5))));
  return { S: Bl.add(Bh).div(k.mul(k).mul(k)), kp, delta };
}

function donelanBanner(theta: Node, r0: Node) {
  const r = clamp(r0, 0.56, 10.0).toVar();
  const beta = select(r.lessThan(0.95), pow(r, 1.3).mul(2.61),
    select(r.lessThan(1.6), pow(r, -1.3).mul(2.28), pow(float(10), exp(log(r.mul(r)).mul(-0.567)).mul(0.8393).sub(0.4)))).toVar();
  const c = cosh(clamp(beta.mul(theta), -15.0, 15.0)).toVar();
  return beta.div(tanh(beta.mul(PI)).mul(2)).div(c.mul(c));
}

// Bretschneider/JONSWAP-shaped swell with prescribed Hs, gamma = 5 (narrow)
function swellSpectrum(w: Node, Hs: Node, Tp: Node) {
  const wp = float(2 * PI).div(Tp).toVar();
  const sigma = select(w.lessThanEqual(wp), float(0.07), float(0.09));
  const d = w.sub(wp).div(sigma.mul(wp)).toVar();
  const r = exp(d.mul(d).mul(-0.5));
  return Hs.mul(Hs).mul(5 / 16).mul(pow(wp, 4)).div(pow(w, 5)).mul(exp(pow(wp.div(w), 4).mul(-1.25)))
    .mul(1 - 0.287 * Math.log(5)).mul(pow(float(5), r));
}

// normalized cos^{2s}(theta/2)
function cos2s(theta: Node, s: Node) {
  const norm = sqrt(s.add(0.25).add(float(1).div(s.mul(32)))).div(2 * Math.sqrt(PI));
  return norm.mul(pow(abs(cos(theta.mul(0.5))), s.mul(2)));
}

interface SpectrumUniforms { wind: Node; swell: Node; spreadBlend: Node }

// 2D wavenumber spectrum Psi(kx, kz) (m^4) for one cascade's band [kmin, kmax)
function spectrum(k: Node, kmin: number, kmax: number, u: SpectrumUniforms) {
  const kl = length(k).toVar();
  const th = atan(k.y, k.x).toVar();
  const { S: S0, kp, delta } = elfouhaily(kl, max(u.wind.x, 0.5), u.wind.y);
  const S = S0.mul(u.wind.w);
  const tw = wrapAngle(th.sub(u.wind.z)).toVar();
  // ECKV spreading (1 + delta cos 2phi)/2pi made downwind-dominant; narrow Donelan-Banner near the peak
  const eps = 0.06;
  const eckv = delta.mul(cos(tw.mul(2))).add(1).div(2 * PI).mul(select(abs(tw).lessThan(0.5 * PI), float(1), float(eps))).mul(2 / (1 + eps));
  const kk = kl.div(kp).toVar();
  const db = donelanBanner(tw, sqrt(kk));
  const D0 = mix(db, eckv, smoothstep(1.4, 3.5, kk));
  const D = mix(D0, cos2s(tw, float(4)), u.spreadBlend.mul(smoothstep(1.5, 4.0, kk)));
  const swell = swellSpectrum(omegaOf(kl), u.swell.x, u.swell.y).mul(cos2s(wrapAngle(th.sub(u.swell.z)), u.swell.w)).mul(domegadk(kl)).div(kl);
  const Psi = S.div(kl).mul(D).add(select(u.swell.x.greaterThan(0), swell, float(0))).mul(exp(kl.mul(kl).mul(-0.004 * 0.004)));
  return select(kl.lessThan(kmin).or(kl.greaterThanEqual(kmax)).or(kl.lessThan(1e-5)), float(0), Psi);
}

const vec4Buffer = (n: number) => instancedArray(n * n, 'vec4');
const texelXY = (n: number) => ({ x: int(instanceIndex.mod(n)), y: int(instanceIndex.div(n)) });

// One radix-2 Stockham pass of the inverse transform along x (dir 0) or y (dir 1): src -> dst, two vec4 signals
// (four complex values) per texel
function fftStage(n: number, stage: number, dir: 0 | 1, src: Node[], dst: Node[]) {
  return Fn(() => {
    const { x, y } = texelXY(n);
    const i = dir === 0 ? x : y;
    const ns = 1 << stage;
    const r = i.bitAnd(2 * ns - 1).toVar();
    const k = r.bitAnd(ns - 1).toVar();
    const j = i.shiftRight(stage + 1).mul(ns).add(k);
    const a = (dir === 0 ? j.add(y.mul(n)) : x.add(j.mul(n))).toVar();
    const b = a.add(dir === 0 ? n / 2 : (n / 2) * n);
    const ang = float(k).mul(PI / ns);
    const w = vec2(cos(ang), sin(ang)).toVar();
    const top = r.lessThan(ns);
    for (let s = 0; s < 2; s++) {
      const v0 = src[s].element(a).toVar(), v1 = src[s].element(b).toVar();
      const t = vec4(cmul(v1.xy, w), cmul(v1.zw, w)).toVar();
      dst[s].element(instanceIndex).assign(select(top, v0.add(t), v0.sub(t)));
    }
  })().compute(n * n);
}

// bicubic Catmull-Rom of the foam channel (w) at a texel-space position, periodic
function foamCR(buf: Node, n: number, pos: Node) {
  const p = pos.sub(0.5).toVar();
  const ip = floor(p).toVar();
  const f = p.sub(ip).toVar();
  const w = [
    f.mul(f.mul(f.mul(-0.5).add(1)).add(-0.5)),
    f.mul(f).mul(f.mul(1.5).add(-2.5)).add(1),
    f.mul(f.mul(f.mul(-1.5).add(2)).add(0.5)),
    f.mul(f).mul(f.mul(0.5).add(-0.5)),
  ].map((v) => v.toVar());
  const ix = int(ip.x), iy = int(ip.y);
  let r: Node = float(0);
  for (let dy = 0; dy < 4; dy++) {
    const row = iy.add(dy - 1 + n).mod(n).mul(n).toVar();
    for (let dx = 0; dx < 4; dx++) {
      r = r.add(buf.element(row.add(ix.add(dx - 1 + n).mod(n))).w.mul(w[dx].x).mul(w[dy].y));
    }
  }
  return r;
}

export class OceanCompute {
  cascades: any[];
  stats: any = null;
  lambda = 1.0;
  drift = [0, 0]; // m/s
  private paramsKey = '';
  private renderer: THREE.WebGPURenderer;
  private fftBufs = new Map<number, { A: Node[]; B: Node[]; passes: Node[] }>();
  private spectrumNodes: Node[] = [];
  private evolveNodes: Node[] = [];
  private assembleNodes: Node[][] = [];
  private u = {
    wind: uniform(new THREE.Vector4()), swell: uniform(new THREE.Vector4()), spreadBlend: uniform(0),
    time: uniform(0), dt: uniform(0), lambda: uniform(1), decay: uniform(0),
  };

  constructor(renderer: THREE.WebGPURenderer, res: number[]) {
    this.renderer = renderer;
    this.cascades = cascadesFor(res);
    const r = rng(1337); // same seed and draw order as src/ocean/ocean.js
    for (const c of this.cascades) {
      const n = c.N;
      c.noise = vec4Buffer(n);
      const noise = c.noise.value.array as Float32Array;
      for (let j = 0; j < noise.length; j++) noise[j] = r.gauss();
      c.h0 = vec4Buffer(n);
      c.disp = [vec4Buffer(n), vec4Buffer(n)];
      c.slope = [vec4Buffer(n), vec4Buffer(n)];
      c.active = [instancedArray(n * n, 'float'), instancedArray(n * n, 'float')];
      c.cur = 0;
      c.uThreshold = uniform(0);
      c.uGain = uniform(0);
      c.uDrift = uniform(new THREE.Vector2());
      const F = this.fft(n);
      this.spectrumNodes.push(this.spectrumKernel(c));
      this.evolveNodes.push(this.evolveKernel(c, F.A));
      this.assembleNodes.push([0, 1].map((cur) => this.assembleKernel(c, F.A, cur)));
    }
  }

  // shared ping-pong buffers and the 2 log2(n) passes per size; the pass count is even, so the result lands in A
  fft(n: number) {
    let F = this.fftBufs.get(n);
    if (!F) {
      const A = [vec4Buffer(n), vec4Buffer(n)], B = [vec4Buffer(n), vec4Buffer(n)];
      const passes: Node[] = [];
      let src = A, dst = B;
      for (const dir of [0, 1] as const) {
        for (let s = 0; s < Math.log2(n); s++) { passes.push(fftStage(n, s, dir, src, dst)); [src, dst] = [dst, src]; }
      }
      this.fftBufs.set(n, (F = { A, B, passes }));
    }
    return F;
  }

  private spectrumKernel(c: any) {
    const n = c.N, dk = (2 * PI) / c.L;
    return Fn(() => {
      const { x, y } = texelXY(n);
      const k = vec2(float(x).sub(n / 2), float(y).sub(n / 2)).mul(dk).toVar();
      const mid = int(n).sub(x).mod(n).add(int(n).sub(y).mod(n).mul(n));
      const xi = c.noise.element(instanceIndex).xy;
      const xm = c.noise.element(mid).xy;
      // E|h0|^2 = S(k) dk^2 / 2 so that the real field variance equals the spectrum integral
      const a0 = sqrt(max(spectrum(k, c.kmin, c.kmax, this.u), 0).mul(dk * dk * 0.25));
      const am = sqrt(max(spectrum(k.negate(), c.kmin, c.kmax, this.u), 0).mul(dk * dk * 0.25));
      const hm = xm.mul(am).toVar();
      // unpaired Nyquist modes stay zero: h0(k), conj(h0(-k))
      c.h0.element(instanceIndex).assign(select(x.equal(0).or(y.equal(0)), vec4(0), vec4(xi.mul(a0), hm.x, hm.y.negate())));
    })().compute(n * n);
  }

  private evolveKernel(c: any, A: Node[]) {
    const n = c.N, dk = (2 * PI) / c.L, W0 = (2 * PI) / 1000;
    return Fn(() => {
      const { x, y } = texelXY(n);
      const k = vec2(float(x).sub(n / 2), float(y).sub(n / 2)).mul(dk).toVar();
      const kl = max(length(k), 1e-6).toVar();
      const h0 = c.h0.element(instanceIndex).toVar();
      // dispersion quantised to a 1000 s repeat period (Tessendorf) keeps the fp32 phase small
      const ph = floor(omegaOf(kl).div(W0)).mul(W0).mul(this.u.time).toVar();
      // exp(-i w t) with field exp(+i k.x): energy at k travels towards +k (downwind)
      const e = vec2(cos(ph), sin(ph).negate()).toVar();
      const h = cmul(h0.xy, e).add(cmul(h0.zw, vec2(e.x, e.y.negate()))).toVar();
      const ih = vec2(h.y.negate(), h.x).toVar();
      const Dx = ih.mul(k.x.div(kl)), Dz = ih.mul(k.y.div(kl)), Dy = h;
      const Dyx = ih.mul(k.x), Dyz = ih.mul(k.y);
      const Dxx = h.negate().mul(k.x.mul(k.x).div(kl)), Dzz = h.negate().mul(k.y.mul(k.y).div(kl));
      const Dxz = h.negate().mul(k.x.mul(k.y).div(kl));
      // pack two real fields into one complex signal: A + iB
      A[0].element(instanceIndex).assign(vec4(Dx.x.sub(Dz.y), Dx.y.add(Dz.x), Dy.x.sub(Dxz.y), Dy.y.add(Dxz.x)));
      A[1].element(instanceIndex).assign(vec4(Dyx.x.sub(Dyz.y), Dyx.y.add(Dyz.x), Dxx.x.sub(Dzz.y), Dxx.y.add(Dzz.x)));
    })().compute(n * n);
  }

  // reads history cur, writes 1 - cur
  private assembleKernel(c: any, F: Node[], cur: number) {
    const n = c.N, next = 1 - cur, u = this.u;
    return Fn(() => {
      const { x, y } = texelXY(n);
      const sgn = select(x.add(y).bitAnd(1).equal(1), float(-1), float(1));
      const a = F[0].element(instanceIndex).mul(sgn).toVar();
      const b = F[1].element(instanceIndex).mul(sgn).toVar();
      const L = u.lambda;
      const jx = L.mul(b.z).add(1).toVar(), jz = L.mul(b.w).add(1).toVar();
      const J = jx.mul(jz).sub(L.mul(L).mul(a.w).mul(a.w));
      const s = vec2(b.x.div(max(jx, 0.25)), b.y.div(max(jz, 0.25))).toVar();
      // residual foam drifts downwind with the surface; Catmull-Rom resampling keeps streaks crisp
      const pos = vec2(float(x), float(y)).add(0.5).sub(c.uDrift.mul(u.dt).mul(n));
      const prev = max(foamCR(c.disp[cur], n, pos), 0);
      const gen = max(c.uThreshold.sub(J), 0).mul(c.uGain).mul(u.dt).toVar();
      const foam = min(prev.mul(exp(u.decay.negate().mul(u.dt))).add(gen), 3.0);
      // active breaking: the same generation, but it lives only while the crest is spilling (~0.4 s)
      const act = c.active[cur].element(instanceIndex).mul(exp(u.dt.mul(-2.5))).add(gen.mul(2.5));
      c.active[next].element(instanceIndex).assign(min(act, 2.0));
      c.disp[next].element(instanceIndex).assign(vec4(a.x.mul(L), a.z, a.y.mul(L), foam));
      c.slope[next].element(instanceIndex).assign(vec4(s, s.mul(s)));
    })().compute(n * n);
  }

  // params: { wind, fetch, dir, scale, swellHs, swellT, swellDir, swellSpread, spreadBlend, choppy }
  setSpectrum(p: any) {
    const key = JSON.stringify(p);
    if (key === this.paramsKey) return;
    this.paramsKey = key;
    this.u.wind.value.set(p.wind, p.fetch, p.dir, p.scale);
    this.u.swell.value.set(p.swellHs, p.swellT, p.swellDir, p.swellSpread);
    this.u.spreadBlend.value = p.spreadBlend ?? 0;
    this.renderer.compute(this.spectrumNodes);
    this.stats = computeStats(p, this.cascades);
  }

  // every uniform is set before the first dispatch, so no dispatch sees a later value
  update(time: number, dt: number, foam: number[]) {
    this.u.time.value = ((time % 1000) + 1000) % 1000;
    this.u.dt.value = dt;
    this.u.lambda.value = this.lambda;
    this.u.decay.value = foam[2];
    const nodes: Node[] = [];
    this.cascades.forEach((c, ci) => {
      // breaking criterion: J below 1 - z * sigma_J, sigma_J ~ lambda * sqrt(mss of the band)
      const sigmaJ = this.lambda * Math.sqrt(Math.max(this.stats.bandMss[ci], 1e-8));
      c.uThreshold.value = 1 - foam[0] * sigmaJ;
      c.uGain.value = foam[1] / Math.max(sigmaJ, 0.02);
      c.uDrift.value.set(this.drift[0] / c.L, this.drift[1] / c.L);
      nodes.push(this.evolveNodes[ci], ...this.fft(c.N).passes, this.assembleNodes[ci][c.cur]);
      c.cur = 1 - c.cur;
    });
    this.renderer.compute(nodes);
  }

  // current fields of cascade ci, as storage nodes
  fields(ci: number) {
    const c = this.cascades[ci];
    return { h0: c.h0, disp: c.disp[c.cur], slope: c.slope[c.cur], active: c.active[c.cur] };
  }

  async read(node: Node) {
    return new Float32Array(await this.renderer.getArrayBufferAsync(node.value));
  }

  // test hook: the bare 2D inverse FFT of two vec4 signals of size n (tools/fft-diff.mjs)
  async fftOnly(n: number, d0: Float32Array, d1: Float32Array) {
    const F = this.fft(n);
    F.A[0].value.array.set(d0); F.A[0].value.needsUpdate = true;
    F.A[1].value.array.set(d1); F.A[1].value.needsUpdate = true;
    this.renderer.compute(F.passes);
    return [await this.read(F.A[0]), await this.read(F.A[1])];
  }
}
