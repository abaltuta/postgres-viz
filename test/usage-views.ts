import assert from "node:assert/strict";
import type { ColumnUsageGroup, UsageOwner } from "../src/protocol";
import {
  aggregateUsageRows,
  buildRadialPlan,
  radialPositions,
  usageCategory,
} from "../webview/usage-views";

const owner = (id: string): UsageOwner => ({
  id,
  type: "function",
  oid: Number(id.slice(1)) || 1,
  schema: "public",
  name: id,
  label: `${id}()`,
});

const group = (
  id: string,
  ownerId: string,
  kind: ColumnUsageGroup["kind"],
  count: number,
): ColumnUsageGroup => ({
  id,
  kind,
  section: usageCategory(kind) === "structural" ? "structural" : "sql",
  owner: owner(ownerId),
  count,
  occurrences: [],
});

assert.equal(usageCategory("reads"), "reads");
assert.equal(usageCategory("updates"), "writes");
assert.equal(usageCategory("fk"), "structural");

const rows = aggregateUsageRows([
  group("r1", "f1", "reads", 4),
  group("u1", "f1", "updates", 4),
  group("s1", "f1", "fk", 1),
  group("r2", "f2", "selects", 10),
]);
assert.equal(rows[0]?.owner.id, "f2", "rows sort by highest total first");
const mixed = rows.find((row) => row.owner.id === "f1")!;
assert.deepEqual(mixed.counts, { reads: 4, writes: 4, structural: 1 });
assert.equal(mixed.primary, "writes", "write category wins equal-count ties");

const manyRows = aggregateUsageRows(
  Array.from({ length: 30 }, (_, index) =>
    group(
      `g${index}`,
      `f${index + 1}`,
      index % 3 === 0 ? "reads" : index % 3 === 1 ? "updates" : "fk",
      1,
    ),
  ),
);
const compact = buildRadialPlan(manyRows, 500, 800);
assert.equal(compact.capacity, 9);
assert.deepEqual(
  Object.values(compact.visible).map((items) => items.length),
  [3, 3, 3],
  "capacity is distributed round-robin across categories",
);
assert.equal(
  Object.values(compact.hidden).reduce((sum, count) => sum + count, 0),
  21,
);
assert.equal(buildRadialPlan(manyRows, 1_400, 900).capacity, 18);

const positions = radialPositions(
  [
    { id: "read", category: "reads", width: 100, height: 60 },
    { id: "write", category: "writes", width: 100, height: 60 },
    { id: "struct", category: "structural", width: 100, height: 60 },
  ],
  120,
  80,
);
assert.ok(positions.get("read")!.x < 0, "reads occupy the left sector");
assert.ok(positions.get("write")!.x > 0, "writes occupy the right sector");
assert.ok(positions.get("struct")!.y > 0, "structural relationships occupy the lower sector");
assert.deepEqual(
  radialPositions([{ id: "read", category: "reads", width: 100, height: 60 }], 120, 80),
  radialPositions([{ id: "read", category: "reads", width: 100, height: 60 }], 120, 80),
  "radial positions are deterministic",
);

const structuralItems = Array.from({ length: 7 }, (_, index) => ({
  id: `struct-${index}`,
  category: "structural" as const,
  width: 120,
  height: 70,
}));
const structuralPositions = radialPositions(structuralItems, 140, 90);
for (let i = 0; i < structuralItems.length; i++) {
  for (let j = i + 1; j < structuralItems.length; j++) {
    const a = structuralPositions.get(structuralItems[i]!.id)!;
    const b = structuralPositions.get(structuralItems[j]!.id)!;
    assert.ok(
      Math.abs(a.x - b.x) >= 120 || Math.abs(a.y - b.y) >= 70,
      `structural radial items ${i} and ${j} must not overlap`,
    );
  }
}

console.log("usage views OK - categories, capacity, sorting, and radial positions");
