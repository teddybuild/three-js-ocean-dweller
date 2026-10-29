// Small TSL helpers shared by the port. Float classification reads the IEEE-754 bits: WGSL has no isnan/isinf, and
// a shader compiler may fold `x != x` to false or `!(x < y)` to `x >= y` under its no-NaN assumption. An exponent of
// all ones is inf (zero mantissa) or NaN (non-zero mantissa).
import * as TSL from 'three/tsl';

type Node = any; // @types/three's TSL overloads reject long node chains, so nodes and TSL functions are untyped
const { float, uint, floatBitsToUint } = TSL as any;

const EXP_BITS = 0x7f800000, ABS_BITS = 0x7fffffff;
const absBits = (x: Node) => floatBitsToUint(float(x)).bitAnd(uint(ABS_BITS));

// scalar tests (bool nodes)
export const isNan = (x: Node) => absBits(x).greaterThan(uint(EXP_BITS));
export const isInf = (x: Node) => absBits(x).equal(uint(EXP_BITS));
export const isNonFinite = (x: Node) => floatBitsToUint(float(x)).bitAnd(uint(EXP_BITS)).equal(uint(EXP_BITS));

// any component of a vector (2 to 4 components) failing the scalar test
const anyOf = (test: (x: Node) => Node) => (v: Node, n = 3) => {
  const c = [v.x, v.y, v.z, v.w].slice(0, n).map(test);
  return c.slice(1).reduce((a: Node, b: Node) => a.or(b), c[0]);
};
export const anyNan = anyOf(isNan);
export const anyInf = anyOf(isInf);
export const anyNonFinite = anyOf(isNonFinite);

// a varyingProperty interpolated at the centroid, as GLSL `centroid out/in`: with MSAA an edge pixel's samples then
// read the varying inside the triangle instead of extrapolating past it (thin rain streaks, spray, the bolt)
export function centroidVarying(type: string, name: string): Node {
  const node = (TSL as any).varyingProperty(type, name);
  const generate = node.generate.bind(node);
  node.generate = (builder: any) => {
    Object.assign(builder.getVaryingFromNode(node, name), { interpolationType: 'perspective', interpolationSampling: 'centroid' });
    return generate(builder);
  };
  // PropertyNode's key hashes type, name and varying only: keep a centroid program apart from a plain one
  const key = node.customCacheKey.bind(node);
  node.customCacheKey = () => key() + 1;
  return node;
}
