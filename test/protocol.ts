import assert from "node:assert/strict";
import { DEFAULT_PREFS, normalizePrefs } from "../src/protocol";

assert.deepEqual(normalizePrefs(undefined), DEFAULT_PREFS, "missing prefs use defaults");
assert.deepEqual(normalizePrefs(null), DEFAULT_PREFS, "null prefs use defaults");

assert.deepEqual(
  normalizePrefs({
    layout: "spiral",
    edgeMode: "everything",
    schemaGroup: "yes",
    route: true,
    hideIsolated: false,
    engine: "v9",
    filterSchemas: [" public ", "", "   ", "audit", "public", 7, "audit"],
    filterNodeTypes: ["table", "bogus", "function", "schema", "table"],
    filterEdgeKinds: ["reads", "bad", "calls", "reads"],
  }),
  {
    ...DEFAULT_PREFS,
    route: true,
    filterSchemas: [" public ", "audit", "public"],
    filterNodeTypes: ["table", "function"],
    filterEdgeKinds: ["reads", "calls"],
  },
  "malformed prefs are normalized field-by-field",
);

assert.deepEqual(
  normalizePrefs({
    filterSchemas: [" exact schema ", "\t", "\n"],
  }).filterSchemas,
  [" exact schema "],
  "schema filters keep exact identifiers but drop whitespace-only entries",
);

assert.deepEqual(
  normalizePrefs({
    layout: "tree",
    edgeMode: "all",
    schemaGroup: false,
    route: true,
    hideIsolated: true,
    emphasizeConnections: true,
    engine: "v2",
    filterSchemas: ["sales"],
    filterNodeTypes: ["view"],
    filterEdgeKinds: ["fk"],
  }),
  {
    layout: "tree",
    edgeMode: "all",
    schemaGroup: false,
    route: true,
    hideIsolated: true,
    emphasizeConnections: true,
    engine: "v2",
    filterSchemas: ["sales"],
    filterNodeTypes: ["view"],
    filterEdgeKinds: ["fk"],
  },
  "valid prefs are preserved",
);

console.log("protocol OK - preference normalization");
