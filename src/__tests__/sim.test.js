import { describe, it, expect } from "vitest";
import {
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
} from "../Intersection.jsx";

describe("phase predicates", () => {
  it("PHASE_RING is the expected 10-phase cycle", () => {
    expect(PHASE_RING).toEqual([
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
    ]);
  });

  it("categorises each phase exactly once", () => {
    for (const p of PHASE_RING) {
      const buckets = [isGreen(p), isYellow(p), isAllRed(p)].filter(Boolean);
      expect(buckets).toHaveLength(1);
    }
  });

  it("groupOf maps NS/EW phases and returns null for all-red", () => {
    expect(groupOf("NS_LEFT")).toBe("NS");
    expect(groupOf("NS_THRU_Y")).toBe("NS");
    expect(groupOf("EW_THRU")).toBe("EW");
    expect(groupOf("AR1")).toBeNull();
    expect(groupOf("AR2")).toBeNull();
  });

  it("movesOf serves L on lefts, T+R on throughs, nothing on yellows or all-red", () => {
    expect(movesOf("NS_LEFT")).toEqual(["L"]);
    expect(movesOf("EW_LEFT")).toEqual(["L"]);
    expect(movesOf("NS_THRU")).toEqual(["T", "R"]);
    expect(movesOf("EW_THRU")).toEqual(["T", "R"]);
    expect(movesOf("AR1")).toEqual([]);
  });
});

describe("lightColor (single source of truth)", () => {
  it("returns red for the off-group regardless of head", () => {
    expect(lightColor("EW", "L", "NS_LEFT")).toBe("red");
    expect(lightColor("EW", "TR", "NS_THRU")).toBe("red");
    expect(lightColor("NS", "L", "EW_LEFT_Y")).toBe("red");
  });

  it("on a LEFT phase: the left head is green, the through/right head is red", () => {
    expect(lightColor("NS", "L", "NS_LEFT")).toBe("green");
    expect(lightColor("NS", "TR", "NS_LEFT")).toBe("red");
  });

  it("on a THRU phase: the through head is green, the left head flashes (permissive)", () => {
    expect(lightColor("NS", "TR", "NS_THRU")).toBe("green");
    expect(lightColor("NS", "L", "NS_THRU")).toBe("flash");
    expect(lightColor("EW", "TR", "EW_THRU")).toBe("green");
    expect(lightColor("EW", "L", "EW_THRU")).toBe("flash");
  });

  it("yellow only shows on the head that just had green", () => {
    expect(lightColor("NS", "L", "NS_LEFT_Y")).toBe("yellow");
    expect(lightColor("NS", "TR", "NS_LEFT_Y")).toBe("red");
    expect(lightColor("NS", "TR", "NS_THRU_Y")).toBe("yellow");
    expect(lightColor("NS", "L", "NS_THRU_Y")).toBe("red");
  });

  it("all-red phases show red on every head of every group", () => {
    for (const p of ["AR1", "AR2"]) {
      for (const g of ["NS", "EW"]) {
        for (const h of ["L", "TR"]) {
          expect(lightColor(g, h, p)).toBe("red");
        }
      }
    }
  });
});

describe("crosswalks", () => {
  it("each approach is blocked by its parallel-traffic group", () => {
    expect(CROSSWALK_BLOCKED_BY).toEqual({
      N: "NS",
      S: "NS",
      E: "EW",
      W: "EW",
    });
  });

  it("a walk is safe only when the perpendicular group is fully red", () => {
    // N/S crosswalk crosses the N-S roadway, so it's safe during EW phases and all-reds.
    expect(isCrosswalkSafe("N", "NS_THRU")).toBe(false);
    expect(isCrosswalkSafe("N", "NS_LEFT_Y")).toBe(false);
    expect(isCrosswalkSafe("N", "EW_THRU")).toBe(true);
    expect(isCrosswalkSafe("N", "AR1")).toBe(true);
    // Symmetric for E/W.
    expect(isCrosswalkSafe("E", "EW_THRU")).toBe(false);
    expect(isCrosswalkSafe("W", "NS_LEFT")).toBe(true);
  });
});

describe("approach maps", () => {
  it("opposites pair correctly", () => {
    for (const ap of APPROACHES) {
      expect(OPPOSITE[OPPOSITE[ap]]).toBe(ap);
    }
  });

  it("approach groups split N/S vs E/W", () => {
    expect(GROUP.N).toBe(GROUP.S);
    expect(GROUP.E).toBe(GROUP.W);
    expect(GROUP.N).not.toBe(GROUP.E);
  });
});

describe("timing", () => {
  it("greenMin is less than greenMax", () => {
    expect(TIMING.greenMin).toBeLessThan(TIMING.greenMax);
  });
  it("yellow and all-red durations are positive", () => {
    expect(TIMING.yellow).toBeGreaterThan(0);
    expect(TIMING.allRed).toBeGreaterThan(0);
  });
});

describe("geometry helpers", () => {
  it("polylineLength sums Euclidean segments", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 3, y: 4 }, // +5
      { x: 3, y: 9 }, // +5
    ];
    expect(polylineLength(pts)).toBeCloseTo(10);
  });

  it("positionAt at d=0 returns the first point", () => {
    const pts = [
      { x: 10, y: 10 },
      { x: 10, y: 50 },
    ];
    const p = positionAt(pts, 0);
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(10);
  });

  it("positionAt interpolates along a segment", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const p = positionAt(pts, 25);
    expect(p.x).toBeCloseTo(25);
    expect(p.y).toBeCloseTo(0);
    expect(p.ang).toBeCloseTo(0); // heading is +x
  });

  it("positionAt walks across corners and reports the new heading", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    const p = positionAt(pts, 15); // 10 along x, then 5 along y
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(5);
    expect(p.ang).toBeCloseTo(Math.PI / 2); // now heading +y
  });

  it("positionAt past the end clamps to the last point", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const p = positionAt(pts, 9999);
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(0);
  });
});

describe("actuated (smart) signal behavior", () => {
  // A car sitting right at the stop bar in the NS-through group. Used as a
  // queue presence indicator for `demand`.
  const queueCar = () => ({ approach: "N", move: "T", dist: STOP_DIST });

  it("skips a green that has no demand", () => {
    const sim = createSim();
    sim.phase = "AR1"; // next in the ring is EW_LEFT (a green)
    sim.cars = []; // no demand anywhere
    advancePhase(sim);
    // EW_LEFT should be skipped because no car wants it; we land on its yellow.
    expect(sim.phase).toBe("EW_LEFT_Y");
  });

  it("a green is held to greenMin even when the queue is empty", () => {
    const sim = createSim();
    sim.phase = "NS_THRU";
    sim.phaseT = 0;
    sim.gapTimer = 0;
    sim.cars = [];
    // Step well past gapOut but still below greenMin.
    stepPhase(sim, TIMING.greenMin - 0.1);
    expect(sim.phase).toBe("NS_THRU");
    expect(sim.gapTimer).toBeGreaterThan(TIMING.gapOut);
  });

  it("ends a green once past greenMin and the queue has been clear for gapOut", () => {
    const sim = createSim();
    sim.phase = "NS_THRU";
    sim.phaseT = TIMING.greenMin - 0.05;
    sim.gapTimer = TIMING.gapOut + 0.5; // queue already cleared
    sim.cars = [];
    stepPhase(sim, 0.1); // tip just past greenMin
    expect(sim.phase).not.toBe("NS_THRU");
  });

  it("a green never exceeds greenMax even with continuous demand", () => {
    const sim = createSim();
    sim.phase = "NS_THRU";
    sim.phaseT = TIMING.greenMax - 0.5;
    sim.gapTimer = 0;
    sim.cars = [queueCar()];

    // Demand pins gapTimer at 0, so without the max cap the green would
    // happily keep running.
    stepPhase(sim, 0.1);
    expect(sim.phase).toBe("NS_THRU");
    expect(sim.gapTimer).toBe(0);

    // Tick past greenMax → forced advance.
    stepPhase(sim, 1.0);
    expect(sim.phase).not.toBe("NS_THRU");
  });
});
