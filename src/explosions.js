import * as THREE from 'three';

// Pooled explosion visuals — an additive fireball (icosahedron that scales out
// and fades) plus a ground shock ring, both drawn additively so they glow over
// the sand. One reusable PointLight snaps to the newest blast and decays. Each
// slot owns its own material so opacities are independent; the pool is small
// (blasts are rare vs. bullets) so plain Meshes beat instancing here.

const POOL = 10;

export class Explosions {
  constructor(scene) {
    this.balls = [];
    this.rings = [];
    const ballGeo = new THREE.IcosahedronGeometry(1, 1);
    const ringGeo = new THREE.RingGeometry(0.55, 1, 28);
    for (let i = 0; i < POOL; i++) {
      const bmat = new THREE.MeshBasicMaterial({
        color: 0xffcf7a, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const ball = new THREE.Mesh(ballGeo, bmat);
      ball.visible = false; ball.frustumCulled = false;
      scene.add(ball); this.balls.push(ball);

      const rmat = new THREE.MeshBasicMaterial({
        color: 0xffa040, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(ringGeo, rmat);
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false; ring.frustumCulled = false;
      scene.add(ring); this.rings.push(ring);
    }

    this.state = new Array(POOL).fill(null); // { life, max, radius } | null
    this.light = new THREE.PointLight(0xffb050, 0, 45);
    scene.add(this.light);
    this._cursor = 0;
  }

  spawn(x, y, z, radius) {
    const i = this._cursor;
    this._cursor = (this._cursor + 1) % POOL;
    const ball = this.balls[i], ring = this.rings[i];
    ball.position.set(x, y, z);
    ball.scale.setScalar(radius * 0.35);
    ball.material.color.setHex(0xfff0c0); // white-hot at birth
    ball.material.opacity = 1;
    ball.visible = true;
    ring.position.set(x, 0.06, z);
    ring.scale.setScalar(radius * 0.5);
    ring.material.opacity = 0.9;
    ring.visible = true;
    this.state[i] = { life: 0, max: 0.5, radius };
    this.light.position.set(x, y + 2, z);
    this.light.intensity = 34;
  }

  update(dt) {
    if (this.light.intensity > 0) {
      this.light.intensity = Math.max(0, this.light.intensity - dt * 190);
    }
    for (let i = 0; i < POOL; i++) {
      const s = this.state[i];
      if (!s) continue;
      s.life += dt;
      const t = s.life / s.max;
      const ball = this.balls[i], ring = this.rings[i];
      if (t >= 1) {
        this.state[i] = null;
        ball.visible = false;
        ring.visible = false;
        continue;
      }
      ball.scale.setScalar(s.radius * (0.35 + t * 0.95));
      ball.material.opacity = (1 - t) * (1 - t);
      ball.material.color.setHex(0xfff0c0).lerp(_smoke, Math.min(t * 1.4, 1)); // fireball → smoke
      ring.scale.setScalar(s.radius * (0.5 + t * 1.7));
      ring.material.opacity = 0.9 * (1 - t);
    }
  }
}

const _smoke = new THREE.Color(0x2a1c12);
