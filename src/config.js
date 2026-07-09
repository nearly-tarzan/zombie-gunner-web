// Central tunables. Phase 1 cares about one thing: the depth read.
// Camera + fog values here are the levers for that; adjust live via the debug panel.
export const CONFIG = {
  truck: {
    speed: 6,          // units/sec, auto-drive along -Z — pursuers must be able to gain on it
    width: 2.4,
    height: 2.2,
    length: 5.6,
  },
  camera: {
    // High side/three-quarter aerial view (per the ad's side frames):
    // camera rides beside-and-ahead of the truck, looking back so the truck
    // sits foreground and the pursuing horde fills the frame behind it.
    fov: 55,
    offsetX: 16,       // beside the truck (+X = right of travel)
    offsetY: 12,       // height above
    offsetZ: -9,       // slightly AHEAD of the truck (travel is -Z)
    lookX: 0,
    lookY: 0.5,
    lookZ: 18,         // aim point BEHIND the truck — frames the chase
    damping: 3.5,      // higher = snappier follow
  },
  horde: {
    count: 400,
    maxCount: 1500,    // instanced mesh capacity — Phase 3 density-push ceiling
    // Pursuit: the truck is ESCAPING. Speeds straddle truck speed so the
    // horde hangs behind it — the fast ones gain, the slow ones fall away.
    minSpeed: 4.5,
    maxSpeed: 7.5,
    spawnMinBehind: 15,
    spawnMaxBehind: 120,
    despawnFar: 145,   // recycled once this far behind — fell out of the chase
    reachRadius: 2.4,  // caught the truck — recycle (contact damage is Phase 2)
    // Lane-keeping (Phase 3 feel fix): far away, each zombie holds its own lane
    // so the pursuit reads as a WALL, not a single-file river; it beelines for
    // the truck only once inside convergeFar (fully by convergeNear).
    convergeFar: 26,
    convergeNear: 7,
    obstacleSteer: true, // horde flows AROUND boulders/wrecks/shacks (world.obstacles)
    speedMul: 1,       // runtime whole-horde speed multiplier — a level surge swells it (levels.js)
  },
  world: {
    canyonHalfWidth: 21,  // wall inner face distance from road center
    roadWidth: 8,
    segmentLength: 40,
    segmentCount: 8,      // recycled corridor segments (8 * 40 = 320u visible run)
  },
  fog: {
    color: 0xd9c8a0,
    near: 70,
    far: 230,
  },

  // ---- Phase 2: gun + combat core -------------------------------------------
  // The gun is a screen-space overlay decoupled from the aerial camera (per the
  // ad: camera floats high over the canyon, gun stays first-person bottom-center).
  // Hitscan raycasts from the MAIN camera through the crosshair's NDC — so the
  // tracer endpoint always lies on that ray and re-projects onto the crosshair
  // at any depth. That is the whole acceptance criterion, made structural.
  gun: {
    fireRate: 11,       // rounds/sec while the button is held
    damage: 34,         // HP per hit (≈3 shots to kill at zombie.hp = 100)
    range: 400,         // hitscan reach when the ray hits neither zombie nor ground
    // Screen-space origin of the tracer streak. muzzleNDC is bottom-center; the
    // muzzle world point is that NDC unprojected muzzleDist units in front of the
    // main camera, so streaks appear to leave the overlay gun's barrel.
    muzzleNDCx: 0,
    muzzleNDCy: -0.82,
    muzzleDist: 12,
    tracerSpeed: 300,   // units/sec the streak's leading edge travels
    tracerLength: 6,    // length of the bright streak
    tracerThick: 0.07,  // cross-section
    tracerMax: 48,      // pooled capacity (full-auto overlap headroom)
  },
  zombie: {
    hp: 100,            // applied to newly spawned/recycled zombies
  },
  spawner: {
    rate: 22,           // zombies/sec the spawner revives dead slots (refill speed)
    min: 0,
    max: 80,
  },
  combat: {
    truckMaxHp: 150,
    contactDamage: 3,   // truck HP lost per zombie that reaches it (then recycles)
  },

  // ---- Phase 3: visceral layer ----------------------------------------------
  // Every feel parameter below is a live knob in the debug panel — the phase's
  // acceptance is subjective (Josh plays), so tuning happens in-session.
  crit: {
    chance: 0.15,       // random roll per shot (slot-machine, ad-style)
    multiplier: 2.2,    // damage multiplier on crit
  },
  gore: {
    enabled: true,
    mistPerHit: 6,      // blood particles per non-lethal hit
    mistKill: 10,       // extra burst when the hit kills
    mistGib: 16,        // burst when the body gibs
    gibCount: 8,        // chunks per gibbed zombie
    gibOverkillFrac: 0.45, // kill overflow ≥ this × max HP → gib (crits always gib)
    corpseLife: 4.5,    // seconds a corpse persists before sinking away
  },
  shake: {
    enabled: true,
    // Sustained fire must OUT-PACE decay or trauma never accumulates and the
    // squared curve crushes the result to invisible (v1 bug: 0.14×11 < 1.7).
    perShot: 0.25,      // trauma added per shot — full-auto saturates in ~0.5s
    amplitude: 0.45,    // world-units of camera jitter at full trauma
    rollAmp: 0.035,     // radians of camera roll at full trauma
    decay: 1.3,         // trauma lost per second
  },
  numbers: {
    enabled: true,
    scale: 0.85,        // world-unit height of a damage digit
    critScale: 1.7,     // size multiplier for crit numbers
    life: 0.75,         // seconds on screen
    rise: 2.4,          // upward drift, units/sec
  },
  casings: {
    max: 40,
    life: 0.9,
  },
  audio: {
    enabled: true,
    volume: 0.5,
  },

  // ---- Phase 4: shoot-the-number powerups -----------------------------------
  // Crates spawn roadside just behind the truck, fully in view, and RECEDE
  // toward the horde as the truck escapes. Shoot the countdown to 0 before the
  // wave swallows the crate — the shrinking window IS the mechanic. Crates are
  // plain Meshes (not InstancedMesh), so their raycast bounds follow them for
  // free — no stale-bounding-sphere trap (that one only bites InstancedMesh).
  powerups: {
    enabled: true,
    spawnRate: 0.15,     // crates/sec the spawner drops (~1 every ~7s)
    maxActive: 4,        // concurrent crates on screen
    spawnBehind: 7,      // relZ where a crate appears (just behind truck, in frame)
    loseDist: 60,        // relZ where an un-cracked crate is swallowed & lost
    startCount: 8,       // hits to crack a crate down to 0
    crateSize: 1.5,
    // Explosions ALWAYS gib (force-gib path) — every AoE kill bursts, no roll.
    tank: {
      duration: 8,       // seconds the cannon lasts
      fireRate: 3,       // cannon rounds/sec (slow, heavy)
      splashRadius: 4.5, // AoE per shell
      splashDamage: 90,  // damage in the blast (falloff to the edge)
    },
    rocket: {
      radius: 10,        // one big AoE on the densest cluster NEAR the truck
      damage: 280,
      fallHeight: 46,    // streaks in from this high
      travel: 0.7,       // seconds from sky to impact
      targetNear: 30,    // only hunt density inside this relZ — hit the threat, not the back rows
    },
    mines: {
      count: 10,         // scattered on the road behind the truck
      spreadX: 24,       // full x-span of the minefield (road + both shoulders)
      nearZ: 4,          // nearest a mine drops (relZ) — right by the truck
      farZ: 30,          // farthest a mine drops (relZ)
      triggerRadius: 1.4,// a zombie this close arms it
      blastRadius: 4.0,
      damage: 150,
      life: 12,          // seconds before an untriggered mine expires
    },
    wall: {
      width: 16,         // x-span of the blocked channel (wide — reads as a real barricade)
      life: 9,           // seconds the barrier stands
      crushDps: 120,     // damage/sec to zombies piled against the rear face (grinds the dam)
    },
    spikes: {
      speed: 8,          // world u/s the drum rolls back into the horde
      duration: 2.0,     // seconds it sweeps before spinning out
      width: 18,         // drum length across the canyon — crushes a wide swath
      crushRadius: 3.0,  // instant-crush depth in Z (always gibs)
      shoveRadius: 3.8,  // survivors just ahead get pushed back/out
      dps: 500,          // crush damage per second inside the swath
      back: 7,           // shove strength (units/sec) applied to survivors
    },
    explosion: {
      trauma: 0.7,       // camera shake added per blast
    },
  },

  // ---- v1.1: levels + camera shifts ------------------------------------------
  // Levels are scripted 2-minute runs (see levels.js); the win is reaching a
  // safe-zone gate alive. Mid-run the camera SHIFTS to a different rig preset
  // at unpredictable moments — never faster than minInterval (design floor 30s).
  // The hitscan is a camera-ray, so a shift genuinely changes the field of fire.
  camShift: {
    sandbox: false,     // enable shifts outside levels too (GUI knob)
    minInterval: 30,    // hard floor between shifts — per design, never faster
    maxExtra: 25,       // + up to this many random seconds (the unpredictability)
    tweenTime: 1.8,     // seconds the swing between presets takes (eased)
  },
  levels: {
    gateLead: 8,        // seconds before the win the gate appears ahead of the truck
    surgeWarn: 2.5,     // seconds of "SURGE INCOMING" heads-up before a surge window opens
  },

  // ---- Phase 6: photo mode (art verification) --------------------------------
  // One toggle that stops the sim fighting the camera: contact damage + both
  // game-over triggers freeze, the boss parks at a chosen distance instead of
  // advancing, firing is disabled, and an OrbitControls free camera replaces the
  // follow rig. The horde keeps flowing (shots look alive) unless frozen.
  photo: {
    enabled: false,
    bossDist: 55,       // relZ the parked boss holds behind the truck
    freezeHorde: false, // true = statue horde for a perfectly still shot
  },

  // ---- Phase 5: boss + sandbox controls -------------------------------------
  // A colossal PALE humanoid (the ad's money shot) that spawns on command deep
  // in the horde, TOWERS over it, and advances slowly on the fleeing truck.
  // Built from plain Meshes (like crates) so its raycast bounds ride its own
  // world matrix every frame — immune to the InstancedMesh stale-sphere trap.
  // Pouring fire into it rains damage numbers; the kill detonates a huge
  // force-gib blast (clears the surrounding horde) and topples the body.
  boss: {
    hp: 6000,            // big pool — ~20s of MG fire, faster with the tank gun
    height: 20,          // ~10× a zombie — several stories tall
    speed: 6.4,          // slow advance (just over truck speed → closes gradually)
    spawnBehind: 92,     // relZ where it rises — deep in the horde, on the horizon
    smashDist: 6,        // reaches the truck within this range → SMASH = instant game over (one hit)
    deathRadius: 15,     // force-gib blast that clears the horde around it on death
    deathDamage: 600,
    maxActive: 3,        // how many bosses the debug button can stack at once
  },
};
