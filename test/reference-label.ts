import assert from "node:assert/strict";
import { referenceLabel } from "../viewer/reference-label";
import type { SnapshotObject } from "../viewer/snapshot";

const schema = "Sales Ops";
const objects = new Map<string, SnapshotObject>();
for (const [kind, name, expected] of [
  ["function", "roll.up()", '"Sales Ops"."roll.up"()'],
  ["procedure", 'roll"(up(amount integer)', '"Sales Ops"."roll""(up"(amount integer)'],
  ["function", 'roll(up)("a)""(" "s)"."t("[])', '"Sales Ops"."roll(up)"("a)""(" "s)"."t("[])'],
  ["function", "rollup(input numeric)", '"Sales Ops".rollup(input numeric)'],
  ["table", "confirmed.orders", '"Sales Ops"."confirmed.orders"'],
] as const) {
  objects.set(kind, { id: kind, schema, kind, name });
  assert.equal(referenceLabel(kind, objects, new Map()), expected);
}

const column = { id: "c", objectId: "table", name: 'min"qty', type: "int", position: 1 };
const columns = new Map([[column.id, column]]);
assert.equal(referenceLabel("c", objects, columns), '"Sales Ops"."confirmed.orders"."min""qty"');
for (const kind of ["trigger", "constraint", "index", "policy"] as const) {
  objects.set(kind, { id: kind, schema, kind, name: "changed.at", parentId: "table" });
  const parent = kind === "index" ? '"Sales Ops"' : '"Sales Ops"."confirmed.orders"';
  assert.equal(referenceLabel(kind, objects, columns), parent + '."changed.at"');
}
