// open-water's ocean surface (archive/gl/src/ocean/water.js) in TSL: the camera-centred polar grid displaced by the FFT
// cascades (mip level per ring, earth curvature), shaded with a slope-variance (LEAN / Bruneton 2010) Beckmann BRDF,
// the reflected environment, physically based water-leaving radiance, crest subsurface scattering, foam, active
// breaking, glints, the mirrored lightning channel and aerial perspective. RAIN_SURFACE_GLSL (archive/gl/src/fx/ripples.js)
// is ported here too. Crepuscular rays and fog are stubs until milestone 5.
// Derivatives and implicit-LOD samples are all taken (and stored in vars) before any non-uniform branch: WGSL
// requires uniform control flow for them, and three emits select() as if/else blocks.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { atmoU } from './atmosphere';
import type { SkyCompute } from './sky';

// Sea grade: reflected sky and water body x SEA_GRADE; sun glints and foam stay full.
const SEA_GRADE = 0.7;
import { foamCoverage } from './foam';

type Node = any; // @types/three's TSL overloads reject long node chains, so nodes and TSL functions are untyped
const {
  Fn, Loop, If, uniform, float, vec2, vec3, vec4, select, sqrt, pow, exp, log, log2, abs, cos, sin, acos, atan, clamp,
  mix, smoothstep, max, min, length, normalize, dot, cross, reflect, texture, floor, fract, dFdx, dFdy, attribute,
  varyingProperty, cameraProjectionMatrix, cameraViewMatrix,
} = TSL as any;

const M_PI = 3.14159265359;
const SQRT_PI = Math.sqrt(M_PI);
const LUMA = [0.2126, 0.7152, 0.0722];

export interface WaterInputs {
  disp: THREE.Texture[];   // 3 cascades: rgba16f, xyz displacement (x, y, z in metres), w foam; repeat, mips
  slope: THREE.Texture[];  // 4 cascades: xy slope, zw slope^2; repeat, mips
  active: THREE.Texture[]; // 2: [0] = cascade 0 (1800 m, GL uActive0), [1] = cascade 1 (117 m, GL uActive); value in .r
  sizes: number[]; texels: number[]; // cascade L (m) and L/N, 4 each
  env: THREE.Texture;      // equirect 512x256 with mips (SkyCompute.env)
  sky: SkyCompute;
  foamTex: THREE.Texture;
  shadow: THREE.Texture;   // cloud-shadow map (CloudsCompute.shadow)
  shadowRect: Node;        // its origin xz and 1/size (CloudsCompute.shadowRect)
}

// ---- RAIN_SURFACE_GLSL: raindrop impact ring waves (procedural, analytic slopes). Capillary ring packets expand at
// ~0.23 m/s (minimum phase speed of capillary-gravity waves) and die out within a second. Far away the rings are
// sub-pixel: their energy becomes roughness.

const rhash3 = (p: Node) =>
  fract(sin(vec3(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)), dot(p, vec2(419.2, 371.9)))).mul(43758.5453));

function rippleLayer(xz: Node, t: Node, cell: number, life: number, rain: Node, seed: number) {
  const p = xz.div(cell).add(seed).toVar();
  const base = floor(p).sub(1).toVar();
  const slope = vec2(0).toVar();
  Loop(3, 3, ({ i: jj, j: ii }: Node) => {
    const cid = base.add(vec2(float(ii), float(jj))).toVar();
    const h = rhash3(cid.add(seed * 7.13)).toVar();
    const period = h.z.add(1).mul(life).toVar();
    const tt = t.div(period).add(h.x.mul(13.7)).toVar();
    const cycle = floor(tt);
    const tl = fract(tt).mul(period).toVar(); // seconds since impact
    const h2 = rhash3(cid.add(cycle.mul(0.618)).add(seed)).toVar();
    const c = cid.add(0.2).add(h2.xy.mul(0.6)).sub(seed).mul(cell);
    const d = xz.sub(c).toVar();
    const r = length(d).toVar();
    const R = tl.mul(0.24).add(0.012).toVar();
    const w = tl.mul(0.03).add(0.012);
    const x = r.sub(R).div(w).toVar();
    // (GL: continue when inactive this cycle, or outside the packet)
    If(h2.z.lessThanEqual(rain).and(abs(x).lessThanEqual(3)), () => {
      const lambda = tl.mul(0.01).add(0.016);
      const env = exp(x.mul(x).negate()).mul(exp(tl.mul(-2.5))).mul(mix(0.3, 1, h2.x.mul(h2.x))).toVar();
      env.mulAssign(smoothstep(0.9 * cell, 1.2 * cell, r).oneMinus().mul(smoothstep(period.mul(0.7), period, tl).oneMinus()));
      const ds = env.mul(cos(r.sub(R).mul(6.2831).div(lambda))).mul(h.y.mul(0.16).add(0.22));
      slope.addAssign(ds.mul(d).div(max(r, 1e-4)));
    });
  });
  return slope;
}

// Impact craters: a dimple ~1 cm wide at every drop impact, relaxing within ~60 ms. One jittered impact per cell and
// cycle (radius << cell: no neighbour search).
function craterLayer(xz: Node, t: Node, cell: number, life: number, rain: Node, seed: number) {
  const p = xz.div(cell).add(seed).toVar();
  const id = floor(p).toVar();
  const h = rhash3(id.add(seed * 3.1)).toVar();
  const period = h.z.add(1).mul(life).toVar();
  const tt = t.div(period).add(h.x.mul(11.3)).toVar();
  const tl = fract(tt).mul(period);
  const h2 = rhash3(id.add(floor(tt).mul(0.731)).add(seed)).toVar();
  const d = p.sub(id).sub(h2.xy.mul(0.7).add(0.15)).mul(cell).toVar();
  const sig = h.y.mul(h.y).mul(0.006).add(0.004).toVar();
  const A = exp(tl.div(-0.06)).mul(1.1);
  return select(h2.z.greaterThan(rain), vec2(0), A.mul(2).mul(d).div(sig).mul(exp(dot(d, d).negate().div(sig.mul(sig)))));
}

// GLSL mat2 R1 = mat2(0.934, 0.358, -0.358, 0.934), R2 = mat2(0.799, -0.602, 0.602, 0.799) (column-major)
const rot = (c: number, s: number, v: Node) => vec2(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)));
const rotT = (c: number, s: number, v: Node) => vec2(v.x.mul(c).add(v.y.mul(s)), v.x.mul(-s).add(v.y.mul(c)));

// vec3(slope xy, isotropic roughness). pix: pixel footprint (m). Rings (1.6-2.6 cm wavelength) and craters (~1 cm)
// are drawn only while they are resolved; beyond that their energy is roughness (and the stipple in the water).
export function rainRipples(xz: Node, t: Node, rain: Node, _dist: Node, pix: Node) {
  const out = vec3(0).toVar();
  If(rain.greaterThanEqual(0.002), () => {
    const near = smoothstep(0.005, 0.011, pix).oneMinus().toVar();
    const s = vec2(0).toVar();
    If(near.greaterThan(0), () => {
      const density = clamp(rain.mul(1.4), 0, 1).toVar();
      s.addAssign(rippleLayer(xz, t, 0.21, 0.55, density, 0.0));
      s.addAssign(rippleLayer(xz, t.add(0.31), 0.17, 0.5, density.mul(0.9), 3.7));
      s.addAssign(rippleLayer(xz, t.add(0.73), 0.27, 0.65, density.mul(0.8), 9.1));
      s.addAssign(rippleLayer(xz, t.add(0.17), 0.1, 0.45, density.mul(0.85), 13.3));
      s.addAssign(rippleLayer(xz, t.add(0.49), 0.12, 0.5, density.mul(0.85), 17.9));
      s.mulAssign(near);
      // ~2600 impacts per m2 and second at the heaviest rate; resolved only within a few metres
      const cr = smoothstep(0.003, 0.006, pix).oneMinus().toVar();
      If(cr.greaterThan(0), () => {
        // two layers on rotated, differently sized grids: no visible lattice
        const c1 = craterLayer(rotT(0.934, 0.358, xz), t, 0.043, 0.25, density.mul(0.8), 1.3);
        const c2 = craterLayer(rotT(0.799, -0.602, xz), t.add(0.11), 0.061, 0.3, density.mul(0.8), 5.9);
        s.addAssign(rot(0.934, 0.358, c1).add(rot(0.799, -0.602, c2)).mul(cr));
      });
    });
    // sub-pixel ring energy -> isotropic roughness (per-axis slope variance)
    out.assign(vec3(s, rain.mul(0.006).mul(near.mul(0.6).oneMinus())));
  });
  return out;
}

// ---- water shading helpers

const ghash = (p: Node) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
function gnoise(p: Node) {
  const i = floor(p).toVar(), f0 = fract(p).toVar();
  const f = f0.mul(f0).mul(f0.mul(-2).add(3)).toVar();
  return mix(mix(ghash(i), ghash(i.add(vec2(1, 0))), f.x), mix(ghash(i.add(vec2(0, 1))), ghash(i.add(vec2(1, 1))), f.x), f.y);
}

// (sky.ts keeps its equirectUv private; same mapping)
const equirectUv = (d: Node) => vec2(atan(d.z, d.x).div(2 * M_PI).add(0.5), acos(clamp(d.y, -1, 1)).div(M_PI));

// Bruneton et al. 2010 (after Ross et al. 2005), Beckmann with slope variance.
const erfc_ = (x: Node) => exp(x.mul(x).negate()).mul(2).div(x.mul(2.319).add(sqrt(x.mul(x).mul(1.52).add(4))));
function Lambda(cosTheta: Node, sigmaSq: Node) {
  const v = cosTheta.div(sqrt(cosTheta.mul(cosTheta).oneMinus().mul(sigmaSq.mul(2)))).toVar();
  return max(0, exp(v.mul(v).negate()).sub(v.mul(SQRT_PI).mul(erfc_(v))).div(v.mul(2).mul(SQRT_PI)));
}
const meanFresnel = (cosThetaV: Node, sigmaV: Node) =>
  pow(max(cosThetaV.oneMinus(), 0), exp(sigmaV.mul(-2.69)).mul(5)).div(pow(sigmaV, 1.5).mul(22.7).add(1));

function reflectedSun(L: Node, V: Node, N: Node, Tx: Node, Ty: Node, sigmaSq: Node) {
  const H = normalize(L.add(V)).toVar();
  const zH = dot(H, N).toVar();
  const zetax = dot(H, Tx).div(zH).toVar();
  const zetay = dot(H, Ty).div(zH).toVar();
  const p = exp(zetax.mul(zetax).div(sigmaSq.x).add(zetay.mul(zetay).div(sigmaSq.y)).mul(-0.5))
    .div(sqrt(sigmaSq.x.mul(sigmaSq.y)).mul(2 * M_PI)).toVar();
  const tv = vec2(dot(V, Tx), dot(V, Ty)).toVar();
  const cosV2 = tv.x.mul(tv.x).div(max(dot(tv, tv), 1e-12)).toVar();
  const sigmaV2 = sigmaSq.x.mul(cosV2).add(sigmaSq.y.mul(cosV2.oneMinus()));
  const tl = vec2(dot(L, Tx), dot(L, Ty)).toVar();
  const cosL2 = tl.x.mul(tl.x).div(max(dot(tl, tl), 1e-12)).toVar();
  const sigmaL2 = sigmaSq.x.mul(cosL2).add(sigmaSq.y.mul(cosL2.oneMinus()));
  const fresnel = pow(max(dot(V, H).oneMinus(), 0), 5).mul(0.98).add(0.02);
  const zL = clamp(dot(L, N), 0.01, 0.9999).toVar();
  const zV = clamp(dot(V, N), 0.01, 0.9999).toVar();
  const r = fresnel.mul(p).div(Lambda(zL, sigmaL2).add(1).add(Lambda(zV, sigmaV2)).mul(zV).mul(zH).mul(zH).mul(zH).mul(zH).mul(4));
  return select(zH.lessThanEqual(0), float(0), r);
}

// C2-smooth bilinear (Quilez): remap the fractional texel position with a quintic
function smoothUv(uv: Node, res: number) {
  const x = uv.mul(res).add(0.5).toVar();
  const i = floor(x).toVar();
  const f0 = x.sub(i).toVar();
  const f = f0.mul(f0).mul(f0).mul(f0.mul(f0.mul(6).sub(15)).add(10));
  return i.add(f).sub(0.5).div(res);
}

const hash13 = (p: Node, k: number[]) => fract(sin(dot(p, vec3(...k))).mul(43758.5453));

export class WaterMesh {
  mesh: THREE.Mesh;
  u = {
    camPos: uniform(new THREE.Vector3()),
    dispScale: uniform(1),
    longSlope: uniform(0.01),     // rms slope of the dominant (1800 m cascade) waves
    glintArea: uniform(2e-5),     // area of a glinting capillary facet (m2)
    glintExp: uniform(1),         // glints integrated by the exposure (long at night)
    unresolved: uniform(0),       // unresolved mean square slope (Cox-Munk remainder)
    mssTotal: uniform(0),         // total mean square slope of the surface (Cox-Munk)
    hs: uniform(1),
    rrs: uniform(new THREE.Vector3(0.0004, 0.003, 0.0085)), // water-leaving remote sensing reflectance (1/sr)
    sss: uniform(new THREE.Vector3(0.004, 0.05, 0.042)),    // crest scatter colour * strength
    gust: uniform(new THREE.Vector3()), // x: gustiness 0..1, yz: downwind drift of the gust pattern (m)
    foamAmount: uniform(1),
    foamLace: uniform(0),         // residual foam lace everywhere at gale force (stage-B whitecaps)
    time: uniform(0),
    rain: uniform(0),
    flash: uniform(new THREE.Vector3()), // lightning illuminance
    bolt: uniform(new THREE.Vector4(0, 0, 0, 0)),  // ground strike: foot xz, channel top height, channel radiance (0: none)
    windDir: uniform(new THREE.Vector2(1, 0)),
    foamStretch: uniform(0),      // 0: isotropic patches, 1: fully streaky (gale)
    dbgMask: uniform(new THREE.Vector3(1, 1, 1)), // debug: reflection, sun, body multipliers
    debug: uniform(0),            // 1: (foam, foamRaw, foamCovA)
  };

  constructor(inputs: WaterInputs, { angular = 512, center = 0.03, far = 40000 }: { angular?: number; center?: number; far?: number } = {}) {
    // the grid: rings in geometric progression, so a cell is about as deep as it is wide everywhere
    const ang = (2 * Math.PI) / angular;
    const q = 1 + ang;
    const a = center / ang;
    const radii = [0];
    const rings = Math.ceil(Math.log(far / a + 1) / Math.log(q));
    for (let i = 1; i <= rings; i++) {
      const r = a * (Math.pow(q, i) - 1);
      radii.push(r);
      if (r > far) break;
    }
    const nr = radii.length;
    const verts = new Float32Array(nr * (angular + 1) * 2);
    let o = 0;
    for (let i = 0; i < nr; i++)
      for (let j = 0; j <= angular; j++) { verts[o++] = radii[i]; verts[o++] = j * ang; }
    const idx = new Uint32Array((nr - 1) * angular * 6);
    o = 0;
    for (let i = 0; i < nr - 1; i++)
      for (let j = 0; j < angular; j++) {
        const a0 = i * (angular + 1) + j, a1 = a0 + 1, b0 = a0 + angular + 1, b1 = b0 + 1;
        idx[o++] = a0; idx[o++] = b0; idx[o++] = a1;
        idx[o++] = a1; idx[o++] = b0; idx[o++] = b1;
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('aPolar', new THREE.BufferAttribute(verts, 2)); // radius (m), angle (rad)
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    // no position attribute to bound: the grid follows the camera and is never culled (sorting reads this sphere)
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), far * 1.5);

    const m = new THREE.NodeMaterial();
    m.name = 'water';
    m.side = THREE.DoubleSide; // (GL draws without face culling)
    m.fog = false;
    m.lights = false;
    m.toneMapped = false;
    const vWorld = varyingProperty('vec3', 'vWorld');
    const vXZ = varyingProperty('vec2', 'vXZ');
    const vDisp = varyingProperty('float', 'vDisp');
    m.vertexNode = this.vertex(inputs, ang, vWorld, vXZ, vDisp);
    m.fragmentNode = this.fragment(inputs, vWorld, vXZ, vDisp);

    this.mesh = new THREE.Mesh(geo, m);
    this.mesh.name = 'water';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false; // the vertex stage outputs clip space from world positions: no model matrix
  }

  private vertex(inp: WaterInputs, angStep: number, vWorld: Node, vXZ: Node, vDisp: Node) {
    const u = this.u;
    return Fn(() => {
      const polar = attribute('aPolar', 'vec2');
      const r = polar.x.toVar();
      const xz = u.camPos.xz.add(vec2(cos(polar.y), sin(polar.y)).mul(r)).toVar();
      // vertex spacing at this ring -> mip level per cascade (filters waves the mesh cannot carry)
      const spacing = max(r.mul(angStep), 0.02);
      const lsp = log2(spacing.mul(1.5)).toVar();
      const D = vec3(0).toVar();
      for (let c = 0; c < 3; c++) {
        D.addAssign(texture(inp.disp[c], xz.div(inp.sizes[c])).level(max(lsp.sub(Math.log2(inp.texels[c])), 0)).xyz);
      }
      D.mulAssign(u.dispScale);
      const Px = xz.x.add(D.x).toVar(), Pz = xz.y.add(D.z).toVar();
      // earth curvature
      const dr = length(vec2(Px, Pz).sub(u.camPos.xz)).toVar();
      const P = vec3(Px, D.y.sub(dr.mul(dr).div(2.0 * 6360000.0)), Pz).toVar();
      vWorld.assign(P);
      vXZ.assign(xz);
      vDisp.assign(D.y);
      return cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(P, 1));
    })();
  }

  private fragment(inp: WaterInputs, vWorld: Node, vXZ: Node, vDisp: Node) {
    const u = this.u, sky = inp.sky, S = inp.sizes, X = inp.texels;
    // Sky seen by a rough facet ensemble: reflected rays spread by el (radians) in elevation. Tilting a facet
    // sideways turns a reflected ray of elevation e by only ~el tan(e) in azimuth, so at grazing angles the blur is a
    // narrow vertical streak, not a disk (a disk would average in sky far to the side: the sun's aureole). Hardware
    // anisotropic filtering takes the streak.
    const envSample = (d0: Node, el: Node) => {
      const d = normalize(vec3(d0.x, max(d0.y, 0), d0.z)).toVar();
      const az = float(el).mul(min(d.y.div(max(sqrt(d.y.mul(d.y).oneMinus()), 1e-3)).add(0.03), 3));
      return texture(inp.env, equirectUv(d)).grad(vec2(az.div(2 * M_PI), 0), vec2(0, float(el).div(M_PI))).rgb;
    };
    return Fn(() => {
      const xz = vXZ.toVar(), disp = vDisp.toVar();
      const sunE = sky.sunIlluminance().toVar();
      const skyE = sky.skyIrradiance().toVar();
      const P = vWorld.toVar();
      // area of the pixel footprint on the sea (m2)
      const footA = max(length(cross(dFdx(P), dFdy(P))), 1e-9).toVar();
      const toCam = u.camPos.sub(P).toVar();
      const dist = length(toCam).toVar();
      // footprint-aligned cells of about one pixel (for per-pixel random events: glints, impacts)
      const ex = dFdx(xz).toVar(), ey = dFdy(xz).toVar();
      const qc = xz.sub(u.camPos.xz).toVar();
      const gCell = floor(vec2(dot(qc, ex).div(max(dot(ex, ex), 1e-12)), dot(qc, ey).div(max(dot(ey, ey), 1e-12)))).toVar();
      const V = toCam.div(dist).toVar();

      // slopes and their variance from all cascades (hardware anisotropic + trilinear filtering)
      const s = vec2(0).toVar();
      const vr = vec2(0).toVar();
      const ms = [0, 1, 2, 3].map((c) => texture(inp.slope[c], xz.div(S[c])).toVar());
      const SLOPE = (c: number, k: Node) => {
        const mm = ms[c];
        s.addAssign(mm.xy.mul(k));
        vr.addAssign(max(mm.zw.sub(mm.xy.mul(mm.xy)), vec2(0)).mul(k).mul(k));
      };
      // short-wave modulation: gust patches (cat's paws, ~100-300 m, drifting with the wind) and hydrodynamic
      // modulation (short waves steepen on the crests of the long waves)
      const gq = xz.sub(u.gust.yz).toVar();
      const gust = gnoise(gq.div(210)).mul(0.6).add(gnoise(gq.div(70).add(7.3)).mul(0.4)).toVar();
      const crestM = smoothstep(u.hs.mul(-0.3), u.hs.mul(0.3), disp).toVar();
      SLOPE(0, float(1));
      // the forward (downwind) faces of the dominant waves: steep short waves and breaking live there
      const face = smoothstep(0, 1, dot(s, u.windDir).negate().div(max(u.longSlope, 0.01))).toVar();
      const hm = clamp(crestM.mul(0.6).add(face.mul(0.4)), 0, 1);
      const sm = clamp(u.gust.x.mul(gust.sub(0.5)).add(1).mul(mix(0.8, 1.25, hm)), 0.6, 1.5).toVar();
      SLOPE(1, mix(1, sm, 0.5).toVar());
      // slopes of the waves long enough to make thin, backlit crests
      const sL = vec2(s).toVar();
      SLOPE(2, sm);
      SLOPE(3, sm);

      // quintic-smoothed lookups: thresholding a bilinear coarse field gives polygonal outlines (explicit
      // gradients: the remapped coordinates must not drive mip selection)
      const u0 = xz.div(S[0]).toVar(), u1 = xz.div(S[1]).toVar();
      const u0x = dFdx(u0).toVar(), u0y = dFdy(u0).toVar(), u1x = dFdx(u1).toVar(), u1y = dFdy(u1).toVar();
      const d0 = texture(inp.disp[0], smoothUv(u0, S[0] / X[0])).grad(u0x.mul(0.5), u0y.mul(0.5)).toVar();
      const d1 = texture(inp.disp[1], smoothUv(u1, S[1] / X[1])).grad(u1x.mul(0.5), u1y.mul(0.5)).toVar();
      const d2 = texture(inp.disp[2], xz.div(S[2])).toVar();
      const foamRaw = d0.w.mul(0.15).add(d1.w.mul(1.0)).add(d2.w.mul(0.75)).toVar();
      // waves break on the crests of the energetic (dominant) waves: whitecaps cluster there
      const crest = smoothstep(u.hs.mul(-0.2), u.hs.mul(0.3), disp).toVar();
      foamRaw.mulAssign(mix(0.4, 1.5, crest));
      // (the crest moves downwind: a point collects the froth of crests now 1.5-5 m downwind of it)
      const ga = u1x.mul(1.6).toVar(), gb = u1y.mul(1.6).toVar(), wo = u.windDir.div(S[1]).toVar();
      const act = (uv: Node) => texture(inp.active[1], uv).grad(ga, gb).r;
      const c0 = act(u1).toVar();
      const aT = max(c0, c0.add(act(u1.add(wo.mul(1.5))).mul(0.8)).add(act(u1.add(wo.mul(3))).mul(0.55)).add(act(u1.add(wo.mul(5))).mul(0.3)).div(1.8));
      const a0 = texture(inp.active[0], u0).grad(u0x.mul(1.2), u0y.mul(1.2)).r;
      const activeRaw = aT.mul(1.2).mul(mix(0.6, 1.6, clamp(a0, 0, 1))).toVar();
      activeRaw.mulAssign(mix(0.6, 1.35, crest).mul(mix(0.6, 1.4, face)));
      // bubble plume: the same foam fields blurred over a few metres (bubbles spread and sink); it follows recent
      // breaking: mostly the active field, a little of the old foam
      const pa = texture(inp.active[1], u1).level(3.5).r;
      const plume = clamp(pa.mul(1.5).mul(mix(0.5, 1.3, crest)), 0, 2).toVar();

      // foam coverage (GL evaluates it after the body: it reads only the values above, and its derivatives stay in
      // uniform control flow here, before the glint and stipple branches)
      const fc = foamCoverage({ tex: inp.foamTex, windDir: u.windDir, stretch: u.foamStretch }, xz,
        foamRaw.mul(u.foamAmount), u.foamLace.mul(u.foamAmount), activeRaw.mul(u.foamAmount), dist);

      // rain ripples: normal perturbation near the camera, extra roughness further away
      const rr = rainRipples(xz, u.time, u.rain, dist, sqrt(footA)).toVar();
      s.addAssign(rr.xy);
      // unresolved capillary roughness: sparkles near the camera, smooth BRDF lobe far away
      const unres = u.unresolved.mul(0.5).mul(sm).mul(sm).mul(u.rain.mul(0.4).oneMinus()).toVar();
      const sig0 = max(vr.add(unres), vec2(2e-5)).toVar();

      const N = normalize(vec3(s.x.negate(), 1, s.y.negate())).toVar();
      // specular anti-aliasing (Kaplanyan & Hoffman 2016): normal variation inside the pixel footprint becomes extra
      // slope variance, so sub-pixel ripples don't alias into hairlines
      const dNx = dFdx(N).toVar(), dNy = dFdy(N).toVar();
      const kv = min(dot(dNx, dNx).add(dot(dNy, dNy)).mul(0.5), 0.08);
      // the footprint cannot hold more slope variance than the whole surface has (Cox-Munk): beyond that the glitter
      // path would stop narrowing toward the horizon. Rain roughness comes on top.
      const sigmaSun = min(sig0.add(kv), vec2(u.mssTotal.mul(0.5))).add(rr.z).toVar();
      const sigmaSq = min(sig0, vec2(u.mssTotal.mul(0.5))).add(rr.z).toVar();
      const Ty = normalize(cross(N, vec3(1, 0, 0))).toVar();
      const Tx = cross(Ty, N).toVar();

      const L = atmoU.sun;
      const nv = clamp(dot(N, V), 0, 1).toVar();
      // view-direction slope variance for the averaged Fresnel
      const vh = normalize(V.xz.add(1e-6)).toVar();
      const sigmaV = sqrt(dot(vh.mul(vh), sigmaSq)).toVar();
      const F = meanFresnel(nv, sigmaV).mul(0.98).add(0.02).toVar();

      // sun visibility through clouds
      const suv = P.xz.sub(inp.shadowRect.xy).mul(inp.shadowRect.zw).toVar();
      const sunVis = mix(atmoU.hazeSun, texture(inp.shadow, suv).level(0).r,
        smoothstep(0, 0.04, min(min(suv.x, suv.y), min(suv.x.oneMinus(), suv.y.oneMinus())))).toVar();

      // reflection of the sky / clouds, blurred by the unresolved roughness (GL's unused dR = |fwidth(R)| dropped)
      const R0 = reflect(V.negate(), N).toVar();
      const Ed = sunE.mul(sunVis).mul(max(L.y, 0)).add(skyE).add(u.flash.mul(0.3)).toVar();
      // on a rough sea the facets we see lean toward us (Smith masking): the reflected rays rise
      const Ry = R0.y.add(sigmaV.mul(1.1).mul(nv.oneMinus())).toVar();
      // a ray reflected downwards hits the next wave: it sees that wave's water and, reflected once more, the sky
      // about two rms slopes up (not the brightest band at the horizon). The lobe has an angular width ~2 sigma:
      // blend by the fraction below the horizon (no per-pixel dashes).
      const sxy = sigmaSq.x.add(sigmaSq.y).toVar();
      const lobe = sqrt(sxy).mul(2).add(0.02).toVar();
      const below = smoothstep(lobe.negate(), lobe, Ry.negate()).toVar();
      const s2 = sqrt(sxy.mul(0.5)).toVar();
      const F2 = pow(clamp(abs(Ry).add(s2), 0, 1).oneMinus(), 5).mul(0.98).add(0.02).toVar();
      const R = normalize(vec3(R0.x, mix(abs(Ry), max(s2.mul(2).sub(abs(Ry)), 0.01), below), R0.z)).toVar();
      // extended sources (sky, clouds) are blurred by the full capillary roughness, except near the camera where
      // only the sun's tiny disk resolves into sparkles
      const rough = sqrt(max(sxy.sub(unres.mul(2).mul(smoothstep(2, 8, dist).oneMinus())), 4e-5));
      // mip from the BRDF width and from the spread of reflected directions within the pixel
      const envSpread = min(rough.mul(1.18), 1.2);
      const skyC = envSample(R, envSpread).mul(mix(1, F2, below)).add(below.mul(F2.oneMinus()).mul(u.rrs).mul(Ed));
      const refl = F.mul(skyC).toVar();
      // rain impact stipple where a single impact (crater + crown, ~2 cm2) is about pixel-sized: a Poisson count of
      // impacts within the ~60 ms they stay visible; craters see the lower sky (darker), crowns catch the light
      // (brighter)
      If(u.rain.greaterThan(0.01), () => {
        const pix = sqrt(footA).toVar();
        const vis = smoothstep(0.003, 0.006, pix).mul(smoothstep(0.05, 0.15, pix).oneMinus()).toVar();
        If(vis.greaterThan(0), () => {
          const lamC = u.rain.mul(2600).mul(footA).mul(0.15).toVar();
          const u1r = hash13(vec3(gCell, floor(u.time.mul(16))), [12.9898, 78.233, 45.164]).toVar();
          const pk = exp(lamC.negate()).toVar(), cdf = float(pk).toVar(), k = float(0).toVar();
          // Poisson sample by inversion (GL breaks out once u <= cdf; here the remaining steps do nothing)
          Loop(16, () => {
            If(u1r.greaterThan(cdf), () => { k.addAssign(1); pk.mulAssign(lamC.div(k)); cdf.addAssign(pk); });
          });
          const frac = min(float(2e-4).div(footA), 1);
          const Limp = envSample(vec3(0, 1, 0), float(0.8)).mul(0.035).add(u.rrs.mul(Ed));
          const e = k.sub(lamC).mul(frac).toVar();
          refl.assign(select(e.greaterThan(0),
            mix(refl, skyE.mul(0.4).div(M_PI), clamp(e.mul(0.15), 0, 0.2).mul(vis)),
            mix(refl, Limp, clamp(e.negate().mul(0.35), 0, 0.5).mul(vis))));
        });
      });

      // sun glitter
      const sun = sunE.mul(sunVis).mul(reflectedSun(L, V, N, Tx, Ty, sigmaSun)).toVar();
      // Glints: the expected sun reflection is carried by a few capillary facets (~1 cm2) whose slopes happen to
      // mirror the sun's disk (6.8e-5 sr) into the eye. With N facets in the pixel footprint, lambda = E[L]
      // Omega_sun / (F L_sun) N glint on average: near the camera lambda << 1 (sparse, full-brightness sparkles on
      // dark water), far away it is large (the smooth glitter path).
      {
        const Hs = normalize(L.add(V)).toVar();
        const fH = pow(max(dot(V, Hs).oneMinus(), 0), 5).mul(0.98).add(0.02);
        const luma = vec3(...LUMA);
        // (glinting capillary facets of a few cm2)
        const lam = dot(sun, luma).div(max(dot(sunE.mul(sunVis), luma), 1e-9)).mul(6.8e-5).div(fH)
          .mul(footA.div(u.glintArea.mul(mix(1.5, 1, smoothstep(8, 80, dist))))).mul(u.glintExp).toVar();
        const gx = clamp(float(0.15).div(max(V.y, 0.0375)), 1, 3).toVar();
        lam.mulAssign(gx);
        If(lam.greaterThan(1e-7).and(lam.lessThan(400)), () => {
          const jit = floor(fract(sin(gCell.y.mul(12.97).add(3.7)).mul(43758.5453)).mul(gx));
          const cell = vec2(floor(gCell.x.add(jit).div(gx)), gCell.y).toVar();
          const ph = fract(sin(dot(cell, vec2(7.13, 3.71))).mul(912.3));
          const uu = hash13(vec3(cell, floor(u.time.mul(12).add(ph))), [12.9898, 78.233, 37.719]).toVar();
          const k = float(0).toVar();
          If(lam.lessThan(12), () => {
            // Poisson sample by inversion (GL breaks out once u <= cdf; here the remaining steps do nothing)
            const pk = exp(lam.negate()).toVar(), cdf = float(pk).toVar();
            Loop(24, () => {
              If(uu.greaterThan(cdf), () => { k.addAssign(1); pk.mulAssign(lam.div(k)); cdf.addAssign(pk); });
            });
          }).Else(() => {
            // shot noise: Gaussian approximation
            const u2 = fract(uu.mul(113.37).add(0.71));
            k.assign(max(lam.add(sqrt(lam).mul(sqrt(log(max(uu, 1e-6)).mul(-2))).mul(cos(u2.mul(6.2831853)))), 0));
          });
          const u3 = fract(uu.mul(71.13).add(0.23));
          sun.mulAssign(k.div(lam).mul(mix(min(log(max(u3, 1e-3)).negate(), 3).div(0.95), 1, min(k.mul(0.25), 1))));
        });
      }

      // the lightning channel mirrored by the rough sea: a glitter column under the strike
      If(u.bolt.w.greaterThan(0), () => {
        const toB = u.bolt.xy.sub(P.xz).toVar();
        const dh = max(length(toB), 1).toVar();
        const lxz = max(length(R.xz), 1e-4).toVar();
        const rh = R.xz.div(lxz);
        const angB = acos(clamp(dot(rh, toB.div(dh)), -1, 1)).toVar();
        // reflected directions spread by twice the facet slope spread
        const lobeW = max(sqrt(sxy.mul(0.5)).mul(2), float(3).div(dh)).toVar();
        const elev = R.y.div(lxz).toVar();
        const span = smoothstep(-0.005, 0.01, elev).mul(smoothstep(0.7, 1, elev.mul(dh).div(max(u.bolt.z, 1))).oneMinus());
        // a channel ~2 m wide seen through a slope lobe of width lobeW: its radiance spreads over the lobe
        const spread = float(2).div(dh).div(lobeW.mul(2.5066));
        // (only the brightest part of the channel, near the sea, is not hidden by rain and cloud: ~3%)
        sun.addAssign(F.mul(vec3(0.82, 0.86, 1)).mul(u.bolt.w).mul(0.02).mul(exp(angB.mul(angB).negate().div(lobeW.mul(lobeW).mul(2))))
          .mul(span).mul(min(spread, 1)));
      });

      // water-leaving radiance (deep, optically infinite water)
      const body = u.rrs.mul(Ed).mul(F.oneMinus()).div(0.98).toVar();

      // crest subsurface scattering (light transmitted through thin backlit crests)
      const H = max(disp.add(u.hs.mul(0.15)), 0).div(max(u.hs, 0.3));
      // only thin, steep crests near enough to resolve transmit light
      const back = pow(max(dot(L, V.negate()), 0), 4).mul(pow(max(dot(L, N).mul(-0.5).add(0.5), 0), 3))
        .mul(smoothstep(20, 200, dist).oneMinus()).mul(smoothstep(0.15, 0.35, length(sL)));
      const sss = u.sss.mul(F.oneMinus()).mul(H).mul(back).mul(3).mul(sunE).mul(sunVis);

      // submerged bubbles backscatter strongly: the water around and beneath whitecaps turns pale aquamarine
      const pl = exp(plume.mul(u.foamAmount).mul(-1.8)).oneMinus().mul(smoothstep(150, 900, dist).mul(0.6).oneMinus());
      body.addAssign(F.oneMinus().mul(pl).mul(vec3(0.035, 0.062, 0.053)).mul(Ed).div(M_PI));
      const col = refl.mul(u.dbgMask.x).add(body.add(sss).mul(u.dbgMask.z)).mul(SEA_GRADE).add(sun.mul(u.dbgMask.y)).toVar();
      col.addAssign(F.oneMinus().mul(u.rain).mul(0.008).mul(smoothstep(3, 40, dist)).mul(skyE.add(sunE.mul(sunVis).mul(max(L.y, 0)))).div(M_PI));

      // foam
      const foam = fc.cov.x.toVar();
      const dbgFoam = vec3(foam, foamRaw, fc.covA);
      If(foam.greaterThan(0), () => {
        // bubble layer: thick fresh foam is a bright diffuse scatterer (albedo ~0.8); thin residual foam is
        // translucent and picks up the water's blue-green
        const thick = fc.cov.y.toVar();
        const Nf = normalize(vec3(s.x.negate().add(fc.bump.x.mul(1.8)), 1, s.y.negate().add(fc.bump.y.mul(1.8)))).toVar();
        const wrapL = max(dot(Nf, L).add(0.2).div(1.2), 0);
        const Ein = sunE.mul(sunVis).mul(wrapL).add(skyE.mul(Nf.y.mul(0.55).add(0.45))).add(u.flash);
        // bubble foam scatters like a diffuse white layer (albedo ~0.6-0.85); only its thinnest parts let a little
        // of the blue-green water show through
        const albedo = mix(0.5, 0.9, thick);
        const tint = mix(vec3(0.93, 0.97, 0.98), vec3(1), thick);
        const foamCol = tint.mul(albedo).mul(Ein).div(M_PI);
        col.assign(col.mul(foam.mul(mix(0.55, 1, thick)).oneMinus()).add(foamCol.mul(foam)));
      });

      // lightning reflection (broad, from cloud base)
      col.addAssign(F.mul(u.flash).mul(0.08));

      // aerial perspective
      const air = sky.aerial(V.negate(), dist.mul(0.001));
      col.assign(col.mul(air.T).add(air.L));
      // light shafts through cloud gaps in the haze between the camera and this point
      col.assign(sky.withShafts(col, u.camPos, V.negate(), dist));
      // rain / mist fog
      col.assign(sky.applyFog(col, V.negate(), dist, undefined, true));
      return vec4(select(u.debug.equal(1), dbgFoam, col), 1);
    })();
  }
}
