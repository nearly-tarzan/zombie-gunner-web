import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from './config.js';

// Desert canyon corridor built from recycled segments. Truck drives toward -Z;
// when a segment falls behind the truck it teleports to the front of the corridor.
// Ground + road + wheel ruts are single planes that slide along with the truck
// (flat color, so no texture swimming) — motion cues come from the walls, road
// wear (cracks/patches/potholes), clutter, and the weathered center dashes.
//
// Everything static in a segment (cliff strata, talus, boulders, wrecks, shacks,
// poles, road wear, ground mottling) is baked into ONE vertex-colored geometry
// per segment — 8 draw calls for the whole corridor.
//
// CLUTTER IS PHYSICAL: big boulders and wrecked cars register in `this.obstacles`
// ({x, z, r} in world space, z maintained across segment recycling). The horde
// steers around them (Horde.update), so the crowd splits into the ad's "rivers"
// instead of ghosting through the scenery.

const SAND = 0xc2a878;
const ROAD = 0x8d7c5e;      // packed dirt/worn asphalt — darker than the sand
const RUT = 0x7c6c50;       // wheel-track strips
const DASH = 0xcbc2a6;      // weathered paint
const CRACK = 0x655741;
const PATCH = 0x7d6e53;
const POTHOLE = 0x5f5340;
const ROCK = 0x8a7355;

// Cliff strata (bottom → top): banded sandstone like the ad's mesas — dark
// shadowed base, orange midbands, pale caprock. Heights are fixed corridor-wide
// so the bedding lines up from segment to segment like real geology.
const STRATA = [
  { h: 2.4, c: 0x6b4c2c },
  { h: 3.4, c: 0xb0713a }, // saturated orange
  { h: 4.2, c: 0xcf8f4d },
  { h: 1.6, c: 0x74522e }, // thin dark seam
  { h: 4.6, c: 0xd6a55f },
  { h: 3.2, c: 0xe0bd80 }, // pale band
  { h: 2.0, c: 0x835a30 }, // second seam
  { h: 4.6, c: 0xc98e4b },
  { h: 5.4, c: 0xdcb271 }, // pale caprock
];

const WRECK_PAINTS = [0x7a4a33, 0x5b6066, 0x6e6a55, 0x4f5a63, 0x74553b];
const SHACK_WOOD = 0x6e5c45;
const SHACK_ROOF = 0x4f4436;
const POLE_WOOD = 0x5c4b38;

export class World {
  constructor(scene) {
    const { segmentLength, segmentCount, canyonHalfWidth, roadWidth } = CONFIG.world;
    this.segmentLength = segmentLength;
    this.segmentCount = segmentCount;
    this.totalLength = segmentLength * segmentCount;

    // Ground
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 700),
      new THREE.MeshLambertMaterial({ color: SAND })
    );
    this.ground.rotation.x = -Math.PI / 2;
    scene.add(this.ground);

    // Road + wheel ruts — uniform along Z, so they can slide with the truck
    this.road = new THREE.Mesh(
      new THREE.PlaneGeometry(roadWidth, 700),
      new THREE.MeshLambertMaterial({ color: ROAD })
    );
    this.road.rotation.x = -Math.PI / 2;
    this.road.position.y = 0.02;
    scene.add(this.road);

    this.ruts = [];
    const rutGeo = new THREE.PlaneGeometry(0.55, 700);
    const rutMat = new THREE.MeshLambertMaterial({ color: RUT });
    for (const x of [-1.0, 1.0]) { // the truck's wheel track
      const rut = new THREE.Mesh(rutGeo, rutMat);
      rut.rotation.x = -Math.PI / 2;
      rut.position.set(x, 0.026, 0);
      scene.add(rut);
      this.ruts.push(rut);
    }

    // Center-line dashes — weathered: uneven lengths, a quarter missing
    this.dashes = [];
    const dashGeo = new THREE.BoxGeometry(0.25, 0.02, 2);
    const dashMat = new THREE.MeshBasicMaterial({ color: DASH });
    this.dashSpacing = 8;
    this.dashCount = Math.ceil(this.totalLength / this.dashSpacing) + 4;
    // Coverage is centered on the chase from frame one: the camera looks
    // BEHIND the truck, so ~56% of the corridor starts on the rear side.
    this.rearMargin = this.totalLength * 0.56;
    for (let i = 0; i < this.dashCount; i++) {
      const dash = new THREE.Mesh(dashGeo, dashMat);
      dash.position.set((Math.random() - 0.5) * 0.12, 0.05, this.rearMargin - i * this.dashSpacing);
      dash.scale.z = 0.55 + Math.random() * 0.7;
      if (Math.random() < 0.25) dash.visible = false; // worn away
      scene.add(dash);
      this.dashes.push(dash);
    }

    // Canyon segments — one merged vertex-colored mesh each
    this.segments = [];
    this.obstacles = []; // {x, z, r} world-space steering blockers (boulders, wrecks)
    this.segMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    for (let i = 0; i < segmentCount; i++) {
      const baseZ = this.rearMargin - i * segmentLength;
      const seg = this._buildSegment(baseZ);
      scene.add(seg);
      this.segments.push(seg);
    }
  }

  // Bake a flat vertex color (with optional value jitter) and normalize the
  // attribute set so everything merges into one geometry. Dodecahedrons are
  // non-indexed while box/plane/circle are indexed — de-index everything so
  // mergeGeometries accepts the mix.
  _paint(geo, hex, vary = 0) {
    if (geo.index) {
      const ni = geo.toNonIndexed();
      geo.dispose();
      geo = ni;
    }
    const c = new THREE.Color(hex);
    if (vary) {
      const f = 1 + (Math.random() * 2 - 1) * vary;
      c.r = Math.min(1, c.r * f); c.g = Math.min(1, c.g * f); c.b = Math.min(1, c.b * f);
    }
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (geo.attributes.uv) geo.deleteAttribute('uv');
    return geo;
  }

  _buildSegment(baseZ) {
    const { segmentLength, canyonHalfWidth, roadWidth } = CONFIG.world;
    const parts = [];
    const obs = []; // this segment's steering blockers, local z
    const box = (w, h, d, x, y, z, ry, hex, vary = 0.05, rx = 0, rz = 0) => {
      const g = new THREE.BoxGeometry(w, h, d);
      if (rx) g.rotateX(rx);
      if (rz) g.rotateZ(rz);
      if (ry) g.rotateY(ry);
      g.translate(x, y, z);
      parts.push(this._paint(g, hex, vary));
    };
    const rock = (s, x, y, z, hex, vary = 0.08, squash = 0.75) => {
      const g = new THREE.DodecahedronGeometry(1, 0);
      g.scale(s, s * squash, s * (0.85 + Math.random() * 0.3));
      g.rotateY(Math.random() * Math.PI * 2);
      g.translate(x, y, z);
      parts.push(this._paint(g, hex, vary));
    };
    const flat = (w, l, x, z, hex, y = 0.012, ry = 0, vary = 0.04) => {
      const g = new THREE.PlaneGeometry(w, l);
      g.rotateX(-Math.PI / 2);
      if (ry) g.rotateY(ry);
      g.translate(x, y, z);
      parts.push(this._paint(g, hex, vary));
    };

    // ---- stratified cliff walls: columns of stacked, jittered strata --------
    for (const side of [-1, 1]) {
      let z = 0;
      while (z < segmentLength) {
        const colLen = 5 + Math.random() * 6;
        const zc = -(z + colLen / 2);
        const baseDepth = 5 + Math.random() * 3;
        const colJitter = Math.random() * 2.2;
        const roll = Math.random();
        // silhouette variety: notches, mid rim, tall towers
        const totalH = roll < 0.15 ? 8 + Math.random() * 4
          : roll < 0.75 ? 14 + Math.random() * 10
          : 24 + Math.random() * 8; // occasional TOWER — breaks the flat skyline
        let y = 0, layer = 0;
        while (y < totalH && layer < STRATA.length) {
          const st = STRATA[layer];
          // near-fixed layer heights keep the bedding lines continuous from
          // column to column — that horizontal read IS the geology
          const h = Math.min(st.h * (0.95 + Math.random() * 0.1), totalH - y);
          const depth = baseDepth - layer * (0.1 + Math.random() * 0.4) + (Math.random() - 0.5) * 2.0;
          const d = Math.max(depth, 1.6);
          box(d, h + 0.25, colLen + Math.random() * 1.6,
            side * (canyonHalfWidth + d / 2 + colJitter),
            y + h / 2, zc + (Math.random() - 0.5) * 0.7, 0, st.c, 0.08);
          y += h; layer++;
        }
        // caprock rubble on the rim
        if (roll >= 0.15 && Math.random() < 0.5) {
          rock(1 + Math.random() * 1.6, side * (canyonHalfWidth + 2 + Math.random() * 2), y + 0.3, zc, 0xcaa76e);
        }
        z += colLen;
      }
      // talus fans at the wall base
      const talusN = 4 + Math.floor(Math.random() * 4);
      for (let t = 0; t < talusN; t++) {
        const s = 0.7 + Math.random() * 1.7;
        rock(s, side * (canyonHalfWidth - 0.5 + Math.random() * 2.5), s * 0.3, -Math.random() * segmentLength,
          STRATA[Math.floor(Math.random() * 3)].c, 0.1);
      }
    }

    // ---- ground mottling: big soft-value sand patches (motion + breakup) ----
    for (let m = 0; m < 4; m++) {
      const w = 3 + Math.random() * 6;
      const side = Math.random() < 0.5 ? -1 : 1;
      flat(w, w * (0.6 + Math.random() * 0.9),
        side * (roadWidth / 2 + 2 + Math.random() * (canyonHalfWidth - roadWidth / 2 - 4)),
        -Math.random() * segmentLength,
        Math.random() < 0.5 ? 0xb89e70 : 0xcdb284, 0.012, Math.random() * Math.PI);
    }

    // ---- small decorative rocks (unchanged role) -----------------------------
    const rockCount = 3 + Math.floor(Math.random() * 4);
    for (let r = 0; r < rockCount; r++) {
      const s = 0.4 + Math.random() * 1.2;
      const side = Math.random() < 0.5 ? -1 : 1;
      rock(s, side * (roadWidth / 2 + 2 + Math.random() * (canyonHalfWidth - roadWidth / 2 - 4)),
        s * 0.3, -Math.random() * segmentLength, ROCK);
    }

    // ---- BIG boulders — physical: the horde flows around these ---------------
    const boulderCount = 2 + Math.floor(Math.random() * 3);
    for (let b = 0; b < boulderCount; b++) {
      const s = 1.4 + Math.random() * 1.3;
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = side * (roadWidth / 2 + 2.5 + Math.random() * (canyonHalfWidth - roadWidth / 2 - 5));
      const lz = -Math.random() * segmentLength;
      rock(s, x, s * 0.42, lz, STRATA[2 + Math.floor(Math.random() * 3)].c, 0.08, 0.85);
      if (Math.random() < 0.6) rock(s * 0.45, x + s * 0.8, s * 0.16, lz + s * 0.5, ROCK); // satellite chunk
      obs.push({ x, lz, r: s * 1.25 });
    }

    // ---- wrecked cars on the shoulder — physical too --------------------------
    if (Math.random() < 0.45) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = side * (roadWidth / 2 + 0.6 + Math.random() * 2.2);
      const lz = -Math.random() * segmentLength;
      const yaw = Math.random() * Math.PI * 2;
      const paint = WRECK_PAINTS[Math.floor(Math.random() * WRECK_PAINTS.length)];
      const roll = (Math.random() - 0.5) * 0.14; // slumped on dead suspension
      box(4.3, 1.05, 1.95, x, 0.5, lz, yaw, paint, 0.06, 0, roll);
      box(2.0, 0.8, 1.75, x + Math.sin(yaw) * -0.4, 1.3, lz + Math.cos(yaw) * -0.4, yaw, 0x2e2c28, 0.05, 0, roll);
      obs.push({ x, lz, r: 2.7 });
    }

    // ---- roadside shack (weathered, with a roof slab) -------------------------
    if (Math.random() < 0.5) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = side * (roadWidth / 2 + 5 + Math.random() * 6);
      const lz = -Math.random() * segmentLength;
      const yaw = (Math.random() - 0.5) * 0.6;
      box(4, 2.8, 5, x, 1.4, lz, yaw, SHACK_WOOD, 0.06);
      box(4.8, 0.25, 5.9, x, 2.9, lz, yaw, SHACK_ROOF, 0.05, 0, (Math.random() - 0.5) * 0.08);
      obs.push({ x, lz, r: 3.4 });
    }

    // ---- power poles: tall silhouettes, strong parallax cue -------------------
    if (Math.random() < 0.6) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = side * (roadWidth / 2 + 1.6 + Math.random() * 1.2);
      const lz = -Math.random() * segmentLength;
      const lean = (Math.random() - 0.5) * 0.1;
      box(0.28, 7.5, 0.28, x, 3.75, lz, 0, POLE_WOOD, 0.05, 0, lean);
      box(2.2, 0.18, 0.22, x + lean * 6, 6.6, lz, 0, POLE_WOOD, 0.05);
    }

    // ---- road wear: cracks, patches, potholes, crumbled edges ----------------
    const cracks = 2 + Math.floor(Math.random() * 3);
    for (let c = 0; c < cracks; c++) {
      flat(0.12 + Math.random() * 0.08, 1.5 + Math.random() * 2.5,
        (Math.random() - 0.5) * (roadWidth - 1.5), -Math.random() * segmentLength,
        CRACK, 0.035, Math.random() * Math.PI);
    }
    for (let p = 0; p < 2; p++) {
      if (Math.random() < 0.6) {
        flat(0.9 + Math.random() * 1.3, 1.2 + Math.random() * 1.6,
          (Math.random() - 0.5) * (roadWidth - 2.5), -Math.random() * segmentLength,
          Math.random() < 0.3 ? 0x4f4638 /* oil stain */ : PATCH, 0.032, Math.random() * Math.PI);
      }
    }
    if (Math.random() < 0.5) {
      const g = new THREE.CircleGeometry(0.3 + Math.random() * 0.4, 7);
      g.rotateX(-Math.PI / 2);
      g.translate((Math.random() - 0.5) * (roadWidth - 2), 0.038, -Math.random() * segmentLength);
      parts.push(this._paint(g, POTHOLE, 0.05));
    }
    for (const side of [-1, 1]) { // sand bites into the road edge
      const bites = 3 + Math.floor(Math.random() * 4);
      for (let e = 0; e < bites; e++) {
        flat(0.7 + Math.random() * 1.1, 1.0 + Math.random() * 1.4,
          side * (roadWidth / 2 + (Math.random() - 0.5) * 0.5), -Math.random() * segmentLength,
          SAND, 0.03, Math.random() * Math.PI, 0.03);
      }
    }

    const merged = mergeGeometries(parts, false);
    parts.forEach((g) => g.dispose());
    const seg = new THREE.Mesh(merged, this.segMat);
    seg.position.z = baseZ;
    // register this segment's blockers in world space; update() keeps z correct
    // across recycling (the whole segment teleports by totalLength)
    seg.userData.obs = obs.map((o) => {
      const ob = { x: o.x, z: baseZ + o.lz, r: o.r };
      this.obstacles.push(ob);
      return ob;
    });
    return seg;
  }

  update(truckZ) {
    // Ground + road + ruts slide with the truck (centered — the camera looks BEHIND)
    this.ground.position.z = truckZ;
    this.road.position.z = truckZ;
    for (const rut of this.ruts) rut.position.z = truckZ;

    // Corridor coverage is centered on the chase: roughly truckZ+180 (behind,
    // where the camera looks and the horde lives) to truckZ-140 (ahead).
    const rearEdge = truckZ + this.rearMargin;

    for (const dash of this.dashes) {
      if (dash.position.z > rearEdge) {
        dash.position.z -= this.dashCount * this.dashSpacing;
      }
    }

    for (const seg of this.segments) {
      if (seg.position.z > rearEdge) {
        seg.position.z -= this.totalLength;
        for (const ob of seg.userData.obs) ob.z -= this.totalLength; // blockers ride along
      }
    }
  }
}
