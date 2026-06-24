# Traffic Intersection

A four-way traffic intersection simulation: a signal that cycles on a timer,
cars that queue and cross on green, protected left turns, sensor-based
(actuated) timing, and a pedestrian walk button for each direction.

Built with React + Vite. Rendering is on a `<canvas>`.

## Run it

Requires Node 20.19+ or 22.12+.

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default http://localhost:5173).

Production build: `npm run build` then `npm run preview`.

## How it works

The whole simulation is one plain object (`createSim`) stepped on a clock.
React only renders the phase label and three buttons; the canvas reads the sim
object directly inside a single `requestAnimationFrame` loop, so 60fps
animation never triggers a React re-render. Everything lives in
`src/Intersection.jsx`, organised top-to-bottom as: layout constants, geometry,
the signal phase model, the simulation step, rendering, and the React shell.

Buttons:

- **Pause / Run** — pause and resume the simulation.
- **Reset** — empty the intersection and start a fresh simulation.
- **Walk Requests (N/E/S/W)** — request a pedestrian crossing for that
  direction. The walk starts as soon as the perpendicular traffic group
  is fully red; the crosswalk stripes pulse bright while a walk is active.

  ## transcript can be found in transcript.txt file

## Running Tests

```bash
npm run test
```

Output:

<img width="898" height="530" alt="Screenshot 2026-06-23 at 2 16 33 PM" src="https://github.com/user-attachments/assets/17293bdb-c67b-4eb8-9cbb-ff9a02935feb" />

![Vitest run — 24 tests passing](docs/screenshot.png)

## Video Demo

https://github.com/user-attachments/assets/30667ac0-2439-4b86-9220-65fd3d9628bd

[Download demo.mp4](docs/demo.mp4)

## Improvements I'd make

A few specific things I'd change with more time, grounded in the current code:

- **Promote sensor ranges to `TIMING`.** The `200` (skip-empty-green
  lookahead) and `18` (gap-out window) inside `demand()` are magic numbers
  buried in `advancePhase` / `stepPhase`. They belong next to `greenMin`,
  `greenMax`, and `gapOut` so all of the actuation tuning lives in one place,
  and so the unit tests can assert against named constants instead of literals.
- **Replace `walkPending` (sparse object with `delete`) with a flat record
  like `walkActive`.** Mixing `{}` + `delete` for one field and `{ N: 0, ... }`
  for another is inconsistent and makes the snapshot in the render loop do
  `!!sim.walkPending[ap]` to paper over the asymmetry. A `{ N: false, E: false,
S: false, W: false }` shape removes that.
- **Pedestrian countdown / Flashing-Don't-Walk.** Today the crosswalk pulses
  bright for the full 5 s and then snaps off. Real signals have a flashing
  clearance interval (FDW) so a pedestrian who started late doesn't get
  stranded. Splitting `walkActive` into `walkWalk` + `walkClear` (e.g. 3 s + 2 s)
  and rendering a different pattern during clearance would close that gap.
- **Index cars by lane on the sim object.** `stepCars` rebuilds `byLane` from a
  flat `sim.cars` array every frame, and `demand()` does a linear scan over
  every car for every phase decision. Both are fine at ~30 cars but would
  start to matter at hundreds. Maintaining `sim.carsByLane` at spawn/retire
  time turns both into O(cars-in-served-lanes).
- **Deterministic mode for tests and reproducible bugs.** `spawnCar`,
  `pick(CAR_COLORS)`, and the spawn-timer jitter all use `Math.random()`
  directly. Threading a seeded RNG through `createSim({ seed })` would let
  tests assert on full simulated runs and let me replay a specific scenario
  when something looks wrong on screen.
- **Yellow timing tied to approach speed.** `TIMING.yellow = 2` is a flat
  constant, but real yellow intervals are derived from approach speed,
  perception-reaction time, and deceleration. With one approach speed
  (`CAR_SPEED = 150`) this doesn't matter today, but if I added per-approach
  speeds (e.g. a faster arterial vs. a slower side street), the yellow should
  derive from them rather than being hard-coded.
- **More test coverage around phase transitions.** The current suite covers
  pure helpers well, but I'd add integration-style tests that drive
  `stepPhase` over a full cycle and assert: skip-empty-green actually skips
  when `demand == 0`, gap-out never fires before `greenMin`, and `greenMax`
  always caps the green even with constant demand.
