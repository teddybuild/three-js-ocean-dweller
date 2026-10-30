// open-water's HDR post chain (archive/gl/src/fx/post.js) as three.js WebGPU fullscreen passes: an energy-conserving bloom
// pyramid (13-tap downsample with a Karis average on the first level, additive tent upsample), centre-weighted log
// metering averaged by the mip chain of a 256x256 half-float target, eye adaptation ping-ponged between two 1x1
// float targets, and the composite (exposure, night shift, vignette, AgX + look + EOTF, grain and dither), written
// raw to the canvas. Every pass samples with three's y-down uv(), so passes stay consistent with each other and with
// the HDR target; the tap patterns, vignette and centre weight are symmetric under the flip. Only the grain and
// dither hashes rebuild GL's y-up vUv and gl_FragCoord, so the noise lands on the same pixels as in GL.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { anyNan, anyInf, anyNonFinite, isNonFinite } from './tsl-util';

type Node = any; // @types/three's TSL overloads reject long node chains, so nodes and TSL functions are untyped
const {
  Fn, uniform, float, vec2, vec3, vec4, ivec2, texture, uv, screenCoordinate, screenSize, select, exp, exp2, log, log2,
  pow, clamp, mix, smoothstep, step, max, min, abs, dot, fract, sin,
} = TSL as any;

const MAX_HDR = 60000.0, LUM_SIZE = 256, LUM_LEVEL = 8; // 256 >> 8 = 1: the 1x1 mean of the metering target
const lum = (c: Node) => dot(c, vec3(0.2126, 0.7152, 0.0722));
// non-finite input (a NaN or overflowed pixel) must not spread through the pyramid or the meter
const bad3 = (v: Node) => anyNonFinite(v).or(abs(v.x).add(abs(v.y)).add(abs(v.z)).greaterThanEqual(1e9));
const hash = (p: Node) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));
// GLSL m * v for a mat3 given column by column, as the GL source writes it
const mat3mul = (c0: number[], c1: number[], c2: number[], v: Node) =>
  vec3(...c0).mul(v.x).add(vec3(...c1).mul(v.y)).add(vec3(...c2).mul(v.z));

export interface PostOptions {
  time?: number;
  bloom?: number;
  exposureBias?: number;
  minLum?: number;
  maxLum?: number;
  grain?: number;
  look?: number[]; // x: contrast (power about the pivot), y: pivot, z: saturation, w: black point
  look2?: number[]; // x: highlight contrast, y: saturation in log space (before the curve)
  vignette?: number;
  flashExposure?: number;
  manualExposure?: number;
  fade?: number;
  night?: number;
  incident?: number;
  whiteBalance?: number;
  adaptSpeed?: number;
}

interface Level { rt: THREE.RenderTarget; w: number; h: number; down: THREE.QuadMesh; up: THREE.QuadMesh | null; texel: Node }

const halfTarget = (w: number, h: number, opts: Record<string, unknown> = {}) =>
  new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, ...opts });

function fullscreen(fragment: Node, name: string, additive = false) {
  const m = new THREE.NodeMaterial();
  m.name = name;
  m.fragmentNode = fragment;
  m.depthTest = false;
  m.depthWrite = false;
  if (additive) {
    // GL blendFunc(ONE, ONE) on colour and alpha
    m.blending = THREE.CustomBlending;
    m.blendEquation = m.blendEquationAlpha = THREE.AddEquation;
    m.blendSrc = m.blendSrcAlpha = THREE.OneFactor;
    m.blendDst = m.blendDstAlpha = THREE.OneFactor;
  }
  return new THREE.QuadMesh(m);
}
const disposeQuad = (q: THREE.QuadMesh) => (q.material as THREE.Material).dispose();

// 13-tap downsample (Jimenez 2014); src is a base texture node, texel its 1/size
function downNode(src: Node, texel: Node, first: boolean) {
  return Fn(() => {
    const p = uv().toVar();
    const s = (x: number, y: number) => {
      const v = src.sample(x === 0 && y === 0 ? p : p.add(texel.mul(vec2(x, y)))).rgb.toVar();
      return select(bad3(v), vec3(0), clamp(v, 0, MAX_HDR)).toVar();
    };
    const a = s(-2, 2), b = s(0, 2), c = s(2, 2);
    const d = s(-2, 0), e = s(0, 0), f = s(2, 0);
    const g = s(-2, -2), h = s(0, -2), i = s(2, -2);
    const j = s(-1, 1), k = s(1, 1);
    const l = s(-1, -1), m = s(1, -1);
    let col: Node;
    if (first) {
      // Karis average on the first mip to suppress fireflies from glints
      const groups = [[a, b, d, e], [b, c, e, f], [d, e, g, h], [e, f, h, i], [j, k, l, m]]
        .map((q) => q[0].add(q[1]).add(q[2]).add(q[3]).mul(0.25).toVar());
      const ws = groups.map((q) => float(1).div(lum(q).mul(0.25).add(1)).toVar());
      const wt = [0.125, 0.125, 0.125, 0.125, 0.5];
      const num = groups.map((q, n) => q.mul(ws[n]).mul(wt[n])).reduce((x: Node, y: Node) => x.add(y));
      const den = ws.map((w, n) => w.mul(wt[n])).reduce((x: Node, y: Node) => x.add(y));
      col = num.div(den);
    } else {
      col = e.mul(0.125).add(a.add(c).add(g).add(i).mul(0.03125)).add(b.add(d).add(f).add(h).mul(0.0625))
        .add(j.add(k).add(l).add(m).mul(0.125));
    }
    return vec4(min(col, vec3(MAX_HDR)), 1);
  })();
}

// 3x3 tent upsample, added onto the next finer level
function upNode(src: Node, texel: Node, radius: Node, weight: Node) {
  return Fn(() => {
    const p = uv().toVar();
    const t = texel.mul(radius).toVar();
    const s = (x: Node, y: Node) => src.sample(p.add(vec2(x, y))).rgb;
    const nx = t.x.negate(), ny = t.y.negate();
    const c = src.sample(p).rgb.mul(4).toVar();
    c.addAssign(s(nx, 0).add(s(t.x, 0)).add(s(0, ny)).add(s(0, t.y)).mul(2));
    c.addAssign(s(nx, ny).add(s(t.x, ny)).add(s(nx, t.y)).add(s(t.x, t.y)));
    return vec4(c.div(16).mul(weight), 1);
  })();
}

export class PostChain {
  private renderer: THREE.WebGPURenderer;
  private levels: Level[] = [];
  // base texture nodes whose value is swapped per frame (their sample() clones follow the base)
  private hdrTex = texture();
  private bloomTex = texture();
  private prevTex = texture();
  private adaptTex = texture();
  private lumRT = halfTarget(LUM_SIZE, LUM_SIZE, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  // WebGPU zero-initialises textures, like the GL clear to 0: the first adapt pass sees a bad prev and takes the target
  private adapt = [0, 1].map(() => new THREE.RenderTarget(1, 1, {
    type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  }));
  private adaptCur = 0;
  private upRadius = uniform(1.0);
  // geometric level weights (2^-1.5 per level): a lens PSF with a tight core and a faint wide skirt
  private upWeight = uniform(0.354);
  private lumQuad: THREE.QuadMesh;
  private adaptQuad: THREE.QuadMesh;
  private compQuad: THREE.QuadMesh;
  private aU = { incident: uniform(0.75), whiteBalance: uniform(0.55), dt: uniform(0), speed: uniform(1.5) };
  private cU = {
    bloomStrength: uniform(0.04), exposureBias: uniform(0), minLum: uniform(0.0003), maxLum: uniform(10), time: uniform(0),
    grain: uniform(0.006), vignette: uniform(0.18), flashExposure: uniform(0), manualExposure: uniform(0), fade: uniform(1),
    night: uniform(0), look: uniform(new THREE.Vector4(1.5, 0.4, 1.0, 0.004)), look2: uniform(new THREE.Vector2(1.8, 1.15)),
  };

  constructor(renderer: THREE.WebGPURenderer, opts: { incidentE: Node }) {
    this.renderer = renderer;
    this.lumQuad = fullscreen(this.lumNode(), 'post.lum');
    this.adaptQuad = fullscreen(this.adaptNode(opts.incidentE), 'post.adapt');
    this.compQuad = fullscreen(this.compositeNode(), 'post.composite');
  }

  private lumNode() {
    return Fn(() => {
      const p = uv().toVar();
      const c = this.hdrTex.sample(p).rgb.toVar();
      // centre-weighted metering; a non-finite pixel is left out (weight 0)
      const d = p.sub(0.5).toVar();
      const w = exp(dot(d, d).mul(-3)).toVar();
      // log luminance and log chroma (R/G, B/G): geometric means over the frame via the mip chain
      const cc = max(min(c, vec3(MAX_HDR)), vec3(1e-6)).toVar();
      const o = vec4(log(max(lum(cc), 1e-6)).mul(w), w, log(cc.x.div(cc.y)).mul(w), log(cc.z.div(cc.y)).mul(w));
      return select(bad3(c), vec4(0), o);
    })();
  }

  private adaptNode(E: Node) {
    const u = this.aU;
    return Fn(() => {
      const l = texture(this.lumRT.texture, vec2(0.5)).level(LUM_LEVEL).toVar();
      const scene = l.x.div(max(l.y, 1e-6));
      // incident metering: luminance of an 18% grey card under the current sun + sky light (E, built by the caller)
      const grey = lum(E).mul(0.18 / 3.14159);
      const target = exp(mix(scene, log(max(grey, 1e-6)), u.incident)).toVar();
      // white balance (von Kries, partial) from the scene's mean chroma (grey world), as a camera's AWB
      // estimates it from what is in the frame, limited to the daylight range (~5000-7500 K)
      const iy = max(l.y, 1e-6).toVar();
      const chroma = vec3(exp(l.z.div(iy)), 1, exp(l.w.div(iy))).toVar();
      const cy = lum(chroma);
      const wb0 = clamp(pow(vec3(cy).div(chroma), vec3(u.whiteBalance)), vec3(0.82), vec3(1.22)).toVar();
      const wb = wb0.div(lum(wb0)).toVar();
      const prevT = this.prevTex.load(ivec2(0, 0)).toVar();
      const prev = prevT.x, prevWb = prevT.yzw;
      // NaN and inf are tested on the bits; the range tests are written so a NaN would also fail them
      const badT = isNonFinite(target).or(target.lessThanEqual(0)).or(target.greaterThanEqual(1e9)).or(anyNonFinite(wb));
      const badP = prev.lessThanEqual(0).or(prev.greaterThanEqual(1e9)).or(isNonFinite(prev)).or(anyNan(prevWb))
        .or(anyInf(prevWb)).or(prevWb.y.lessThanEqual(0.1)).or(prevWb.y.greaterThanEqual(10.0));
      const p0 = select(badP, target, prev), pw = select(badP, wb, prevWb);
      const a = exp(u.dt.mul(u.speed).negate()).oneMinus();
      const next = vec4(exp(mix(log(p0), log(target), a)), mix(pw, wb, a));
      return select(badT.and(badP), vec4(1), select(badT, prevT, next));
    })();
  }

  private compositeNode() {
    const u = this.cU;
    const agxContrast = (x: Node) => {
      const x2 = x.mul(x).toVar();
      const x4 = x2.mul(x2).toVar();
      return x4.mul(x2).mul(15.5).sub(x4.mul(x).mul(40.14)).add(x4.mul(31.96)).sub(x2.mul(x).mul(6.868))
        .add(x2.mul(0.4298)).add(x.mul(0.1191)).sub(0.00232);
    };
    const agx = (v0: Node) => {
      const lo = -12.47393, hi = 4.026069;
      const m = mat3mul([0.842479062253094, 0.0423282422610123, 0.0423756549057051],
        [0.0784335999999992, 0.878468636469772, 0.0784336], [0.0792237451477643, 0.0791661274605434, 0.879142973793104], v0);
      const v = clamp(log2(max(m, vec3(1e-10))), lo, hi).sub(lo).div(hi - lo).toVar();
      const lm = lum(v);
      return agxContrast(v.sub(lm).mul(u.look2.y).add(lm).toVar());
    };
    const agxEotf = (v: Node) => mat3mul([1.19687900512017, -0.0528968517574562, -0.0529716355144438],
      [-0.0980208811401368, 1.15190312990417, -0.0980434501171241], [-0.0990297440797205, -0.0989611768448433, 1.15107367264116], v);
    // photographic S-curve in display space: deepens shadows and carries highlights to white,
    // matching the tonal spread of reference photographs (p10 ~5-45, max ~240-255 of 255)
    const agxLook = (v0: Node) => {
      const v = max(v0, vec3(0)).toVar();
      const k = u.look.x, pv = u.look.y;
      // a gentler (near-linear) toe: deep shadows keep some separation
      const klo = mix(vec3(1.1), vec3(k), smoothstep(vec3(0.08), vec3(pv), v));
      const lo = pow(v.div(pv), klo).mul(pv);
      const hi = pow(max(v.oneMinus(), vec3(0)).div(float(1).sub(pv)), vec3(u.look2.x)).mul(float(1).sub(pv)).oneMinus();
      const s = mix(lo, hi, step(vec3(pv), v));
      const b = max(s.sub(u.look.w), vec3(0)).div(float(1).sub(u.look.w)).toVar();
      const luma = lum(b);
      return b.sub(luma).mul(u.look.z).add(luma);
    };
    return Fn(() => {
      const p = uv().toVar();
      const raw = this.hdrTex.sample(p).rgb.toVar();
      // (an overflowed pixel is a bright one; a NaN pixel is dropped)
      const over = anyInf(raw).or(abs(raw.x).add(abs(raw.y)).add(abs(raw.z)).greaterThanEqual(1e9));
      const hdr = select(anyNan(raw), vec3(0), select(over, vec3(MAX_HDR), raw));
      const bloom = this.bloomTex.sample(p).rgb;
      const c = mix(hdr, bloom, u.bloomStrength).toVar();
      const adapt = this.adaptTex.load(ivec2(0, 0)).toVar();
      const avg = clamp(adapt.x, u.minLum, u.maxLum);
      c.mulAssign(adapt.yzw);
      const exposure = select(u.manualExposure.greaterThan(0), u.manualExposure, float(0.18).div(avg))
        .mul(exp2(u.night.mul(-2.8))).mul(exp2(u.exposureBias).div(u.flashExposure.add(1)));
      c.mulAssign(exposure.mul(u.fade));
      const ly = lum(c);
      c.assign(mix(c, vec3(0.78, 0.9, 1.15).mul(ly), u.night.mul(0.12)));
      const d = p.sub(0.5).toVar();
      c.mulAssign(float(1).sub(u.vignette.mul(dot(d, d)).mul(1.6)));
      c.assign(clamp(agxEotf(agxLook(agx(c))), 0, 1));
      // luminance grain (film-like, stronger in mid-tones) + triangular dither against banding; GL's vUv and
      // gl_FragCoord are y-up
      const vUv = vec2(p.x, p.y.oneMinus()).toVar();
      const frag = vec2(screenCoordinate.x, screenSize.y.sub(screenCoordinate.y));
      const n = hash(vUv.mul(1931.7).add(fract(u.time.mul(7.31)))).add(hash(vUv.mul(1173.3).add(fract(u.time.mul(3.17))))).sub(1);
      const l2 = lum(c).toVar();
      c.addAssign(n.mul(u.grain).mul(u.night.mul(1.6).add(1)).mul(l2.mul(l2.oneMinus()).mul(4).add(0.35)));
      c.addAssign(hash(frag.add(fract(u.time).mul(91.0))).sub(0.5).div(255.0));
      return vec4(c, 1);
    })();
  }

  resize(w: number, h: number) {
    for (const lv of this.levels) {
      lv.rt.dispose();
      disposeQuad(lv.down);
      if (lv.up) disposeQuad(lv.up);
    }
    this.levels = [];
    let lw = w >> 1, lh = h >> 1;
    for (let i = 0; i < 7 && lw > 4 && lh > 4; i++) {
      const rt = halfTarget(lw, lh);
      const src = i === 0 ? this.hdrTex : texture(this.levels[i - 1].rt.texture);
      const texel = uniform(new THREE.Vector2());
      const down = fullscreen(downNode(src, texel, i === 0), `bloom.down${i}`);
      // the upsample from this level into the one above: reads this level, 1 / its size
      const upTexel = uniform(new THREE.Vector2(1 / lw, 1 / lh));
      const up = i === 0 ? null
        : fullscreen(upNode(texture(rt.texture), upTexel, this.upRadius, this.upWeight), `bloom.up${i}`, true);
      this.levels.push({ rt, w: lw, h: lh, down, up, texel });
      lw >>= 1; lh >>= 1;
    }
  }

  private draw(quad: THREE.QuadMesh, target: THREE.RenderTarget | null) {
    this.renderer.setRenderTarget(target);
    quad.render(this.renderer);
  }

  render(hdr: THREE.Texture, dt: number, opts: PostOptions = {}) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget(), prevAutoClear = r.autoClear;
    // every pass covers its whole target, and the upsample adds onto what the downsample wrote
    r.autoClear = false;
    this.hdrTex.value = hdr;
    this.bloomTex.value = this.levels.length ? this.levels[0].rt.texture : hdr;

    // bloom pyramid
    let { width: sw, height: sh } = hdr.image as { width: number; height: number };
    for (const lv of this.levels) {
      lv.texel.value.set(1 / sw, 1 / sh);
      this.draw(lv.down, lv.rt);
      sw = lv.w; sh = lv.h;
    }
    for (let i = this.levels.length - 1; i > 0; i--) this.draw(this.levels[i].up!, this.levels[i - 1].rt);

    // eye adaptation: meter (mips generated when the pass ends), then prev -> next
    this.draw(this.lumQuad, this.lumRT);
    const next = 1 - this.adaptCur;
    this.prevTex.value = this.adapt[this.adaptCur].texture;
    this.aU.incident.value = opts.incident ?? 0.75;
    this.aU.whiteBalance.value = opts.whiteBalance ?? 0.55;
    this.aU.dt.value = dt;
    this.aU.speed.value = opts.adaptSpeed ?? 1.5;
    this.draw(this.adaptQuad, this.adapt[next]);
    this.adaptCur = next;

    // composite
    const u = this.cU;
    this.adaptTex.value = this.adapt[this.adaptCur].texture;
    u.bloomStrength.value = opts.bloom ?? 0.04;
    u.exposureBias.value = opts.exposureBias ?? 0;
    u.minLum.value = opts.minLum ?? 0.0003;
    u.maxLum.value = opts.maxLum ?? 10;
    u.time.value = opts.time ?? 0;
    u.grain.value = opts.grain ?? 0.006;
    u.look.value.fromArray(opts.look ?? [1.5, 0.4, 1.0, 0.004]);
    u.look2.value.fromArray(opts.look2 ?? [1.8, 1.15]);
    u.vignette.value = opts.vignette ?? 0.18;
    u.flashExposure.value = opts.flashExposure ?? 0;
    u.manualExposure.value = opts.manualExposure ?? 0;
    u.fade.value = opts.fade ?? 1;
    u.night.value = opts.night ?? 0;
    // the composite already outputs display values (GL writes them raw to a non-sRGB canvas): with no tone mapping
    // and the working colour space as output, three skips its framebuffer target and output pass and draws straight
    // to the canvas, as its own RenderPipeline.render() does for its final quad
    const toneMapping = r.toneMapping, outputColorSpace = r.outputColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    r.outputColorSpace = THREE.ColorManagement.workingColorSpace;
    this.draw(this.compQuad, null);
    r.toneMapping = toneMapping;
    r.outputColorSpace = outputColorSpace;

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
  }

  dispose() {
    this.resize(0, 0);
    this.lumRT.dispose();
    for (const t of this.adapt) t.dispose();
    for (const q of [this.lumQuad, this.adaptQuad, this.compQuad]) disposeQuad(q);
  }
}
