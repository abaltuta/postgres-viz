import assert from "node:assert/strict";
import { readSnapshot } from "../viewer/snapshot";
import example from "./fixtures/commerce.pgviz.json";
import readerCases from "./fixtures/snapshot-reader-cases.json";
import { SnapshotIndex } from "../viewer/snapshot-index";

const fixture = readSnapshot(example);
for (const tc of readerCases) {
  const input = structuredClone(fixture);
  input.diagnostics.unresolved = [
    { ownerId: "f", identifier: "x", reason: "unknown", snippet: "x" },
  ];
  const parts = tc.path.split(".");
  const key = parts.pop()!;
  let parent = input as unknown as Record<string, unknown>;
  for (const part of parts) parent = parent[part] as Record<string, unknown>;
  if ("value" in tc) parent[key] = tc.value;
  else {
    if (tc.rename) parent[tc.rename] = parent[key];
    delete parent[key];
  }
  if (tc.valid) assert.doesNotThrow(() => readSnapshot(input), tc.path);
  else assert.throws(() => readSnapshot(input), /invalid snapshot/i, tc.path);
}
const oldProcedure = {
  ...fixture,
  definitions: fixture.definitions.map((d) =>
    d.ownerId === "f"
      ? { ...d, sql: "CREATE OR REPLACE PROCEDURE billing.adjust() LANGUAGE sql AS $$SELECT 1$$" }
      : d,
  ),
};
assert.equal(readSnapshot(oldProcedure).objects.find((o) => o.id === "f")?.kind, "procedure");
assert.equal(oldProcedure.objects.find((o) => o.id === "f")?.kind, "function");
assert.deepEqual(readSnapshot(JSON.parse(JSON.stringify(fixture))), fixture);
assert.throws(() => readSnapshot({ ...fixture, version: 2 }), /version.*2/i);
assert.throws(() => readSnapshot({ graph: { nodes: [], edges: [] } }), /legacy.*evidence/i);
assert.throws(() => readSnapshot({ ...fixture, columns: [] }), /target.*a/i);
assert.throws(
  () =>
    readSnapshot({ ...fixture, columns: fixture.columns.map((c) => ({ ...c, objectId: "f" })) }),
  /column.*relation/i,
);
assert.throws(
  () => readSnapshot({ ...fixture, columns: fixture.columns.map((c) => ({ ...c, position: 1 })) }),
  /duplicate column position/i,
);
assert.throws(
  () =>
    readSnapshot({
      ...fixture,
      relationships: fixture.relationships.map((r) =>
        r.kind === "fk" ? { ...r, position: 2 } : r,
      ),
    }),
  /FK.*position/i,
);
const index = new SnapshotIndex(fixture);
const policy = readSnapshot({
  ...fixture,
  objects: [
    ...fixture.objects,
    { id: "policy", parentId: "t", name: "guard", schema: "billing", kind: "policy" },
  ],
  relationships: [
    ...fixture.relationships,
    { id: "policy-read", source: "policy", target: "a", kind: "reads", provenance: "catalog" },
    { id: "policy-call", source: "policy", target: "f", kind: "calls", provenance: "catalog" },
  ],
});
const policyIndex = new SnapshotIndex(policy);
assert(policyIndex.columnReferences("a").some((edge) => edge.id === "policy-read"));
assert(policyIndex.neighborhood("f", "incoming", 1).some(([edge]) => edge?.id === "policy-call"));
assert.deepEqual(
  index.neighborhood("a", "incoming", 2).map((path) => path.map((edge) => edge.id)),
  [["reads"], ["reads", "calls"]],
);
assert.deepEqual(index.neighborhood("b", "incoming", 2), []);
assert.equal(index.objectPairs().length, 2);
assert.deepEqual(
  index.columnReferences("previous").map((edge) => edge.constraintId),
  ["k"],
);
console.log("snapshot compatibility and offline queries passed");
