import assert from "node:assert/strict";
import { GraphIndex } from "../src/graph-index";
import type { GraphPayload } from "../src/types";

const graph: GraphPayload = {
  nodes: [
    { data: { id: "s_public", label: "public", type: "schema", schema: "public", oid: 0 } },
    {
      data: {
        id: "r_orders",
        label: "orders",
        type: "table",
        parent: "s_public",
        schema: "public",
        oid: 1,
      },
    },
    {
      data: {
        id: "r_customers",
        label: "customers",
        type: "table",
        parent: "s_public",
        schema: "public",
        oid: 2,
      },
    },
    {
      data: {
        id: "c_orders_total",
        label: "total",
        type: "column",
        parent: "r_orders",
        schema: "public",
        oid: 1,
        ord: 2,
      },
    },
    {
      data: {
        id: "c_orders_customer",
        label: "customer_id",
        type: "column",
        parent: "r_orders",
        schema: "public",
        oid: 1,
        ord: 1,
      },
    },
    {
      data: {
        id: "c_customers_id",
        label: "id",
        type: "column",
        parent: "r_customers",
        schema: "public",
        oid: 2,
      },
    },
    {
      data: {
        id: "c_customers_name",
        label: "name",
        type: "column",
        parent: "r_customers",
        schema: "public",
        oid: 2,
      },
    },
    {
      data: {
        id: "g_orders_audit",
        label: "orders_audit",
        type: "trigger",
        parent: "r_orders",
        schema: "public",
        oid: 3,
      },
    },
    {
      data: {
        id: "f_log_order",
        label: "log_order()",
        type: "function",
        parent: "s_public",
        schema: "public",
        oid: 4,
      },
    },
    {
      data: {
        id: "f_notify",
        label: "notify_stats()",
        type: "function",
        parent: "s_public",
        schema: "public",
        oid: 5,
      },
    },
  ],
  edges: [
    {
      data: {
        id: "reads|f_log_order|c_orders_total",
        source: "f_log_order",
        target: "c_orders_total",
        kind: "reads",
        detail: true,
      },
    },
    {
      data: {
        id: "agg|reads|f_log_order|r_orders",
        source: "f_log_order",
        target: "r_orders",
        kind: "reads",
        agg: true,
        count: 1,
      },
    },
    {
      data: {
        id: "updates|f_log_order|c_customers_name",
        source: "f_log_order",
        target: "c_customers_name",
        kind: "updates",
        detail: true,
      },
    },
    {
      data: {
        id: "agg|updates|f_log_order|r_customers",
        source: "f_log_order",
        target: "r_customers",
        kind: "updates",
        agg: true,
        count: 1,
      },
    },
    {
      data: {
        id: "calls|f_log_order|f_notify",
        source: "f_log_order",
        target: "f_notify",
        kind: "calls",
      },
    },
    {
      data: {
        id: "executes|g_orders_audit|f_log_order",
        source: "g_orders_audit",
        target: "f_log_order",
        kind: "executes",
        detail: true,
      },
    },
    {
      data: {
        id: "agg|executes|r_orders|f_log_order",
        source: "r_orders",
        target: "f_log_order",
        kind: "executes",
        agg: true,
        count: 1,
      },
    },
    {
      data: {
        id: "fk|c_orders_customer|c_customers_id",
        source: "c_orders_customer",
        target: "c_customers_id",
        kind: "fk",
        detail: true,
      },
    },
    {
      data: {
        id: "agg|fk|r_orders|r_customers",
        source: "r_orders",
        target: "r_customers",
        kind: "fk",
        agg: true,
        count: 1,
        label: "orders_customer_id_fkey",
      },
    },
  ],
  stats: {},
};

const index = new GraphIndex(graph);

assert.equal(index.node("r_orders")?.label, "orders", "node lookup by id");
assert.deepEqual(
  index.nodesOfType("table").map((n) => n.id),
  ["r_customers", "r_orders"],
  "type index is label-sorted",
);
assert.equal(index.parent("c_orders_total")?.id, "r_orders", "row parent lookup");
assert.deepEqual(
  index.ancestors("c_orders_total").map((n) => n.id),
  ["r_orders", "s_public"],
  "ancestor walk reaches the schema",
);
assert.deepEqual(
  index.children("r_orders").map((n) => n.id),
  ["c_orders_customer", "c_orders_total", "g_orders_audit"],
  "relation children are sorted by row ownership and row order",
);
assert.equal(index.cardId("g_orders_audit"), "r_orders", "trigger rows map to their card");
assert.equal(index.cardId("f_log_order"), "f_log_order", "functions are their own cards");

assert.deepEqual(
  index.outgoing("f_log_order", { includeDetail: false }).map((e) => e.id),
  ["agg|reads|f_log_order|r_orders", "agg|updates|f_log_order|r_customers", "calls|f_log_order|f_notify"],
  "card-level outgoing edges hide detail rows",
);
assert.deepEqual(
  index.incoming("r_customers", { includeDetail: false }).map((e) => e.id),
  ["agg|updates|f_log_order|r_customers", "agg|fk|r_orders|r_customers"],
  "card-level incoming edges include aggregate relationship edges",
);
function* fkOnly() {
  yield "fk" as const;
}
assert.deepEqual(
  index.incoming("r_customers", { includeDetail: false, kinds: fkOnly() }).map((e) => e.id),
  ["agg|fk|r_orders|r_customers"],
  "single-use edge-kind iterables are normalized once per query",
);

const updateAgg = index.edge("agg|updates|f_log_order|r_customers")!;
assert.deepEqual(
  index.aggregateMembers(updateAgg).map((e) => e.id),
  ["updates|f_log_order|c_customers_name"],
  "aggregate members resolve by card endpoints and edge kind",
);
assert.equal(
  index.aggregateFor("updates|f_log_order|c_customers_name")?.id,
  updateAgg.id,
  "detail edge can find its aggregate",
);

const affected = index.impact("f_log_order", { includeDetail: false })!;
assert.deepEqual(
  affected.direct.map((s) => `${s.edge.kind}:${s.node.id}`).sort(),
  ["calls:f_notify", "reads:r_orders", "updates:r_customers"],
  "impact defaults to outgoing dependencies when direction is omitted",
);
assert.deepEqual(
  index.impact("f_log_order", { includeDetail: false, maxDepth: 0 })?.direct,
  [],
  "zero-depth impact has no direct rows",
);

const dependents = index.impact("r_customers", {
  direction: "in",
  includeDetail: false,
  kinds: ["updates", "fk"],
})!;
assert.deepEqual(
  dependents.direct.map((s) => `${s.edge.kind}:${s.node.id}`).sort(),
  ["fk:r_orders", "updates:f_log_order"],
  "incoming impact answers what depends on a table",
);

const path = index.shortestPath("g_orders_audit", "f_notify", { includeDetail: true });
assert.deepEqual(
  path?.nodes.map((n) => n.id),
  ["g_orders_audit", "f_log_order", "f_notify"],
  "shortest path can traverse row-detail trigger edges",
);
assert.deepEqual(
  index
    .reachable("r_orders", { includeDetail: false, maxDepth: 2 })
    .map((s) => `${s.depth}:${s.node.id}`)
    .sort(),
  ["1:f_log_order", "1:r_customers", "2:f_notify"],
  "reachable breadth-first traversal tracks depth and avoids cycles",
);
assert.deepEqual(
  index
    .reachable("r_orders", { includeDetail: false, maxDepth: 1.5 })
    .map((s) => `${s.depth}:${s.node.id}`)
    .sort(),
  ["1:f_log_order", "1:r_customers"],
  "fractional maxDepth cannot leak traversal past the requested depth",
);
assert.equal(
  index.shortestPath("r_orders", "f_notify", { includeDetail: false, maxDepth: 1.5 }),
  null,
  "fractional maxDepth does not round up shortest-path traversal",
);
assert.deepEqual(
  index.impact("f_log_order", { includeDetail: false, maxDepth: Number.NaN })?.direct,
  [],
  "non-finite maxDepth is treated as zero-depth impact",
);
assert.equal(index.shortestPath("missing", "f_notify"), null, "missing source returns no path");

const cyclicParents = new GraphIndex({
  nodes: [
    { data: { id: "a", label: "a", type: "table", parent: "b", oid: 20 } },
    { data: { id: "b", label: "b", type: "table", parent: "a", oid: 21 } },
  ],
  edges: [],
  stats: {},
});
assert.deepEqual(
  cyclicParents.ancestors("a").map((n) => n.id),
  ["b"],
  "ancestor lookup stops on parent cycles",
);

const ambiguousPath = new GraphIndex({
  nodes: [
    { data: { id: "a", label: "a", type: "table", oid: 30 } },
    { data: { id: "b", label: "b", type: "table", oid: 31 } },
    { data: { id: "c", label: "c", type: "table", oid: 32 } },
    { data: { id: "t", label: "t", type: "table", oid: 33 } },
  ],
  edges: [
    { data: { id: "a-c", source: "a", target: "c", kind: "reads" } },
    { data: { id: "c-t", source: "c", target: "t", kind: "reads" } },
    { data: { id: "a-b", source: "a", target: "b", kind: "reads" } },
    { data: { id: "b-t", source: "b", target: "t", kind: "reads" } },
  ],
  stats: {},
});
assert.deepEqual(
  ambiguousPath.shortestPath("a", "t")?.nodes.map((n) => n.id),
  ["a", "b", "t"],
  "shortest path tie-breaks do not depend on edge input order",
);

const multiEdgeImpact = new GraphIndex({
  nodes: [
    { data: { id: "f_sync", label: "sync()", type: "function", oid: 10 } },
    { data: { id: "r_accounts", label: "accounts", type: "table", oid: 11 } },
  ],
  edges: [
    { data: { id: "reads|f_sync|r_accounts", source: "f_sync", target: "r_accounts", kind: "reads" } },
    {
      data: {
        id: "updates|f_sync|r_accounts",
        source: "f_sync",
        target: "r_accounts",
        kind: "updates",
      },
    },
  ],
  stats: {},
}).impact("f_sync")!;
assert.deepEqual(
  multiEdgeImpact.direct.map((s) => s.edge.kind).sort(),
  ["reads", "updates"],
  "direct impact preserves parallel edge kinds to the same target",
);

console.log("graph-index OK — lookup, card ownership, impact, paths, aggregate members");
