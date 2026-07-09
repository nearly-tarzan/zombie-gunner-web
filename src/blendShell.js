import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from './config.js';

// SDF blend-shell — build an organic character from round-cone primitives that
// fuse seamlessly. Each shape contributes a low-poly capsule base mesh; all are
// merged to ONE draw call. A vertex shader then snaps every vertex onto the
// smooth-min SDF isosurface of ALL shapes combined, so overlapping primitives
// converge onto the same blended surface and their seams vanish. Normals come
// from the SDF gradient (lighting flows continuously across joints); vertex
// colors blend by SDF proximity (soft gradients at every join). Ordinary mesh
// rendering — the cost is per-vertex, not per-pixel (no raymarching, no skin).
//
// Toon-banded, with an inverted-hull outline that snaps to an OFFSET isosurface
// (uOutlineOffset) rather than inflating along normals, so concave joints don't
// pucker. Animate by mutating the shape uniforms each frame — the shader re-snaps.
//
// A shape: { a:[x,y,z], b:[x,y,z], ra, rb, color:0xRRGGBB }  (a round cone:
// segment a→b, radius ra→rb; ra===rb is a capsule, a≈b is a sphere).

const MAX_SHAPES = 32;

const VERT = /* glsl */`
  uniform int   uCount;
  uniform vec4  uShapeA[${MAX_SHAPES}]; // xyz = point a, w = radius ra
  uniform vec4  uShapeB[${MAX_SHAPES}]; // xyz = point b, w = radius rb
  uniform vec3  uShapeCol[${MAX_SHAPES}];
  uniform float uK;             // smooth-min blend radius
  uniform float uOutlineOffset; // 0 for the body pass; >0 pushes to an outer shell
  uniform float uFogNear;
  uniform float uFogFar;

  varying vec3  vNormalW;
  varying vec3  vColor;
  varying float vFog;

  // Round-cone SDF (Inigo Quilez).
  float sdRoundCone(vec3 p, vec3 a, vec3 b, float r1, float r2){
    vec3  ba = b - a; float l2 = dot(ba,ba);
    float rr = r1 - r2; float a2 = l2 - rr*rr; float il2 = 1.0/l2;
    vec3  pa = p - a;  float y = dot(pa,ba); float z = y - l2;
    vec3  q = pa*l2 - ba*y; float x2 = dot(q,q);
    float y2 = y*y*l2; float z2 = z*z*l2;
    float k = sign(rr)*rr*rr*x2;
    if( sign(z)*a2*z2 > k ) return sqrt(x2 + z2)*il2 - r2;
    if( sign(y)*a2*y2 < k ) return sqrt(x2 + y2)*il2 - r1;
    return (sqrt(x2*a2*il2) + y*rr)*il2 - r1;
  }
  float smin(float a, float b, float k){
    float h = clamp(0.5 + 0.5*(b-a)/k, 0.0, 1.0);
    return mix(b, a, h) - k*h*(1.0-h);
  }
  float scene(vec3 p){
    float d = 1e5;
    for(int i=0;i<${MAX_SHAPES};i++){ if(i>=uCount) break;
      d = smin(d, sdRoundCone(p, uShapeA[i].xyz, uShapeB[i].xyz, uShapeA[i].w, uShapeB[i].w), uK);
    }
    return d;
  }
  vec3 grad(vec3 p){
    vec2 e = vec2(0.015, 0.0);
    return normalize(vec3(
      scene(p+e.xyy)-scene(p-e.xyy),
      scene(p+e.yxy)-scene(p-e.yxy),
      scene(p+e.yyx)-scene(p-e.yyx)));
  }

  void main(){
    // snap the base-mesh vertex onto the (offset) isosurface — 3 Newton steps
    // (3rd step keeps animated shapes converged when uniforms move each frame)
    vec3 p = position;
    for(int it=0; it<3; it++){ p -= grad(p) * (scene(p) - uOutlineOffset); }

    vNormalW = normalize(mat3(modelMatrix) * grad(p));

    // blend shape colors by proximity (softmin weights, min-subtracted for stability)
    float dmin = 1e5;
    for(int i=0;i<${MAX_SHAPES};i++){ if(i>=uCount) break;
      dmin = min(dmin, sdRoundCone(p, uShapeA[i].xyz, uShapeB[i].xyz, uShapeA[i].w, uShapeB[i].w));
    }
    vec3 col = vec3(0.0); float ws = 0.0;
    for(int i=0;i<${MAX_SHAPES};i++){ if(i>=uCount) break;
      float di = sdRoundCone(p, uShapeA[i].xyz, uShapeB[i].xyz, uShapeA[i].w, uShapeB[i].w);
      float w = exp(-(di - dmin) * 13.0);
      col += uShapeCol[i] * w; ws += w;
    }
    vColor = col / max(ws, 1e-4);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vFog = clamp((-mv.z - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  uniform vec3  uLightDir;
  uniform vec3  uFogColor;
  uniform vec3  uOutlineColor;
  uniform float uIsOutline;
  uniform float uFlash;   // hit flash → white
  uniform float uOpacity; // death fade

  varying vec3  vNormalW;
  varying vec3  vColor;
  varying float vFog;

  void main(){
    if(uIsOutline > 0.5){
      gl_FragColor = vec4(mix(uOutlineColor, uFogColor, vFog), uOpacity);
      return;
    }
    vec3 N = normalize(vNormalW);
    float ndl = dot(N, normalize(uLightDir));
    // 3-band toon ramp
    float band = ndl > 0.55 ? 1.0 : (ndl > 0.05 ? 0.72 : 0.5);
    vec3 lit = vColor * band;
    // soft rim to lift the silhouette
    lit += vColor * 0.18 * pow(1.0 - max(ndl, 0.0), 2.0);
    lit = mix(lit, vec3(1.0, 0.96, 0.9), uFlash);
    lit = mix(lit, uFogColor, vFog);
    gl_FragColor = vec4(lit, uOpacity);
  }
`;

function orientCapsule(g, a, b) {
  const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = dir.length();
  if (len > 1e-4) {
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
  }
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
}

// Build the merged base geometry + body & outline materials (uniforms shared by
// reference, so animating shapes / flash / opacity drives both passes at once).
export function buildBlendShell(shapes, opts = {}) {
  const k = opts.k ?? 1.0;
  const outline = opts.outline ?? 0.5;
  const n = Math.min(shapes.length, MAX_SHAPES);

  // base meshes: a low-poly capsule per shape, slightly inflated by k so its
  // vertices start OUTSIDE the blended surface and snap inward onto it. A
  // shape's optional `pad` inflates further — set it to the animation excursion
  // so vertices still start outside the surface at the gait extremes.
  const geos = [];
  for (let i = 0; i < n; i++) {
    const s = shapes[i];
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]);
    const r = Math.max(s.ra, s.rb) + k + (s.pad || 0);
    const g = new THREE.CapsuleGeometry(r, Math.max(len, 0.01), 5, 14);
    orientCapsule(g, s.a, s.b);
    geos.push(g);
  }
  const geometry = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());

  // shared uniform value arrays (mutated in place to animate)
  const shapeA = [], shapeB = [], shapeCol = [];
  for (let i = 0; i < MAX_SHAPES; i++) {
    const s = shapes[i % n];
    shapeA.push(new THREE.Vector4(s.a[0], s.a[1], s.a[2], s.ra));
    shapeB.push(new THREE.Vector4(s.b[0], s.b[1], s.b[2], s.rb));
    shapeCol.push(new THREE.Color(s.color));
  }
  // uniform OBJECTS shared between the two materials by reference
  const shared = {
    uCount: { value: n },
    uShapeA: { value: shapeA },
    uShapeB: { value: shapeB },
    uShapeCol: { value: shapeCol },
    uK: { value: k },
    uLightDir: { value: new THREE.Vector3(0.4, 1.0, 0.55).normalize() },
    uFogColor: { value: new THREE.Color(CONFIG.fog.color) },
    uFogNear: { value: CONFIG.fog.near },
    uFogFar: { value: CONFIG.fog.far },
    uFlash: { value: 0 },
    uOpacity: { value: 1 },
    uOutlineColor: { value: new THREE.Color(0x14100c) },
  };

  const bodyMaterial = new THREE.ShaderMaterial({
    uniforms: { ...shared, uOutlineOffset: { value: 0 }, uIsOutline: { value: 0 } },
    vertexShader: VERT, fragmentShader: FRAG,
  });
  const outlineMaterial = new THREE.ShaderMaterial({
    uniforms: { ...shared, uOutlineOffset: { value: outline }, uIsOutline: { value: 1 } },
    vertexShader: VERT, fragmentShader: FRAG,
    side: THREE.BackSide,
  });

  return { geometry, bodyMaterial, outlineMaterial, uniforms: shared, count: n };
}
