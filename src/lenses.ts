/**
 * PURE CodeLens/Hover logic — no `vscode`, no I/O. Turns parsed HCL symbols
 * into anchors resolved against the graph, plus the markdown for a hover.
 * The thin provider classes in `src/lens-providers.ts` wrap these.
 */
import type { HclEntry } from "./hcl";
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

function nodes(graph: GraphPayload): Node[] {
  return graph.nodes.map((n) => n.data);
}

/**
 * Resolve a table-ish anchor to a graph node by label, honouring the schema.
 * When the entry has no schema and the label is claimed by more than one
 * schema, we refuse to guess — returning undefined (mirrors hcl.ts ambiguity).
 */
function resolveByLabel(list: Node[], label: string, schema: string | undefined): Node | undefined {
  const hits = list.filter((n) => n.label === label);
  if (hits.length === 0) return undefined;
  if (schema !== undefined) return hits.find((n) => n.schema === schema);
  return hits.length === 1 ? hits[0] : undefined;
}

function resolveNode(entry: HclEntry, graph: GraphPayload): Node | undefined {
  const all = nodes(graph);
  switch (entry.kind) {
    case "table": {
      const tables = all.filter((n) => n.type === "table" || n.type === "foreign");
      return resolveByLabel(tables, entry.name, entry.schema);
    }
    case "view":
      return resolveByLabel(
        all.filter((n) => n.type === "view"),
        entry.name,
        entry.schema,
      );
    case "materialized": {
      const mat = all.filter((n) => n.type === "matview");
      return (
        resolveByLabel(mat, entry.name, entry.schema) ??
        resolveByLabel(
          all.filter((n) => n.type === "view"),
          entry.name,
          entry.schema,
        )
      );
    }
    case "function":
    case "procedure":
      return resolveByLabel(
        all.filter((n) => n.type === "function"),
        `${entry.name}()`,
        entry.schema,
      );
    case "trigger": {
      const trg = resolveByLabel(
        all.filter((n) => n.type === "trigger"),
        entry.name,
        entry.schema,
      );
      if (!trg) return undefined;
      // owner sanity: the trigger's parent card must be the table it lives on
      if (entry.owner) {
        const parent = all.find((n) => n.id === trg.parent);
        if (parent && parent.label !== entry.owner) return undefined;
      }
      return trg;
    }
    default:
      return undefined;
  }
}

/** Card-level edges = the ones WITHOUT detail:true. */
function cardEdges(graph: GraphPayload): GraphEdgeData[] {
  return graph.edges.map((e) => e.data).filter((e) => e.detail !== true);
}

function buildSummary(graph: GraphPayload, nodeId: string): string | undefined {
  const segs: string[] = [];
  const out = new Map<string, number>();
  const inc = new Map<string, number>();
  for (const e of cardEdges(graph)) {
    if (e.source === nodeId) out.set(e.kind, (out.get(e.kind) ?? 0) + 1);
    else if (e.target === nodeId) inc.set(e.kind, (inc.get(e.kind) ?? 0) + 1);
  }
  for (const [kind, n] of out) segs.push(`${kind} ${n}`);
  for (const [kind, n] of inc) segs.push(`${INCOMING_PHRASE[kind] ?? `${kind} by`} ${n}`);
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

export function hoverMarkdown(anchor: LensAnchor, graph: GraphPayload): string | null {
  if (!anchor.graphId) return null;
  const nodeMap = new Map(nodes(graph).map((n) => [n.id, n]));
  const self = nodeMap.get(anchor.graphId);
  const title = self ? qualify(self) : anchor.name;
  const heading = `**${title}** — ${anchor.nodeType ?? anchor.kind}`;

  const lines: string[] = [];
  for (const e of cardEdges(graph)) {
    if (e.source === anchor.graphId) {
      const other = endpointLabel(nodeMap, e.target);
      if (other) lines.push(`→ ${e.kind} \`${other}\``);
    } else if (e.target === anchor.graphId) {
      const other = endpointLabel(nodeMap, e.source);
      if (other) lines.push(`← ${INCOMING_PHRASE[e.kind] ?? `${e.kind} by`} \`${other}\``);
    }
  }

  const shown = lines.slice(0, 8);
  const body = shown.length > 0 ? shown.join("\n\n") : "_no card-level relationships_";
  const more = lines.length > 8 ? `\n\n… and ${lines.length - 8} more` : "";
  return `${heading}\n\n${body}${more}`;
}
