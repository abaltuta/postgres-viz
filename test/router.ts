import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { ObstacleIndex } from "../webview/router";

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

console.log(`router OK - 2,000 boxes and 2,000 routes in ${Math.round(elapsed)} ms`);
