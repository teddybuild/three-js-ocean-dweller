// open-water's spindrift (src/fx/spray.js) in TSL: above ~Beaufort 7 the wind tears spray off breaking crests.
// Particles are seeded at random points around the camera and only live where the sea is actively breaking (dense
// fresh foam on the crest); they rise, are carried downwind at ~0.6 U, spread and settle back. Instanced quads with
// rng(41) seeds in GL's order; blending premultiplied, ONE / ONE_MINUS_SRC_ALPHA (helpers in ./rain).
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { atmoU } from './atmosphere';
import type { SkyCompute } from './sky';
import { quadGeometry, seedAttribute, fxMaterial, fxMesh, clipOf, OFFSCREEN, h1, setV2, setV3, type Vec2In, type Vec3In } from './rain';

type Node = any; // @types/three's TSL overloads reject long node chains, so nodes and TSL functions are untyped
const {
  Fn, uniform, float, vec2, vec3, vec4, select, sqrt, exp, sin, cos, max, mix, smoothstep, step, normalize, dot, cross,
  length, fract, floor, texture, attribute, varyingProperty,
} = TSL as any;

export interface SprayInputs {
  disp: THREE.Texture[];   // ocean.textures().disp: cascades 0 and 1 used
  active: THREE.Texture[]; // ocean.textures().active: [1] (117 m cascade, GL uActive) used, value in .r
  sizes: number[];         // cascade L (m)
}

export interface SprayDrawArgs {
  camPos: Vec3In; anchor?: Vec2In; time: number; wind: number; windVec: Vec2In; flash: Vec3In;
  [k: string]: unknown; // GL's viewProj, pixelAngle, skyU, disp, active, sizes: unused
}

export class Spray {
  mesh: THREE.Mesh; // renderOrder 2 (GL: after the lightning, before the rain)
  readonly count: number;
  u = {
    camPos: uniform(new THREE.Vector3()),
    anchor: uniform(new THREE.Vector2()), // spawn-field centre (camera base, does not sway)
    time: uniform(0),
    radius: uniform(250),
    strength: uniform(0),                 // 0..1 with wind (gale and above)
    wind: uniform(new THREE.Vector2()),   // m/s
    flash: uniform(new THREE.Vector3()),
  };
  private geo: THREE.InstancedBufferGeometry;

  constructor(_renderer: THREE.WebGPURenderer, sky: SkyCompute, inputs: SprayInputs, count = 12000) {
    this.count = count;
    this.geo = quadGeometry();
    this.geo.setAttribute('aSeed', seedAttribute(count, 41));
    const m = fxMaterial('spray', THREE.OneFactor, THREE.OneMinusSrcAlphaFactor);
    const vUv = varyingProperty('vec2', 'vUv'), vAlpha = varyingProperty('float', 'vAlpha'), vAlong = varyingProperty('float', 'vAlong');
    m.vertexNode = this.vertex(inputs, vUv, vAlpha, vAlong);
    m.fragmentNode = this.fragment(sky, vUv, vAlpha, vAlong);
    this.mesh = fxMesh(this.geo, m, 'spray', 2);
    this.mesh.visible = false;
  }

  private vertex(inp: SprayInputs, vUv: Node, vAlpha: Node, vAlong: Node) {
    const u = this.u, S = inp.sizes;
    return Fn(() => {
      const seed = attribute('aSeed', 'vec4').toVar();
      const corner = attribute('aCorner', 'vec2').toVar();
      const life = seed.z.mul(1.6).add(1.6).toVar();
      const tt = u.time.div(life).add(seed.x.mul(31.0)).toVar();
      const cyc = floor(tt).toVar();
      const age = fract(tt).toVar(); // 0..1 over the particle life
      const r = sqrt(h1(cyc.mul(1.31).add(seed.y.mul(77.0)))).mul(u.radius);
      const a = h1(cyc.mul(2.71).add(seed.x.mul(53.0))).mul(6.2831853).toVar();
      const xz = u.anchor.add(vec2(cos(a), sin(a)).mul(r)).toVar();
      // where is the sea breaking right now? dense foam on a crest
      const d0 = texture(inp.disp[0], xz.div(S[0])).level(1).toVar();
      const d1 = texture(inp.disp[1], xz.div(S[1])).level(1).toVar();
      const crest = d0.y.add(d1.y).toVar();
      // spray is torn off crests that are breaking right now
      const act = texture(inp.active[1], xz.div(S[1])).level(1).r;
      const alive = smoothstep(0.05, 0.3, act).mul(step(0.0, crest)).mul(u.strength).toVar();
      const dead = alive.lessThan(0.01).or(seed.w.greaterThan(u.strength)).toVar();
      const T = age.mul(life).toVar();
      const start = vec3(xz.x.add(d0.x).add(d1.x), crest.add(0.3), xz.y.add(d0.z).add(d1.z));
      const vel = vec3(u.wind.x, 0, u.wind.y).mul(seed.y.mul(0.25).add(0.45));
      // ballistic rise and settle, slowed by drag
      const pos = start.add(vel.mul(T)).add(vec3(0, seed.z.mul(1.0).add(0.6).mul(T).sub(T.mul(T).mul(1.0)), 0)).toVar();
      const size = mix(0.3, seed.y.mul(1.2).add(1.6), sqrt(age)).toVar();
      const toCam = u.camPos.sub(pos).toVar();
      const dist = length(toCam).toVar();
      const vdir = toCam.div(max(dist, 1e-3)).toVar();
      const right = normalize(cross(vec3(0, 1, 0), toCam));
      const c = corner.sub(0.5).toVar();
      const wdir = normalize(vec3(u.wind.x, 0, u.wind.y).add(1e-4)).toVar();
      // a sheet drawn out along the wind: the wind direction projected into the view plane
      const along0 = wdir.sub(vdir.mul(dot(wdir, vdir))).toVar();
      const al = length(along0).toVar();
      const along = select(al.greaterThan(0.2), along0.div(al), right).toVar();
      const up = normalize(cross(vdir, along));
      // further away a sheet is smeared over more of its drift: longer
      const P = pos.add(along.mul(c.x).mul(size).mul(mix(2.4, 4.0, smoothstep(20.0, 150.0, dist))).mul(mix(0.35, 1.0, smoothstep(0.2, 0.6, al))))
        .add(up.mul(c.y).mul(size).mul(0.7));
      vAlong.assign(smoothstep(0.2, 0.6, al));
      vUv.assign(c.add(0.5));
      const alpha = alive.mul(sin(age.mul(3.14159))).mul(smoothstep(u.radius.mul(0.6), u.radius, dist).oneMinus())
        .mul(smoothstep(15.0, 40.0, dist)).mul(smoothstep(60.0, 120.0, dist).oneMinus());
      vAlpha.assign(select(dead, float(0), alpha));
      return select(dead, OFFSCREEN(), clipOf(P));
    })();
  }

  private fragment(sky: SkyCompute, vUv: Node, vAlpha: Node, vAlong: Node) {
    const u = this.u;
    const hsh = (p: Node) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));
    const vn = (p: Node) => {
      const i = floor(p).toVar(), f0 = fract(p).toVar();
      const f = f0.mul(f0).mul(f0.mul(-2).add(3)).toVar();
      return mix(mix(hsh(i), hsh(i.add(vec2(1, 0))), f.x), mix(hsh(i.add(vec2(0, 1))), hsh(i.add(vec2(1, 1))), f.x), f.y);
    };
    return Fn(() => {
      const uv = vUv.toVar();
      const q = uv.mul(2).sub(1).toVar();
      const r = dot(q, q);
      // streaky along the wind; seen end-on (no length to streak) an isotropic puff
      const sc = mix(vec2(6.0, 6.0), vec2(2.5, 11.0), vAlong).toVar();
      const n = vn(uv.mul(sc)).mul(0.6).add(vn(uv.mul(sc).mul(2.2).add(3.1)).mul(0.4));
      const a = exp(r.mul(-2.2)).mul(smoothstep(0.35, 0.85, n)).mul(vAlpha).mul(0.5).toVar();
      // fine droplets scatter all wavelengths alike: the grey of the light around them
      const Lc = sky.skyIrradiance().mul(0.9 / 3.14159)
        .add(sky.sunIlluminance().mul(atmoU.hazeSun).mul(max(atmoU.sun.y, 0)).mul(0.35)).add(u.flash.mul(0.3));
      const L = vec3(dot(Lc, vec3(0.2126, 0.7152, 0.0722)));
      return vec4(L.mul(a), a);
    })();
  }

  // GL draw(u): sets the uniforms and the visibility (GL skips the draw below a gale)
  update(u: SprayDrawArgs) {
    const U = this.u;
    const strength = Math.min(Math.max((u.wind - 16) / 8, 0), 1);
    this.mesh.visible = strength > 0;
    if (!this.mesh.visible) return;
    setV3(U.camPos, u.camPos);
    setV2(U.anchor, u.anchor || [0, 0]);
    U.time.value = u.time;
    U.radius.value = 250;
    U.strength.value = strength;
    setV2(U.wind, u.windVec);
    setV3(U.flash, u.flash);
    // instances past the active quantile are culled in the shader anyway (w >= i / n): skip drawing them
    this.geo.instanceCount = Math.min(this.count, Math.ceil(strength * this.count) + 1);
  }
}
