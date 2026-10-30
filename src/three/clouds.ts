// open-water's volumetric clouds (archive/gl/src/sky/clouds.js) in TSL: the tileable Perlin-Worley shape and Worley detail
// volumes and the weather map (compute kernels; the 3D mips are box-filtered level by level, since three only
// generates 2D mips), the Nubis-style raymarch (CLOUD_GLSL), the cloud-shadow map, the reflection-probe clouds and
// the screen pass with temporal reprojection. Every pass is a compute kernel writing texel (x, y) of GL's target at
// vUv = ((x + 0.5) / w, (y + 0.5) / h), v up, so all lookups keep GL's orientation. The screen pass rebuilds rays from
// the camera basis instead of GL's inverse view-projection (three's NDC differs), and reprojects with the previous
// basis the same way.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { atmoU } from './atmosphere';
import type { SkyCompute } from './sky';
import { anyNonFinite, isNonFinite } from './tsl-util';

type Node = any; // @types/three's TSL overloads reject long node chains, so nodes and TSL functions are untyped
const {
  Fn, Loop, If, Break, Continue, uniform, float, int, vec2, vec3, vec4, uvec2, uvec3, ivec3, select, sqrt, pow, exp,
  exp2, log2, abs, sin, cos, clamp, mix, smoothstep, step, max, min, length, normalize, dot, textureStore, texture,
  texture3D, instanceIndex, floor, fract,
} = TSL as any;

const PI = 3.14159265;
const RG_M = 6360000.0;
const SCUD_BASE = 260.0;
// Fair-weather towers (congestus), fitted to the owner's sketch (2026-10-29): 3.6 km tall on a 2.2 km base. The width
// holds the base's over the lowest 15%, narrows to 0.47 of it by 45% and domes over the top 12%; ~250 m puffs.
// One candidate per TOWER_CELL square, kept where its centre stands in cloud; none under a storm deck.
const TOWER_M = 2000.0; // the tallest top above the plain cumulus top (m)
const TOWER_CELL = 5000.0;
const TOWER_R = 1100.0; // base half-width (m)
const TOWER_P = 0.6; // share of candidate cells that grow one

// ---- NOISE_COMMON

function hash33(p0: Node) {
  const p3 = fract(p0.mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yxz.add(33.33)));
  return fract(p3.xxy.add(p3.yxx).mul(p3.zyx));
}
function worley(uv: Node, freq: number) {
  const id = floor(uv.mul(freq)).toVar(), p = fract(uv.mul(freq)).toVar();
  const md = float(1e4).toVar();
  Loop(3, 3, 3, ({ i, j, k }: Node) => {
    const o = vec3(float(i).sub(1), float(j).sub(1), float(k).sub(1)).toVar();
    const d = p.sub(hash33(id.add(o).mod(vec3(freq))).add(o));
    md.assign(min(md, dot(d, d)));
  });
  return md.oneMinus();
}
const grad3 = (p: Node) => normalize(hash33(p).mul(2).sub(1));
function gnoise(x: Node, freq: number) {
  const p = floor(x).toVar(), w = fract(x).toVar();
  const u = w.mul(w).mul(w).mul(w.mul(w.mul(6).sub(15)).add(10)).toVar();
  const v = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
    const o = vec3(i & 1, (i >> 1) & 1, (i >> 2) & 1);
    return dot(grad3(p.add(o).mod(vec3(freq))), w.sub(o));
  });
  return mix(mix(mix(v[0], v[1], u.x), mix(v[2], v[3], u.x), u.y), mix(mix(v[4], v[5], u.x), mix(v[6], v[7], u.x), u.y), u.z);
}
function perlinFbm(p: Node, freq: number, oct: number) {
  const G = Math.pow(2, -0.85);
  let noise: Node = float(0), amp = 1;
  for (let i = 0; i < oct; i++, freq *= 2, amp *= G) noise = noise.add(gnoise(p.mul(freq), freq).mul(amp));
  return noise;
}
const worleyFbm = (p: Node, f: number) => worley(p, f).mul(0.625).add(worley(p, f * 2).mul(0.25)).add(worley(p, f * 4).mul(0.125));
const remap = (x: Node, a: Node, b: Node, c: Node, d: Node) => float(c).add(float(x).sub(a).div(float(b).sub(a)).mul(float(d).sub(c)));

// a 3D rgba8 volume, repeat-wrapped, with a full mip chain written by hand
function volume(renderer: THREE.WebGPURenderer, n: number, texel: (p: Node) => Node) {
  const tex = new THREE.Storage3DTexture(n, n, n);
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true; // allocates the chain
  (tex as any).mipmapsAutoUpdate = false; // the levels below are written here
  const coord = (s: number) => {
    const x = instanceIndex.mod(s), y = instanceIndex.div(s).mod(s), z = instanceIndex.div(s * s);
    return { x, y, z, c: uvec3(x, y, z) };
  };
  // level 0 into the volume and a plain copy (the source of level 1)
  let prev = new THREE.Storage3DTexture(n, n, n);
  const base = prev;
  renderer.compute(Fn(() => {
    const { x, y, z, c } = coord(n);
    const v = vec4(texel(vec3(float(x), float(y), float(z)).add(0.5).div(n))).toVar();
    textureStore(tex, c, v);
    textureStore(base, c, v);
  })().compute(n * n * n));
  // each level: the box filter of the one above (GL's genMips), read from the previous plain copy
  const temps = [prev];
  for (let level = 1, s = n >> 1; s >= 1; level++, s >>= 1) {
    const src = prev, dst = new THREE.Storage3DTexture(s, s, s);
    renderer.compute(Fn(() => {
      const { x, y, z, c } = coord(s);
      const o = ivec3(int(x).mul(2), int(y).mul(2), int(z).mul(2)).toVar();
      const sum = vec4(0).toVar();
      for (let k = 0; k < 8; k++) sum.addAssign(texture3D(src, o.add(ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1))).setSampler(false));
      textureStore(tex, c, sum.mul(0.125)).setMipLevel(level);
      textureStore(dst, c, sum.mul(0.125));
    })().compute(s * s * s));
    temps.push(dst);
    prev = dst;
  }
  return { tex, temps };
}

// ---- the march (CLOUD_GLSL)

export const cloudU = {
  windOffset: uniform(new THREE.Vector3()),  // metres of advection (xz) and detail evolution (y)
  coverage: uniform(0),                      // fair-weather side of the front
  base: uniform(1500), top: uniform(3500),   // m
  density: uniform(0.11),                    // extinction scale (1/m)
  dark: uniform(0),                          // storm darkness 0..1
  front: uniform(new THREE.Vector4(1, 0, 0, 0)), // squall front: xy unit normal (towards the storm), z offset (m), w width (0 = off)
  frontCell: uniform(new THREE.Vector2()),   // squall cell: x half-length along the line, y depth behind it (m)
  stormA: uniform(new THREE.Vector4(0, 0, 0, 0)), // storm side: coverage, darkness, density, base
  stormTop: uniform(0),                      // storm side: top (m)
  shapeLod: uniform(-1),                     // debug: >= 0 forces the shape-noise mip level
  flash: uniform(new THREE.Vector4(0, 0, 0, 0)), // lightning position xyz (m), intensity (Vector4() has w = 1)
  flashColor: uniform(new THREE.Vector3(0.75, 0.8, 1.0)),
};

// per pass: radians per pixel (texture LOD), erosion detail where a pixel covers less than detailFoot (m), steps of
// the sky-light (upward) march through decks
interface PassU { pixelAngle: Node; detailFoot: Node; upSteps: Node }
interface Ctx { pa: PassU; gFoot: Node }

// the squall line meanders: one curve for the CPU (numbers) and the shaders (nodes), shared with the fog
export function frontCurve(a: number): number;
export function frontCurve(a: Node): Node;
export function frontCurve(a: any): any {
  if (typeof a === 'number') return 1400 * Math.sin(a / 7000) + 650 * Math.sin(a / 2900 + 1.3);
  return sin(float(a).div(7000)).mul(1400).add(sin(float(a).div(2900).add(1.3)).mul(650));
}
const hgPhase = (c: Node, g: number) => float((1 - g * g) / (4 * PI)).div(pow(float(1 + g * g).sub(c.mul(2 * g)), 1.5));

export class CloudsCompute {
  shape: THREE.Storage3DTexture;
  detail: THREE.Storage3DTexture;
  weatherMap: THREE.StorageTexture;
  shadow = halfTex(256, 256);
  shadowRect = uniform(new THREE.Vector4(0, 0, 1 / 24000, 1 / 24000)); // origin xz, 1/size
  shadowSize = 24000;
  envTex = [halfTex(320, 160), halfTex(320, 160)];
  envCur = 0;
  tex: THREE.StorageTexture[] = [];
  dtex: THREE.StorageTexture[] = [];
  cur = 0;
  w = 0; h = 0;
  frame = 0;
  reset = true;
  // the screen pass: camera basis now and one frame ago, history blend, quality
  sU = {
    camPos: uniform(new THREE.Vector3()), right: uniform(new THREE.Vector3()), up: uniform(new THREE.Vector3()), fwd: uniform(new THREE.Vector3()),
    tan: uniform(new THREE.Vector2(1, 1)),
    prevPos: uniform(new THREE.Vector3()), prevRight: uniform(new THREE.Vector3()), prevUp: uniform(new THREE.Vector3()), prevFwd: uniform(new THREE.Vector3()),
    prevTan: uniform(new THREE.Vector2(1, 1)), prevWind: uniform(new THREE.Vector3()),
    frame: uniform(0), blend: uniform(1), steps: uniform(64), lightSteps: uniform(6), lightDetail: uniform(3), check: uniform(0),
    size: uniform(new THREE.Vector2(1, 1)),
  };
  private screenPass: PassU = { pixelAngle: uniform(0.001), detailFoot: uniform(25), upSteps: uniform(4) };
  private envPass: PassU = { pixelAngle: uniform((2 * Math.PI) / 320), detailFoot: uniform(25), upSteps: uniform(2) };
  private envFrame = uniform(0);
  private shadowOrigin = uniform(new THREE.Vector2());
  private renderer: THREE.WebGPURenderer;
  private sky: SkyCompute;
  private shadowNode: Node;
  private envNodes: Node[];
  private screenNodes: Node[] = [];
  private prev: { pos: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3; fwd: THREE.Vector3; tan: THREE.Vector2; wind: THREE.Vector3 } | null = null;

  constructor(renderer: THREE.WebGPURenderer, sky: SkyCompute) {
    this.renderer = renderer;
    this.sky = sky;
    const shape = volume(renderer, 128, (p) => {
      const pf = abs(mix(1, perlinFbm(p, 4, 7), 0.5).mul(2).sub(1)).toVar();
      const w0 = worleyFbm(p, 4).toVar();
      return vec4(clamp(remap(pf, 0, 1, w0, 1), 0, 1), w0, worleyFbm(p, 8), worleyFbm(p, 16));
    });
    const detail = volume(renderer, 32, (p) => vec4(worleyFbm(p, 2), worleyFbm(p, 4), worleyFbm(p, 8), 1));
    this.shape = shape.tex;
    this.detail = detail.tex;
    const wm = (this.weatherMap = new THREE.StorageTexture(512, 512)); // rgba8, auto-mips on first sampled use
    wm.wrapS = wm.wrapT = THREE.RepeatWrapping;
    wm.generateMipmaps = true;
    wm.minFilter = THREE.LinearMipmapLinearFilter;
    renderer.compute(Fn(() => {
      const x = instanceIndex.mod(512), y = instanceIndex.div(512);
      const p = vec3(vec2(float(x), float(y)).add(0.5).div(512), 0.37).toVar();
      const base = perlinFbm(p, 6, 6).mul(0.5).add(0.5);
      const cells = worleyFbm(p, 10);
      const cov = clamp(remap(base, 0.25, 0.85, 0, 1).mul(0.6).add(cells.mul(0.55)).sub(0.15), 0, 1);
      const type = clamp(perlinFbm(p.add(3.7), 3, 4).mul(0.5).add(0.5), 0, 1);
      const big = clamp(perlinFbm(p.add(9.1), 2, 3).mul(0.6).add(0.5), 0, 1);
      textureStore(wm, uvec2(x, y), vec4(cov, type, big, 1));
    })().compute(512 * 512));
    [...shape.temps, ...detail.temps].forEach((t) => t.dispose());
    this.shadowNode = this.shadowKernel();
    this.envNodes = [0, 1].map((i) => this.envKernel(this.envTex[i], this.envTex[1 - i]));
  }

  get screen() { return this.tex[this.cur]; }
  get depth() { return this.dtex[this.cur]; }
  get env() { return this.envTex[this.envCur]; }

  resize(w: number, h: number, div = 2) {
    const nw = Math.ceil(w / div), nh = Math.ceil(h / div);
    if (this.tex.length && nw === this.w && nh === this.h) return;
    [...this.tex, ...this.dtex].forEach((t) => t.dispose());
    this.w = nw; this.h = nh;
    this.tex = [halfTex(nw, nh), halfTex(nw, nh)];
    this.dtex = [halfTex(nw, nh), halfTex(nw, nh)];
    this.sU.size.value.set(nw, nh);
    this.screenNodes.forEach((n) => n.dispose()); // drops the old size's compute pipelines
    this.screenNodes = [0, 1].map((i) => this.screenKernel(i));
    this.cur = 0;
    this.reset = true;
  }

  // ---- density

  private lodFor(cx: Ctx, texel: number) { return max(log2(max(cx.gFoot, 1e-3).div(texel)), 0); }
  private frontDist(xz: Node) {
    const f = cloudU.front, fc = cloudU.frontCell;
    const along = dot(xz, vec2(f.y.negate(), f.x)).toVar();
    const d = dot(xz, f.xy).sub(f.z).sub(frontCurve(along)).toVar();
    const c = vec2(select(fc.x.greaterThan(0), fc.x, 1e7), select(fc.y.greaterThan(0), fc.y, 1e7)); // 0 = endless
    return min(d, min(c.y.sub(d), c.x.sub(abs(along))));
  }
  shellBase() {
    const u = cloudU;
    const b = select(u.front.w.greaterThan(0), min(u.base, u.stormA.w), u.base);
    // (only once scud is visible: a lowered shell with no cloud in it is pure cost)
    const storm = smoothstep(0.5, 0.9, u.dark).greaterThan(0.02).or(u.front.w.greaterThan(0).and(u.stormA.y.greaterThan(0.5)));
    return select(storm, min(b, SCUD_BASE), b);
  }
  private towerM() { return smoothstep(0.3, 0.6, cloudU.dark).oneMinus().mul(TOWER_M); }
  shellTop() {
    const t = cloudU.top.add(this.towerM());
    return select(cloudU.front.w.greaterThan(0), max(t, cloudU.stormTop), t);
  }
  maxCoverage() { return select(cloudU.front.w.greaterThan(0), max(cloudU.coverage, cloudU.stormA.x), cloudU.coverage); }

  // local cloud regime at a point: R = (coverage, darkness, density, front mask), and its base and top. h: sample
  // height. High up, the storm's anvil spreads ahead of the line (~3.5 km).
  private regime(xz: Node, h: Node) {
    const u = cloudU, f = u.front, fc = u.frontCell;
    const m = float(0).toVar(), tv = float(1).toVar();
    If(f.w.greaterThan(0), () => {
      const anvil = smoothstep(u.stormTop.mul(0.62), u.stormTop.mul(0.86), h).mul(3500);
      // the storm's face bulges forward and recedes by kilometres: convective towers, not a wall
      const bp = vec3(xz.x.add(u.windOffset.x), h.mul(1.3), xz.y.add(u.windOffset.z)).div(8500).add(0.77).toVar();
      const bn = texture3D(this.shape, bp).level(2).toVar();
      const bf = texture3D(this.shape, bp.mul(3.1).add(0.29)).level(2);
      const bulge = bn.r.mul(0.7).add(bn.g.mul(0.3)).sub(0.5).mul(5500).add(bf.r.sub(0.5).mul(1400)).mul(smoothstep(300, 2500, h));
      tv.assign(bn.g.mul(0.3).add(0.7));
      // (a small cell bulges and spreads its anvil in proportion: km-scale noise would swallow it)
      const cs = select(fc.x.greaterThan(0).or(fc.y.greaterThan(0)),
        clamp(min(select(fc.x.greaterThan(0), fc.x, 1e7), select(fc.y.greaterThan(0), fc.y, 1e7)).div(6000), 0.15, 1), 1);
      m.assign(smoothstep(f.w.negate(), f.w, this.frontDist(xz).add(anvil.add(bulge).mul(cs))));
    });
    const base = mix(u.base, u.stormA.w, m).toVar();
    const top = mix(u.top, u.stormTop.mul(tv), m).toVar();
    // the storm's coverage closes over the outer half of the ramp: its face has no see-through gaps (and darkens
    // just as fast: the storm's leading towers are part of one dark mass, not fair-weather cumulus)
    const R = vec4(mix(u.coverage, u.stormA.x, smoothstep(0, 0.35, m)), mix(u.dark, u.stormA.y, smoothstep(0, 0.2, m)), mix(u.density, u.stormA.z, m), m).toVar();
    return { R, base, top };
  }

  // the nearest tower to q (wind frame, m): xy offset from its base centre, z its height above base (0 = none), w a seed
  private nearestTower(q: Node, plainH: Node, tm: Node, cov: Node) {
    const cell = floor(q.div(TOWER_CELL)).toVar();
    const best = vec4(1e9, 0, 0, 0).toVar();
    Loop(3, 3, ({ i, j }: Node) => {
      const id = cell.add(vec2(float(j).sub(1), float(i).sub(1))).toVar();
      const r = hash33(vec3(id.x, id.y, id.x).add(1000)).toVar();
      const ctr = id.add(r.xy.mul(0.6)).add(0.2).mul(TOWER_CELL).toVar();
      const d = length(q.sub(ctr)).toVar();
      If(r.z.lessThanEqual(TOWER_P).and(d.lessThanEqual(TOWER_R * 1.6)).and(d.lessThanEqual(length(best.xy))), () => {
        const w = texture(this.weatherMap, ctr.div(30000)).level(0).toVar();
        // (heights follow g, the cloud-type noise, so neighbouring towers rise alike)
        If(w.r.mul(0.85).add(w.b.mul(0.25).mul(cov)).greaterThanEqual(cov.oneMinus()), () => {
          best.assign(vec4(q.sub(ctr), plainH.add(tm.mul(mix(0.4, 1, w.g)).mul(mix(0.85, 1, fract(r.z.mul(7.31))))), r.x.add(r.y)));
        });
      });
    });
    return best;
  }

  // detail: false, or a bool node
  private densityR(cx: Ctx, p: Node, h: Node, detail: Node | false, R: Node, base: Node, top: Node) {
    const u = cloudU, f = u.front, wo = u.windOffset;
    const out = float(0).toVar();
    If(h.lessThan(base), () => {
      // scud (fractus): ragged low fragments racing under a storm deck
      const sg = select(f.w.greaterThan(0),
        smoothstep(0.5, 0.85, R.w).mul(smoothstep(5000, 9000, this.frontDist(p.xz)).oneMinus()),
        smoothstep(0.5, 0.9, R.y)).toVar();
      If(sg.greaterThanEqual(0.02).and(h.greaterThanEqual(SCUD_BASE)), () => {
        const sp2 = p.add(vec3(wo.x, 0, wo.z).mul(1.8)).div(vec3(1400, 500, 1400));
        const n2 = texture3D(this.shape, sp2).level(this.lodFor(cx, 1400 / 128)).toVar();
        const sb = n2.b.mul(300).add(SCUD_BASE);
        const sh = h.sub(sb).div(max(base.sub(sb), 1)).toVar();
        If(sh.greaterThan(0), () => {
          const frag = n2.r.mul(0.7).add(n2.g.mul(0.3));
          const d2 = smoothstep(0.6, 0.9, frag).mul(n2.b.mul(0.6).add(0.4)).mul(smoothstep(0, 0.35, sh)).mul(smoothstep(0.55, 1, sh).oneMinus())
            // (a near-field feature: at the horizon it would read as flat slabs under the storm)
            .mul(smoothstep(3000, 8000, cx.gFoot.div(max(cx.pa.pixelAngle, 1e-6))).oneMinus());
          out.assign(d2.mul(min(R.z, 0.07)).mul(sg).mul(0.5));
        });
      });
    }).Else(() => {
      const cov = R.x, dark = R.y;
      const tm = smoothstep(0.3, 0.6, dark).oneMinus().mul(R.w.oneMinus()).mul(TOWER_M).toVar();
      If(h.lessThanEqual(top.add(tm)), () => {
      const wuv = p.xz.add(wo.xz).div(30000);
      const wm = texture(this.weatherMap, wuv).level(this.lodFor(cx, 30000 / 512)).toVar();
      const tw = vec4(1e9, 0, 0, 0).toVar();
      If(tm.greaterThan(0), () => { tw.assign(this.nearestTower(p.xz.add(wo.xz), top.sub(base), tm, cov)); });
      const tt = h.sub(base).div(max(tw.z, 1)).toVar();
      If(h.lessThanEqual(top).or(tt.lessThan(1)), () => {
      const hf = h.sub(base).div(top.sub(base)).toVar();
      const c = smoothstep(cov.oneMinus().sub(0.18), cov.oneMinus().add(0.2), wm.r.mul(0.85).add(wm.b.mul(0.25).mul(cov))).toVar();
      // an overcast deck is closed: no column-shaped gaps from the 2D coverage map
      c.assign(max(c, smoothstep(0.82, 0.96, cov)));
      If(c.greaterThan(0.001).or(tw.z.greaterThan(0)), () => {
        // shape noise: ~350 m billows for cumulus, ~750 m cells for storm decks (blended in between)
        const pw = p.add(vec3(wo.x, 0, wo.z)).toVar();
        const forced = u.shapeLod.greaterThanEqual(0);
        const n = texture3D(this.shape, pw.div(3000)).level(select(forced, u.shapeLod, this.lodFor(cx, 3000 / 128))).toVar();
        If(dark.lessThan(0.85), () => {
          const nc = texture3D(this.shape, pw.div(1400).add(0.37)).level(select(forced, u.shapeLod, this.lodFor(cx, 1400 / 128)));
          n.assign(mix(nc, n, smoothstep(0.15, 0.85, dark)));
        });
        const wf = n.g.mul(0.625).add(n.b.mul(0.25)).add(n.a.mul(0.125)).toVar();
        // the tower: its radius follows the sketch's width profile around an axis that wanders ~300 m (the sketch's
        // column swings 1 km), pushed out up to 400 m by ~750 m bubbles (the shape texture's inverted-Worley
        // channels) so the outline is a pile of puffs; bounded, so nothing floats free
        const dT = float(0).toVar();
        If(tw.z.greaterThan(0).and(tt.lessThan(1)), () => {
          const uu = clamp(tt.sub(0.88).div(0.12), 0, 1);
          const renv = mix(1, 0.47, smoothstep(0.15, 0.45, tt)).mul(mix(1, 0.65, smoothstep(0.6, 0.88, tt)))
            .mul(sqrt(uu.mul(uu).oneMinus())).mul(TOWER_R).toVar();
          const sd = tw.w.mul(6.28);
          const axis = vec2(sin(tt.mul(4).add(sd)), cos(tt.mul(3.1).add(sd.mul(1.7)))).mul(300).mul(smoothstep(0.1, 0.5, tt));
          const nb = texture3D(this.shape, pw.div(3000).add(0.61)).level(this.lodFor(cx, 3000 / 128));
          const bub = clamp(nb.g.mul(0.6).add(nb.b.mul(0.4)).sub(0.55).div(0.3), 0, 1);
          const ct = smoothstep(renv.sub(80), renv.add(80), length(tw.xy.sub(axis)).sub(bub.mul(400))).oneMinus();
          dT.assign(ct.mul(smoothstep(0, float(110).div(tw.z), tt)).mul(mix(0.6, 1, n.r)));
        });
        // vertical profile. Fair weather: cumulus towers with type-dependent tops. Storm: a layer deck whose base
        // undulates (rolls, scud) and whose thickness varies 2-3x (the mottled light and dark patches of an overcast)
        const span = max(top.sub(base), 100).toVar();
        const baseFrac = mix(0, wf.sub(0.45).mul(400).add(60).div(span), dark).toVar();
        const topCu = mix(0.45, 1, wm.g);
        const cells = select(f.w.greaterThan(0),
          smoothstep(0.35, 0.75, wm.b.mul(0.6).add(sin(dot(p.xz, vec2(f.y.negate(), f.x)).div(5200)).mul(0.25)).add(0.3)), 0);
        const topSt = mix(0.18, 1, clamp(wm.b.mul(0.9).add(n.r.mul(0.7)).sub(0.3).add(cells.mul(0.6)), 0, 1)).toVar();
        // the anvil itself: a flat, smooth spreading layer near the top of the storm
        topSt.assign(max(topSt, step(0.86, hf).mul(dark)));
        // cumulus tops dome over the core of the coverage cell instead of a flat slab
        const tf = mix(topCu.mul(mix(0.55, 1, smoothstep(0, 0.85, c))), topSt, dark).toVar();
        // per-cloud base height (flat bases that differ from cloud to cloud)
        baseFrac.addAssign(wm.g.sub(0.5).mul(0.05).mul(dark.oneMinus()));
        const anvilSlab = dark.greaterThan(0.5).and(hf.greaterThan(0.8));
        const hg = select(anvilSlab,
          smoothstep(baseFrac, baseFrac.add(0.05), hf).mul(smoothstep(0.95, 1, hf).oneMinus()),
          smoothstep(baseFrac, baseFrac.add(mix(110, 140, dark).div(span)), hf).mul(smoothstep(tf.mul(0.55), tf, hf).oneMinus())).toVar();
        const shape = remap(n.r, wf.sub(1), 1, 0, 1).toVar();
        If(R.w.greaterThan(0.6).and(hf.lessThan(0.8)), () => { shape.assign(max(shape, smoothstep(0.6, 0.9, R.w).mul(0.35))); });
        shape.assign(max(shape, smoothstep(0.35, 0.8, c).mul(0.45).mul(dark.oneMinus())));
        // the base of a cumulus is a little narrower than its body
        const c2 = c.mul(mix(mix(0.8, 1, smoothstep(0, 0.12, hf)), 1, dark)).toVar();
        // coverage erodes with height (Schneider 2017): the cloud narrows upward into turrets
        const d = select(c.greaterThan(0.001),
          remap(shape.mul(hg), c2.mul(mix(1, 0.55, min(hf, 1).mul(dark.oneMinus()))).oneMinus(), 1, 0, 1).mul(c2), 0).toVar();
        d.assign(max(d, dT));
        If(d.greaterThan(0), () => {
          if (detail !== false) {
            If(detail, () => {
              // (a cumulonimbus billows at ~1 km, a fair-weather cumulus at ~400 m)
              const dp = p.add(wo.mul(vec3(1.15, 1, 1.15))).div(mix(420, 1100, smoothstep(0.6, 0.9, dark))).toVar();
              const dn = texture3D(this.detail, dp).level(this.lodFor(cx, 420 / 32)).rgb;
              const df = dn.r.mul(0.625).add(dn.g.mul(0.25)).add(dn.b.mul(0.125)).toVar();
              // a finer octave (~140 m) for cauliflower lobes, only where it is resolved, and not on closed decks
              const l2 = this.lodFor(cx, 140 / 32).toVar();
              const dn2 = texture3D(this.detail, dp.mul(3).add(0.41)).level(l2).rgb;
              const w2 = smoothstep(1, 2, l2).oneMinus().mul(0.3).mul(smoothstep(0.88, 0.97, cov).oneMinus());
              df.assign(mix(df, dn2.r.mul(0.625).add(dn2.g.mul(0.25)).add(dn2.b.mul(0.125)), w2));
              // fair-weather cumulus are billowy everywhere; decks wispy at the base
              const dm = mix(df.oneMinus(), mix(df, df.oneMinus(), clamp(hf.mul(5), 0, 1)), dark);
              const thr = dm.mul(mix(0.55, 0.45, dark)).mul(mix(1, 0.3, smoothstep(0.88, 0.97, cov))).mul(select(anvilSlab, 0, 1))
                // (a fair-weather base is flat: the detail erodes it only a little)
                .mul(mix(mix(0.35, 1, smoothstep(0.02, 0.12, hf)), 1, dark))
                .mul(mix(1, 0.7, smoothstep(0.6, 0.9, dark))).toVar();
              d.assign(clamp(remap(d, thr, thr.add(thr.oneMinus().mul(mix(0.25, 0.5, dark))), 0, 1), 0, 1));
            });
          }
          // a storm deck seen from below is mottled because its optical thickness varies 2-3x over a few km (the base
          // radiance goes ~1/tau): thicker, darker masses beside thinner, brighter patches
          const thick = mix(1, smoothstep(0.15, 0.85, wm.b.mul(0.6).add(n.g.mul(0.6)).sub(0.1)).mul(1.5).add(0.3), smoothstep(0.3, 0.7, dark));
          out.assign(max(d, 0).mul(R.z).mul(thick));
        });
      });
      });
      });
    });
    return out;
  }
  private density(cx: Ctx, p: Node, h: Node, detail: Node | false) {
    const { R, base, top } = this.regime(p.xz, h);
    return this.densityR(cx, p, h, detail, R, base, top);
  }

  // Fraction of the haze path (camera to distance md along rd) that is sunlit when a storm stands between the path
  // and the sun: the storm's shadow reaches stormTop / tan(elevation) ahead of the line, scaled by how much the sun
  // stands behind the line. Skylight still scatters in the shadow.
  private stormHazeLit(cam: Node, rd: Node, md: Node) {
    const u = cloudU, f = u.front, sun = atmoU.sun;
    const lit = float(1).toVar();
    If(f.w.greaterThan(0).and(u.stormA.y.greaterThanEqual(0.5)), () => {
      const lh = max(length(sun.xz), 1e-3).toVar();
      const sh = sun.xz.div(lh);
      const tanE = max(sun.y, 0.02).div(lh);
      const reach = u.stormTop.div(tanE).mul(max(dot(sh, f.xy), 0)).toVar();
      const fd0 = this.frontDist(cam.xz).toVar();
      const rate = dot(rd.xz, f.xy).toVar();
      // distance along the ray at which it enters the shadow (or never)
      const sEdge = select(fd0.greaterThanEqual(reach.negate()), 0, select(rate.greaterThan(1e-4), reach.negate().sub(fd0).div(rate), 1e9));
      // the first 12 km are handled by the shadow-mapped crepuscular term (shafts) in the composite
      const tF = select(rate.greaterThan(1e-4), max(fd0.negate().div(rate), 0), 1e9).toVar();
      const l0 = max(md.sub(min(max(sEdge, 12000), tF)), 0).div(max(md, 1)).oneMinus();
      // a ray that passes beside a short cell is not in its shadow
      const alongF = dot(cam.xz.add(rd.xz.mul(min(tF, 1e6))), vec2(f.y.negate(), f.x));
      const fc = u.frontCell.x;
      lit.assign(mix(0.15, 1, mix(l0, 1, select(fc.greaterThan(0), smoothstep(fc, fc.add(f.w.mul(2)), abs(alongF)), 0))));
    });
    return lit;
  }

  // in-scattered radiance L (sun illuminance = 1 units) and transmittance T, and the mean distance of the cloud
  // light (GL's marchClouds; steps, lightSteps, lightDetail: numbers or uniforms)
  private march(cx: Ctx, ro: Node, rd: Node, steps: Node, lightSteps: Node, lightDetail: Node, jitter: Node, sunE: Node, ambTop: Node, ambBot: Node, ambFace: Node) {
    const u = cloudU, sun = atmoU.sun;
    const res = vec4(0, 0, 0, 1).toVar();
    const meanDist = float(0).toVar();
    const shellHits = (R: Node) => {
      const o = ro.add(vec3(0, RG_M, 0)).toVar();
      const b = dot(o, rd).toVar();
      const disc = b.mul(b).sub(dot(o, o).sub(R.mul(R))).toVar();
      const s = sqrt(max(disc, 0));
      return select(disc.lessThan(0), vec2(-1), vec2(b.negate().sub(s), b.negate().add(s))).toVar();
    };
    const heightOf = (p: Node) => length(p.add(vec3(0, RG_M, 0))).sub(RG_M);
    If(this.maxCoverage().greaterThanEqual(0.01), () => {
      const sB = this.shellBase().toVar(), sT = this.shellTop().toVar();
      const hb = shellHits(sB.add(RG_M)), ht = shellHits(sT.add(RG_M));
      const t0 = float(0).toVar(), t1 = float(0).toVar(), ok = float(1).toVar();
      const h0 = heightOf(ro).toVar();
      If(h0.lessThan(sB), () => {
        If(rd.y.lessThan(-0.02), () => { ok.assign(0); });
        t0.assign(hb.y); t1.assign(ht.y);
      }).ElseIf(h0.lessThan(sT), () => {
        t1.assign(select(rd.y.greaterThan(0), ht.y, select(hb.x.greaterThan(0), hb.x, ht.y)));
      }).Else(() => {
        If(ht.x.lessThan(0), () => { ok.assign(0); });
        t0.assign(ht.x); t1.assign(select(hb.x.greaterThan(0), hb.x, ht.y));
      });
      t1.assign(min(t1, t0.add(select(u.front.w.greaterThan(0), 120000, 60000))));
      If(ok.greaterThan(0).and(t1.greaterThan(t0)), () => {
        const sf = float(64).div(float(steps)).toVar();
        // adaptive stepping: coarse probes in empty space, fine steps inside clouds. Fine step grows with distance
        // (pixel footprint) to bound the cost near the horizon.
        const fine = clamp(t0.mul(0.008), 30, 700).mul(sf).toVar();
        const coarse = fine.mul(3).toVar();
        const t = t0.add(coarse.mul(jitter)).toVar();
        const L = vec3(0).toVar(), T = float(1).toVar(), wsum = float(0).toVar();
        const cosT = dot(rd, sun).toVar();
        // multiple-scattering octaves (Wrenninge 2013): energy a^i, extinction b^i, eccentricity c^i
        const ph0 = mix(hgPhase(cosT, 0.82), hgPhase(cosT, -0.3), 0.4).toVar();
        const ph1 = mix(hgPhase(cosT, 0.41), hgPhase(cosT, -0.15), 0.5).toVar();
        const ph2 = mix(hgPhase(cosT, 0.2), hgPhase(cosT, -0.07), 0.5).toVar();
        const ph3 = mix(hgPhase(cosT, 0.1), hgPhase(cosT, -0.035), 0.5).toVar();
        const inside = float(0).toVar(), allowBack = float(1).toVar();
        const tEnter = float(0).toVar(), tDone = float(t0).toVar(), miss = float(0).toVar();
        const luma = vec3(0.2126, 0.7152, 0.0722);
        // (budget: a ray may cross a few near cumulus and still has to reach a storm 20+ km away)
        Loop(320, ({ i }: Node) => {
          If(float(i).greaterThanEqual(float(steps).mul(3)).or(T.lessThan(0.02)).or(t.greaterThan(t1)), () => { Break(); });
          const p = ro.add(rd.mul(t)).toVar();
          cx.gFoot.assign(t.mul(cx.pa.pixelAngle));
          const h = heightOf(p).toVar();
          const { R, base, top } = this.regime(p.xz, h);
          If(inside.equal(0), () => {
            // a probe that hits steps back one stride at every entry: the cloud's near edge is not skipped
            const stride = clamp(t.mul(0.02), coarse, max(coarse, 600)).toVar();
            If(this.densityR(cx, p, h, false, R, base, top).greaterThan(0), () => {
              inside.assign(1); miss.assign(0);
              // (fine steps restart at a jittered phase: a back-step clamped to the shell entry would otherwise put
              // every pixel's samples at the same depths, printing contour bands)
              If(allowBack.greaterThan(0), () => {
                tEnter.assign(t);
                t.assign(max(t.sub(stride), max(t0, tDone)).add(fine.mul(jitter)));
                allowBack.assign(0);
                Continue();
              });
            }).Else(() => { t.addAssign(stride); Continue(); });
          });
          // distance LOD: erosion detail and long light paths are sub-pixel far away
          const nearField = t.mul(cx.pa.pixelAngle).lessThan(cx.pa.detailFoot).toVar();
          const sigma = this.densityR(cx, p, h, nearField, R, base, top).toVar();
          const stepLen = max(fine, min(max(t.sub(15000), 0).mul(0.005), 150).mul(sf)).mul(t.mul(0.00004).add(1)).toVar();
          If(sigma.greaterThan(0).and(T.greaterThan(0.05)), () => { stepLen.assign(min(stepLen, max(float(1.2).div(sigma), 8))); });
          If(sigma.greaterThan(0), () => {
            miss.assign(0);
            const hf = clamp(h.sub(base).div(top.sub(base)), 0, 1).toVar();
            // light march towards the sun (geometric step growth). The march spans the same ~2.6 km whatever the
            // step count, so coarse passes don't see thick decks as thin and sunlit inside; far away the light path
            // must still span the cloud (few long steps); scud under a deck is lit analytically
            const tau = float(0).toVar();
            const scud = h.lessThan(base).toVar();
            const nL = select(scud, 0, select(nearField.or(R.y.greaterThan(0.5)), float(lightSteps), 4)).toVar();
            const ls = float(2600).div(max(exp2(nL).sub(1), 1)).toVar();
            const lp = vec3(p).toVar();
            const marched = float(0).toVar(), exited = float(0).toVar();
            Loop(8, ({ i: j }: Node) => {
              If(float(j).greaterThanEqual(nL), () => { Break(); });
              lp.addAssign(sun.mul(ls));
              const lh = heightOf(lp).toVar();
              If(lh.greaterThan(sT).or(lh.lessThan(sB.sub(50))), () => { exited.assign(1); Break(); });
              tau.addAssign(this.density(cx, lp, lh, float(j).lessThan(float(lightDetail))).mul(ls));
              marched.addAssign(ls);
              ls.mulAssign(2);
            });
            // still inside a deck after 2.6 km: extrapolate the rest of the column with the mean density
            If(exited.equal(0).and(marched.greaterThan(0)), () => {
              const rest = clamp(top.sub(heightOf(lp)).div(max(sun.y, 0.05)), 0, 60000);
              tau.addAssign(tau.div(marched).mul(rest));
            });
            // scud sits under the deck: sunlight must cross the whole layer above it
            If(scud, () => { tau.addAssign(R.z.mul(top.sub(base)).mul(0.8).div(max(sun.y, 0.1))); });
            const msK = exp(tau.add(sigma.mul(30)).negate()).oneMinus();
            const ms = ph0.mul(exp(tau.negate())).add(msK.mul(ph1.mul(0.7).mul(exp(tau.mul(-0.5)))
              .add(ph2.mul(0.49).mul(exp(tau.mul(-0.25)))).add(ph3.mul(0.343).mul(exp(tau.mul(-0.125))))));
            // powder: in-scattering probability is low at cloud edges facing the light
            const powder = exp(tau.mul(-2).sub(sigma.mul(80))).oneMinus();
            // optical depth of the column above: diffuse light filtering down through the deck
            const tauUp = float(0).toVar();
            If(scud, () => {
              tauUp.assign(R.z.mul(top.sub(base)).mul(0.5));
            }).ElseIf(R.x.greaterThan(0.55), () => {
              const us = float(180).toVar(), marchedUp = float(0).toVar(), uhLast = float(h).toVar();
              const up = vec3(p).toVar();
              Loop(4, ({ i: j }: Node) => {
                If(float(j).greaterThanEqual(float(cx.pa.upSteps)), () => { Break(); });
                up.y.addAssign(us);
                const uh = heightOf(up).toVar();
                If(uh.greaterThan(top), () => { Break(); });
                tauUp.addAssign(this.densityR(cx, up, uh, false, R, base, top).mul(us));
                marchedUp.addAssign(us); uhLast.assign(uh);
                us.mulAssign(select(float(cx.pa.upSteps).lessThan(3), 4.5, 2.4));
              });
              If(R.y.greaterThan(0.5).and(marchedUp.greaterThan(0)), () => { tauUp.addAssign(tauUp.div(marchedUp).mul(max(top.sub(uhLast), 0))); });
            }).Else(() => {
              tauUp.assign(sigma.mul(hf.oneMinus()).mul(top.sub(base)).mul(0.35));
            });
            // two-stream diffusion transmittance for thick media (asymmetry g ~ 0.85): 1/(1 + 0.75(1-g) tau)
            const diffSun = float(1).div(tau.mul(0.11).add(1));
            const diffUp = float(1).div(tauUp.mul(0.11).add(1)).toVar();
            // multiply scattered sunlight fills thick clouds with near-isotropic light, L ~ E T_diff / pi (a deck is a
            // slab lit from above: E mu0 T_d / pi; an isolated cumulus is lit on its sunward side, dark bodies with
            // bright rims when backlit)
            const slab = smoothstep(0.75, 0.95, R.x);
            const diffuse = diffSun.mul(mix(mix(0.12, 0.5, smoothstep(-0.6, 0.3, cosT).oneMinus()), max(sun.y, 0).div(3.14159), slab))
              .mul(exp(tau.mul(-0.15)).oneMinus());
            // diffused deck light mixes sun and blue skylight: neutral-cool (~6500 K) at the sun's luminance
            const diffCol = vec3(0.93, 1.0, 1.09).mul(dot(sunE, luma));
            const sunL = sunE.mul(ms).mul(mix(1, powder, max(cosT, 0).oneMinus().mul(0.25))).add(diffCol.mul(diffuse));
            const amb = ambTop.mul(diffUp).mul(mix(0.6, 1, hf)).add(ambBot.mul(hf.oneMinus()).mul(diffUp).mul(0.6)).toVar();
            // the face toward the camera reflects the sky/sea light behind the camera where the column above no
            // longer lets skylight through (a storm face: its shadowed sides fall to ~30% of the sunlit side)
            const stormy = step(0.5, R.y);
            amb.addAssign(ambFace.mul(diffUp.oneMinus()).mul(smoothstep(0.5, 0.9, R.x)).mul(mix(1, 0.55, R.w))
              .mul(mix(1, smoothstep(0.03, 0.25, hf), stormy)).mul(mix(1, 0.4, stormy.mul(R.w))));
            // a tall storm's faces see half the sky and half the dark sea: ~0.45 of the sky radiance
            amb.mulAssign(mix(1, 0.45, smoothstep(0.5, 0.9, R.y)));
            // scud: fragments in the deck's shade read darker than the deck
            If(scud, () => { amb.mulAssign(mix(0.3, 0.8, smoothstep(1500, 6000, t))); });
            const S = sunL.add(amb).mul(sigma).toVar();
            If(u.flash.w.greaterThan(0), () => {
              const fd = length(p.sub(u.flash.xyz)).toVar();
              S.addAssign(u.flashColor.mul(u.flash.w).mul(sigma).mul(exp(fd.div(-1400))).div(fd.mul(fd).mul(1e-6).add(1)));
            });
            const a = exp(sigma.mul(stepLen).negate()).toVar();
            L.addAssign(T.mul(S.sub(S.mul(a)).div(max(sigma, 1e-7))));
            wsum.addAssign(T.mul(a.oneMinus()));
            meanDist.addAssign(t.mul(T).mul(a.oneMinus()));
            T.mulAssign(a);
          }).ElseIf(t.greaterThan(tEnter), () => {
            miss.addAssign(1);
            If(miss.greaterThan(5), () => { inside.assign(0); allowBack.assign(1); tDone.assign(t); });
          });
          t.addAssign(stepLen);
        });
        meanDist.assign(select(wsum.greaterThan(0), meanDist.div(max(wsum, 1e-30)), t0));
        // early termination leaves a residual: treat it as opaque
        res.assign(vec4(L, clamp(T.sub(0.01).div(0.99), 0, 1)));
      });
    });
    return { c: res, md: meanDist };
  }

  // the lighting inputs and the aerial perspective toward the cloud, shared by the screen and env passes
  private shade(cx: Ctx, ro: Node, rd: Node, steps: Node, lightSteps: Node, lightDetail: Node, j: Node) {
    const sky = this.sky, sun = atmoU.sun;
    const sunE = sky.transmittanceAt(cloudU.base.max(0).mul(0.001).add(0.5), sun.y).mul(atmoU.lightScale).toVar();
    const zen = sky.skyRadiance(vec3(0, 1, 0)).toVar();
    const hor = sky.skyRadiance(normalize(vec3(sun.z, 0.15, sun.x.negate())));
    const ambTop = zen.mul(0.55).add(hor.mul(0.45)).toVar();
    const ambBot = sky.transmittanceAt(float(0), sun.y).mul(atmoU.lightScale).mul(max(sun.y, 0)).add(zen.mul(3.14159)).mul(0.06 / 3.14159);
    // light of the sky and sea behind the camera (mean radiance of the actual, clouded sky)
    const ambFace = sky.skyIrradiance().div(3.14159).mul(0.45);
    const { c, md } = this.march(cx, ro, rd, steps, lightSteps, lightDetail, j, sunE, ambTop, ambBot, ambFace);
    If(c.a.lessThan(0.999), () => {
      const air = sky.aerial(rd, md.mul(0.001));
      // the aerial table holds horizontal sea-level paths; a raised cloud is seen through less haze: scale the
      // optical depth by the slant-path factor of the boundary layer (H ~ 2 km)
      const sEl = max(rd.y, 0).mul(md).mul(0.001 / 2).toVar();
      const fsl = select(sEl.greaterThan(1e-3), exp(sEl.negate()).oneMinus().div(max(sEl, 1e-3)), 1);
      const aT = max(air.T, vec3(1e-4)).toVar();
      const aT2 = pow(aT, vec3(fsl)).toVar();
      const aL = air.L.mul(aT2.oneMinus()).div(max(air.T.oneMinus(), vec3(1e-4))).mul(this.stormHazeLit(ro, rd, md));
      c.rgb.assign(c.rgb.mul(aT2).add(aL.mul(c.a.oneMinus()).mul(0.9)));
    });
    return { c, md };
  }

  private jhash(p0: Node) {
    const p = fract(p0.mul(0.1031)).toVar();
    p.addAssign(dot(p, p.zyx.add(31.32)));
    return fract(p.x.add(p.y).mul(p.z));
  }

  // cloud-shadow map centred on the camera: transmittance of the cloud layer along the sun from the sea at each texel
  private shadowKernel() {
    const tex = this.shadow;
    return Fn(() => {
      const x = instanceIndex.mod(256), y = instanceIndex.div(256);
      const uv = vec2(float(x), float(y)).add(0.5).div(256);
      const sz = this.shadowSize;
      const p0 = vec3(this.shadowOrigin.x.add(uv.x.mul(sz)), 0, this.shadowOrigin.y.add(uv.y.mul(sz))).toVar();
      const sun = atmoU.sun;
      const L = normalize(vec3(sun.x, max(sun.y, 0.03), sun.z)).toVar();
      const tb = this.shellBase().div(L.y).toVar(), tt = this.shellTop().div(L.y);
      const cx: Ctx = { pa: { pixelAngle: float(0), detailFoot: float(0), upSteps: float(0) }, gFoot: float(sz / 256).toVar() };
      // (32 steps: the towers raise the shell top ~2 km, and 16 steps across it would step past a tower's column)
      const dt = tt.sub(tb).div(32).toVar();
      const tau = float(0).toVar();
      Loop(32, ({ i }: Node) => {
        const p = p0.add(L.mul(tb.add(float(i).add(0.5).mul(dt)))).toVar();
        tau.addAssign(this.density(cx, p, p.y, false).mul(dt));
      });
      textureStore(tex, uvec2(x, y), vec4(exp(tau.mul(-0.85)), 0, 0, 1));
    })().compute(256 * 256);
  }

  // reflection-probe clouds (equirect 320 x 160, upper half), amortised by a history blend
  private envKernel(dst: THREE.StorageTexture, hist: THREE.StorageTexture) {
    return Fn(() => {
      const x = instanceIndex.mod(320), y = instanceIndex.div(320);
      const fc = vec2(float(x), float(y)).add(0.5).toVar();
      const uv = fc.div(vec2(320, 160));
      const phi = uv.x.sub(0.5).mul(2 * PI).toVar(), theta = uv.y.mul(PI).toVar();
      const rd0 = vec3(cos(phi).mul(sin(theta)), cos(theta), sin(phi).mul(sin(theta))).toVar();
      const out = vec4(0, 0, 0, 1).toVar();
      If(rd0.y.greaterThanEqual(0), () => {
        const rd = normalize(rd0.add(vec3(0, 0.002, 0))).toVar();
        // jitter: a golden-ratio sequence in time from a random offset per pixel (stratified in time, no spatial
        // pattern: a low-discrepancy pattern in space, IGN, leaves a crosshatch no photograph has)
        const j = fract(this.jhash(vec3(fc, 17)).add(this.envFrame.mul(0.618034)));
        const cx: Ctx = { pa: this.envPass, gFoot: float(0).toVar() };
        const { c } = this.shade(cx, this.sU.camPos, rd, 36, 3, 0, j);
        const h = texture(hist, uv).level(0).toVar();
        const bad = anyNonFinite(h, 4).or(abs(h.r).add(abs(h.g)).add(abs(h.b)).add(abs(h.a)).lessThan(1e5).not());
        out.assign(mix(select(bad, c, h), c, select(this.envFrame.lessThan(1.5), 1, 0.25)));
      });
      textureStore(dst, uvec2(x, y), out);
    })().compute(320 * 160);
  }

  // the screen pass into tex[next], history from tex[cur]
  private screenKernel(cur: number) {
    const next = 1 - cur, w = this.w, h = this.h, s = this.sU;
    const hTex = this.tex[cur], hD = this.dtex[cur], oTex = this.tex[next], oD = this.dtex[next];
    const project = (X: Node) => {
      const v = X.sub(s.prevPos).toVar();
      const z = dot(v, s.prevFwd).toVar();
      const uv = vec2(dot(v, s.prevRight).div(z.mul(s.prevTan.x)), dot(v, s.prevUp).div(z.mul(s.prevTan.y))).mul(0.5).add(0.5);
      return { uv, z };
    };
    return Fn(() => {
      const x = instanceIndex.mod(w), y = instanceIndex.div(w);
      const fc = vec2(float(x), float(y)).add(0.5).toVar();
      const uv = fc.div(s.size).toVar();
      const ndc = uv.mul(2).sub(1);
      const rd = normalize(s.fwd.add(s.right.mul(ndc.x.mul(s.tan.x))).add(s.up.mul(ndc.y.mul(s.tan.y)))).toVar();
      // clouds are effectively at infinity: reproject by direction
      const bord = vec2(1).div(s.size).toVar();
      const inRect = (q: Node) => q.x.greaterThanEqual(bord.x).and(q.y.greaterThanEqual(bord.y)).and(q.x.lessThanEqual(bord.x.oneMinus())).and(q.y.lessThanEqual(bord.y.oneMinus()));
      const P1 = project(s.camPos.add(rd.mul(1e4)));
      const puv = vec2(P1.uv).toVar();
      const valid = P1.z.greaterThan(0).and(inRect(puv)).and(s.blend.lessThan(1)).toVar();
      const hist = select(valid, texture(hTex, puv).level(0), vec4(0)).toVar();
      const histD = select(valid, texture(hD, puv).level(0).r, 0).toVar();
      const slot = x.bitAnd(1).add(y.bitAnd(1).mul(2));
      const outC = vec4(hist).toVar(), outD = float(histD).toVar();
      If(s.check.equal(1).and(valid).and(s.blend.lessThan(0.5)).and(float(slot).notEqual(s.frame.mod(4))).not(), () => {
        const j = fract(this.jhash(vec3(fc, 17)).add(s.frame.mul(0.618034)));
        const cx: Ctx = { pa: this.screenPass, gFoot: float(0).toVar() };
        const { c, md } = this.shade(cx, s.camPos, rd, s.steps, s.lightSteps, s.lightDetail, j);
        // the clouds drift with the wind aloft (their noise is sampled at p + windOffset): the cloud now at X was at
        // X + dWind a frame ago. Refetch the history there (the camera's own motion included).
        If(s.check.equal(0).and(c.a.lessThan(0.999)).and(s.blend.lessThan(1)), () => {
          const dw = cloudU.windOffset.sub(s.prevWind);
          const P2 = project(s.camPos.add(rd.mul(md)).add(vec3(dw.x, 0, dw.z)));
          const pu = vec2(P2.uv).toVar();
          valid.assign(P2.z.greaterThan(0).and(inRect(pu)));
          If(valid, () => { hist.assign(texture(hTex, pu).level(0)); histD.assign(texture(hD, pu).level(0).r); });
        });
        // temporal accumulation (a checkerboarded pixel is refreshed every 4th frame: blend harder)
        const dk = md.mul(0.001).toVar();
        If(valid, () => {
          const bl = select(s.check.equal(1), min(s.blend.mul(2.5), 1), s.blend);
          // (a non-finite history texel would persist and spread through the bilinear reprojection)
          const bad = anyNonFinite(hist, 4).or(abs(hist.r).add(abs(hist.g)).add(abs(hist.b)).add(abs(hist.a)).lessThan(1e5).not())
            .or(isNonFinite(histD)).or(abs(histD).lessThan(1e6).not());
          c.assign(mix(select(bad, c, hist), c, bl));
          dk.assign(mix(select(bad, dk, histD), dk, bl));
        });
        outC.assign(c); outD.assign(dk);
      });
      textureStore(oTex, uvec2(x, y), outC);
      textureStore(oD, uvec2(x, y), vec4(outD, 0, 0, 1));
    })().compute(w * h);
  }

  // as GL Clouds.render: q = { steps, lightSteps, lightDetail, blend, check, detailFoot, upSteps }; camera: three's
  // camera (world matrix current), its vertical fov in radians
  render(camera: THREE.PerspectiveCamera, q: { steps: number; lightSteps: number; lightDetail: number; blend: number; check: boolean; detailFoot: number; upSteps: number; everyFrame?: boolean }) {
    this.frame++;
    const r = this.renderer;
    // cloud shadow map centred on the camera, snapped to texels to avoid crawling
    const cp = camera.position;
    const texel = this.shadowSize / 256;
    const ox = Math.floor((cp.x - this.shadowSize / 2) / texel) * texel;
    const oz = Math.floor((cp.z - this.shadowSize / 2) / texel) * texel;
    const full = this.reset || this.frame < 4 || q.everyFrame;
    this.sU.camPos.value.copy(cp);
    if (full || this.frame % 2 === 0) {
      this.shadowOrigin.value.set(ox, oz);
      r.compute(this.shadowNode);
      this.shadowRect.value.set(ox, oz, 1 / this.shadowSize, 1 / this.shadowSize);
    }
    // reflection probe clouds (amortised via history blend)
    if (full || this.frame % 2 === 1 || cloudU.flash.value.w > 0.01) {
      this.envFrame.value = this.reset ? 0 : this.frame;
      const en = 1 - this.envCur;
      r.compute(this.envNodes[en]); // writes envTex[en] from envTex[envCur]
      this.envCur = en;
    }
    // the screen pass: camera basis now and one frame ago
    const e = camera.matrixWorld.elements;
    const right = new THREE.Vector3(e[0], e[1], e[2]).normalize(), up = new THREE.Vector3(e[4], e[5], e[6]).normalize();
    const fwd = new THREE.Vector3(-e[8], -e[9], -e[10]).normalize();
    const ty = Math.tan(((camera.fov * Math.PI) / 180) / 2);
    const tan = new THREE.Vector2(ty * camera.aspect, ty);
    const wind = cloudU.windOffset.value.clone();
    const prev = this.prev ?? { pos: cp.clone(), right, up, fwd, tan, wind };
    const s = this.sU;
    s.right.value.copy(right); s.up.value.copy(up); s.fwd.value.copy(fwd); s.tan.value.copy(tan);
    s.prevPos.value.copy(prev.pos); s.prevRight.value.copy(prev.right); s.prevUp.value.copy(prev.up); s.prevFwd.value.copy(prev.fwd);
    s.prevTan.value.copy(prev.tan); s.prevWind.value.copy(prev.wind);
    s.frame.value = this.frame % 64;
    s.blend.value = this.reset ? 1 : q.blend;
    s.steps.value = q.steps; s.lightSteps.value = q.lightSteps; s.lightDetail.value = q.lightDetail; s.check.value = q.check ? 1 : 0;
    this.screenPass.pixelAngle.value = ((camera.fov * Math.PI) / 180) / this.h;
    this.screenPass.detailFoot.value = q.detailFoot;
    this.screenPass.upSteps.value = q.upSteps;
    r.compute(this.screenNodes[this.cur]);
    this.cur = 1 - this.cur;
    this.prev = { pos: cp.clone(), right, up, fwd, tan, wind };
    this.reset = false;
  }
}

function halfTex(w: number, h: number) {
  const t = new THREE.StorageTexture(w, h);
  t.type = THREE.HalfFloatType; // rgba16f (r16f storage writes need an optional feature)
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}
