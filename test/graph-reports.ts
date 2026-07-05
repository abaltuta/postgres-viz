import assert from "node:assert/strict";
import { buildImpactReport, buildPathReport, nodeDisplayName } from "../src/graph-reports";
import { GraphIndex } from "../src/graph-index";
import type { GraphPayload } from "../src/types";

const graph: GraphPayload = {
  nodes: [
    {
      data: { id: "s_reporting", label: "reporting", type: "schema", schema: "reporting", oid: 0 },
    },
    { data: { id: "r_invoices", label: "invoices", type: "table", parent: "s_reporting", oid: 6 } },
    {
      data: {
        id: "c_invoices_total",
        label: "total",
        type: "column",
        parent: "r_invoices",
        oid: 6,
      },
    },
    { data: { id: "r_orders", label: "orders", type: "table", schema: "public", oid: 1 } },
    { data: { id: "r_customers", label: "customers", type: "table", schema: "public", oid: 2 } },
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
    { data: { id: "f_log", label: "log_order()", type: "function", schema: "public", oid: 3 } },
    {
      data: { id: "f_notify", label: "notify_stats()", type: "function", schema: "public", oid: 4 },
    },
    {
      data: { id: "r_markdown", label: "a_[b](c)<d>&", type: "table", schema: "public", oid: 7 },
    },
    {
      data: {
        id: "f_markdown",
        label: "uses`name()*",
        type: "function",
        schema: "public",
        oid: 8,
      },
    },
    {
      data: {
        id: "r_newline",
        label: "line\nitems",
        type: "table",
        schema: "public",
        oid: 9,
      },
    },
  ],
  edges: [
    { data: { id: "e0", source: "f_log", target: "r_orders", kind: "updates" } },
    { data: { id: "e1", source: "f_log", target: "r_orders", kind: "reads" } },
    {
      data: {
        id: "e2",
        source: "f_log",
        target: "r_customers",
        kind: "updates",
        agg: true,
        count: 2,
      },
    },
    { data: { id: "e3", source: "f_log", target: "f_notify", kind: "calls" } },
    { data: { id: "e4", source: "r_orders", target: "r_customers", kind: "fk", agg: true } },
    {
      data: {
        id: "e5",
        source: "f_log",
        target: "c_customers_name",
        kind: "updates",
        detail: true,
      },
    },
    { data: { id: "e6", source: "f_markdown", target: "r_markdown", kind: "reads" } },
    { data: { id: "e7", source: "f_markdown", target: "r_newline", kind: "calls" } },
  ],
  stats: {},
};

const index = new GraphIndex(graph);
assert.equal(
  nodeDisplayName(index, "s_reporting"),
  "reporting",
  "schema display names are not doubled",
);
assert.equal(
  nodeDisplayName(index, "r_invoices"),
  "reporting.invoices",
  "card display names can inherit schema from schema parent",
);
assert.equal(
  nodeDisplayName(index, "c_invoices_total"),
  "reporting.invoices.total",
  "row display names can inherit schema from owner",
);
assert.equal(
  nodeDisplayName(index, "c_customers_name"),
  "public.customers.name",
  "row display names include owner",
);
assert.equal(
  nodeDisplayName(index, "f_markdown"),
  "public.uses`name()*",
  "plain display names are not markdown-escaped",
);

const dependents = buildImpactReport(graph, {
  rootId: "r_customers",
  direction: "in",
  kinds: ["updates", "fk"],
});
assert.match(dependents, /# Dependents: public\.customers/, "report title names root");
assert.match(dependents, /`updates x2` <- public\.log_order\(\)/, "aggregate count appears");
assert.match(dependents, /`fk` <- public\.orders/, "incoming FK dependent appears");
assert.doesNotMatch(dependents, /customers\.name/, "detail edges are hidden in impact reports");

const dependencies = buildImpactReport(graph, {
  rootId: "f_log",
  direction: "out",
  kinds: ["reads", "calls"],
});
assert.match(dependencies, /`reads` -> public\.orders/, "outgoing dependencies report reads");
assert.match(
  dependencies,
  /`calls` -> public\.notify_stats\(\)/,
  "outgoing dependencies report calls",
);
assert.doesNotMatch(dependencies, /public\.customers/, "edge-kind filters apply");

const defaultDependencies = buildImpactReport(graph, {
  rootId: "f_log",
  kinds: ["reads"],
});
assert.match(
  defaultDependencies,
  /# Dependencies: public\.log_order\(\)/,
  "impact reports default to outgoing dependency wording",
);
assert.match(defaultDependencies, /`reads` -> public\.orders/, "default impact direction is outgoing");
assert.doesNotMatch(defaultDependencies, /# Dependents:/, "default impact title matches traversal");

const parallelEdges = buildImpactReport(graph, {
  rootId: "f_log",
  direction: "out",
  kinds: ["updates", "reads"],
  maxDepth: 1,
});
const readsOrder = parallelEdges.indexOf("`reads` -> public.orders");
const updatesOrder = parallelEdges.indexOf("`updates` -> public.orders");
assert.ok(
  readsOrder !== -1 && updatesOrder !== -1 && readsOrder < updatesOrder,
  "parallel edge rows sort by kind",
);

const zeroDepth = buildImpactReport(graph, {
  rootId: "f_log",
  direction: "out",
  maxDepth: 0,
});
assert.match(
  zeroDepth,
  /Filter: all card-level edges; max depth 0\./,
  "max-depth filter is reported",
);
assert.doesNotMatch(zeroDepth, /depth 1:/, "zero-depth impact reports no direct rows");

const fractionalDepth = buildImpactReport(graph, {
  rootId: "f_log",
  direction: "out",
  maxDepth: 1.5,
});
assert.match(
  fractionalDepth,
  /Filter: all card-level edges; max depth 1\./,
  "fractional max-depth reports the effective floored traversal depth",
);

const nanDepth = buildImpactReport(graph, {
  rootId: "f_log",
  direction: "out",
  maxDepth: Number.NaN,
});
assert.match(
  nanDepth,
  /Filter: all card-level edges; max depth 0\./,
  "non-finite max-depth reports the effective zero traversal depth",
);
assert.doesNotMatch(nanDepth, /depth 1:/, "non-finite max-depth shows no direct rows");

const noKinds = buildImpactReport(graph, {
  rootId: "f_log",
  direction: "out",
  kinds: [],
});
assert.match(
  noKinds,
  /Filter: no edge kinds; max depth 6\./,
  "empty edge-kind filters are described",
);
assert.doesNotMatch(noKinds, /depth 1:/, "empty edge-kind filters match no edges");

const markdownEscaped = buildImpactReport(graph, {
  rootId: "f_markdown",
  direction: "out",
});
assert.ok(
  markdownEscaped.includes("# Dependencies: public.uses\\`name()\\*"),
  "report titles escape markdown-sensitive function names",
);
assert.ok(
  markdownEscaped.includes("`reads` -> public.a_\\[b\\](c)\\<d\\>"),
  "report rows escape markdown-sensitive relation names",
);
assert.ok(
  markdownEscaped.includes("`calls` -> public.line items"),
  "report rows flatten newlines in object names",
);
assert.doesNotMatch(
  markdownEscaped,
  /public\.line\r?\nitems/,
  "object-name newlines cannot break report rows",
);

const outPath = buildPathReport(graph, {
  sourceId: "f_log",
  targetId: "r_customers",
});
assert.match(outPath, /1 edge found/, "path report counts edges");
assert.match(
  outPath,
  /Filter: all card-level edges; out direction\./,
  "path reports describe default filters",
);
assert.match(outPath, /public\.log_order\(\) --updates--> public\.customers/, "forward path");

const reversePath = buildPathReport(graph, {
  sourceId: "r_customers",
  targetId: "f_log",
  direction: "both",
  kinds: ["updates"],
});
assert.match(
  reversePath,
  /public\.customers <--updates-- public\.log_order\(\)/,
  "reverse traversal keeps actual edge direction",
);
assert.match(
  reversePath,
  /Filter: updates; both direction\./,
  "path reports describe selected edge-kind filters",
);

const filteredPath = buildPathReport(graph, {
  sourceId: "f_log",
  targetId: "r_customers",
  kinds: ["calls"],
});
assert.match(filteredPath, /Filter: calls; out direction\./, "filtered no-path reports name filter");
assert.match(filteredPath, /No path found\./, "filtered no-path reports do not hide filter state");

const missingPath = buildPathReport(graph, {
  sourceId: "missing_source",
  targetId: "missing_target",
});
assert.match(
  missingPath,
  /Node not found: source `missing_source`, target `missing_target`/,
  "missing path endpoints are reported explicitly",
);

const missingImpactWithNewline = buildImpactReport(graph, {
  rootId: "missing\nroot",
});
assert.ok(
  missingImpactWithNewline.includes("Node not found: `missing root`"),
  "missing-node ids render as one-line inline code",
);
assert.doesNotMatch(
  missingImpactWithNewline,
  /missing\r?\nroot/,
  "missing-node ids cannot inject line breaks into report rows",
);

console.log("graph-reports OK — impact summaries and dependency paths");
