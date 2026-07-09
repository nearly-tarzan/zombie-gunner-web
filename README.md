# Zombie Gunner

**▶ [Play in your browser](https://nearly-tarzan.github.io/zombie-gunner-web/)** — desktop, landscape. No install.

You man the gun on the back of a truck fleeing down a desert canyon. A horde chases you from behind. Shoot the countdown crates along the roadside before the wave swallows them and you get a tank gun, a rocket strike, landmines, a cargo-container barricade, or a rolling spiked drum.

Six levels. Each is a roughly two-minute run, and you win by reaching the safe-zone gate alive. Some levels send a colossal three-headed Cerberus after you first — the gate stays shut while it lives. The camera swings to a new angle at unpredictable moments, so your field of fire keeps changing.

## Controls

| | |
|---|---|
| Mouse | Aim |
| Hold left click | Fire |
| `R` | Restart the current run |
| `M` | Back to the menu |

The menu also has a free-play sandbox with a debug panel for tuning everything live.

## Run it locally

```
npm install
npm run dev
```

Then open http://localhost:5173.

## Built with

[Three.js](https://threejs.org/) and [Vite](https://vite.dev/). Everything is procedural — no downloaded models or textures. Gunshot samples are CC0; see `public/sfx/CREDITS.txt`.
