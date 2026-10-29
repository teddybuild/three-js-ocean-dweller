// open-water's lightning (src/fx/lightning.js): Poisson-timed strikes with multiple return strokes, a procedural
// branching channel (fractal midpoint displacement), in-cloud illumination and thunder scheduling (343 m/s). The CPU
// logic (trigger, buildBolt, update) is GL's, line for line, on the same rng(7) stream, so both engines strike alike.
// The channel is drawn as instanced quads, one per segment, additive (ONE / ONE); helpers in ./rain.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { rng } from '../math.js';
import { quadGeometry, fxMaterial, fxMesh, clipOf, setV3, type Vec3In } from './rain';

type Node = any; // @types/three's TSL overloads reject long node chains, so nodes and TSL functions are untyped
const {
  Fn, uniform, float, vec3, vec4, select, exp, abs, min, max, clamp, mix, smoothstep, normalize, cross, length, attribute,
  varyingProperty,
} = TSL as any;

type V3 = number[];
export interface LightningCam { pos: Vec3In; yaw: number }
export interface Strike { t: number; times: number[]; ground: boolean; dist: number; pos: V3; peak: number; duration: number }
export interface ThunderEvent { delay: number; dist: number; ground: boolean; power: number }
export interface LightningDrawArgs {
  camPos: Vec3In; pixelAngle: number; fogDensity?: number; transmit?: number; base?: number;
  [k: string]: unknown; // GL's viewProj: unused
}

const xyz = (p: Vec3In): V3 => ('x' in p ? [p.x, p.y, p.z] : [p[0], p[1], p[2]]);

export class Lightning {
  mesh: THREE.Mesh; // renderOrder 1 (GL: first of the effects, after the water)
  rand: () => number;
  segments = 0;
  strike: Strike | null = null;
  nextIn = 4;
  events: ThunderEvent[] = []; // thunder events for the audio engine
  flash = 0;
  bolt = 0;
  pos: V3 = [0, 0, 0];
  ground: V3 | undefined; // channel foot xz and top height (set by buildBolt)
  u = {
    camPos: uniform(new THREE.Vector3()),
    pixelAngle: uniform(0.001),
    fogDensity: uniform(0),
    base: uniform(1e5),      // cloud base: the channel above it is hidden inside the cloud
    intensity: uniform(0),
    color: uniform(new THREE.Vector3(0.82, 0.86, 1.0)),
  };
  private geo: THREE.InstancedBufferGeometry;
  private capacity = 0;
  private aA!: THREE.InstancedBufferAttribute; // segment start xyz, intensity
  private aB!: THREE.InstancedBufferAttribute; // segment end xyz, width scale

  constructor(_renderer: THREE.WebGPURenderer, seed = 7) {
    this.rand = rng(seed);
    this.geo = quadGeometry();
    this.grow(16384); // a ground strike is ~6k segments (median), rarely over 15k
    const m = fxMaterial('lightning', THREE.OneFactor, THREE.OneFactor);
    const vUv = varyingProperty('vec2', 'vUv'), vI = varyingProperty('float', 'vI'), vClip = varyingProperty('float', 'vClip');
    m.vertexNode = this.vertex(vUv, vI, vClip);
    m.fragmentNode = this.fragment(vUv, vI, vClip);
    this.mesh = fxMesh(this.geo, m, 'lightning', 1);
    this.mesh.visible = false;
  }

  // (re)allocate the segment attributes; a new attribute object rebinds the geometry in three
  private grow(n: number) {
    this.capacity = n;
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aA.setUsage(THREE.DynamicDrawUsage);
    this.aB.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aA', this.aA);
    this.geo.setAttribute('aB', this.aB);
  }

  private vertex(vUv: Node, vI: Node, vClip: Node) {
    const u = this.u;
    return Fn(() => {
      const aA = attribute('aA', 'vec4').toVar(), aB = attribute('aB', 'vec4').toVar();
      const c = attribute('aCorner', 'vec2').toVar();
      const p = mix(aA.xyz, aB.xyz, c.y).toVar();
      const toCam = u.camPos.sub(p).toVar();
      const dist = length(toCam).toVar();
      // a segment seen end-on (or of zero length) has no defined side: avoid normalize(0) = NaN
      const cr = cross(aB.xyz.sub(aA.xyz), toCam).toVar();
      const cl = length(cr).toVar();
      const side = select(cl.greaterThan(1e-6), cr.div(max(cl, 1e-30)), normalize(cross(vec3(0, 1, 0), toCam).add(vec3(1e-4, 0, 0))));
      // a few metres of glowing channel, at least ~2.5 px wide; radiance scaled to keep energy
      const wPhys = aB.w.mul(0.8).toVar();
      const wPix = dist.mul(u.pixelAngle).mul(1.6);
      const w = max(wPhys, wPix).toVar();
      vUv.assign(c);
      vI.assign(aA.w.mul(wPhys.div(w)).mul(exp(u.fogDensity.negate().mul(dist).mul(0.6))));
      vClip.assign(smoothstep(u.base.sub(120.0), u.base.add(60.0), p.y).oneMinus()); // GL smoothstep(base + 60, base - 120, y)
      return clipOf(p.add(side.mul(c.x.sub(0.5)).mul(w)));
    })();
  }

  private fragment(vUv: Node, vI: Node, vClip: Node) {
    const u = this.u;
    return Fn(() => {
      const x = clamp(abs(vUv.x.mul(2).sub(1)), 0, 1).toVar();
      const core = exp(x.mul(x).mul(-9.0));
      return vec4(min(u.color.mul(core).mul(vI).mul(vClip).mul(u.intensity), vec3(30000.0)), float(0));
    })();
  }

  // Force a strike (UI / timeline)
  trigger(cam: LightningCam, opts: { dist?: number; az?: number; base?: number; ground?: boolean } = {}) {
    const r = this.rand;
    const cp = xyz(cam.pos);
    const dist = opts.dist ?? 1500 + Math.pow(r(), 1.5) * 12000;
    const az = opts.az ?? cam.yaw + (r() - 0.5) * 2.2;
    const x = cp[0] + Math.cos(az) * dist, z = cp[2] + Math.sin(az) * dist;
    const cloudBase = opts.base ?? 650;
    const ground = opts.ground ?? r() < 0.45;
    const strokes = 1 + Math.floor(r() * 3.5);
    const times = [0];
    for (let i = 1; i < strokes; i++) times.push(times[i - 1] + 0.04 + r() * 0.07);
    this.strike = {
      t: 0, times, ground, dist,
      pos: [x, ground ? cloudBase + 300 + r() * 1500 : 4000 + r() * 4000, z],
      peak: 0.6 + r() * 0.8,
      duration: times[times.length - 1] + 0.35,
    };
    if (ground) this.buildBolt([x, cloudBase + 100, z], r);
    else this.segments = 0;
    this.events.push({ delay: dist / 343, dist, ground, power: this.strike.peak });
  }

  buildBolt(top: V3, r: () => number) {
    const segs: number[][] = [];
    const H = top[1];
    const walk = (a: V3, b: V3, depth: number, intensity: number, width: number) => {
      // midpoint displacement
      let pts = [a, b];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      // tortuous at every scale (segments of tens of metres turn by ~15-20 degrees)
      let rough = len * 0.2;
      for (let lvl = 0; lvl < 8; lvl++) {
        const next = [pts[0]];
        for (let i = 0; i < pts.length - 1; i++) {
          const p = pts[i], q = pts[i + 1];
          next.push([(p[0] + q[0]) / 2 + (r() - 0.5) * rough, (p[1] + q[1]) / 2 + (r() - 0.5) * rough * 0.4, (p[2] + q[2]) / 2 + (r() - 0.5) * rough]);
          next.push(q);
        }
        pts = next;
        rough *= 0.6;
      }
      for (let i = 0; i < pts.length - 1; i++) {
        // branches taper: dimmer and thinner toward their tips; the trunk stays bright
        const f = depth > 0 ? Math.pow(1 - i / pts.length, 1.4) : 1;
        segs.push([...pts[i], intensity * f, ...pts[i + 1], width * (0.35 + 0.65 * f)]);
        if (depth < 2 && r() < 0.035 * (1 - i / pts.length) && pts[i][1] > H * 0.15) {
          const p = pts[i];
          const blen = (p[1]) * (0.25 + r() * 0.45);
          const ang = r() * Math.PI * 2;
          const end = [p[0] + Math.cos(ang) * blen * 0.6, p[1] - blen, p[2] + Math.sin(ang) * blen * 0.6];
          walk(p, end, depth + 1, intensity * f * 0.22, width * f * 0.45);
        }
      }
    };
    const bottom = [top[0] + (r() - 0.5) * 400, -2, top[2] + (r() - 0.5) * 400];
    this.ground = [bottom[0], bottom[2], top[1]];
    walk(top, bottom, 0, 1, 1);
    if (segs.length > this.capacity) {
      let n = this.capacity;
      while (n < segs.length) n *= 2;
      this.grow(n);
    }
    const A = this.aA.array as Float32Array, B = this.aB.array as Float32Array;
    segs.forEach((s, i) => { A.set(s.slice(0, 4), i * 4); B.set(s.slice(4, 8), i * 4); });
    this.aA.clearUpdateRanges(); this.aA.addUpdateRange(0, segs.length * 4); this.aA.needsUpdate = true;
    this.aB.clearUpdateRanges(); this.aB.addUpdateRange(0, segs.length * 4); this.aB.needsUpdate = true;
    this.segments = segs.length;
  }

  update(dt: number, rate: number, cam: LightningCam, cloudBase: number) {
    this.flash = 0;
    this.bolt = 0;
    if (rate > 0.01) {
      this.nextIn -= dt;
      if (this.nextIn <= 0) {
        this.trigger(cam, { base: cloudBase });
        // Poisson process: mean interval 25 s at rate 0.1 down to ~5 s at rate 1
        const mean = 3.5 / Math.pow(rate, 0.9);
        this.nextIn = -Math.log(1 - this.rand() * 0.98) * mean + 0.8;
      }
    }
    const s = this.strike;
    if (s) {
      s.t += dt;
      let i = 0;
      for (const t0 of s.times) {
        // average of the stroke's decay over this frame's exposure [s.t - dt, s.t]
        const a = Math.max(s.t - dt - t0, 0), b = s.t - t0;
        if (b > 0) i += (0.028 * (Math.exp(-a / 0.028) - Math.exp(-b / 0.028)) + 0.25 * 0.15 * (Math.exp(-a / 0.15) - Math.exp(-b / 0.15))) / Math.max(dt, 1e-4);
      }
      // stepped-leader flicker before the first stroke
      this.flash = Math.min(i, 2.5) * s.peak;
      this.bolt = s.ground ? Math.min(i, 2) * s.peak : 0;
      this.pos = s.pos;
      if (s.t > s.duration) this.strike = null;
    }
    return this.flash;
  }

  // GL draw(u): the bolt's uniforms and visibility (GL skips the draw with no segments or bolt < 0.01)
  draw(u: LightningDrawArgs) {
    const U = this.u;
    this.mesh.visible = this.segments > 0 && this.bolt >= 0.01;
    if (!this.mesh.visible) return;
    this.geo.instanceCount = this.segments;
    setV3(U.camPos, u.camPos);
    U.pixelAngle.value = u.pixelAngle;
    U.fogDensity.value = u.fogDensity || 0;
    U.base.value = u.base ?? 1e5;
    U.intensity.value = this.bolt * 2600 * (u.transmit ?? 1);
    U.color.value.set(0.82, 0.86, 1.0);
  }
}
