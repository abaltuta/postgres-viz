import { GraphIndex, type GraphDirection, type GraphStep } from "./graph-index";
import type { EdgeKind, GraphEdgeData, GraphNodeData, GraphPayload } from "./types";

const ROW_TYPES = new Set<GraphNodeData["type"]>(["column", "trigger", "constraint", "index"]);

interface EdgeReportOptions {
  kinds?: EdgeKind[];
  includeDetail?: boolean;
}

export interface ImpactReportOptions extends EdgeReportOptions {
  rootId: string;
  direction?: Extract<GraphDirection, "out" | "in">;
  maxDepth?: number;
}

export interface PathReportOptions extends EdgeReportOptions {
  sourceId: string;
  targetId: string;
  direction?: GraphDirection;
}

export function nodeDisplayName(index: GraphIndex, nodeOrId: GraphNodeData | string): string {
  const node = typeof nodeOrId === "string" ? index.node(nodeOrId) : nodeOrId;
  if (!node) return String(nodeOrId);
  if (node.type === "schema") return node.label;
  const parent = node.parent ? index.node(node.parent) : undefined;
  const schemaName = node.schema ?? schemaNameFromAncestors(index, parent);
  const schema = schemaName ? `${schemaName}.` : "";
  if (parent && ROW_TYPES.has(node.type)) {
    return `${schema}${parent.label}.${node.label}`;
  }
  return `${schema}${node.label}`;
}

function schemaNameFromAncestors(
  index: GraphIndex,
  node: GraphNodeData | undefined,
): string | undefined {
  const seen = new Set<string>();
  let current = node;
  while (current && !seen.has(current.id)) {
    if (current.schema) return current.schema;
    if (current.type === "schema") return current.label;
    seen.add(current.id);
    current = current.parent ? index.node(current.parent) : undefined;
  }
  return undefined;
}

export function buildImpactReport(graph: GraphPayload, opts: ImpactReportOptions): string {
  const index = new GraphIndex(graph);
  const direction = opts.direction ?? "out";
  const maxDepth = normalizeMaxDepth(opts.maxDepth, 6);
  const impact = index.impact(opts.rootId, {
    direction,
    kinds: opts.kinds,
    maxDepth,
    includeDetail: opts.includeDetail ?? false,
  });
  if (!impact) return `# Impact Analysis\n\nNode not found: ${inlineCode(opts.rootId)}\n`;

  const relation =
    direction === "out"
      ? { title: "Dependencies", arrow: "->", phrase: "depends on" }
      : { title: "Dependents", arrow: "<-", phrase: "is depended on by" };
  const filter = formatEdgeFilter(opts);
  const direct = maxDepth < 1 ? [] : impact.direct;
  const lines = [
    `# ${relation.title}: ${formatNodeName(index, impact.root)}`,
    "",
    `Root ${inlineCode(impact.root.id)} ${relation.phrase} the objects below.`,
    "",
    `Filter: ${filter}; max depth ${maxDepth}.`,
    "",
    "## Direct",
    "",
    ...formatSteps(index, direct, relation.arrow),
    "",
    "## Transitive",
    "",
    ...formatSteps(
      index,
      impact.transitive.filter((step) => step.depth > 1),
      relation.arrow,
    ),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export function buildPathReport(graph: GraphPayload, opts: PathReportOptions): string {
  const index = new GraphIndex(graph);
  const sourceNode = index.node(opts.sourceId);
  const targetNode = index.node(opts.targetId);
  const source = formatNodeName(index, sourceNode ?? opts.sourceId);
  const target = formatNodeName(index, targetNode ?? opts.targetId);
  const title = `# Dependency Path: ${source} -> ${target}`;
  if (!sourceNode || !targetNode) {
    const missing = [
      sourceNode ? undefined : `source ${inlineCode(opts.sourceId)}`,
      targetNode ? undefined : `target ${inlineCode(opts.targetId)}`,
    ]
      .filter((value): value is string => Boolean(value))
      .join(", ");
    return [title, "", `Node not found: ${missing}`, ""].join("\n");
  }
  const direction = opts.direction ?? "out";
  const filter = formatEdgeFilter(opts);
  const path = index.shortestPath(opts.sourceId, opts.targetId, {
    direction,
    kinds: opts.kinds,
    includeDetail: opts.includeDetail ?? false,
  });
  if (!path) {
    return [title, "", `Filter: ${filter}; ${direction} direction.`, "", "No path found.", ""].join(
      "\n",
    );
  }

  const lines = [
    title,
    "",
    `Filter: ${filter}; ${direction} direction.`,
    "",
    `${path.edges.length} edge${path.edges.length === 1 ? "" : "s"} found.`,
    "",
  ];
  for (let i = 0; i < path.edges.length; i++) {
    const edge = path.edges[i]!;
    const from = path.nodes[i]!;
    const to = path.nodes[i + 1]!;
    const arrow =
      edge.source === from.id && edge.target === to.id ? `--${edge.kind}-->` : `<--${edge.kind}--`;
    lines.push(`${i + 1}. ${formatNodeName(index, from)} ${arrow} ${formatNodeName(index, to)}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatSteps(index: GraphIndex, steps: GraphStep[], arrow: string): string[] {
  if (steps.length === 0) return ["_None._"];
  return [...steps]
    .sort((a, b) => compareStep(index, a, b))
    .map(
      (step) =>
        `- depth ${step.depth}: ${formatEdge(step.edge)} ${arrow} ${formatNodeName(index, step.node)}`,
    );
}

function compareStep(index: GraphIndex, a: GraphStep, b: GraphStep): number {
  const aName = nodeDisplayName(index, a.node);
  const bName = nodeDisplayName(index, b.node);
  return (
    a.depth - b.depth ||
    aName.localeCompare(bName) ||
    a.node.id.localeCompare(b.node.id) ||
    a.edge.kind.localeCompare(b.edge.kind) ||
    a.edge.id.localeCompare(b.edge.id)
  );
}

function formatEdgeFilter(opts: EdgeReportOptions): string {
  const level = opts.includeDetail ? "all edge levels" : "card-level edges";
  if (!opts.kinds) return `all ${level}`;
  const uniqueKinds = [...new Set(opts.kinds)];
  return uniqueKinds.length ? uniqueKinds.join(", ") : "no edge kinds";
}

function normalizeMaxDepth(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function formatEdge(edge: GraphEdgeData): string {
  const suffix = edge.count && edge.count > 1 ? ` x${edge.count}` : "";
  return inlineCode(`${edge.kind}${suffix}`);
}

function formatNodeName(index: GraphIndex, nodeOrId: GraphNodeData | string): string {
  return escapeMarkdownText(nodeDisplayName(index, nodeOrId));
}

function escapeMarkdownText(value: string): string {
  return value.replace(/[\\`*[\]<>]/g, "\\$&").replace(/\r\n?|\n/g, " ");
}

function inlineCode(value: string): string {
  const text = String(value).replace(/\r\n?|\n/g, " ");
  const longestTickRun = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(longestTickRun + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}
