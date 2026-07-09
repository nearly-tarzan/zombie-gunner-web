import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from './config.js';

// Instanced zombie horde — one draw call for the whole crowd.
// PURSUIT: the truck is escaping. Zombies spawn BEHIND it in "streams" (the
// ad's zombie rivers), chase it, and recycle when they catch it or fall out
// of the chase. Perspective handles all shrink-with-distance for free.
//
// Phase 2 adds combat state on top of the same flat arrays:
//   - hp[]     : per-instance health; bullets subtract, 0 -> death.
//   - dead[]   : 1 = killed and hidden, awaiting the spawner.
//   Deaths (bullets) thin the crowd and are refilled by the spawner at a rate
//   knob. World-flow recycles (reaching the truck / falling out the back) are
//   NOT deaths — they reposition a still-living zombie and cost no spawn budget.

// Wider, muted palette — greens → olive → brown → grey → ashen, plus a rare
// dried-blood maroon. All dark/low-value so the crowd still reads as the ad's
// "dark figures", but with real hue variation across the horde.
const ZOMBIE_TINTS = [
  0x3a4a3a, // olive green
  0x445038, // yellow-green
  0x2f3d33, // deep green
  0x484f47, // grey-green
  0x4a4438, // muddy brown
  0x554a3a, // tan-brown
  0x3e3629, // dark earth
  0x40433f, // cold grey
  0x565c4a, // pale sickly green
  0x4a3838, // dried-blood maroon (muted)
  0x35423a, // teal-green
  0x504a42, // grey-tan
];

// Phase 6 art pass: a merged low-poly humanoid to replace the Phase-1 capsule.
// ONE BufferGeometry (all parts merged) so the whole horde stays a single
// InstancedMesh draw call — the perf contract that lets 1500 zombies hold 60fps.
// Built feet-at-y=0, ~1.55u tall (matches the capsule's footprint so lurch/
// scale/reach distances read unchanged), and FRONT = +Z: the horde's per-instance
// rotation.y (atan2(dx,dz) in update()) points local +Z at the truck, so the
// jutting head and reaching arms lunge toward the convoy. The shambling read is
// carried by the silhouette (hunched torso, dropped head, forward-reaching arms)
// — that's what registers across a canyon-wide crowd, not surface detail.
function makeZombieGeometry() {
  const parts = [];
  // box(w,h,d, x,y,z, rotX, shade) — rotate about the part's own center, position
  // it, then bake a flat grayscale VERTEX color (`shade`). That vertex color
  // multiplies the per-instance tint in the shader, giving every figure an
  // internal dark-legs → lit-head value gradient on top of its overall hue.
  // Shades are hue-neutral and ≤1 so the hit-flash (which drives instanceColor
  // toward white) still blows the whole body bright.
  const box = (w, h, d, x, y, z, rx, shade) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    g.translate(x, y, z);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    col.fill(shade);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  };
  // Gaunt, starved build — narrow limbs and a lean torso; height held ~1.55u so
  // the Phase-1 lurch/scale/reach distances read unchanged. FRONT = +Z (the
  // horde's rotation.y points local +Z at the truck, so the jutting head and
  // reaching arms lunge toward the convoy). One merged BufferGeometry keeps the
  // whole horde a single InstancedMesh draw call — the 60fps-at-1500 contract.
  box(0.15, 0.76, 0.17, -0.11, 0.38,  0.06, 0,    0.72); // legs — dark (boots/dirt/pants)
  box(0.15, 0.76, 0.17,  0.11, 0.38, -0.06, 0,    0.72);
  box(0.34, 0.20, 0.22,  0,    0.84,  0,    0,    0.82); // pelvis
  box(0.36, 0.54, 0.24,  0,    1.14,  0.02, 0.12, 0.90); // hunched, lean torso
  box(0.22, 0.26, 0.24,  0,    1.41,  0.11, 0.18, 1.00); // head — lit (exposed, juts fwd/down)
  box(0.11, 0.11, 0.60, -0.22, 1.08,  0.28, 0.55, 1.00); // arms reaching fwd-down (exposed)
  box(0.11, 0.11, 0.60,  0.22, 1.08,  0.28, 0.55, 1.00);
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  return merged;
}

export class Horde {
  constructor(scene) {
    const h = CONFIG.horde;
    const geo = makeZombieGeometry(); // Phase 6: merged low-poly humanoid, feet at y=0, front +Z
    // vertexColors on: the baked per-part shade modulates each instance's tint.
    // instanceColor (setColorAt) still multiplies on top for hue + hit-flash.
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });

    this.mesh = new THREE.InstancedMesh(geo, mat, h.maxCount);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; // instances span the whole corridor
    scene.add(this.mesh);

    // Per-instance state (flat arrays, no per-zombie objects)
    this.x = new Float32Array(h.maxCount);
    this.z = new Float32Array(h.maxCount);
    this.speed = new Float32Array(h.maxCount);
    this.phase = new Float32Array(h.maxCount);
    this.scale = new Float32Array(h.maxCount);
    this.hp = new Float32Array(h.maxCount);
    this.dead = new Uint8Array(h.maxCount); // 1 = killed, hidden, awaiting respawn
    this.flash = new Float32Array(h.maxCount); // Phase 3 hit flash, 1 → 0
    this.laneX = new Float32Array(h.maxCount); // held lane — the wall, not the river

    const color = new THREE.Color();
    for (let i = 0; i < h.maxCount; i++) {
      color.setHex(ZOMBIE_TINTS[i % ZOMBIE_TINTS.length]);
      this.mesh.setColorAt(i, color);
    }
    this.mesh.instanceColor.needsUpdate = true;

    this.activeCount = h.count;   // iterated slots (mesh.count) — the density ceiling
    this.aliveCount = h.count;    // living zombies within the pool (kills reduce this)
    this.contactCount = 0;        // zombies that reached the truck this frame (read by main)
    this.time = 0;
    this._dummy = new THREE.Object3D();
    this._col = new THREE.Color();
    this._white = new THREE.Color(0xfff0e0);
    this._colorDirty = false;
    this._spawnCredit = 0;        // fractional spawner accumulator
    this._deadSlots = [];         // indices of killed zombies awaiting the spawner
    this._lastTruckZ = 0;
    this.barriers = [];           // Phase 4 walls: {x0,x1,z} — block crossings

    // Streams: rough x-centers the horde flows down, like the ad's channels
    this.streams = [-16, -9, 0, 9, 16];

    for (let i = 0; i < h.maxCount; i++) this._respawn(i, 0, true);
    this.mesh.count = this.activeCount;
  }

  _respawn(i, truckZ, initial = false) {
    const h = CONFIG.horde;
    const w = CONFIG.world;
    const behind = initial
      ? 8 + Math.random() * (h.spawnMaxBehind - 8)
      : h.spawnMinBehind + Math.random() * (h.spawnMaxBehind - h.spawnMinBehind);
    const stream = this.streams[Math.floor(Math.random() * this.streams.length)];
    // Gaussian-ish spread around the stream center
    const spread = (Math.random() + Math.random() + Math.random() - 1.5) * 4;
    this.x[i] = THREE.MathUtils.clamp(stream + spread, -w.canyonHalfWidth + 1, w.canyonHalfWidth - 1);
    this.laneX[i] = this.x[i]; // hold the lane you spawned in until close to the truck
    this.z[i] = truckZ + behind; // behind = +Z (truck travels -Z)
    this.speed[i] = h.minSpeed + Math.random() * (h.maxSpeed - h.minSpeed);
    this.phase[i] = Math.random() * Math.PI * 2;
    this.scale[i] = 0.9 + Math.random() * 0.25;
    this.hp[i] = CONFIG.zombie.hp;
    this.dead[i] = 0;
    if (this.flash[i] > 0) { // clear any leftover hit flash from the previous life
      this.flash[i] = 0;
      this.mesh.setColorAt(i, this._col.setHex(this.tintHexOf(i)));
      this._colorDirty = true;
    }
  }

  tintHexOf(i) {
    return ZOMBIE_TINTS[i % ZOMBIE_TINTS.length];
  }

  setCount(n) {
    n = Math.min(Math.max(0, Math.round(n)), CONFIG.horde.maxCount);
    if (n > this.activeCount) {
      // Newly activated slots enter alive, positioned relative to the truck now
      for (let i = this.activeCount; i < n; i++) this._respawn(i, this._lastTruckZ);
      this.aliveCount += (n - this.activeCount);
    } else if (n < this.activeCount) {
      // Dropping slots off the top — subtract any that were alive
      for (let i = n; i < this.activeCount; i++) if (!this.dead[i]) this.aliveCount--;
      this._deadSlots = this._deadSlots.filter((idx) => idx < n);
    }
    this.activeCount = n;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // Nearest LIVING instance under a camera ray, or null. Dead instances are
  // parked far below with zero scale, so they don't register as hits.
  hit(raycaster) {
    const hits = raycaster.intersectObject(this.mesh, false);
    for (const it of hits) {
      if (it.instanceId != null && !this.dead[it.instanceId]) return it;
    }
    return null;
  }

  // Apply bullet damage. Returns { killed, overkill } (overkill = damage past
  // zero HP — main uses it for the gib threshold), or null on a stale target.
  // Position arrays keep the death spot until the spawner reuses the slot, so
  // callers can read x/z/scale right after a kill for corpse/gib placement.
  damage(i, dmg) {
    if (i == null || this.dead[i]) return null;
    this.hp[i] -= dmg;
    this.flash[i] = 1;
    if (this.hp[i] <= 0) {
      this.dead[i] = 1;
      this.aliveCount--;
      this._deadSlots.push(i);
      this._hide(i);
      return { killed: true, overkill: -this.hp[i] };
    }
    return { killed: false, overkill: 0 };
  }

  // Phase 4: radial blast damage in the XZ plane. Damages every LIVING instance
  // within `radius` of (cx, cz) with linear falloff to the edge, kills into the
  // same spawner queue as bullets, and returns a kill list ({ x, z, scale, tint })
  // so the caller can burst gibs/mist/numbers. Callers ALWAYS gib these —
  // explosions have no crit roll (force-gib path, per the Phase 4 spec).
  areaDamage(cx, cz, radius, dmg) {
    const r2 = radius * radius;
    const kills = [];
    for (let i = 0; i < this.activeCount; i++) {
      if (this.dead[i]) continue;
      const dx = this.x[i] - cx, dz = this.z[i] - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const falloff = 1 - 0.6 * (Math.sqrt(d2) / radius); // center full, edge 40%
      this.hp[i] -= dmg * falloff;
      this.flash[i] = 1;
      if (this.hp[i] <= 0) {
        this.dead[i] = 1;
        this.aliveCount--;
        this._deadSlots.push(i);
        this._hide(i);
        kills.push({ x: this.x[i], z: this.z[i], scale: this.scale[i], tint: this.tintHexOf(i) });
      }
    }
    return kills;
  }

  // Phase 4: rectangular crush (the rolling spike drum's footprint — a wide
  // swath, not a circle). Same kill-list contract as areaDamage.
  boxDamage(cx, cz, halfX, halfZ, dmg) {
    const kills = [];
    for (let i = 0; i < this.activeCount; i++) {
      if (this.dead[i]) continue;
      if (Math.abs(this.x[i] - cx) > halfX || Math.abs(this.z[i] - cz) > halfZ) continue;
      this.hp[i] -= dmg;
      this.flash[i] = 1;
      if (this.hp[i] <= 0) {
        this.dead[i] = 1;
        this.aliveCount--;
        this._deadSlots.push(i);
        this._hide(i);
        kills.push({ x: this.x[i], z: this.z[i], scale: this.scale[i], tint: this.tintHexOf(i) });
      }
    }
    return kills;
  }

  _hide(i) {
    const d = this._dummy;
    d.position.set(this.x[i], -50, this.z[i]); // park below the world
    d.rotation.set(0, 0, 0);
    d.scale.setScalar(0);
    d.updateMatrix();
    this.mesh.setMatrixAt(i, d.matrix);
    this.mesh.instanceMatrix.needsUpdate = true; // may fire between frames
  }

  update(dt, truckPos, obstacles) {
    const h = CONFIG.horde;
    this._lastTruckZ = truckPos.z;
    this.time += dt;
    this.contactCount = 0;
    const d = this._dummy;

    // Keep the raycast bounding sphere riding with the chase. InstancedMesh
    // computes it ONCE from wherever the instances were on the first raycast;
    // as the truck drives away the stale sphere stops intersecting aim rays and
    // every shot silently "misses". (Bit us on 2026-07-02 — hits died after
    // ~2 min of travel.)
    if (!this.mesh.boundingSphere) this.mesh.boundingSphere = new THREE.Sphere();
    this.mesh.boundingSphere.center.set(truckPos.x, 1, truckPos.z + h.spawnMaxBehind * 0.5);
    this.mesh.boundingSphere.radius = h.despawnFar + 60;

    // Spawner: revive killed slots at the rate knob, up to the density ceiling.
    this._spawnCredit += CONFIG.spawner.rate * dt;
    while (this._spawnCredit >= 1 && this._deadSlots.length) {
      const i = this._deadSlots.pop();
      this._respawn(i, truckPos.z); // clears dead[i], restores hp
      this.aliveCount++;
      this._spawnCredit -= 1;
    }
    if (!this._deadSlots.length && this._spawnCredit > 1) this._spawnCredit = 1; // don't bank

    // Whole-horde speed multiplier — a level surge swells it so the wall visibly
    // rushes the truck (levels.js sets CONFIG.horde.speedMul; stays 1 in sandbox).
    const sMul = CONFIG.horde.speedMul;
    for (let i = 0; i < this.activeCount; i++) {
      if (this.dead[i]) continue; // stays hidden (matrix already zeroed on death)

      // Steer: chase the truck's Z, but hold your own lane while far — the
      // horde reads as a broad wall. Beeline for the truck itself only when
      // close (convergeFar → convergeNear blend), so the swarm collapses onto
      // the truck at the last moment instead of forming a single-file river.
      let dx = truckPos.x - this.x[i];
      let dz = truckPos.z - this.z[i];
      const dist = Math.hypot(dx, dz);

      if (dist < h.reachRadius) {
        this.contactCount++;            // caught the truck — deals contact damage
        this._respawn(i, truckPos.z);   // world-flow recycle: still alive, re-fed behind
        dx = truckPos.x - this.x[i];
        dz = truckPos.z - this.z[i];
      } else if (this.z[i] > truckPos.z + h.despawnFar) {
        this._respawn(i, truckPos.z);   // fell out of the chase — re-fed behind
        dx = truckPos.x - this.x[i];
        dz = truckPos.z - this.z[i];
      }

      const lane = THREE.MathUtils.clamp(
        (dist - h.convergeNear) / Math.max(h.convergeFar - h.convergeNear, 0.001), 0, 1
      ); // 1 = far (hold lane), 0 = close (beeline)
      dx = (truckPos.x + this.laneX[i] * lane) - this.x[i];

      const inv = 1 / Math.max(Math.hypot(dx, dz), 0.001);
      // Slight lateral weave so the flow looks alive, not laser-guided
      const weave = Math.sin(this.time * 1.7 + this.phase[i]) * 0.35;
      const pz0 = this.z[i]; // pre-move z, for the wall-crossing test below
      this.x[i] += (dx * inv * this.speed[i] * sMul + weave) * dt;
      this.z[i] += dz * inv * this.speed[i] * sMul * dt;

      // World clutter is physical: project out of boulders/wrecks/shacks so the
      // crowd SPLITS around them (the ad's rivers). Radial push-out plus a small
      // per-zombie tangential bias so a head-on approach slides off to a side
      // instead of stalling against the face. Cheap: ~30 blockers, early-outs.
      if (obstacles && obstacles.length && CONFIG.horde.obstacleSteer) {
        for (let o = 0; o < obstacles.length; o++) {
          const ob = obstacles[o];
          const dzo = this.z[i] - ob.z;
          if (dzo > ob.r || dzo < -ob.r) continue;
          const dxo = this.x[i] - ob.x;
          if (dxo > ob.r || dxo < -ob.r) continue;
          const d2 = dxo * dxo + dzo * dzo;
          if (d2 >= ob.r * ob.r) continue;
          const dd = Math.sqrt(d2) || 0.001;
          const push = ob.r - dd;
          const side = (i & 1) ? 1 : -1; // stable per-zombie handedness
          this.x[i] += (dxo / dd) * push + (-dzo / dd) * side * push * 0.5;
          this.z[i] += (dzo / dd) * push + (dxo / dd) * side * push * 0.5;
        }
      }

      // Phase 4 cargo-box wall: a barrier blocks zombies crossing it from behind
      // toward the truck (they pile against its rear face). Zombies already in
      // FRONT when it dropped (pz0 < wall z) are untouched, so it never yanks
      // anyone backward — it only holds the line for those still behind it.
      if (this.barriers.length) {
        for (let b = 0; b < this.barriers.length; b++) {
          const bar = this.barriers[b];
          if (this.x[i] > bar.x0 && this.x[i] < bar.x1 && pz0 >= bar.z && this.z[i] < bar.z) {
            this.z[i] = bar.z;
          }
        }
      }

      // Lurching walk: bob + tilt driven by per-instance phase
      const lurch = this.time * this.speed[i] * 2.4 + this.phase[i];
      d.position.set(this.x[i], Math.abs(Math.sin(lurch)) * 0.08, this.z[i]);
      d.rotation.set(
        Math.sin(lurch * 0.5) * 0.06 + 0.12, // slight forward hunch
        Math.atan2(dx, dz),                   // face the truck
        Math.sin(lurch) * 0.1
      );
      d.scale.setScalar(this.scale[i]);
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);

      // Hit flash: blend the tint toward white and decay back
      if (this.flash[i] > 0) {
        const f = this.flash[i];
        this._col.setHex(this.tintHexOf(i)).lerp(this._white, Math.min(f, 1) * 0.85);
        this.flash[i] = f - dt * 7;
        if (this.flash[i] <= 0) {
          this.flash[i] = 0;
          this._col.setHex(this.tintHexOf(i)); // restore the exact tint
        }
        this.mesh.setColorAt(i, this._col);
        this._colorDirty = true;
      }
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this._colorDirty) {
      this.mesh.instanceColor.needsUpdate = true;
      this._colorDirty = false;
    }
  }
}
