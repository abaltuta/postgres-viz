import assert from "node:assert/strict";
import { normalizeSchemaFilter, normalizeSchemaList } from "../src/load-service";

assert.deepEqual(normalizeSchemaList([]), [], "empty schema lists stay empty");
assert.deepEqual(
  normalizeSchemaList([" public ", "", "payroll", "public", "  payroll  ", "analytics", null, 42]),
  ["public", "payroll", "analytics"],
  "schema lists are trimmed, de-duped, and malformed entries are ignored",
);
assert.deepEqual(
  normalizeSchemaList(["Sales", "sales"]),
  ["Sales", "sales"],
  "normalization does not change PostgreSQL identifier case",
);
assert.deepEqual(normalizeSchemaList("public"), [], "malformed non-array schema setting is ignored");
assert.deepEqual(normalizeSchemaList({ 0: "public" }), [], "array-like schema setting is ignored");

assert.deepEqual(
  normalizeSchemaFilter([" public "], ["hdb_catalog"]),
  { include: ["public"], exclude: [] },
  "exclude schemas are ignored when an include whitelist is active",
);
assert.deepEqual(
  normalizeSchemaFilter([], [" hdb_catalog ", "hdb_catalog", "", 42]),
  { include: null, exclude: ["hdb_catalog"] },
  "exclude schemas apply only for all-schema introspection",
);

console.log("load-service OK - schema setting normalization and effective filters");
