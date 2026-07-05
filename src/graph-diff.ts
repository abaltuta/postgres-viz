import type { GraphEdgeData, GraphNodeData, GraphPayload } from "./types";

export interface GraphSnapshot {
  savedAt: number;
  database: string;
  graph: GraphPayload;
}

export interface GraphDiff {
  addedNodes: GraphNodeData[];
  removedNodes: GraphNodeData[];
  changedNodes: { before: GraphNodeData; after: GraphNodeData }[];
  addedEdges: GraphEdgeData[];
  removedEdges: GraphEdgeData[];
  changedEdges: { before: GraphEdgeData; after: GraphEdgeData }[];
}

export function diffGraphs(before: GraphPayload, after: GraphPayload): GraphDiff {
  const beforeNodes = dataById(before.nodes);
  const afterNodes = dataById(after.nodes);
  const beforeEdges = dataById(before.edges);
  const afterEdges = dataById(after.edges);

  return {
    addedNodes: missingFrom(afterNodes, beforeNodes).sort(compareNode),
    removedNodes: missingFrom(beforeNodes, afterNodes).sort(compareNode),
    changedNodes: changed(beforeNodes, afterNodes, nodeComparable).sort((a, b) =>
      compareNode(a.after, b.after),
    ),
    addedEdges: missingFrom(afterEdges, beforeEdges).sort(compareEdge),
    removedEdges: missingFrom(beforeEdges, afterEdges).sort(compareEdge),
    changedEdges: changed(beforeEdges, afterEdges, edgeComparable).sort((a, b) =>
      compareEdge(a.after, b.after),
    ),
  };
}

function dataById<T extends { id: string }>(items: Array<{ data: T }>): Map<string, T> {
  return new Map(items.map(({ data }) => [data.id, data]));
}

function missingFrom<T extends { id: string }>(source: Map<string, T>, other: Map<string, T>): T[] {
  return [...source.values()].filter((item) => !other.has(item.id));
}

export function buildGraphDiffReport(snapshot: GraphSnapshot, current: GraphPayload): string {
  const diff = diffGraphs(snapshot.graph, current);
  let snapshotSaved: string;
  try {
    snapshotSaved = new Date(snapshot.savedAt).toISOString();
  } catch {
    snapshotSaved = `${snapshot.savedAt} (invalid date)`;
  }
  const changedNodes = markdownList(
    diff.changedNodes,
    (c) =>
      `- ${formatNodeLabel(c.after)} (${escapeMarkdownText(c.after.id)}) - ${changedFields(c.before, c.after, nodeComparable)}`,
  );
  const changedEdges = markdownList(
    diff.changedEdges,
    (c) => `- ${formatEdgeLabel(c.after)} - ${changedFields(c.before, c.after, edgeComparable)}`,
  );
  return `# Graph Snapshot Diff

- Snapshot database: ${escapeMarkdownText(snapshot.database)}
- Snapshot saved: ${snapshotSaved}

## Summary

- Added nodes: ${diff.addedNodes.length}
- Removed nodes: ${diff.removedNodes.length}
- Changed nodes: ${diff.changedNodes.length}
- Added edges: ${diff.addedEdges.length}
- Removed edges: ${diff.removedEdges.length}
- Changed edges: ${diff.changedEdges.length}

## Added Nodes

${nodeList(diff.addedNodes)}

## Removed Nodes

${nodeList(diff.removedNodes)}

## Changed Nodes

${changedNodes}

## Added Edges

${edgeList(diff.addedEdges)}

## Removed Edges

${edgeList(diff.removedEdges)}

## Changed Edges

${changedEdges}
`;
}

function changed<T extends { id: string }>(
  before: Map<string, T>,
  after: Map<string, T>,
  comparable: (value: T) => Record<string, unknown>,
): { before: T; after: T }[] {
  const out: { before: T; after: T }[] = [];
  for (const [id, next] of after) {
    const prev = before.get(id);
    if (prev && !sameValue(comparable(prev), comparable(next))) {
      out.push({ before: prev, after: next });
    }
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function nodeComparable(n: GraphNodeData): Record<string, unknown> {
  return {
    label: n.label,
    type: n.type,
    parent: n.parent,
    schema: n.schema,
    schemaParent: n.schemaParent,
    detail: n.detail,
    oid: n.oid,
    ord: n.ord,
  };
}

function edgeComparable(e: GraphEdgeData): Record<string, unknown> {
  return {
    source: e.source,
    target: e.target,
    kind: e.kind,
    label: e.label,
    detail: e.detail,
    agg: e.agg,
    count: e.count,
  };
}

function nodeList(nodes: GraphNodeData[]): string {
  return markdownList(nodes, (n) => `- ${formatNodeLabel(n)} (${escapeMarkdownText(n.id)})`);
}

function edgeList(edges: GraphEdgeData[]): string {
  return markdownList(edges, (e) => `- ${formatEdgeLabel(e)}`);
}

function markdownList<T>(items: T[], format: (item: T) => string): string {
  return items.length ? items.map(format).join("\n") : "_None._";
}

function changedFields<T>(
  before: T,
  after: T,
  comparable: (value: T) => Record<string, unknown>,
): string {
  const prev = comparable(before);
  const next = comparable(after);
  return [...new Set([...Object.keys(prev), ...Object.keys(next)])]
    .filter((key) => !sameValue(prev[key], next[key]))
    .map((key) => `${key}: ${formatValue(prev[key])} -> ${formatValue(next[key])}`)
    .join("; ");
}

function formatValue(value: unknown): string {
  return value === undefined ? "unset" : escapeMarkdownText(JSON.stringify(value) ?? String(value));
}

function nodeLabel(n: GraphNodeData): string {
  if (n.type === "schema") return `${n.label} [${n.type}]`;
  return `${n.schema ? `${n.schema}.` : ""}${n.label} [${n.type}]`;
}

function edgeLabel(e: GraphEdgeData): string {
  const flags = edgeFlags(e);
  return `${e.source} --${e.kind}--> ${e.target}${flags ? ` (${flags})` : ""}`;
}

function edgeFlags(e: GraphEdgeData): string {
  return [e.detail ? "detail" : "", e.agg ? "agg" : "", e.count ? `x${e.count}` : ""]
    .filter(Boolean)
    .join(", ");
}

function formatNodeLabel(n: GraphNodeData): string {
  return escapeMarkdownText(nodeLabel(n));
}

function formatEdgeLabel(e: GraphEdgeData): string {
  const flags = edgeFlags(e);
  return (
    `${escapeMarkdownText(e.source)} --${escapeMarkdownText(e.kind)}--> ` +
    `${escapeMarkdownText(e.target)}${flags ? ` (${escapeMarkdownText(flags)})` : ""}`
  );
}

const MARKDOWN_TEXT_CONTROL_CHARS = new RegExp(String.raw`[\u0000-\u001F\u007F\u2028\u2029]+`, "g");
const MARKDOWN_TEXT_SPECIAL_CHARS = /[\\`*[\]<>]/g;

function escapeMarkdownText(value: string): string {
  return value
    .replace(MARKDOWN_TEXT_CONTROL_CHARS, " ")
    .replace(MARKDOWN_TEXT_SPECIAL_CHARS, "\\$&");
}

function compareNode(a: GraphNodeData, b: GraphNodeData): number {
  return nodeLabel(a).localeCompare(nodeLabel(b)) || a.id.localeCompare(b.id);
}

function compareEdge(a: GraphEdgeData, b: GraphEdgeData): number {
  return edgeLabel(a).localeCompare(edgeLabel(b)) || a.id.localeCompare(b.id);
}
