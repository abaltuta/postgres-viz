/**
 * PURE CodeLens/Hover logic — no `vscode`, no I/O. Turns parsed HCL symbols
 * into anchors resolved against the graph, plus the markdown for a hover.
 * The thin provider classes in `src/lens-providers.ts` wrap these.
 */
import type { HclEntry } from "./hcl";
import { routineNameFromLabel } from "./routine-label";
import type { GraphEdgeData, GraphNodeData, GraphPayload } from "./types";

export interface LensAnchor {
  line: number;
  col: number;
  kind: string;
  name: string;
  schema?: string;
  graphId?: string;
  nodeType?: string;
  canCallTree: boolean;
  summary?: string;
}

/** Top-level HCL kinds that get an anchor — `schema` is intentionally excluded. */
const ANCHOR_KINDS = new Set(["table", "view", "materialized", "function", "procedure", "trigger"]);

type Node = GraphNodeData;

/** Outgoing kinds are read verbatim; incoming ones are phrased as "<kind> by". */
const INCOMING_PHRASE: Partial<Record<string, string>> = {
  reads: "read by",
  selects: "selected by",
  inserts: "inserted by",
  updates: "updated by",
  deletes: "deleted by",
  writes: "written by",
  modifies: "modified by",
  calls: "called by",
  executes: "executed by",
};

const EDGE_KIND_ORDER = [
  "selects",
  "reads",
  "inserts",
  "updates",
  "deletes",
  "writes",
  "modifies",
  "calls",
  "executes",
  "update-of",
  "fk",
  "constrains",
  "indexes",
  "default",
];

function nodes(graph: GraphPayload): Node[] {
  return graph.nodes.map((n) => n.data);
}

function unique<T>(items: T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

/**
 * Resolve a table-ish anchor to a graph node by label, honouring the schema.
 * When the entry has no schema and the label is claimed by more than one
 * schema, we refuse to guess — returning undefined (mirrors hcl.ts ambiguity).
 */
function resolveByLabel(list: Node[], label: string, schema: string | undefined): Node | undefined {
  const hits = list.filter((n) => n.label === label && (schema === undefined || n.schema === schema));
  return unique(hits);
}

function resolveByRoutineName(
  list: Node[],
  name: string,
  schema: string | undefined,
): Node | undefined {
  const hits = list.filter(
    (n) =>
      routineNameFromLabel(n.label) === name && (schema === undefined || n.schema === schema),
  );
  return unique(hits);
}

function resolveNode(entry: HclEntry, graph: GraphPayload): Node | undefined {
  const all = nodes(graph);
  const byType = (type: string): Node[] => all.filter((n) => n.type === type);
  switch (entry.kind) {
    case "table": {
      const tables = all.filter((n) => n.type === "table" || n.type === "foreign");
      return resolveByLabel(tables, entry.name, entry.schema);
    }
    case "view":
      return resolveByLabel(byType("view"), entry.name, entry.schema);
    case "materialized": {
      return (
        resolveByLabel(byType("matview"), entry.name, entry.schema) ??
        resolveByLabel(byType("view"), entry.name, entry.schema)
      );
    }
    case "function":
    case "procedure":
      return resolveByRoutineName(byType("function"), entry.name, entry.schema);
    case "trigger": {
      let triggers = all.filter(
        (n) =>
          n.type === "trigger" &&
          n.label === entry.name &&
          (entry.schema === undefined || n.schema === entry.schema),
      );
      if (entry.owner) {
        const owner = entry.owner;
        triggers = triggers.filter(
          (n) => all.find((parent) => parent.id === n.parent)?.label === owner,
        );
      }
      return unique(triggers);
    }
    default:
      return undefined;
  }
}

/** Card-level edges = the ones WITHOUT detail:true. */
function cardEdges(graph: GraphPayload): GraphEdgeData[] {
  return graph.edges.map((e) => e.data).filter((e) => e.detail !== true);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function kindRank(kind: string): number {
  const idx = EDGE_KIND_ORDER.indexOf(kind);
  return idx < 0 ? Number.MAX_SAFE_INTEGER : idx;
}

function cmpKind(a: string, b: string): number {
  return kindRank(a) - kindRank(b) || cmp(a, b);
}

function buildSummary(graph: GraphPayload, nodeId: string): string | undefined {
  const segs: string[] = [];
  const out = new Map<string, number>();
  const inc = new Map<string, number>();
  for (const e of cardEdges(graph)) {
    if (e.source === nodeId) out.set(e.kind, (out.get(e.kind) ?? 0) + 1);
    else if (e.target === nodeId) inc.set(e.kind, (inc.get(e.kind) ?? 0) + 1);
  }
  for (const [kind, n] of [...out].sort(([a], [b]) => cmpKind(a, b))) segs.push(`${kind} ${n}`);
  for (const [kind, n] of [...inc].sort(([a], [b]) => cmpKind(a, b))) {
    segs.push(`${INCOMING_PHRASE[kind] ?? `${kind} by`} ${n}`);
  }
  if (segs.length === 0) return undefined;
  if (segs.length > 4) return [...segs.slice(0, 4), "…"].join(" · ");
  return segs.join(" · ");
}

export function buildLensAnchors(entries: HclEntry[], graph: GraphPayload | null): LensAnchor[] {
  const out: LensAnchor[] = [];
  for (const e of entries) {
    if (!ANCHOR_KINDS.has(e.kind)) continue;
    const anchor: LensAnchor = {
      line: e.line,
      col: e.col,
      kind: e.kind,
      name: e.name,
      schema: e.schema,
      canCallTree: false,
    };
    const node = graph ? resolveNode(e, graph) : undefined;
    if (node && graph) {
      anchor.graphId = node.id;
      anchor.nodeType = node.type;
      anchor.canCallTree = node.type === "function" || node.type === "trigger";
      anchor.summary = buildSummary(graph, node.id);
    }
    out.push(anchor);
  }
  return out;
}

/** A row endpoint (column/trigger/constraint/index) reads best as its card. */
function endpointLabel(nodeMap: Map<string, Node>, id: string): string | undefined {
  const node = nodeMap.get(id);
  if (!node) return undefined;
  if (node.parent) {
    const card = nodeMap.get(node.parent);
    if (card) return qualify(card);
  }
  return qualify(node);
}

function qualify(node: Node): string {
  return node.schema ? `${node.schema}.${node.label}` : node.label;
}

const MARKDOWN_SPECIALS = new Set(["\\", "`", "*", "_", "{", "}", "[", "]", "(", ")", "#", "+", "-", ".", "!", "|"]);

function oneLine(text: string): string {
  return text.replace(/\r\n?|\n/g, " ");
}

function escapeMarkdownText(text: string): string {
  const htmlEscaped = oneLine(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  let out = "";
  for (const ch of htmlEscaped) out += MARKDOWN_SPECIALS.has(ch) ? `\\${ch}` : ch;
  return out;
}

function codeSpan(text: string): string {
  const safeText = oneLine(text);
  const maxTicks = Math.max(0, ...Array.from(safeText.matchAll(/`+/g), (m) => m[0]!.length));
  const fence = "`".repeat(maxTicks + 1);
  const body = safeText.startsWith("`") || safeText.endsWith("`") ? ` ${safeText} ` : safeText;
  return `${fence}${body}${fence}`;
}

export function hoverMarkdown(anchor: LensAnchor, graph: GraphPayload): string | null {
  if (!anchor.graphId) return null;
  const nodeMap = new Map(nodes(graph).map((n) => [n.id, n]));
  const self = nodeMap.get(anchor.graphId);
  const title = self ? qualify(self) : anchor.name;
  const heading = `**${escapeMarkdownText(title)}** — ${escapeMarkdownText(anchor.nodeType ?? anchor.kind)}`;

  const lines: { direction: number; kind: string; endpoint: string; text: string }[] = [];
  for (const e of cardEdges(graph)) {
    if (e.source === anchor.graphId) {
      const other = endpointLabel(nodeMap, e.target);
      if (other) {
        lines.push({
          direction: 0,
          kind: e.kind,
          endpoint: other,
          text: `→ ${escapeMarkdownText(e.kind)} ${codeSpan(other)}`,
        });
      }
    } else if (e.target === anchor.graphId) {
      const other = endpointLabel(nodeMap, e.source);
      if (other) {
        lines.push({
          direction: 1,
          kind: e.kind,
          endpoint: other,
          text: `← ${escapeMarkdownText(INCOMING_PHRASE[e.kind] ?? `${e.kind} by`)} ${codeSpan(other)}`,
        });
      }
    }
  }

  lines.sort(
    (a, b) =>
      a.direction - b.direction || cmpKind(a.kind, b.kind) || cmp(a.endpoint, b.endpoint),
  );
  const shown = lines.slice(0, 8).map((line) => line.text);
  const body = shown.length > 0 ? shown.join("\n\n") : "_no card-level relationships_";
  const more = lines.length > 8 ? `\n\n… and ${lines.length - 8} more` : "";
  return `${heading}\n\n${body}${more}`;
}
