import React, { useRef, useEffect, useState } from "react";

/**
 * Domain types (JSDoc; picked up by tsserver in editors).
 * @typedef {"N"|"E"|"S"|"W"} Approach
 * @typedef {"NS"|"EW"} Group
 * @typedef {"L"|"T"|"R"} Move
 * @typedef {"L"|"TR"} SignalHead
 * @typedef {"red"|"yellow"|"green"|"flash"} LightColor
 * @typedef {"NS_LEFT"|"NS_LEFT_Y"|"NS_THRU"|"NS_THRU_Y"|"AR1"|"EW_LEFT"|"EW_LEFT_Y"|"EW_THRU"|"EW_THRU_Y"|"AR2"} Phase
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ id: string, approach: Approach, move: Move, path: Point[], length: number }} Lane
 */

/* ============================================================================
   Traffic intersection — 4 approaches, 4 lanes each (L, T, T, R).
   Each approach has a through/right signal head and a dedicated left-turn
   head that can show red/yellow/green or flashing-amber (permissive: yield
   to oncoming through traffic). Smart actuation skips empty greens and ends
   a green early when the queue clears. Each approach has its own WALK
   button that activates whenever its perpendicular traffic group is red.
============================================================================ */

// ---- Layout ---------------------------------------------------------------
const SIZE = 600;
const CENTER = 300;
const ROAD_HALF = 96; // half road width = 4 lanes * 24px (L, T, T, R)
const SPAWN_Y = -40; // cars spawn just above the canvas
// Stop bar sits 14 px north of the intersection edge, leaving room for the
// crosswalk between the bar and the intersection so cars stop before peds.
const STOP_Y = CENTER - ROAD_HALF - 14;
const STOP_DIST = STOP_Y - SPAWN_Y; // distance from spawn to stop bar
const CAR_LEN = 26;
const CAR_W = 14;
const CAR_GAP = 8; // following gap
const CAR_SPEED = 150; // px/s

const COLORS = {
  red: "#e0322b",
  amber: "#f7a01d",
  green: "#28c071",
  off: "#3a3d42",
  asphalt: "#262a30",
  grass: "#33402f",
  line: "#c9ccc4",
  median: "#e7c14a",
};
const CAR_COLORS = ["#d96c4a", "#4a8fd9", "#e3c04a", "#8a6fd1", "#5bbf8a"];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---- Geometry: define one approach, rotate it to get the other three -----
const APPROACHES = ["N", "E", "S", "W"];
const ROTATION = { N: 0, E: 90, S: 180, W: 270 };
const GROUP = { N: "NS", S: "NS", E: "EW", W: "EW" };
const OPPOSITE = { N: "S", S: "N", E: "W", W: "E" };

// Lane center x's on the canonical N approach (median → outside).
// Four inbound lanes: a dedicated left-turn, two through lanes, and a right.
const LANE_X = {
  L: CENTER - 12,
  T1: CENTER - 36,
  T2: CENTER - 60,
  R: CENTER - 84,
};

// Each lane is a 2- or 3-point polyline. Turns are a single corner.
const PATHS = {
  L: [
    { x: LANE_X.L, y: SPAWN_Y },
    { x: LANE_X.L, y: CENTER + 14 },
    { x: 640, y: CENTER + 14 },
  ],
  T1: [
    { x: LANE_X.T1, y: SPAWN_Y },
    { x: LANE_X.T1, y: 640 },
  ],
  T2: [
    { x: LANE_X.T2, y: SPAWN_Y },
    { x: LANE_X.T2, y: 640 },
  ],
  R: [
    { x: LANE_X.R, y: SPAWN_Y },
    { x: LANE_X.R, y: CENTER - 64 },
    { x: -40, y: CENTER - 64 },
  ],
};
const LANE_DEFS = [
  { key: "L", move: "L" },
  { key: "T1", move: "T" },
  { key: "T2", move: "T" },
  { key: "R", move: "R" },
];

function rotate(point, deg) {
  const rad = (deg * Math.PI) / 180;
  const dx = point.x - CENTER;
  const dy = point.y - CENTER;
  return {
    x: CENTER + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: CENTER + dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}

/** @type {(pts: Point[]) => number} */
function polylineLength(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return total;
}

// Position + heading at distance `d` along a polyline.
/** @type {(pts: Point[], dist: number) => { x: number, y: number, ang: number }} */
function positionAt(pts, dist) {
  for (let i = 1; i < pts.length; i++) {
    const start = pts[i - 1];
    const end = pts[i];
    const seg = Math.hypot(end.x - start.x, end.y - start.y);
    if (dist <= seg) {
      const frac = dist / seg;
      return {
        x: start.x + (end.x - start.x) * frac,
        y: start.y + (end.y - start.y) * frac,
        ang: Math.atan2(end.y - start.y, end.x - start.x),
      };
    }
    dist -= seg;
  }
  const start = pts[pts.length - 2];
  const end = pts[pts.length - 1];
  return {
    x: end.x,
    y: end.y,
    ang: Math.atan2(end.y - start.y, end.x - start.x),
  };
}

// 16 lanes (4 approaches × 4 lane defs).
function buildLanes() {
  const lanes = [];
  for (const ap of APPROACHES) {
    for (const def of LANE_DEFS) {
      const path = PATHS[def.key].map((point) => rotate(point, ROTATION[ap]));
      lanes.push({
        id: `${ap}-${def.key}`,
        approach: ap,
        move: def.move,
        path,
        length: polylineLength(path),
      });
    }
  }
  return lanes;
}

// ---- Signal phase model --------------------------------------------------
// Fixed cycle. Opposite lefts run together; conflicting throughs never
// overlap; each green is bracketed by a yellow; an all-red separates
// direction changes. Crosswalks run independently on their own timers
// (see stepCrosswalks below).
const PHASE_RING = [
  "NS_LEFT",
  "NS_LEFT_Y",
  "NS_THRU",
  "NS_THRU_Y",
  "AR1",
  "EW_LEFT",
  "EW_LEFT_Y",
  "EW_THRU",
  "EW_THRU_Y",
  "AR2",
];
const isGreen = (phase) =>
  phase === "NS_LEFT" ||
  phase === "NS_THRU" ||
  phase === "EW_LEFT" ||
  phase === "EW_THRU";
const isYellow = (phase) => phase.endsWith("_Y");
const isAllRed = (phase) => phase === "AR1" || phase === "AR2";
const groupOf = (phase) =>
  phase.startsWith("NS") ? "NS" : phase.startsWith("EW") ? "EW" : null;
const movesOf = (phase) =>
  phase.includes("LEFT") ? ["L"] : phase.includes("THRU") ? ["T", "R"] : [];

const TIMING = {
  greenMin: 4, // smart: don't end a green before this
  greenMax: 10, // smart: never extend a green past this
  yellow: 2,
  allRed: 1,
  walk: 5, // pedestrian crossing
  gapOut: 1.5, // end green this long after queue clears
};

// What lamp is lit on a given signal head right now?
// `head` is "L" (left-turn) or "TR" (through/right).
// Returns "red" | "yellow" | "green" | "flash".
// "flash" = permissive flashing-amber left — yield to oncoming through.
/** @type {(group: Group, head: SignalHead, phase: Phase) => LightColor} */
function lightColor(group, head, phase) {
  if (groupOf(phase) !== group) return "red";
  if (isYellow(phase)) {
    const ours =
      (phase.includes("LEFT") && head === "L") ||
      (phase.includes("THRU") && head === "TR");
    return ours ? "yellow" : "red";
  }
  if (phase.includes("LEFT")) return head === "L" ? "green" : "red";
  if (phase.includes("THRU")) return head === "TR" ? "green" : "flash";
  return "red";
}

const PHASE_NAME = {
  NS_LEFT: "N–S left",
  NS_LEFT_Y: "N–S left ending",
  NS_THRU: "N–S through",
  NS_THRU_Y: "N–S ending",
  EW_LEFT: "E–W left",
  EW_LEFT_Y: "E–W left ending",
  EW_THRU: "E–W through",
  EW_THRU_Y: "E–W ending",
  AR1: "All-red",
  AR2: "All-red",
};

// An approach's crosswalk crosses the road carrying the perpendicular group's
// traffic, so a walk is safe whenever that group is fully red.
const CROSSWALK_BLOCKED_BY = { N: "NS", S: "NS", E: "EW", W: "EW" };
const isCrosswalkSafe = (ap, phase) =>
  groupOf(phase) !== CROSSWALK_BLOCKED_BY[ap];

// ---- Simulation ----------------------------------------------------------
function createSim() {
  return {
    lanes: buildLanes(),
    cars: [],
    nextId: 1,

    phase: "NS_THRU",
    phaseT: 0,
    gapTimer: 0,

    // Per-approach walk state. walkActive is seconds-remaining (0 = off).
    // walkPending holds requests that haven't started yet (perpendicular
    // traffic still has a green or yellow).
    walkActive: { N: 0, E: 0, S: 0, W: 0 },
    walkPending: {},

    spawnTimer: 0,
    cleared: 0,
    playing: true,
  };
}

// Count cars approaching the stop bar for the moves this phase serves,
// within `range` px of the bar.
function demand(sim, phase, range) {
  const group = groupOf(phase);
  const moves = movesOf(phase);
  let count = 0;
  for (const car of sim.cars) {
    if (GROUP[car.approach] !== group || !moves.includes(car.move)) continue;
    if (car.dist > STOP_DIST + 2) continue; // past the bar
    if (car.dist > STOP_DIST - range) count++;
  }
  return count;
}

function advancePhase(sim) {
  let next =
    PHASE_RING[(PHASE_RING.indexOf(sim.phase) + 1) % PHASE_RING.length];
  // Smart actuation: skip an entirely empty green.
  if (isGreen(next) && demand(sim, next, 200) === 0) {
    next = PHASE_RING[(PHASE_RING.indexOf(next) + 1) % PHASE_RING.length];
  }
  sim.phase = next;
  sim.phaseT = 0;
  sim.gapTimer = 0;
}

function stepPhase(sim, dt) {
  sim.phaseT += dt;
  const phase = sim.phase;

  if (isGreen(phase)) {
    // Gap-out: end the green once the queue has been clear for `gapOut`
    // seconds, but never before `greenMin` and always by `greenMax`.
    if (demand(sim, phase, 18) > 0) sim.gapTimer = 0;
    else sim.gapTimer += dt;
    const min = sim.phaseT >= TIMING.greenMin;
    const max = sim.phaseT >= TIMING.greenMax;
    if (max || (min && sim.gapTimer >= TIMING.gapOut)) advancePhase(sim);
  } else {
    const dur = isYellow(phase) ? TIMING.yellow : TIMING.allRed;
    if (sim.phaseT >= dur) advancePhase(sim);
  }
}

// Each crosswalk runs on its own timer: start a pending walk when its
// perpendicular traffic group goes red, cancel it if that group goes
// green/yellow mid-walk, count it down otherwise.
function stepCrosswalks(sim, dt) {
  for (const ap of APPROACHES) {
    const safe = isCrosswalkSafe(ap, sim.phase);
    if (sim.walkPending[ap] && sim.walkActive[ap] === 0 && safe) {
      sim.walkActive[ap] = TIMING.walk;
      delete sim.walkPending[ap];
    }
    if (sim.walkActive[ap] > 0 && !safe) sim.walkActive[ap] = 0;
    if (sim.walkActive[ap] > 0) {
      sim.walkActive[ap] = Math.max(0, sim.walkActive[ap] - dt);
    }
  }
}

// Permissive (flashing) left: may go only if no oncoming through is in the box.
function permissiveClear(sim, car) {
  const opp = OPPOSITE[car.approach];
  return !sim.cars.some(
    (other) =>
      other.approach === opp &&
      other.move === "T" &&
      other.dist > STOP_DIST - 8 &&
      other.dist < STOP_DIST + 150,
  );
}

function spawnCar(sim) {
  // Pick a lane that has no car within 44 px of the spawn point.
  const free = sim.lanes.filter(
    (lane) => !sim.cars.some((car) => car.laneId === lane.id && car.dist < 44),
  );
  if (!free.length) return;
  const lane = pick(free);
  sim.cars.push({
    id: sim.nextId++,
    laneId: lane.id,
    approach: lane.approach,
    move: lane.move,
    path: lane.path,
    length: lane.length,
    dist: 0,
    color: pick(CAR_COLORS),
    stopped: false,
  });
}

function stepCars(sim, dt) {
  // Sort each lane front-to-back so each car only checks the one ahead.
  const byLane = {};
  for (const car of sim.cars) (byLane[car.laneId] ||= []).push(car);

  for (const id in byLane) {
    const list = byLane[id].sort((a, b) => b.dist - a.dist);
    for (let i = 0; i < list.length; i++) {
      const car = list[i];
      const leader = list[i - 1];

      const head = car.move === "L" ? "L" : "TR";
      const color = lightColor(GROUP[car.approach], head, sim.phase);
      const canPass =
        color === "green" || (color === "flash" && permissiveClear(sim, car));

      let limit = Infinity;
      // Hold at the stop bar. `dist` is the car's center, so back off half a
      // car-length plus a buffer so the front bumper sits at the white line.
      if (!canPass && car.dist < STOP_DIST) {
        limit = STOP_DIST - CAR_LEN / 2 - 2;
      }
      // Don't rear-end the car in front.
      if (leader) limit = Math.min(limit, leader.dist - (CAR_LEN + CAR_GAP));

      const next = Math.min(car.dist + CAR_SPEED * dt, limit);
      car.stopped = next <= car.dist + 0.01;
      car.dist = Math.max(car.dist, next);
    }
  }

  // Retire cars that have left the canvas.
  sim.cars = sim.cars.filter((car) => {
    if (car.dist >= car.length) {
      sim.cleared++;
      return false;
    }
    return true;
  });
}

function step(sim, dtReal) {
  if (!sim.playing) return;
  const dt = Math.min(0.05, dtReal); // clamp so a backgrounded tab can't jump
  stepPhase(sim, dt);
  stepCrosswalks(sim, dt);
  stepCars(sim, dt);

  sim.spawnTimer -= dt;
  if (sim.spawnTimer <= 0) {
    spawnCar(sim);
    sim.spawnTimer = 0.6 + Math.random() * 1.2;
  }
}

// ---- Rendering -----------------------------------------------------------
function withRotation(ctx, ap, fn) {
  ctx.save();
  ctx.translate(CENTER, CENTER);
  ctx.rotate((ROTATION[ap] * Math.PI) / 180);
  ctx.translate(-CENTER, -CENTER);
  fn();
  ctx.restore();
}

function draw(ctx, sim, time) {
  ctx.clearRect(0, 0, SIZE, SIZE);

  // Grass + asphalt cross.
  ctx.fillStyle = COLORS.grass;
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = COLORS.asphalt;
  ctx.fillRect(CENTER - ROAD_HALF, 0, ROAD_HALF * 2, SIZE);
  ctx.fillRect(0, CENTER - ROAD_HALF, SIZE, ROAD_HALF * 2);

  APPROACHES.forEach((ap) => drawApproach(ctx, ap, sim, time));
  sim.cars.forEach((car) => drawCar(ctx, car));
  APPROACHES.forEach((ap) => drawSignals(ctx, ap, sim, time));
  drawCompass(ctx, SIZE - 44, SIZE - 44);
}

// Small N/E/S/W compass overlay in the corner.
function drawCompass(ctx, cx, cy) {
  const radius = 22;
  ctx.save();
  // Backing disc.
  ctx.fillStyle = "rgba(15,23,32,0.75)";
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(201,204,196,0.4)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Needle: red points N, grey points S.
  ctx.beginPath();
  ctx.moveTo(cx, cy - radius + 6);
  ctx.lineTo(cx - 4, cy);
  ctx.lineTo(cx + 4, cy);
  ctx.closePath();
  ctx.fillStyle = COLORS.red;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy + radius - 6);
  ctx.lineTo(cx - 4, cy);
  ctx.lineTo(cx + 4, cy);
  ctx.closePath();
  ctx.fillStyle = "#8a8f96";
  ctx.fill();

  // Cardinal labels.
  ctx.fillStyle = COLORS.line;
  ctx.font = "bold 9px ui-sans-serif, system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("N", cx, cy - radius + 2);
  ctx.fillText("S", cx, cy + radius - 2);
  ctx.fillText("W", cx - radius + 4, cy);
  ctx.fillText("E", cx + radius - 4, cy);
  ctx.restore();
}

function drawApproach(ctx, ap, sim, time) {
  withRotation(ctx, ap, () => {
    // Dashed lane lines (between the 4 inbound lanes).
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 2;
    ctx.setLineDash([12, 12]);
    for (const x of [CENTER - 24, CENTER - 48, CENTER - 72]) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, STOP_Y - 4);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Yellow median.
    ctx.strokeStyle = COLORS.median;
    ctx.beginPath();
    ctx.moveTo(CENTER, 0);
    ctx.lineTo(CENTER, STOP_Y);
    ctx.stroke();

    // Stop bar.
    ctx.fillStyle = COLORS.line;
    ctx.fillRect(CENTER - ROAD_HALF, STOP_Y - 4, ROAD_HALF, 4);

    // Crosswalk: drawn south of the stop bar (between the bar and the
    // intersection) so it sits in front of stopped cars. Bright pulse when
    // this approach's WALK is active, dim otherwise.
    const walking = sim.walkActive[ap] > 0;
    ctx.fillStyle = walking
      ? `rgba(255,255,255,${0.5 + 0.4 * Math.abs(Math.sin(time * 3))})`
      : "rgba(201,204,196,0.35)";
    for (let x = CENTER - ROAD_HALF + 4; x < CENTER + ROAD_HALF - 4; x += 12) {
      ctx.fillRect(x, STOP_Y + 2, 6, 8);
    }
  });
}

function drawCar(ctx, car) {
  const pos = positionAt(car.path, car.dist);
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(pos.ang);
  ctx.fillStyle = car.color;
  ctx.fillRect(-CAR_LEN / 2, -CAR_W / 2, CAR_LEN, CAR_W);
  ctx.fillStyle = "rgba(15,20,28,0.5)";
  ctx.fillRect(CAR_LEN / 2 - 7, -CAR_W / 2 + 2, 4, CAR_W - 4);
  ctx.restore();
}

function drawSignals(ctx, ap, sim, time) {
  withRotation(ctx, ap, () => {
    const x = CENTER - ROAD_HALF - 14;
    const y = STOP_Y - 6;
    const group = GROUP[ap];

    const throughRight = lightColor(group, "TR", sim.phase);
    const left = lightColor(group, "L", sim.phase);

    // Permissive left flashes amber at 2 Hz.
    const flashOn = Math.floor(time * 2) % 2 === 0;
    const leftShown = left === "flash" ? (flashOn ? "yellow" : "off") : left;

    drawStack(ctx, x, y, throughRight);
    drawStack(ctx, x - 18, y, leftShown);
  });
}

const LAMP = { red: COLORS.red, yellow: COLORS.amber, green: COLORS.green };
function drawStack(ctx, x, y, active) {
  ctx.fillStyle = "#15171a";
  ctx.fillRect(x - 7, y - 30, 14, 30);
  ["red", "yellow", "green"].forEach((slot, i) => {
    ctx.beginPath();
    ctx.arc(x, y - 24 + i * 9, 3.4, 0, Math.PI * 2);
    ctx.fillStyle = slot === active ? LAMP[slot] : COLORS.off;
    ctx.fill();
  });
}

// ---- React shell ---------------------------------------------------------
export default function Intersection() {
  const canvasRef = useRef(null);
  const simRef = useRef(null);
  if (!simRef.current) simRef.current = createSim();

  const [phase, setPhase] = useState(simRef.current.phase);
  const [playing, setPlaying] = useState(true);
  // Per-approach { pending, active } badge state for the buttons.
  const [walks, setWalks] = useState({});

  useEffect(() => {
    simRef.current.playing = playing;
  }, [playing]);

  // One animation loop: step the sim, draw it, push a throttled HUD update.
  useEffect(() => {
    const ctx = canvasRef.current.getContext("2d");
    let raf;
    let last = performance.now();
    let frames = 0;
    const loop = (now) => {
      step(simRef.current, (now - last) / 1000);
      last = now;
      draw(ctx, simRef.current, now / 1000);
      if (++frames >= 6) {
        frames = 0;
        const sim = simRef.current;
        setPhase(sim.phase);
        const snap = {};
        for (const ap of APPROACHES) {
          snap[ap] = {
            active: sim.walkActive[ap] > 0,
            pending: !!sim.walkPending[ap],
          };
        }
        setWalks(snap);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const requestWalk = (ap) => {
    simRef.current.walkPending[ap] = true;
  };
  const reset = () => {
    simRef.current = createSim();
    simRef.current.playing = playing;
    setPhase(simRef.current.phase);
    setWalks({});
  };

  return (
    <div
      className="min-h-screen bg-[#0f1216] text-zinc-200 flex flex-col items-center gap-3 p-4"
      style={{ fontFamily: "ui-sans-serif, system-ui" }}
    >
      <header className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold text-zinc-100">
          Traffic Intersection
        </h1>
        <span className="text-sm text-zinc-400 font-mono">
          {PHASE_NAME[phase] || phase}
        </span>
      </header>

      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        className="rounded-lg ring-1 ring-zinc-800"
        style={{ width: SIZE, height: SIZE, display: "block" }}
        aria-label="Traffic intersection simulation"
      />

      <div className="flex gap-2">
        <button
          onClick={() => setPlaying((p) => !p)}
          className="px-3 py-1.5 rounded bg-zinc-100 text-zinc-900 text-sm"
        >
          {playing ? "Pause" : "Run"}
        </button>
        <button
          onClick={reset}
          className="px-3 py-1.5 rounded bg-zinc-800 text-sm"
        >
          Reset
        </button>
      </div>

      <div className="flex flex-col items-center gap-1">
        <span className="text-xs text-zinc-500">Walk requests</span>
        <div className="flex gap-2">
          {APPROACHES.map((ap) => {
            const walk = walks[ap] || {};
            const cls = walk.active
              ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40"
              : walk.pending
                ? "bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40"
                : "bg-zinc-800 text-zinc-300";
            return (
              <button
                key={ap}
                onClick={() => requestWalk(ap)}
                className={`px-3 py-1.5 rounded text-sm font-mono ${cls}`}
              >
                {ap}
                {walk.active ? " ▶" : walk.pending ? " •" : ""}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Named exports for unit tests. (The component is the default export above.)
export {
  APPROACHES,
  GROUP,
  OPPOSITE,
  STOP_DIST,
  PHASE_RING,
  TIMING,
  CROSSWALK_BLOCKED_BY,
  polylineLength,
  positionAt,
  isGreen,
  isYellow,
  isAllRed,
  groupOf,
  movesOf,
  lightColor,
  isCrosswalkSafe,
  createSim,
  demand,
  advancePhase,
  stepPhase,
};
