// open-water's ocean probe (src/ocean/probe.js) as a TSL compute kernel: the sea surface under the camera (height,
// horizontal orbital displacement, mean slope over a boat-sized footprint). WebGPU has no synchronous readback, so
// run() returns the last result and starts a new read; ?render awaits read() every frame instead (GL's sync path).
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';

type Node = any; // @types/three's TSL overloads reject long node chains, so nodes and TSL functions are untyped
const { Fn, Loop, uniform, float, vec2, vec3, vec4, select, max, log2, texture, instancedArray, instanceIndex } = TSL as any;

interface OceanTextures { disp: THREE.Texture[]; slope: THREE.Texture[]; sizes: number[]; texels: number[] }

export class OceanProbe {
  result = { height: 0, dx: 0, dz: 0, sx: 0, sz: 0 };
  private out = instancedArray(2, 'vec4');
  private xz = uniform(new THREE.Vector2());
  private footprint = uniform(8); // metres: waves shorter than this barely move the boat
  private node: Node;
  private reading: Promise<void> | null = null;
  private renderer: THREE.WebGPURenderer;

  constructor(renderer: THREE.WebGPURenderer, ot: OceanTextures) {
    this.renderer = renderer;
    // the first 3 cascades, each at the mip level whose texel matches the footprint
    const sum = (tex: THREE.Texture[], p: Node, l: Node) => [0, 1, 2]
      .map((i) => texture(tex[i], p.div(ot.sizes[i])).level(max(l.sub(Math.log2(ot.texels[i])), 0)))
      .reduce((a, b) => a.add(b));
    const disp = (p: Node) => sum(ot.disp, p, log2(this.footprint)).xyz;
    this.node = Fn(() => {
      // invert the horizontal (choppy) displacement: find x0 with x0 + D(x0) = x
      const x0 = vec2(this.xz).toVar();
      Loop(4, () => { x0.assign(this.xz.sub(disp(x0).xz)); });
      const D = disp(x0);
      const s = sum(ot.slope, x0, log2(this.footprint.mul(1.5))).xy;
      this.out.element(instanceIndex).assign(select(instanceIndex.equal(0), vec4(D, 1), vec4(s, 0, 1)));
    })().compute(2);
  }

  private dispatch(xz: number[], footprint: number) {
    this.xz.value.set(xz[0], xz[1]);
    this.footprint.value = footprint;
    this.renderer.compute(this.node);
  }

  // probe now and wait for the result (deterministic offline frames)
  async read(xz: number[], footprint: number) {
    this.dispatch(xz, footprint);
    this.decode(new Float32Array(await this.renderer.getArrayBufferAsync(this.out.value)));
    return this.result;
  }

  // live: the last finished result; a new probe starts once the previous read is back (1-3 frames latency)
  run(xz: number[], footprint: number) {
    if (!this.reading) {
      this.dispatch(xz, footprint);
      this.reading = this.renderer.getArrayBufferAsync(this.out.value).then((b) => { this.decode(new Float32Array(b)); this.reading = null; });
    }
    return this.result;
  }

  private decode(d: Float32Array) {
    this.result = { dx: d[0], height: d[1], dz: d[2], sx: d[4], sz: d[5] };
  }
}
