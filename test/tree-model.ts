import assert from "node:assert/strict";
import { buildTreeModel } from "../src/tree-model";
import type { GraphPayload } from "../src/types";

const graph: GraphPayload = {
  nodes: [
    {
      data: { id: "s_reporting", label: "reporting", type: "schema", schema: "reporting", oid: 0 },
    },
    { data: { id: "s_public", label: "public", type: "schema", schema: "public", oid: 0 } },
    {
      data: {
        id: "c_orders_z",
        label: "z_col",
        type: "column",
        parent: "r_orders",
        schema: "public",
        oid: 1,
        ord: 2,
      },
    },
    {
      data: {
        id: "idx_orders",
        label: "orders_idx",
        type: "index",
        parent: "r_orders",
        schema: "public",
        oid: 5,
        ord: 30_000,
      },
    },
    {
      data: {
        id: "trg_orders",
        label: "orders_audit",
        type: "trigger",
        parent: "r_orders",
        schema: "public",
        oid: 3,
        detail: "BEFORE UPDATE",
        ord: 10_000,
      },
    },
    {
      data: {
        id: "c_orphan",
        label: "orphan",
        type: "column",
        parent: "missing",
        schema: "public",
        oid: 99,
        ord: 1,
      },
    },
    {
      data: {
        id: "con_orders",
        label: "orders_pkey",
        type: "constraint",
        parent: "r_orders",
        schema: "public",
        oid: 4,
        ord: 20_000,
      },
    },
    {
      data: {
        id: "c_orders_a",
        label: "a_col",
        type: "column",
        parent: "r_orders",
        schema: "public",
        oid: 1,
        ord: 1,
      },
    },
    {
      data: {
        id: "r_orders",
        label: "orders",
        type: "table",
        schema: "public",
        parent: "s_public",
        oid: 1,
      },
    },
    {
      data: {
        id: "f_public_a",
        label: "aaa()",
        type: "function",
        schema: "public",
        parent: "s_public",
        oid: 6,
      },
    },
    {
      data: {
        id: "r_report",
        label: "active_orders",
        type: "view",
        schema: "reporting",
        parent: "s_reporting",
        oid: 2,
      },
    },
    {
      data: {
        id: "f_report",
        label: "z_report()",
        type: "function",
        parent: "s_reporting",
        oid: 7,
      },
    },
  ],
  edges: [],
  stats: {},
};

const model = buildTreeModel(graph);

assert.deepEqual(
  model.roots.map((n) => n.label),
  ["public", "reporting"],
  "schema roots are sorted",
);
assert.equal(model.byGraphId.get("s_public")?.label, "public", "schema graph id is indexed");
assert.equal(model.byGraphId.get("r_orders")?.label, "orders", "table graph id is indexed");
assert.equal(
  model.byGraphId.get("f_report")?.parent?.parent?.label,
  "reporting",
  "schema-parented nodes inherit their schema grouping",
);
assert.equal(model.byGraphId.get("c_orphan"), undefined, "orphan row nodes are not indexed");
assert.equal(
  model.roots.some((n) => n.label === ""),
  false,
  "schema-parented nodes do not create an empty schema root",
);

const publicSchema = model.roots.find((n) => n.label === "public");
assert.ok(publicSchema, "public schema exists");
assert.deepEqual(
  publicSchema.children.map((n) => n.label),
  ["tables", "functions"],
  "schema groups use stable type order rather than first object label",
);
const tableGroup = publicSchema.children.find((n) => n.label === "tables");
assert.ok(tableGroup, "table group exists");
const orders = tableGroup.children.find((n) => n.label === "orders");
assert.ok(orders, "orders table exists");
assert.deepEqual(
  orders.children.map((n) => n.label),
  ["a_col", "z_col", "orders_audit", "orders_pkey", "orders_idx"],
  "table rows follow graph row ord, not alphabetical label order",
);
assert.equal(
  orders.children.find((n) => n.label === "orders_audit")?.description,
  "BEFORE UPDATE",
  "row descriptions are preserved",
);

const schemaOnlyModel = buildTreeModel({
  nodes: [{ data: { id: "s_empty", label: "empty", type: "schema", schema: "empty", oid: 0 } }],
  edges: [],
  stats: {},
});
assert.deepEqual(
  schemaOnlyModel.roots.map((n) => n.label),
  ["empty"],
  "schema graph nodes without child objects are still shown",
);
assert.equal(
  schemaOnlyModel.byGraphId.get("s_empty")?.label,
  "empty",
  "empty schema graph nodes are indexed",
);

const unknownSchemaModel = buildTreeModel({
  nodes: [{ data: { id: "f_unknown", label: "helper()", type: "function", oid: 8 } }],
  edges: [],
  stats: {},
});
assert.deepEqual(
  unknownSchemaModel.roots.map((n) => n.label),
  ["(unknown schema)"],
  "nodes without schema metadata are grouped under a visible fallback root",
);

const unknownSchemaCollisionModel = buildTreeModel({
  nodes: [
    {
      data: {
        id: "s_literal_unknown",
        label: "(unknown schema)",
        type: "schema",
        schema: "(unknown schema)",
        oid: 0,
      },
    },
    {
      data: {
        id: "f_literal_unknown",
        label: "literal_unknown()",
        type: "function",
        schema: "(unknown schema)",
        parent: "s_literal_unknown",
        oid: 9,
      },
    },
    { data: { id: "f_missing_schema", label: "missing_schema()", type: "function", oid: 10 } },
  ],
  edges: [],
  stats: {},
});
const literalUnknownSchema = unknownSchemaCollisionModel.byGraphId.get("s_literal_unknown");
const fallbackUnknownSchema = unknownSchemaCollisionModel.roots.find(
  (n) => n.label === "(unknown schema)" && !n.graphId,
);
assert.ok(literalUnknownSchema, "literal '(unknown schema)' schema is indexed");
assert.ok(fallbackUnknownSchema, "fallback unknown schema root is present");
assert.notEqual(
  fallbackUnknownSchema,
  literalUnknownSchema,
  "fallback unknown schema root does not reuse a real schema with the same label",
);
assert.notEqual(
  fallbackUnknownSchema?.id,
  literalUnknownSchema.id,
  "fallback unknown schema root has a distinct VS Code tree item id",
);
assert.equal(
  unknownSchemaCollisionModel.byGraphId.get("f_literal_unknown")?.parent?.parent,
  literalUnknownSchema,
  "objects in a real '(unknown schema)' schema stay under that schema root",
);
assert.equal(
  unknownSchemaCollisionModel.byGraphId.get("f_missing_schema")?.parent?.parent,
  fallbackUnknownSchema,
  "objects without schema metadata stay under the fallback root",
);

console.log("tree-model OK - schema grouping and row ordering");
