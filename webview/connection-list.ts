import type { Core, EdgeSingular, NodeSingular } from "cytoscape";
import type { Prefs } from "../src/protocol";
import type { EdgeKind, GraphEdgeData, GraphNodeData } from "../src/types";
import { edgeShownByClasses, type EdgeDef, type NodeDef, ROW_TYPES } from "./cytoscape-adapter";

const PAGE_SIZE = 40;

const PASSIVE_KIND: Readonly<Record<string, string>> = {
  calls: "called by",
  executes: "executed by",
  reads: "read by",
  inserts: "inserted by",
  updates: "updated by",
  deletes: "deleted by",
  writes: "written by",
  modifies: "modified by",
  selects: "selected by",
  fk: "referenced by",
  constrains: "constrained by",
  indexes: "indexed by",
  "update-of": "update-of by",
  default: "default of",
};

interface ConnectionGroup {
  outgoing: boolean;
  other: NodeSingular;
  display: string;
  type: string;
  color: string;
  kinds: Set<string>;
  members: Set<string>;
}

export interface ConnectionListOptions {
  root: {
    addEventListener(type: string, listener: (event: { target: unknown }) => void): void;
  };
  graph: () => Core | null;
  prefs: () => Prefs;
  edgeColors: Readonly<Record<string, string>>;
  detailEdgesByCard: ReadonlyMap<string, readonly EdgeDef[]>;
  nodeDefById: ReadonlyMap<string, NodeDef>;
  cardOfNode: ReadonlyMap<string, string>;
  isShown: (node: NodeSingular) => boolean;
  onSelect: (node: NodeSingular) => void;
  onPage: (html: string) => void;
}

export class ConnectionList {
  private readonly membersByAggregate = new Map<string, string[]>();
  private nodeId = "";
  private outLimit = PAGE_SIZE;
  private inLimit = PAGE_SIZE;
  private outgoing: ConnectionGroup[] = [];
  private incoming: ConnectionGroup[] = [];

  constructor(private readonly options: ConnectionListOptions) {
    options.root.addEventListener("click", (event) => {
      const target = event.target;
      if (
        typeof target !== "object" ||
        target === null ||
        !("closest" in target) ||
        typeof target.closest !== "function"
      ) {
        return;
      }
      const button = target.closest("button[data-connection-node], button[data-more]") as {
        dataset: Record<string, string | undefined>;
      } | null;
      if (!button) return;
      const graph = this.options.graph();
      if (!graph) return;
      const current = graph.getElementById(this.nodeId);
      if (current.empty()) return;
      if (button.dataset.more === "out") {
        this.outLimit += PAGE_SIZE;
        this.options.onPage(this.renderCached());
        return;
      }
      if (button.dataset.more === "in") {
        this.inLimit += PAGE_SIZE;
        this.options.onPage(this.renderCached());
        return;
      }
      const other = graph.getElementById(button.dataset.connectionNode ?? "");
      if (other.nonempty() && this.options.isShown(other as unknown as NodeSingular)) {
        this.options.onSelect(other as unknown as NodeSingular);
      }
    });
  }

  reindex(): void {
    this.membersByAggregate.clear();
    this.nodeId = "";
    this.outgoing = [];
    this.incoming = [];
    const seen = new Set<string>();
    for (const edges of this.options.detailEdgesByCard.values()) {
      for (const edge of edges) {
        const { id, source, target, kind } = edge.data;
        const edgeId = id || `${kind}|${source}|${target}`;
        if (seen.has(edgeId)) continue;
        seen.add(edgeId);
        const sourceDef = this.options.nodeDefById.get(source);
        const targetDef = this.options.nodeDefById.get(target);
        const sourceIsRow = Boolean(sourceDef && ROW_TYPES.has(sourceDef.data.type));
        const targetIsRow = Boolean(targetDef && ROW_TYPES.has(targetDef.data.type));
        if (!sourceIsRow && !targetIsRow) continue;
        const sourceUnit = this.options.cardOfNode.get(source) ?? source;
        const targetUnit = this.options.cardOfNode.get(target) ?? target;
        const key = this.aggregateKey(sourceUnit, targetUnit, kind);
        const sourceLabel = String(sourceDef?.data.label ?? source);
        const targetLabel = String(targetDef?.data.label ?? target);
        const label =
          sourceIsRow && targetIsRow
            ? `${sourceLabel}->${targetLabel}`
            : sourceIsRow
              ? sourceLabel
              : targetLabel;
        const members = this.membersByAggregate.get(key);
        if (members) members.push(label);
        else this.membersByAggregate.set(key, [label]);
      }
    }
  }

  render(node: NodeSingular): string {
    if (node.id() !== this.nodeId) {
      this.nodeId = node.id();
      this.outLimit = PAGE_SIZE;
      this.inLimit = PAGE_SIZE;
    }
    const prefs = this.options.prefs();
    const isRow = this.options.cardOfNode.has(node.id());
    const scope = isRow ? node : node.union(node.descendants());
    const edges = (isRow ? node.connectedEdges("[!agg]") : scope.connectedEdges("[?agg]")).filter(
      (edge) => edgeShownByClasses(edge as EdgeSingular),
    );
    const groups = new Map<string, ConnectionGroup>();
    edges.forEach((edge: EdgeSingular) => {
      const data = edge.data() as GraphEdgeData;
      const outgoing = scope.contains(edge.source());
      const other = (outgoing ? edge.target() : edge.source()) as NodeSingular;
      const otherData = other.data() as GraphNodeData;
      const owner = ROW_TYPES.has(otherData.type)
        ? String(other.parent().first().data("label") ?? "")
        : "";
      const display = owner ? `${owner}.${otherData.label}` : otherData.label;
      const groupKey = `${outgoing ? "out" : "in"}\0${other.id()}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          outgoing,
          other,
          display,
          type: otherData.type,
          color: data.agg ? "#8993A4" : (this.options.edgeColors[data.kind] ?? "#8993A4"),
          kinds: new Set(),
          members: new Set(),
        };
        groups.set(groupKey, group);
      }
      const kindCounts = data.kinds ?? { [data.kind]: data.count ?? 1 };
      for (const [kind, count] of Object.entries(kindCounts)) {
        if (prefs.filterEdgeKinds.length > 0 && !prefs.filterEdgeKinds.includes(kind as EdgeKind)) {
          continue;
        }
        const label = outgoing ? kind : (PASSIVE_KIND[kind] ?? `${kind} by`);
        group.kinds.add(`${label}${count > 1 ? ` x${count}` : ""}`);
        if (data.agg) {
          const members = this.memberLabels(data.source, data.target, kind);
          if (members) group.members.add(`${label}: ${members}`);
        }
      }
    });
    const sorted = [...groups.values()].sort(
      (a, b) =>
        Number(b.outgoing) - Number(a.outgoing) ||
        a.display.localeCompare(b.display) ||
        a.type.localeCompare(b.type),
    );
    this.outgoing = sorted.filter((group) => group.outgoing);
    this.incoming = sorted.filter((group) => !group.outgoing);
    return `<div id="connection-sections">${this.renderCached()}</div>`;
  }

  private aggregateKey(source: string, target: string, kind: string): string {
    return `${source}\0${target}\0${kind}`;
  }

  private memberLabels(source: string, target: string, kind: string, max = 6): string {
    const members = this.membersByAggregate.get(this.aggregateKey(source, target, kind)) ?? [];
    const shown = members.slice(0, max).join(", ");
    return members.length > max ? `${shown}, +${members.length - max} more` : shown;
  }

  private renderCached(): string {
    if (this.outgoing.length === 0 && this.incoming.length === 0) {
      return "<h3>No connections</h3>";
    }
    return (
      this.renderDirection("Uses", this.outgoing, this.outLimit, "out") +
      this.renderDirection("Used by", this.incoming, this.inLimit, "in")
    );
  }

  private renderDirection(
    title: string,
    groups: ConnectionGroup[],
    limit: number,
    direction: "out" | "in",
  ): string {
    if (groups.length === 0) return "";
    const rows = groups.slice(0, limit).map((group) => {
      const kinds = [...group.kinds].join(", ");
      const members = [...group.members].join(" | ");
      const label = `${group.outgoing ? "Uses" : "Used by"} ${group.display}: ${kinds}`;
      return `<li><button type="button" class="edge-link" data-connection-node="${escapeHtml(group.other.id())}" aria-label="${escapeHtml(label)}">
        <span class="kind" style="color:${group.color}">${group.outgoing ? "->" : "<-"} ${escapeHtml(kinds)}</span>
        <span class="name">${escapeHtml(group.display)}</span>
        <small>${escapeHtml(group.type)}</small>
        ${members ? `<span class="cols">${escapeHtml(members)}</span>` : ""}
      </button></li>`;
    });
    const remaining = groups.length - Math.min(groups.length, limit);
    if (remaining > 0) {
      rows.push(
        `<li class="more-row"><button type="button" class="show-more" data-more="${direction}">Show ${Math.min(PAGE_SIZE, remaining)} more (${remaining} remaining)</button></li>`,
      );
    }
    return `<details ${groups.length <= 12 ? "open" : ""}><summary>${title} (${groups.length})</summary><ul class="edge-list">${rows.join("")}</ul></details>`;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
