import assert from "node:assert/strict";
import { buildGraphDiffReport, diffGraphs, type GraphSnapshot } from "../src/graph-diff";
import type { GraphPayload } from "../src/types";

const before: GraphPayload = {
  nodes: [
    { data: { id: "r1", label: "orders", type: "table", schema: "public", oid: 1 } },
    { data: { id: "r2", label: "customers", type: "table", schema: "public", oid: 2 } },
    { data: { id: "f1", label: "log_order()", type: "function", schema: "public", oid: 3 } },
    { data: { id: "s1", label: "public", type: "schema", schema: "public", oid: 0 } },
    { data: { id: "c1", label: "total", type: "column", schema: "public", oid: 1, ord: 2 } },
  ],
  edges: [
    { data: { id: "e1", source: "f1", target: "r1", kind: "reads" } },
    { data: { id: "e2", source: "f1", target: "r2", kind: "updates", agg: true, count: 1 } },
  ],
  stats: {},
};

const after: GraphPayload = {
  nodes: [
    { data: { id: "r1", label: "orders_v2", type: "table", schema: "public", oid: 1 } },
    { data: { id: "r2", label: "customers", type: "table", schema: "public", oid: 2 } },
    { data: { id: "f2", label: "notify_stats()", type: "function", schema: "public", oid: 4 } },
    { data: { id: "s1", label: "public", type: "schema", schema: "public", oid: 0 } },
    { data: { id: "c1", label: "total", type: "column", schema: "public", oid: 1, ord: 1 } },
  ],
  edges: [
    { data: { id: "e1", source: "f2", target: "r1", kind: "reads" } },
    { data: { id: "e3", source: "f2", target: "r2", kind: "calls" } },
  ],
  stats: {},
};

const diff = diffGraphs(before, after);
assert.deepEqual(diff.addedNodes.map((n) => n.id), ["f2"], "added node");
assert.deepEqual(diff.removedNodes.map((n) => n.id), ["f1"], "removed node");
assert.deepEqual(diff.changedNodes.map((n) => n.after.id), ["r1", "c1"], "changed nodes");
assert.deepEqual(diff.addedEdges.map((e) => e.id), ["e3"], "added edge");
assert.deepEqual(diff.removedEdges.map((e) => e.id), ["e2"], "removed edge");
assert.deepEqual(diff.changedEdges.map((e) => e.after.id), ["e1"], "changed edge");

const snapshot: GraphSnapshot = {
  savedAt: Date.UTC(2026, 6, 2),
  database: "postgres",
  graph: before,
};
const report = buildGraphDiffReport(snapshot, after);
assert.match(report, /Added nodes: 1/, "summary includes added nodes");
assert.match(report, /Removed edges: 1/, "summary includes removed edges");
assert.match(report, /public\.orders_v2 \\\[table\\\]/, "changed node appears");
assert.match(report, /label: "orders" -> "orders_v2"/, "changed node field appears");
assert.match(report, /public\.total \\\[column\\\].*ord: 2 -> 1/, "changed row order appears");
assert.doesNotMatch(report, /public\.public \[schema\]/, "schema nodes are not double-qualified");
assert.match(report, /source: "f1" -> "f2"/, "changed edge field appears");
assert.match(report, /f2 --calls--> r2/, "added edge appears");

const markdownReport = buildGraphDiffReport(
  {
    savedAt: Date.UTC(2026, 6, 2),
    database: "db*name",
    graph: {
      nodes: [{ data: { id: "r*old", label: "old_*[table]", type: "table", schema: "public", oid: 1 } }],
      edges: [],
      stats: {},
    },
  },
  {
    nodes: [{ data: { id: "r*old", label: "new_*[table]", type: "table", schema: "public", oid: 1 } }],
    edges: [{ data: { id: "e*1", source: "r*old", target: "r*old", kind: "reads" } }],
    stats: {},
  },
);
assert.ok(markdownReport.includes("db\\*name"), "snapshot database is markdown-escaped");
assert.ok(markdownReport.includes("public.new_\\*\\[table\\]"), "node labels are markdown-escaped");
assert.ok(
  markdownReport.includes('label: "old_\\*\\[table\\]" -> "new_\\*\\[table\\]"'),
  "changed string values are markdown-escaped",
);
assert.ok(markdownReport.includes("r\\*old --reads--> r\\*old"), "edge endpoint ids are markdown-escaped");

const newlineReport = buildGraphDiffReport(
  {
    savedAt: Date.UTC(2026, 6, 2),
    database: "db\nname",
    graph: {
      nodes: [{ data: { id: "r\nold", label: "old\nname", type: "table", schema: "public", oid: 1 } }],
      edges: [],
      stats: {},
    },
  },
  {
    nodes: [{ data: { id: "r\nold", label: "new\nname", type: "table", schema: "public", oid: 1 } }],
    edges: [{ data: { id: "e\n1", source: "r\nold", target: "r\nold", kind: "reads" } }],
    stats: {},
  },
);
assert.ok(newlineReport.includes("- Snapshot database: db name"), "database newlines are flattened");
assert.ok(newlineReport.includes("public.new name"), "node label newlines are flattened");
assert.ok(newlineReport.includes("(r old)"), "node id newlines are flattened");
assert.ok(newlineReport.includes("r old --reads--> r old"), "edge endpoint newlines are flattened");
assert.doesNotMatch(
  newlineReport,
  /Snapshot database: db\r?\nname/,
  "database newlines cannot break report metadata",
);

const controlReport = buildGraphDiffReport(
  {
    savedAt: Date.UTC(2026, 6, 2),
    database: "db\u0000name\twith\u2028separator",
    graph: {
      nodes: [{ data: { id: "r\u0007old", label: "old\u000bname", type: "table", schema: "public", oid: 1 } }],
      edges: [],
      stats: {},
    },
  },
  {
    nodes: [{ data: { id: "r\u0007old", label: "new\u000cname", type: "table", schema: "public", oid: 1 } }],
    edges: [{ data: { id: "e\u00081", source: "r\u0007old", target: "r\u0007old", kind: "reads" } }],
    stats: {},
  },
);
const NON_NEWLINE_CONTROL_CHARS = new RegExp(
  String.raw`[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]`,
);
assert.ok(
  controlReport.includes("- Snapshot database: db name with separator"),
  "database control characters are flattened",
);
assert.ok(controlReport.includes("public.new name"), "node label control characters are flattened");
assert.ok(controlReport.includes("(r old)"), "node id control characters are flattened");
assert.ok(controlReport.includes("r old --reads--> r old"), "edge endpoint control characters are flattened");
assert.equal(
  NON_NEWLINE_CONTROL_CHARS.test(controlReport),
  false,
  "report values do not retain non-newline control characters",
);

const invalidDateReport = buildGraphDiffReport(
  {
    savedAt: Number.MAX_VALUE,
    database: "postgres",
    graph: before,
  },
  after,
);
assert.match(
  invalidDateReport,
  /Snapshot saved: 1\.7976931348623157e\+308 \(invalid date\)/,
  "out-of-range finite snapshot dates do not break diff reports",
);

console.log("graph-diff OK — snapshot added/removed/changed report");
