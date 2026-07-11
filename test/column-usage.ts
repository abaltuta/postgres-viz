import assert from "node:assert/strict";
import type { FuncRefs } from "../src/analyze";
import { buildColumnUsageStore, columnUsageResult, usageOccurrencePage } from "../src/column-usage";
import { buildGraph } from "../src/graph";
import type { Catalog } from "../src/types";

const catalog: Catalog = {
  rels: [
    { oid: 1, schema: "public", name: "orders", kind: "table" },
    { oid: 2, schema: "public", name: "customers", kind: "table" },
  ],
  cols: [
    { relOid: 1, attnum: 1, name: "customer_id", type: "bigint" },
    { relOid: 2, attnum: 1, name: "id", type: "bigint" },
  ],
  funcs: [
    {
      oid: 3,
      schema: "public",
      name: "find_orders",
      language: "sql",
      kind: "f",
      args: "",
      returns: "setof orders",
      src: "SELECT customer_id FROM orders",
      def: "CREATE FUNCTION find_orders() RETURNS SETOF orders AS $$SELECT customer_id FROM orders$$ LANGUAGE sql;",
      hasSqlBody: false,
    },
  ],
  triggers: [],
  viewDeps: [],
  viewFuncDeps: [],
  fks: [{ name: "orders_customer_fk", relOid: 1, refRelOid: 2, cols: [1], refCols: [1] }],
  constraints: [],
  constraintFuncDeps: [],
  indexes: [],
  sqlBodyDeps: [],
  defaultDeps: [],
};

const refs: FuncRefs = {
  reads: new Map([[1, new Set([1])]]),
  inserts: new Map(),
  updates: new Map(),
  deletes: new Map(),
  writes: new Map(),
  modifies: new Map(),
  calls: new Set(),
  occurrences: Array.from({ length: 55 }, (_, index) => ({
    relOid: 1,
    attnum: 1,
    kind: "reads" as const,
    start: 71,
    end: 82,
    snippet: `SELECT customer_id FROM orders -- ${index}`,
  })),
  diagnostics: [],
  unresolved: new Map(),
  parsed: true,
};

const analysis = new Map([[3, refs]]);
const graph = buildGraph(catalog, analysis, { includeFks: true });
const store = buildColumnUsageStore(catalog, graph, analysis, new Map());
const result = columnUsageResult(store, "c1_1");
const sql = result.groups.find((group) => group.kind === "reads");
const structural = result.groups.find((group) => group.kind === "fk");

assert.equal(sql?.owner.name, "find_orders");
assert.equal(sql?.count, 55);
assert.equal(sql?.occurrences.length, 3, "usage summaries contain bounded previews");
assert.equal(sql?.occurrences[0]?.exact, true);
assert.equal(structural?.section, "structural");
assert.equal(structural?.owner.owner, "customers", "column relationships retain table ownership");

const firstPage = usageOccurrencePage(store, sql!.id, 0);
const secondPage = usageOccurrencePage(store, sql!.id, 50);
assert.equal(firstPage?.occurrences.length, 50);
assert.equal(secondPage?.occurrences.length, 5);
assert.equal(firstPage?.total, 55);
assert.ok(store.navigationById.get(firstPage!.occurrences[0]!.id)?.definition?.includes("CREATE"));
assert.equal(usageOccurrencePage(store, "unknown", 0), undefined);

console.log("column usage OK");
