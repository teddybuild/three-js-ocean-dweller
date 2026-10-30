// open-water's atmosphere (src/sky/atmosphere.js, after Hillaire 2020) as TSL compute: transmittance,
// multiple-scattering, sky-view and sea-level aerial-perspective LUTs, written texel by texel into half-float storage
// textures (row y is v = (y + 0.5) / h, as in GL), plus the lookups the sky, water and clouds sample them with.
// Units: kilometres; radiance relative to a solar illuminance of 1.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { mediumFor } from '../sky/medium.js';

type Node = any; // @types/three's TSL overloads reject long node chains, so nodes and TSL functions are untyped
const {
  Fn, Loop, If, uniform, float, int, vec2, vec3, vec4, uvec2, select, sqrt, pow, exp, log, abs, cos, sin, acos, asin, atan,
  clamp, mix, smoothstep, max, min, length, normalize, dot, cross, sign, textureStore, texture, instanceIndex, floor, fract,
} = TSL as any;

const PI = Math.PI, Rg = 6360.0, Rt = 6460.0, H = Math.sqrt(Rt * Rt - Rg * Rg);

// shared medium uniforms (set once per haze change, before any dispatch that reads them)
export const atmoU = {
  rayleigh: uniform(new THREE.Vector3()), mie: uniform(new THREE.Vector2()), mieH: uniform(1.2), ozone: uniform(new THREE.Vector3()),
  sun: uniform(new THREE.Vector3(0, 1, 0)), camH: uniform(0.001), maxDist: uniform(60), extRatio: uniform(new THREE.Vector3(1, 1, 1)),
  // consumers: fraction of direct sun below the clouds, light-source scale and magnitude
  hazeSun: uniform(1), lightScale: uniform(1), lightMag: uniform(-26.74),
};

function medium(h0: Node) {
  const h = max(h0, 0).toVar();
  const dR = exp(h.div(-8.0)), dM = exp(h.negate().div(atmoU.mieH)).toVar();
  const dO = max(0, abs(h.sub(25)).div(15).oneMinus());
  const scatR = atmoU.rayleigh.mul(dR).toVar();
  const scatM = atmoU.mie.x.mul(dM).toVar();
  return { scatR, scatM, ext: scatR.add(vec3(atmoU.mie.y.mul(dM))).add(atmoU.ozone.mul(dO)).toVar() };
}

// distance to the origin-centred sphere of radius R along ro + t rd, -1 if none
function raySphere(ro: Node, rd: Node, R: number) {
  const b = dot(ro, rd).toVar();
  const d = b.mul(b).sub(dot(ro, ro).sub(R * R)).toVar();
  const s = sqrt(max(d, 0)).toVar();
  const t0 = b.negate().sub(s), t1 = b.negate().add(s);
  return select(d.lessThan(0), float(-1), select(t0.greaterThan(0), t0, select(t1.greaterThan(0), t1, float(-1))));
}

const rayleighPhase = (c: Node) => c.mul(c).add(1).mul(3 / (16 * PI));
const hgPhase = (c: Node, g: number) => float((1 - g * g) / (4 * PI)).div(pow(max(c.mul(-2 * g).add(1 + g * g), 1e-4), 1.5));
// maritime aerosol: a sharp forward lobe (a compact aureole) and a little backscatter
const miePhase = (c: Node) => hgPhase(c, 0.95).mul(0.45).add(hgPhase(c, 0.65).mul(0.47)).add(hgPhase(c, -0.3).mul(0.08));

function transmittanceUv(r: Node, mu: Node) {
  const rho = sqrt(max(0, r.mul(r).sub(Rg * Rg))).toVar();
  const disc = r.mul(r).mul(mu.mul(mu).sub(1)).add(Rt * Rt);
  const d = max(0, r.negate().mul(mu).add(sqrt(max(disc, 0))));
  const dmin = float(Rt).sub(r), dmax = rho.add(H);
  return vec2(d.sub(dmin).div(dmax.sub(dmin)), rho.div(H));
}

const lutTexture = (w: number, h: number) => {
  const t = new THREE.StorageTexture(w, h);
  t.type = THREE.HalfFloatType;
  return t;
};
const sizeOf = (t: THREE.Texture) => t.image as { width: number; height: number };

// texel of a w x h compute dispatch and its GL-style uv
function texel(w: number, h: number) {
  const x = instanceIndex.mod(w), y = instanceIndex.div(w);
  return { at: uvec2(x, y), uv: vec2(float(x).add(0.5).div(w), float(y).add(0.5).div(h)).toVar() };
}

export class AtmosphereCompute {
  transmittance = lutTexture(256, 64);
  multiScatter = lutTexture(32, 32);
  skyView = lutTexture(256, 128);
  aerialL = lutTexture(64, 64);
  private key = '';
  private renderer: THREE.WebGPURenderer;
  private nodes: Record<string, Node>;

  constructor(renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
    this.nodes = { trans: this.transKernel(), ms: this.msKernel(), sky: this.skyKernel(), aerial: this.aerialKernel() };
  }

  sunTransmittance(p: Node, sun: Node) {
    const r = length(p).toVar();
    const mu = dot(p.div(r), sun).toVar();
    // below the horizon of the planet: no direct sun
    const sinH = float(Rg).div(r);
    const cosH = sqrt(max(0, sinH.mul(sinH).oneMinus())).negate().toVar();
    return texture(this.transmittance, transmittanceUv(r, mu)).level(0).rgb.mul(smoothstep(cosH.sub(0.01), cosH.add(0.01), mu));
  }

  private transKernel() {
    const tex = this.transmittance;
    return Fn(() => {
      const { at, uv } = texel(sizeOf(tex).width, sizeOf(tex).height);
      const rho = uv.y.mul(H).toVar();
      const r = sqrt(rho.mul(rho).add(Rg * Rg)).toVar();
      const dmin = float(Rt).sub(r), dmax = rho.add(H);
      const d = dmin.add(uv.x.mul(dmax.sub(dmin))).toVar();
      const mu = select(d.equal(0), float(1), clamp(float(H * H).sub(rho.mul(rho)).sub(d.mul(d)).div(r.mul(d).mul(2)), -1, 1)).toVar();
      const ro = vec3(0, r, 0), rd = vec3(sqrt(mu.mul(mu).oneMinus()), mu, 0).toVar();
      const STEPS = 48;
      const dt = raySphere(ro, rd, Rt).div(STEPS).toVar();
      const tau = vec3(0).toVar();
      Loop(STEPS, ({ i }: Node) => {
        const p = ro.add(rd.mul(float(i).add(0.5).mul(dt)));
        tau.addAssign(medium(length(p).sub(Rg)).ext.mul(dt));
      });
      textureStore(tex, at, vec4(exp(tau.negate()), 1));
    })().compute(sizeOf(tex).width * sizeOf(tex).height);
  }

  private msKernel() {
    const tex = this.multiScatter;
    return Fn(() => {
      const { at, uv } = texel(32, 32);
      const muS = uv.x.mul(2).sub(1).toVar();
      const ro = vec3(0, uv.y.mul(Rt - Rg).add(Rg + 0.01), 0).toVar();
      const sun = vec3(sqrt(max(0, muS.mul(muS).oneMinus())), muS, 0).toVar();
      const SQ = 8, STEPS = 20;
      const L2 = vec3(0).toVar(), fms = vec3(0).toVar();
      Loop(SQ, SQ, ({ i, j }: Node) => {
        const th = float(i).add(0.5).mul(PI / SQ);
        const ph = acos(float(j).add(0.5).mul(-2 / SQ).add(1)).toVar();
        const rd = vec3(cos(th).mul(sin(ph)), cos(ph), sin(th).mul(sin(ph))).toVar();
        const tG = raySphere(ro, rd, Rg).toVar();
        const tmax = select(tG.greaterThan(0), tG, raySphere(ro, rd, Rt));
        const dt = tmax.div(STEPS).toVar();
        const T = vec3(1).toVar(), L = vec3(0).toVar(), F = vec3(0).toVar();
        Loop(STEPS, ({ i: s }: Node) => {
          const p = ro.add(rd.mul(float(s).add(0.5).mul(dt))).toVar();
          const m = medium(length(p).sub(Rg));
          const scat = m.scatR.add(m.scatM).toVar();
          const S = scat.mul(this.sunTransmittance(p, sun)).div(4 * PI).toVar();
          const ext = max(m.ext, vec3(1e-7)).toVar();
          const sd = exp(ext.negate().mul(dt)).toVar();
          L.addAssign(T.mul(S.sub(S.mul(sd))).div(ext));
          F.addAssign(T.mul(scat.sub(scat.mul(sd))).div(ext));
          T.mulAssign(sd);
        });
        If(tG.greaterThan(0), () => {
          const p = ro.add(rd.mul(tG)).toVar();
          L.addAssign(T.mul(this.sunTransmittance(p, sun)).mul(max(dot(normalize(p), sun), 0)).mul(0.06 / PI));
        });
        L2.addAssign(L);
        fms.addAssign(F);
      });
      textureStore(tex, at, vec4(L2.div(SQ * SQ).div(fms.div(SQ * SQ).oneMinus()), 1));
    })().compute(32 * 32);
  }

  // in-scattered radiance and transmittance along ro + rd [0, tmax], quadratic steps (dense near the camera)
  private integrate(ro: Node, rd: Node, tmax: Node, steps: number) {
    const sun = atmoU.sun;
    const c = dot(rd, sun).toVar();
    const pR = rayleighPhase(c).toVar(), pM = miePhase(c).toVar();
    const L = vec3(0).toVar(), T = vec3(1).toVar(), prev = float(0).toVar();
    Loop(steps, ({ i }: Node) => {
      const t = tmax.mul(pow(float(i).add(0.5).div(steps), 2));
      const tn = tmax.mul(pow(float(i).add(1).div(steps), 2)).toVar();
      const dt = tn.sub(prev).toVar();
      prev.assign(tn);
      const p = ro.add(rd.mul(t)).toVar();
      const h = length(p).sub(Rg).toVar();
      const m = medium(h);
      const ms = texture(this.multiScatter, vec2(dot(normalize(p), sun).mul(0.5).add(0.5), clamp(h.div(Rt - Rg), 0, 1))).level(0).rgb;
      const S = m.scatR.mul(pR).add(m.scatM.mul(pM)).mul(this.sunTransmittance(p, sun)).add(m.scatR.add(m.scatM).mul(ms)).toVar();
      const ext = max(m.ext, vec3(1e-7)).toVar();
      const sd = exp(ext.negate().mul(dt)).toVar();
      L.addAssign(T.mul(S.sub(S.mul(sd))).div(ext));
      T.mulAssign(sd);
    });
    return { L, T };
  }

  // horizontal basis with x towards the sun's azimuth
  private sunBasis() {
    const sunH = normalize(vec3(atmoU.sun.x, 0, atmoU.sun.z).add(vec3(1e-6, 0, 0))).toVar();
    return { sunH, sunR: normalize(cross(vec3(0, 1, 0), sunH)).toVar() };
  }

  private skyKernel() {
    const tex = this.skyView;
    return Fn(() => {
      const { at, uv } = texel(256, 128);
      // x = azimuth relative to the sun (0..pi), y = elevation (non-linear, dense at the horizon)
      const az = uv.x.mul(PI).toVar();
      const v = uv.y.mul(2).sub(1).toVar();
      const el = sign(v).mul(v).mul(v).mul(PI / 2).toVar();
      const { sunH, sunR } = this.sunBasis();
      const rd = sunH.mul(cos(az)).add(sunR.mul(sin(az))).mul(cos(el)).add(vec3(0, sin(el), 0)).toVar();
      const ro = vec3(0, max(atmoU.camH, 0.001).add(Rg), 0).toVar();
      const tG = raySphere(ro, rd, Rg).toVar();
      const { L } = this.integrate(ro, rd, select(tG.greaterThan(0), tG, raySphere(ro, rd, Rt)), 40);
      textureStore(tex, at, vec4(L, 1));
    })().compute(256 * 128);
  }

  private aerialKernel() {
    const tex = this.aerialL;
    return Fn(() => {
      const { at, uv } = texel(64, 64);
      // x = azimuth relative to the sun (0..pi), y = sqrt(distance / max)
      const az = uv.x.mul(PI).toVar();
      const d = atmoU.maxDist.mul(uv.y).mul(uv.y).toVar();
      const { sunH, sunR } = this.sunBasis();
      const hdir = sunH.mul(cos(az)).add(sunR.mul(sin(az)));
      const ro = vec3(0, max(atmoU.camH, 0.001).add(Rg), 0).toVar();
      const ang = d.div(Rg).toVar();
      const seg = vec3(0, cos(ang), 0).add(hdir.mul(sin(ang))).mul(Rg).sub(ro).toVar();
      const len = max(length(seg), 1e-5).toVar();
      const { L, T } = this.integrate(ro, seg.div(len), len, 24);
      // a: optical depth in green; the other channels follow from the medium's spectral ratio (uExtRatio)
      const out = vec4(L, log(max(T.y, 1e-4)).negate());
      textureStore(tex, at, select(length(seg).lessThan(1e-5), vec4(0), out));
    })().compute(64 * 64);
  }

  // same inputs as Atmosphere.update: sun direction, camera height (m), haze
  update(sun: number[], camHeightM: number, haze: number) {
    const m = mediumFor(haze);
    const u = m.uniforms;
    atmoU.rayleigh.value.fromArray(u.uRayleigh);
    atmoU.mie.value.fromArray(u.uMie);
    atmoU.mieH.value = u.uMieH;
    atmoU.ozone.value.fromArray(u.uOzone);
    atmoU.extRatio.value.fromArray(m.extRatio);
    atmoU.sun.value.fromArray(sun);
    atmoU.camH.value = camHeightM / 1000;
    const key = haze.toFixed(4);
    const nodes = key !== this.key ? [this.nodes.trans, this.nodes.ms] : [];
    this.key = key;
    this.renderer.compute([...nodes, this.nodes.sky, this.nodes.aerial]);
  }
}
