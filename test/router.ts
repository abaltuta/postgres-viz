import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { EdgeRoutingPlanner, ObstacleIndex, RoutingCandidateSet } from "../webview/router";

const small = new ObstacleIndex([
  { id: "source", box: { x1: 0, y1: 0, x2: 20, y2: 20 } },
  { id: "blocker", box: { x1: 40, y1: 0, x2: 60, y2: 20 } },
  { id: "target", box: { x1: 80, y1: 0, x2: 100, y2: 20 } },
]);
assert.equal(small.intersects(10, 10, 90, 10, "source", "target"), true);
assert.equal(small.intersects(10, 30, 90, 30, "source", "target"), false);
assert.deepEqual(small.box("blocker"), { x1: 40, y1: 0, x2: 60, y2: 20 });

const boxes = Array.from({ length: 2_000 }, (_, index) => {
  const x = (index % 50) * 48;
  const y = Math.floor(index / 50) * 48;
  return { id: `n${index}`, box: { x1: x, y1: y, x2: x + 24, y2: y + 24 } };
});
const started = performance.now();
const dense = new ObstacleIndex(boxes);
let hits = 0;
for (let row = 0; row < 40; row++) {
  for (let sample = 0; sample < 50; sample++) {
    if (dense.intersects(-20, row * 48 + 12, 2_400, row * 48 + 12, "none", "none")) hits++;
  }
}
const elapsed = performance.now() - started;
assert.equal(hits, 2_000, "dense routes find row obstacles");
assert.ok(elapsed < 2_000, `dense obstacle lookup took ${Math.round(elapsed)} ms`);

const candidates = new RoutingCandidateSet<string>(3);
candidates.add("distant", 2, 1);
candidates.add("viewport-far", 1, 20);
candidates.add("selected", 0, 100);
candidates.add("viewport-near", 1, 5);
candidates.add("discarded-distant", 2, 2);
assert.deepEqual(
  candidates.selected(),
  ["selected", "viewport-near", "viewport-far"],
  "priority wins before distance and the cap is deterministic",
);
assert.equal(candidates.omitted, 2, "omitted count covers only candidates beyond the cap");

const planner = new EdgeRoutingPlanner<string>(
  [
    { id: "source", box: { x1: 0, y1: 0, x2: 20, y2: 20 } },
    { id: "blocker", box: { x1: 40, y1: 0, x2: 60, y2: 20 } },
    { id: "target", box: { x1: 80, y1: 0, x2: 100, y2: 20 } },
  ],
  10,
);
planner.add("same-card", "source", "source", { x: 10, y: 10 }, { x: 15, y: 10 }, 1, 0);
planner.add("clear", "source", "target", { x: 10, y: 40 }, { x: 90, y: 40 }, 1, 0);
planner.add("blocked", "source", "target", { x: 10, y: 10 }, { x: 90, y: 10 }, 1, 0);
const planned = planner.result();
assert.deepEqual(
  planned.routes.map((route) => route.value),
  ["blocked"],
  "clear and same-card edges do not stop later blocked routes",
);
assert.equal(planned.routes[0]!.waypoints.length, 4, "blocked route receives Manhattan waypoints");

const lanes = new EdgeRoutingPlanner<string>(
  [
    { id: "source", box: { x1: 0, y1: 0, x2: 20, y2: 20 } },
    { id: "blocker", box: { x1: 40, y1: 0, x2: 60, y2: 20 } },
    { id: "target", box: { x1: 80, y1: 0, x2: 100, y2: 20 } },
  ],
  10,
);
lanes.add("first", "source", "target", { x: 10, y: 10 }, { x: 90, y: 10 }, 1, 1);
lanes.add("second", "source", "target", { x: 10, y: 11 }, { x: 90, y: 11 }, 1, 2);
const separatedLanes = lanes.result().routes.map((route) => route.waypoints[1]!.x);
assert.equal(new Set(separatedLanes).size, 2, "overlapping detours receive separate bus lanes");

const candidateStarted = performance.now();
const bounded = new RoutingCandidateSet<number>(2_000);
for (let index = 0; index < 100_000; index++) {
  bounded.add(index, 2, 100_000 - index);
}
const candidateElapsed = performance.now() - candidateStarted;
assert.equal(bounded.selected().length, 2_000, "large candidate sets retain only the route cap");
assert.equal(bounded.omitted, 98_000);
assert.ok(
  candidateElapsed < 2_000,
  `bounded candidate selection took ${Math.round(candidateElapsed)} ms`,
);

console.log(
  `router OK - obstacles ${Math.round(elapsed)} ms, 100,000 bounded candidates ${Math.round(candidateElapsed)} ms`,
);
