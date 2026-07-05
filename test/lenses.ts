/**
 * Tests for the PURE CodeLens/Hover logic (`src/lenses.ts`) — runs in `pnpm smoke`.
 * We hand-build HclEntry[] (the parser is tested in test/hcl.ts) and a tiny
 * GraphPayload so we can pin down the resolution rules:
 *   - top-level anchors only (schema is skipped)
 *   - ambiguity: a schema-less name that matches two schemas must NOT resolve
 *   - summaries count CARD-LEVEL edges (detail !== true), one per edge — the
 *     agg `count` multiplier is ignored
 *   - hover markdown lists qualified counterpart names; null when unresolved
 */
import assert from "node:assert/strict";
import { buildLensAnchors, hoverMarkdown } from "../src/lenses";
import type { HclEntry } from "../src/hcl";
import type { GraphPayload } from "../src/types";

const entries: HclEntry[] = [
  { kind: "schema", name: "payroll", line: 0, col: 0 },
  // two `instruction` tables in different schemas → ambiguous without a schema
  { kind: "table", name: "instruction", schema: "payroll", line: 4, col: 7 },
  { kind: "table", name: "instruction_pub", line: 10, col: 7 }, // resolves to r2 via label
  { kind: "table", name: "instruction", line: 16, col: 7 }, // NO schema → ambiguous, must not resolve
  { kind: "function", name: "recalculate_totals", schema: "payroll", line: 22, col: 9 },
  { kind: "procedure", name: "refresh_audit", schema: "payroll", line: 24, col: 11 },
  { kind: "view", name: "customer_orders", schema: "public", line: 28, col: 5 },
  { kind: "materialized", name: "order_stats", schema: "public", line: 32, col: 12 },
  // trigger row, owner is the enclosing table → must agree with the parent label
  { kind: "trigger", name: "trg_x", owner: "instruction", schema: "payroll", line: 36, col: 8 },
  { kind: "trigger", name: "trg_bad", owner: "nope", schema: "payroll", line: 40, col: 8 },
];

const graph: GraphPayload = {
  nodes: [
    { data: { id: "r1", label: "instruction", type: "table", schema: "payroll", oid: 1 } },
    { data: { id: "r2", label: "instruction", type: "table", schema: "public", oid: 2 } },
    { data: { id: "r2b", label: "instruction_pub", type: "table", schema: "public", oid: 22 } },
    {
      data: {
        id: "f1",
        label: "recalculate_totals(report_id uuid)",
        type: "function",
        schema: "payroll",
        oid: 3,
      },
    },
    {
      data: {
        id: "p1",
        label: "refresh_audit(since timestamptz)",
        type: "function",
        schema: "payroll",
        oid: 33,
      },
    },
    { data: { id: "f9", label: "caller_fn()", type: "function", schema: "payroll", oid: 9 } },
    { data: { id: "v1", label: "customer_orders", type: "view", schema: "public", oid: 4 } },
    { data: { id: "m1", label: "order_stats", type: "matview", schema: "public", oid: 5 } },
    {
      data: { id: "g1", label: "trg_x", type: "trigger", parent: "r1", schema: "payroll", oid: 6 },
    },
  ],
  edges: [
    { data: { id: "e1", source: "f1", target: "r1", kind: "reads", agg: true, count: 3 } },
    { data: { id: "e2", source: "f1", target: "r1", kind: "deletes" } },
    { data: { id: "e3", source: "f9", target: "f1", kind: "calls" } },
    // detail edge — must NOT count toward any card-level summary
    { data: { id: "e4", source: "g1", target: "f1", kind: "executes", detail: true } },
  ],
  stats: {},
};

const anchors = buildLensAnchors(entries, graph);

// only top-level kinds become anchors; schema is skipped
assert.ok(!anchors.some((a) => a.kind === "schema"), "schema entries produce no anchor");
assert.equal(anchors.length, 9, "one anchor per non-schema top-level entry");

const byName = (name: string, kind?: string) =>
  anchors.find((a) => a.name === name && (kind === undefined || a.kind === kind))!;

// schema-qualified table resolves to its own schema's node
assert.equal(byName("instruction", "table").graphId, "r1", "payroll.instruction → r1");
assert.equal(byName("instruction", "table").nodeType, "table");

// schema-LESS table whose label exists in two schemas must NOT resolve (ambiguity rule)
const ambiguous = anchors.filter((a) => a.name === "instruction" && a.schema === undefined);
assert.equal(ambiguous.length, 1, "the schema-less instruction anchor exists");
assert.equal(ambiguous[0]!.graphId, undefined, "ambiguous schema-less name must not resolve");

// a unique label resolves even without a schema
assert.equal(byName("instruction_pub").graphId, "r2b", "unique label resolves schema-less");

// function/procedure anchors resolve by routine name even when graph labels show signatures
const fn = byName("recalculate_totals");
assert.equal(fn.graphId, "f1");
assert.equal(fn.nodeType, "function");
assert.equal(fn.canCallTree, true, "functions can show a call tree");
const proc = byName("refresh_audit");
assert.equal(proc.graphId, "p1", "procedures resolve to routine graph nodes");
assert.equal(proc.nodeType, "function", "routine graph nodes use the shared function type");
assert.equal(proc.canCallTree, true, "procedures can show a call tree");

// view / matview resolution
assert.equal(byName("customer_orders").graphId, "v1", "view → matching view node");
assert.equal(byName("order_stats").graphId, "m1", "materialized → matview node");
assert.equal(byName("customer_orders").canCallTree, false, "tables/views cannot call-tree");

// trigger resolves by label with owner sanity; canCallTree true
const trg = byName("trg_x");
assert.equal(trg.graphId, "g1", "trigger resolves by label");
assert.equal(trg.nodeType, "trigger");
assert.equal(trg.canCallTree, true, "triggers can show a call tree");
// owner mismatch → no resolution
assert.equal(byName("trg_bad").graphId, undefined, "trigger owner mismatch must not resolve");

const duplicateTriggerGraph: GraphPayload = {
  nodes: [
    { data: { id: "r_accounts", label: "accounts", type: "table", schema: "public", oid: 10 } },
    { data: { id: "r_orders", label: "orders", type: "table", schema: "public", oid: 11 } },
    {
      data: {
        id: "g_accounts",
        label: "trg_touch",
        type: "trigger",
        parent: "r_accounts",
        schema: "public",
        oid: 12,
      },
    },
    {
      data: {
        id: "g_orders",
        label: "trg_touch",
        type: "trigger",
        parent: "r_orders",
        schema: "public",
        oid: 13,
      },
    },
  ],
  edges: [],
  stats: {},
};

const duplicateTrigger = buildLensAnchors(
  [{ kind: "trigger", name: "trg_touch", owner: "orders", schema: "public", line: 0, col: 0 }],
  duplicateTriggerGraph,
)[0]!;
assert.equal(
  duplicateTrigger.graphId,
  "g_orders",
  "duplicate trigger names resolve by owner before ambiguity is decided",
);

const overloadedFunctionGraph: GraphPayload = {
  nodes: [
    {
      data: {
        id: "f_overload_1",
        label: "calculate(input integer)",
        type: "function",
        schema: "public",
        oid: 20,
      },
    },
    {
      data: {
        id: "f_overload_2",
        label: "calculate(input text)",
        type: "function",
        schema: "public",
        oid: 21,
      },
    },
  ],
  edges: [],
  stats: {},
};

const overloadedFunction = buildLensAnchors(
  [{ kind: "function", name: "calculate", schema: "public", line: 0, col: 0 }],
  overloadedFunctionGraph,
)[0]!;
assert.equal(
  overloadedFunction.graphId,
  undefined,
  "overloaded functions in one schema must not resolve arbitrarily",
);

// ── summaries: count CARD-LEVEL edges (one per edge), agg multiplier ignored ──
// f1: outgoing reads(1) + deletes(1), incoming calls(1) → "reads 1 · deletes 1 · called by 1"
// the executes edge is detail:true and must NOT appear.
assert.equal(fn.summary, "reads 1 · deletes 1 · called by 1", "function summary, edge counts");

// r1 (payroll.instruction): incoming reads(1) + deletes(1) → "read by 1 · deleted by 1"
assert.equal(
  byName("instruction", "table").summary,
  "read by 1 · deleted by 1",
  "table summary, incoming kinds phrased as '<kind> by'",
);

// unresolved anchors carry no summary
assert.equal(ambiguous[0]!.summary, undefined, "no summary without a graph node");

// ── hover markdown ──
const fnHover = hoverMarkdown(fn, graph)!;
assert.match(fnHover, /recalculate\\_totals/, "hover names the unit");
assert.match(fnHover, /payroll\.instruction/, "hover qualifies the read counterpart");
assert.match(fnHover, /caller_fn\(\)/, "hover names the caller function");

const shuffledGraph: GraphPayload = {
  ...graph,
  edges: [graph.edges[2]!, graph.edges[1]!, graph.edges[3]!, graph.edges[0]!],
};
const shuffledFn = buildLensAnchors(entries, shuffledGraph).find(
  (a) => a.name === "recalculate_totals",
)!;
assert.equal(
  shuffledFn.summary,
  "reads 1 · deletes 1 · called by 1",
  "summary order is independent of graph edge order",
);
assert.equal(
  hoverMarkdown(shuffledFn, shuffledGraph),
  fnHover,
  "hover relationship order is independent of graph edge order",
);

const markdownGraph: GraphPayload = {
  nodes: [
    { data: { id: "weird", label: "weird_*name", type: "table", schema: "public", oid: 30 } },
    {
      data: { id: "caller_tick", label: "uses`name()", type: "function", schema: "public", oid: 31 },
    },
  ],
  edges: [{ data: { id: "e_weird", source: "caller_tick", target: "weird", kind: "reads" } }],
  stats: {},
};
const markdownHover = hoverMarkdown(
  {
    line: 0,
    col: 0,
    kind: "table",
    name: "weird_*name",
    graphId: "weird",
    nodeType: "table",
    canCallTree: false,
  },
  markdownGraph,
)!;
assert.ok(
  markdownHover.includes("**public\\.weird\\_\\*name**"),
  "hover escapes title markdown",
);
assert.ok(
  markdownHover.includes("← read by ``public.uses`name()``"),
  "hover uses a safe code span for names containing backticks",
);

const htmlishHover = hoverMarkdown(
  {
    line: 0,
    col: 0,
    kind: "table",
    name: "a_[b](c)<d>&",
    graphId: "htmlish",
    nodeType: "table",
    canCallTree: false,
  },
  {
    nodes: [
      {
        data: { id: "htmlish", label: "a_[b](c)<d>&", type: "table", schema: "public", oid: 40 },
      },
    ],
    edges: [],
    stats: {},
  },
)!;
assert.ok(
  htmlishHover.includes("**public\\.a\\_\\[b\\]\\(c\\)&lt;d&gt;&amp;**"),
  "hover title renders punctuation and html-like text literally",
);

const newlineHover = hoverMarkdown(
  {
    line: 0,
    col: 0,
    kind: "table",
    name: "line\nitems",
    graphId: "line_items",
    nodeType: "table",
    canCallTree: false,
  },
  {
    nodes: [
      {
        data: { id: "line_items", label: "line\nitems", type: "table", schema: "public", oid: 50 },
      },
      {
        data: { id: "line_caller", label: "uses\nline()", type: "function", schema: "public", oid: 51 },
      },
    ],
    edges: [{ data: { id: "e_line", source: "line_caller", target: "line_items", kind: "reads" } }],
    stats: {},
  },
)!;
assert.ok(newlineHover.includes("**public\\.line items**"), "hover titles flatten newlines");
assert.ok(
  newlineHover.includes("← read by `public.uses line()`"),
  "hover relationship code spans flatten newlines",
);
assert.doesNotMatch(newlineHover, /public\.line\r?\nitems/, "title newlines cannot break hover markdown");

// hover null when the anchor never resolved
assert.equal(hoverMarkdown(ambiguous[0]!, graph), null, "no hover for an unresolved anchor");

// graph === null → anchors still built, nothing resolved
const bare = buildLensAnchors(entries, null);
assert.equal(bare.length, 9, "anchors built even without a graph");
assert.ok(
  bare.every((a) => a.graphId === undefined && a.summary === undefined),
  "no graph → nothing resolved",
);

console.log(`lenses OK — ${anchors.length} anchors, ambiguity + edge-count summaries + hover`);
