// open-water's rain (src/fx/rain.js) in TSL: motion-blurred drop streaks around the camera and splash crowns and jets
// on the sea surface, as instanced camera-facing quads. Drop diameters follow Marshall-Palmer N(D) = N0 exp(-Lambda D),
// Lambda = 4.1 R^-0.21 /mm; terminal velocity v(D) = 9.65 - 10.3 exp(-0.6 D) m/s (Atlas et al. 1973). A drop covers a
// point of its streak only for D / (v T) of the exposure T (Garg & Nayar 2006).
// GL's gl_VertexID corners are the aCorner attribute of a 4-vertex quad (strip order: (0,0) (1,0) (0,1) (1,1)); the
// per-instance seeds are rng(11) / rng(23) in GL's draw order. The vertex stage outputs clip space from world
// positions (no model matrix), as src/three/water.ts. Blending: premultiplied, ONE / ONE_MINUS_SRC_ALPHA.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { atmoU } from './atmosphere';
import { centroidVarying } from './tsl-util';
import type { SkyCompute } from './sky';
import { rng } from '../math.js';

type Node = any; // @types/three's TSL overloads reject long node chains, so nodes and TSL functions are untyped
const {
  Fn, uniform, float, vec2, vec3, vec4, select, exp, log, abs, sin, atan, acos, min, max, clamp, mix, smoothstep, normalize,
  cross, length, fract, floor, mod, texture, attribute, varyingProperty, cameraProjectionMatrix, cameraViewMatrix,
} = TSL as any;

export type Vec3In = ArrayLike<number> | { x: number; y: number; z: number };
export type Vec2In = ArrayLike<number> | { x: number; y: number };
export const setV3 = (u: Node, v: Vec3In) => {
  if ('x' in v) u.value.set(v.x, v.y, v.z); else u.value.set(v[0], v[1], v[2]);
};
export const setV2 = (u: Node, v: Vec2In) => {
  if ('x' in v) u.value.set(v.x, v.y); else u.value.set(v[0], v[1]);
};

// a quad of 4 corners in GL's TRIANGLE_STRIP order, drawn once per instance
export function quadGeometry(radius = 1e6) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('aCorner', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
  geo.setIndex([0, 1, 2, 2, 1, 3]); // the strip's two triangles, winding kept
  // no position attribute to bound: the quads follow the camera and are never culled (sorting reads this sphere)
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius);
  geo.instanceCount = 0;
  return geo;
}

// seeds as GL makeSeeds: xyz uniform, w an ordered quantile (activating a prefix scales density smoothly)
export function seedAttribute(n: number, seed: number) {
  const r = rng(seed);
  const data = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = r(); data[i * 4 + 1] = r(); data[i * 4 + 2] = r();
    data[i * 4 + 3] = (i + r()) / n;
  }
  return new THREE.InstancedBufferAttribute(data, 4);
}

// GL blendFunc(src, dst), depth test on, depth write off, no face culling
export function fxMaterial(name: string, src: THREE.BlendingSrcFactor, dst: THREE.BlendingDstFactor) {
  const m = new THREE.NodeMaterial();
  m.name = name;
  m.transparent = true;
  m.depthTest = true;
  m.depthWrite = false;
  m.blending = THREE.CustomBlending;
  m.blendSrc = src;
  m.blendDst = dst;
  m.blendEquation = THREE.AddEquation;
  m.side = THREE.DoubleSide;
  m.fog = false;
  m.lights = false;
  m.toneMapped = false;
  return m;
}

export function fxMesh(geo: THREE.BufferGeometry, m: THREE.Material, name: string, renderOrder: number) {
  const mesh = new THREE.Mesh(geo, m);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false; // the vertex stage outputs clip space from world positions: no model matrix
  mesh.renderOrder = renderOrder;
  return mesh;
}

export const clipOf = (p: Node) => cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(p, 1));
export const OFFSCREEN = () => vec4(2, 2, 2, 1); // GL's culled instance: outside the clip volume
export const h1 = (n: Node) => fract(sin(n).mul(43758.5453));

export interface RainInputs {
  disp: THREE.Texture[]; // ocean.textures().disp: 3 cascades used (xyz displacement), repeat, mips
  sizes: number[];       // cascade L (m)
}

export interface RainDrawArgs {
  camPos: Vec3In; pixelAngle: number; rain: number; time: number; exposure: number;
  wind: Vec2In; drift?: Vec2In; flash: Vec3In; gain?: number;
  [k: string]: unknown; // GL's viewProj, skyU, viewport, env, disp, sizes: unused (camera matrices, global sky uniforms)
}

export class Rain {
  mesh: THREE.Group; // splashes (renderOrder 3), then streaks (renderOrder 4), as GL's draw order
  splashMesh: THREE.Mesh;
  streakMesh: THREE.Mesh;
  readonly drops: number;
  readonly splashes: number;
  u = {
    camPos: uniform(new THREE.Vector3()),
    time: uniform(0),
    pixelAngle: uniform(0.001),
    flash: uniform(new THREE.Vector3()),
    // streaks
    box: uniform(new THREE.Vector3(36, 22, 36)), // box size (m)
    wind: uniform(new THREE.Vector2()),          // horizontal wind (m/s), for the streak direction
    drift: uniform(new THREE.Vector2()),         // integrated horizontal drift (m)
    exposure: uniform(1 / 60),                   // shutter time (s)
    lambda: uniform(4.1),                        // Marshall-Palmer slope (1/mm)
    count: uniform(0),                           // active fraction
    gain: uniform(30),
    // splashes
    radius: uniform(7),
    splashCount: uniform(0),
    splashGain: uniform(1.2),
  };
  private splashGeo: THREE.InstancedBufferGeometry;
  private streakGeo: THREE.InstancedBufferGeometry;

  constructor(_renderer: THREE.WebGPURenderer, sky: SkyCompute, inputs: RainInputs, { drops = 600000, splashes = 40000 } = {}) {
    this.drops = drops;
    this.splashes = splashes;
    // GL constructor order: drop seeds rng(11), splash seeds rng(23)
    this.streakGeo = quadGeometry();
    this.streakGeo.setAttribute('aSeed', seedAttribute(drops, 11));
    this.splashGeo = quadGeometry();
    this.splashGeo.setAttribute('aSeed', seedAttribute(splashes, 23));

    const ms = fxMaterial('rain.splash', THREE.OneFactor, THREE.OneMinusSrcAlphaFactor);
    {
      const vUv = centroidVarying('vec2', 'vUv'), vAlpha = varyingProperty('float', 'vAlpha'), vJet = varyingProperty('float', 'vJet');
      ms.vertexNode = this.splashVertex(inputs, vUv, vAlpha, vJet);
      ms.fragmentNode = this.splashFragment(sky, vUv, vAlpha, vJet);
    }
    const mt = fxMaterial('rain.streak', THREE.OneFactor, THREE.OneMinusSrcAlphaFactor);
    {
      const vUv = centroidVarying('vec2', 'vUv'), vAlpha = varyingProperty('float', 'vAlpha');
      const vDir = varyingProperty('vec3', 'vDir');
      mt.vertexNode = this.streakVertex(vUv, vAlpha, vDir);
      mt.fragmentNode = this.streakFragment(sky, vUv, vAlpha, vDir);
    }
    this.splashMesh = fxMesh(this.splashGeo, ms, 'rain.splash', 3);
    this.streakMesh = fxMesh(this.streakGeo, mt, 'rain.streak', 4);
    this.mesh = new THREE.Group();
    this.mesh.name = 'rain';
    this.mesh.matrixAutoUpdate = false;
    this.mesh.add(this.splashMesh, this.streakMesh);
    this.mesh.visible = false;
  }

  private streakVertex(vUv: Node, vAlpha: Node, vDir: Node) {
    const u = this.u;
    return Fn(() => {
      const seed = attribute('aSeed', 'vec4').toVar();
      const corner = attribute('aCorner', 'vec2').toVar();
      // drop diameter (mm) from an exponential distribution, truncated to visible sizes
      const q = fract(seed.w.mul(7.31).add(seed.x.mul(3.17))).toVar();
      const lq = log(q.mul(0.985).oneMinus()).toVar();
      const D = clamp(lq.negate().div(u.lambda).add(0.35), 0.35, 5.0).toVar();
      const v = float(9.65).sub(exp(D.mul(-0.6)).mul(10.3)).toVar();
      const vel = vec3(u.wind.x, v.negate(), u.wind.y);
      // fall speed for the position comes from a fixed per-drop size (independent of the rain rate)
      const Dk = float(0.35).sub(lq.div(2.0));
      const vk = float(9.65).sub(exp(Dk.mul(-0.6)).mul(10.3));
      // world-anchored positions wrapped into a camera-centred box (no swimming when moving)
      const p = seed.xyz.mul(u.box).add(vec3(u.drift.x, vk.negate().mul(u.time), u.drift.y));
      const rel = mod(p.sub(u.camPos).add(u.box.mul(0.5)), u.box).sub(u.box.mul(0.5))
        .add(vec3(0, u.box.y.mul(0.5).sub(2.0), 0));
      const head = u.camPos.add(rel).toVar();
      const tail = head.sub(vel.mul(u.exposure)).toVar();
      const mid = head.add(tail).mul(0.5).toVar();
      const toCam = u.camPos.sub(mid).toVar();
      const dist = length(toCam).toVar();
      const axis = head.sub(tail);
      const side = normalize(cross(axis, toCam)).toVar();
      // physical width, clamped to one pixel (energy kept by scaling alpha)
      const wPhys = D.mul(0.001).toVar();
      const wPix = dist.mul(u.pixelAngle);
      const w = max(wPhys, wPix.mul(1.2)).toVar();
      const pos = mix(tail, head, corner.y).add(side.mul(corner.x.sub(0.5)).mul(w));
      vUv.assign(corner);
      // duty cycle of the streak (D / (v T)) times sub-pixel coverage
      const a = wPhys.div(w).mul(min(D.mul(0.001).div(v.mul(u.exposure)), 1.0))
        .mul(smoothstep(0.25, 0.9, dist)).mul(smoothstep(u.box.x.mul(0.32), u.box.x.mul(0.5), dist).oneMinus());
      vAlpha.assign(select(head.y.lessThan(-0.5), float(0), a)); // below the mean sea level: hidden by the water anyway
      vDir.assign(normalize(mid.sub(u.camPos)));
      return select(seed.w.greaterThan(u.count), OFFSCREEN(), clipOf(pos));
    })();
  }

  private streakFragment(sky: SkyCompute, vUv: Node, vAlpha: Node, vDir: Node) {
    const u = this.u;
    const eqUv = (d: Node) => vec2(atan(d.z, d.x).div(6.2831853).add(0.5), acos(clamp(d.y, -1, 1)).div(3.14159265));
    return Fn(() => {
      const uv = vUv.toVar();
      const across = clamp(abs(uv.x.mul(2).sub(1)).oneMinus(), 0, 1);
      const along = smoothstep(0.0, 0.15, uv.y).mul(smoothstep(0.8, 1.0, uv.y).oneMinus()); // GL smoothstep(1, 0.8, y)
      const d = vDir.toVar();
      // a drop is a wide-angle lens: it shows a blurred, inverted image of the bright sky
      // (GL equirectUv(0, 1, 0): atan(0, 0) = 0 -> u = 0.5, v = 0)
      const skyC = texture(sky.env, vec2(0.5, 0)).level(6).rgb.mul(0.6)
        .add(texture(sky.env, eqUv(normalize(vec3(d.x, 0.35, d.z)))).level(5).rgb.mul(0.4));
      const L = skyC.mul(1.15).add(u.flash.mul(0.25));
      const a = clamp(vAlpha.mul(across).mul(along).mul(u.gain), 0, 1).toVar();
      return vec4(L.mul(a), a);
    })();
  }

  // Splashes: the crown of an impact, a few mm tall and ~50 ms long; only the largest drops throw a Worthington jet of
  // 2-4 cm.
  private splashVertex(inp: RainInputs, vUv: Node, vAlpha: Node, vJet: Node) {
    const u = this.u, S = inp.sizes;
    return Fn(() => {
      const seed = attribute('aSeed', 'vec4').toVar();
      const corner = attribute('aCorner', 'vec2').toVar();
      const period = seed.z.mul(0.07).add(0.08).toVar();
      const tt = u.time.div(period).add(seed.x.mul(17.0)).toVar();
      const cyc = floor(tt).toVar();
      const ph = fract(tt);
      const life = float(0.05).div(period); // ~50 ms of the cycle
      // world-anchored spots, new each cycle, wrapped into a square around the camera
      const o = vec2(h1(cyc.mul(1.7).add(seed.y.mul(91.0))), h1(cyc.mul(3.1).add(seed.x.mul(57.0)))).mul(2).sub(1).mul(u.radius);
      const R = vec2(u.radius, u.radius);
      const xz = u.camPos.xz.add(mod(o.sub(u.camPos.xz).add(R), R.mul(2))).sub(R).toVar();
      const D = texture(inp.disp[0], xz.div(S[0])).level(2).xyz
        .add(texture(inp.disp[1], xz.div(S[1])).level(2).xyz)
        .add(texture(inp.disp[2], xz.div(S[2])).level(1).xyz).toVar();
      const base = vec3(xz.x.add(D.x), D.y, xz.y.add(D.z)).toVar();
      const t = ph.div(life).toVar();
      const q = seed.z;
      const big = q.greaterThan(0.95).toVar();
      const height = select(big, mix(0.02, 0.04, q.sub(0.95).mul(20.0)), mix(0.003, 0.01, q.div(0.95)));
      const jet = sin(min(t, 1.0).mul(3.14159)).mul(height);
      vJet.assign(select(big, float(1), float(0)));
      const toCam = u.camPos.sub(base).toVar();
      const dist = length(toCam).toVar();
      const side = normalize(cross(vec3(0, 1, 0), toCam));
      // crown ~6-12 mm across; a jet is a thin column
      const wPhys = select(big, float(0.004), q.mul(0.006).add(0.006)).toVar();
      const w = max(wPhys, dist.mul(u.pixelAngle).mul(1.2)).toVar();
      const pos = base.add(side.mul(corner.x.sub(0.5)).mul(w)).add(vec3(0, corner.y.mul(max(jet, 0.0015)), 0));
      vUv.assign(corner);
      // further out the specks are sub-pixel: they fade into the surface roughness (no hard band)
      vAlpha.assign(select(t.lessThan(1.0), float(1), float(0))
        .mul(smoothstep(u.radius.mul(0.3), u.radius, dist).oneMinus()).mul(min(wPhys.div(w), 1.0)));
      return select(seed.w.greaterThan(u.splashCount), OFFSCREEN(), clipOf(pos));
    })();
  }

  private splashFragment(sky: SkyCompute, vUv: Node, vAlpha: Node, vJet: Node) {
    const u = this.u;
    // GL pow(v, 2.0) of a signed v: written as v * v (pow of a negative base is undefined in GLSL and WGSL)
    const g = (v: Node) => exp(v.mul(v).negate());
    return Fn(() => {
      const x = vUv.x.mul(2).sub(1).toVar(), y = clamp(vUv.y, 0, 1).toVar();
      const ax = abs(x).toVar();
      // crown: two thin walls with beads at the rim; jet: a column with a drop on top
      const walls = g(ax.sub(0.6).div(0.22)).mul(smoothstep(0.0, 0.35, y)).mul(smoothstep(0.55, 0.9, y).oneMinus());
      const beads = g(y.sub(0.85).div(0.12)).mul(g(ax.sub(0.65).div(0.16)).add(exp(x.mul(x).negate().div(0.03)).mul(0.7)));
      const column = exp(x.mul(x).negate().div(0.12))
        .mul(smoothstep(0.0, 0.2, y).mul(smoothstep(0.7, 0.85, y).oneMinus()).add(g(y.sub(0.92).div(0.07))));
      const shape = mix(max(walls, beads), column, vJet);
      // a thin water sheet: translucent, showing the sky above it
      const L = sky.skyIrradiance().mul(0.7 / 3.14159)
        .add(sky.sunIlluminance().mul(atmoU.hazeSun).mul(max(atmoU.sun.y, 0)).mul(0.15)).add(u.flash.mul(0.2));
      const a = clamp(vAlpha.mul(shape).mul(u.splashGain), 0, 0.35).toVar();
      return vec4(L.mul(a), a);
    })();
  }

  // GL draw(u): sets the uniforms and the visibility (GL skips the draw below rain 0.005)
  update(u: RainDrawArgs) {
    const U = this.u;
    this.mesh.visible = u.rain >= 0.005;
    if (!this.mesh.visible) return;
    const rateMmH = u.rain * 50; // 0..50 mm/h (very heavy shower at the top)
    U.lambda.value = 4.1 * Math.pow(Math.max(rateMmH, 0.5), -0.21);
    setV3(U.camPos, u.camPos);
    U.time.value = u.time;
    U.pixelAngle.value = u.pixelAngle;
    setV3(U.flash, u.flash);
    U.radius.value = 7;
    U.splashCount.value = Math.min(u.rain * 1.3, 1);
    U.splashGain.value = 1.2;
    U.box.value.set(36, 22, 36);
    setV2(U.wind, u.wind);
    setV2(U.drift, u.drift || [0, 0]);
    U.exposure.value = u.exposure;
    U.count.value = Math.min(Math.sqrt(u.rain) * 1.05, 1);
    U.gain.value = u.gain ?? 30;
    // instances past the active quantile are culled in the shader anyway (w >= i / n): skip drawing them
    this.splashGeo.instanceCount = Math.min(this.splashes, Math.ceil(U.splashCount.value * this.splashes) + 1);
    this.streakGeo.instanceCount = Math.min(this.drops, Math.ceil(U.count.value * this.drops) + 1);
  }
}
