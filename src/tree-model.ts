import type { GraphNodeData, GraphPayload } from "./types";

export interface TreeNode {
  id: string;
  label: string;
  type: string;
  description?: string;
  children: TreeNode[];
  parent?: TreeNode;
  /** graph node id to reveal in the webview (groups have none) */
  graphId?: string;
}

export interface TreeModel {
  roots: TreeNode[];
  byGraphId: Map<string, TreeNode>;
}

const ROWS = new Set(["column", "trigger", "constraint", "index"]);
const UNKNOWN_SCHEMA_LABEL = "(unknown schema)";
const UNKNOWN_SCHEMA_KEY = "\0unknown-schema";
const GROUP_ORDER = new Map([
  ["tables", 0],
  ["views", 1],
  ["materialized views", 2],
  ["foreign tables", 3],
  ["functions", 4],
]);
const GROUP_TITLE: Partial<Record<GraphNodeData["type"], string>> = {
  table: "tables",
  view: "views",
  matview: "materialized views",
  foreign: "foreign tables",
  function: "functions",
};

export function buildTreeModel(graph: GraphPayload): TreeModel {
  const roots: TreeNode[] = [];
  const byGraphId = new Map<string, TreeNode>();
  // schema graph nodes exist in the payload — clicking a schema in the tree
  // focuses that schema in the graph
  const schemaGraphIds = new Map<string, string>();
  const schemaNamesById = new Map<string, string>();
  for (const { data: d } of graph.nodes) {
    if (d.type === "schema") {
      const name = String(d.label);
      schemaGraphIds.set(name, d.id);
      schemaNamesById.set(d.id, name);
    }
  }
  const node = (
    label: string,
    type: string,
    parent: TreeNode | undefined,
    graphId?: string,
    description?: string,
    id?: string,
  ): TreeNode => {
    const n: TreeNode = {
      id: id ?? graphId ?? `grp:${parent?.id ?? ""}:${label}`,
      label,
      type,
      description,
      children: [],
      parent,
      graphId,
    };
    if (parent) parent.children.push(n);
    if (graphId) byGraphId.set(graphId, n);
    return n;
  };
  const bySchema = new Map<string, TreeNode>();
  const relNodes = new Map<string, TreeNode>();
  const rows: GraphNodeData[] = [];
  const schemaKey = (name: string): string => `schema:${name}`;
  const schemaNameOf = (d: GraphNodeData): string | undefined => {
    if (d.schema) return String(d.schema);
    if (d.parent && schemaNamesById.has(d.parent)) return schemaNamesById.get(d.parent)!;
    if (d.schemaParent && schemaNamesById.has(d.schemaParent)) {
      return schemaNamesById.get(d.schemaParent)!;
    }
    return undefined;
  };
  const schemaOf = (d: GraphNodeData): TreeNode => {
    const name = schemaNameOf(d);
    const key = name === undefined ? UNKNOWN_SCHEMA_KEY : schemaKey(name);
    let s = bySchema.get(key);
    if (!s) {
      s = node(
        name ?? UNKNOWN_SCHEMA_LABEL,
        "schema",
        undefined,
        name ? schemaGraphIds.get(name) : undefined,
        undefined,
        name === undefined ? `grp:${UNKNOWN_SCHEMA_KEY}` : undefined,
      );
      bySchema.set(key, s);
      roots.push(s);
    }
    return s;
  };
  for (const [name, graphId] of schemaGraphIds) {
    const key = schemaKey(name);
    if (bySchema.has(key)) continue;
    const s = node(name, "schema", undefined, graphId);
    bySchema.set(key, s);
    roots.push(s);
  }
  const groups = new Map<string, TreeNode>();
  const groupOf = (schema: TreeNode, type: string, title: string): TreeNode => {
    const key = `${schema.id}:${type}`;
    let g = groups.get(key);
    if (!g) {
      g = node(title, "group", schema);
      groups.set(key, g);
    }
    return g;
  };
  const sorted = [...graph.nodes].sort((a, b) => compareGraphNode(a.data, b.data));
  for (const { data: d } of sorted) {
    if (d.type === "schema") continue;
    if (ROWS.has(d.type)) {
      rows.push(d);
      continue;
    }
    const schema = schemaOf(d);
    const title = GROUP_TITLE[d.type];
    if (!title) continue;
    const rel = node(d.label, d.type, groupOf(schema, d.type, title), d.id);
    relNodes.set(d.id, rel);
  }
  for (const d of rows.sort(compareRows)) {
    const parent = relNodes.get(d.parent ?? "");
    if (parent) node(d.label, d.type, parent, d.id, d.detail);
  }
  roots.sort((a, b) => compareText(a.label, b.label));
  for (const schema of roots) {
    schema.children.sort(compareGroups);
    for (const group of schema.children) group.children.sort(compareTreeNode);
  }
  return { roots, byGraphId };
}

function compareGraphNode(a: GraphNodeData, b: GraphNodeData): number {
  return (
    compareText(a.schema, b.schema) ||
    compareText(a.parent, b.parent) ||
    compareNameTypeId(a, b)
  );
}

function compareGroups(a: TreeNode, b: TreeNode): number {
  return (
    (GROUP_ORDER.get(a.label) ?? Number.MAX_SAFE_INTEGER) -
      (GROUP_ORDER.get(b.label) ?? Number.MAX_SAFE_INTEGER) ||
    compareText(a.label, b.label) ||
    compareText(a.id, b.id)
  );
}

function compareTreeNode(a: TreeNode, b: TreeNode): number {
  return compareNameTypeId(a, b);
}

function compareRows(a: GraphNodeData, b: GraphNodeData): number {
  return (
    compareText(a.parent, b.parent) ||
    (a.ord ?? Number.MAX_SAFE_INTEGER) - (b.ord ?? Number.MAX_SAFE_INTEGER) ||
    compareNameTypeId(a, b)
  );
}

function compareNameTypeId(
  a: Pick<TreeNode, "id" | "label" | "type">,
  b: Pick<TreeNode, "id" | "label" | "type">,
): number {
  return compareText(a.label, b.label) || compareText(a.type, b.type) || compareText(a.id, b.id);
}

function compareText(a: unknown, b: unknown): number {
  return String(a ?? "").localeCompare(String(b ?? ""));
}
