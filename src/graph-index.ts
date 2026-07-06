import type { EdgeKind, GraphEdgeData, GraphNodeData, GraphPayload, NodeType } from "./types";

export type GraphDirection = "out" | "in" | "both";

export interface GraphEdgeFilter {
  kinds?: Iterable<EdgeKind>;
  includeDetail?: boolean;
  includeAggregate?: boolean;
}

export interface GraphWalkOptions extends GraphEdgeFilter {
  direction?: GraphDirection;
  maxDepth?: number;
}

type NormalizedGraphEdgeFilter = Omit<GraphEdgeFilter, "kinds"> & {
  kinds?: ReadonlySet<EdgeKind>;
};
interface NormalizedGraphWalkOptions {
  direction: GraphDirection;
  maxDepth: number;
  filter: NormalizedGraphEdgeFilter;
}

export interface GraphStep {
  node: GraphNodeData;
  edge: GraphEdgeData;
  depth: number;
  direction: "out" | "in";
}

export interface GraphPath {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
}

export interface GraphImpact {
  root: GraphNodeData;
  direct: GraphStep[];
  transitive: GraphStep[];
}

const ROW_TYPES = new Set<NodeType>(["column", "trigger", "constraint", "index"]);
const NODE_TYPE_ORDER: Record<NodeType, number> = {
  schema: 0,
  table: 1,
  view: 1,
  matview: 1,
  foreign: 1,
  column: 2,
  trigger: 3,
  constraint: 4,
  index: 5,
  function: 6,
};
const EDGE_KIND_ORDER: EdgeKind[] = [
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

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function normalizeFilter(filter: GraphEdgeFilter): NormalizedGraphEdgeFilter {
  return {
    ...filter,
    kinds: filter.kinds
      ? filter.kinds instanceof Set
        ? filter.kinds
        : new Set(filter.kinds)
      : undefined,
  };
}

function edgeAllowed(edge: GraphEdgeData, filter: NormalizedGraphEdgeFilter): boolean {
  if (filter.kinds && !filter.kinds.has(edge.kind)) return false;
  if (filter.includeDetail === false && edge.detail) return false;
  if (filter.includeAggregate === false && edge.agg) return false;
  return true;
}

function normalizeMaxDepth(maxDepth: number | undefined): number {
  if (maxDepth === undefined) return Number.POSITIVE_INFINITY;
  if (maxDepth === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(maxDepth)) return 0;
  return Math.max(0, Math.floor(maxDepth));
}

function normalizeWalkOptions(options: GraphWalkOptions): NormalizedGraphWalkOptions {
  return {
    direction: options.direction ?? "out",
    maxDepth: normalizeMaxDepth(options.maxDepth),
    filter: normalizeFilter(options),
  };
}

export class GraphIndex {
  readonly graph: GraphPayload;
  readonly nodesById = new Map<string, GraphNodeData>();
  readonly edgesById = new Map<string, GraphEdgeData>();
  readonly nodesByType = new Map<NodeType, GraphNodeData[]>();
  readonly childrenById = new Map<string, GraphNodeData[]>();
  readonly outgoingById = new Map<string, GraphEdgeData[]>();
  readonly incomingById = new Map<string, GraphEdgeData[]>();

  constructor(graph: GraphPayload) {
    this.graph = graph;
    for (const { data } of graph.nodes) {
      this.nodesById.set(data.id, data);
      push(this.nodesByType, data.type, data);
      if (data.parent) push(this.childrenById, data.parent, data);
    }
    for (const { data } of graph.edges) {
      this.edgesById.set(data.id, data);
      push(this.outgoingById, data.source, data);
      push(this.incomingById, data.target, data);
    }
    for (const arr of this.nodesByType.values()) arr.sort(compareNode);
    for (const arr of this.childrenById.values()) arr.sort(compareNode);
    for (const arr of this.outgoingById.values()) arr.sort(compareEdge);
    for (const arr of this.incomingById.values()) arr.sort(compareEdge);
  }

  node(id: string): GraphNodeData | undefined {
    return this.nodesById.get(id);
  }

  edge(id: string): GraphEdgeData | undefined {
    return this.edgesById.get(id);
  }

  nodesOfType(type: NodeType): GraphNodeData[] {
    return [...(this.nodesByType.get(type) ?? [])];
  }

  children(id: string): GraphNodeData[] {
    return [...(this.childrenById.get(id) ?? [])];
  }

  parent(id: string): GraphNodeData | undefined {
    const parentId = this.nodesById.get(id)?.parent;
    return parentId ? this.nodesById.get(parentId) : undefined;
  }

  ancestors(id: string): GraphNodeData[] {
    const out: GraphNodeData[] = [];
    const seen = new Set([id]);
    let current = this.parent(id);
    while (current && !seen.has(current.id)) {
      out.push(current);
      seen.add(current.id);
      current = current.parent ? this.nodesById.get(current.parent) : undefined;
    }
    return out;
  }

  cardId(id: string): string {
    const node = this.nodesById.get(id);
    if (!node) return id;
    if (!ROW_TYPES.has(node.type)) return id;
    return node.parent ?? id;
  }

  card(id: string): GraphNodeData | undefined {
    return this.nodesById.get(this.cardId(id));
  }

  outgoing(id: string, filter: GraphEdgeFilter = {}): GraphEdgeData[] {
    return this.filteredEdges(this.outgoingById, id, filter);
  }

  incoming(id: string, filter: GraphEdgeFilter = {}): GraphEdgeData[] {
    return this.filteredEdges(this.incomingById, id, filter);
  }

  edgesBetween(source: string, target: string, filter: GraphEdgeFilter = {}): GraphEdgeData[] {
    return this.outgoing(source, filter).filter((edge) => edge.target === target);
  }

  cardEdges(filter: GraphEdgeFilter = {}): GraphEdgeData[] {
    const normalized = normalizeFilter(filter);
    return [...this.edgesById.values()]
      .filter((edge) => !edge.detail && edgeAllowed(edge, normalized))
      .sort(compareEdge);
  }

  aggregateMembers(edgeOrId: GraphEdgeData | string): GraphEdgeData[] {
    const edge = this.resolveEdge(edgeOrId);
    if (!edge?.agg) return [];
    return [...this.edgesById.values()]
      .filter(
        (candidate) =>
          candidate.detail === true &&
          candidate.kind === edge.kind &&
          this.cardId(candidate.source) === edge.source &&
          this.cardId(candidate.target) === edge.target,
      )
      .sort(compareEdge);
  }

  aggregateFor(edgeOrId: GraphEdgeData | string): GraphEdgeData | undefined {
    const edge = this.resolveEdge(edgeOrId);
    if (!edge?.detail) return undefined;
    const source = this.cardId(edge.source);
    const target = this.cardId(edge.target);
    return this.edgesBetween(source, target, { kinds: [edge.kind], includeDetail: false }).find(
      (candidate) => candidate.agg,
    );
  }

  reachable(startId: string, options: GraphWalkOptions = {}): GraphStep[] {
    if (!this.nodesById.has(startId)) return [];
    const { direction, filter, maxDepth } = normalizeWalkOptions(options);
    const seen = new Set([startId]);
    const queue: { id: string; depth: number }[] = [{ id: startId, depth: 0 }];
    const out: GraphStep[] = [];

    for (let i = 0; i < queue.length; i++) {
      const current = queue[i]!;
      if (current.depth >= maxDepth) continue;
      for (const step of this.adjacent(current.id, direction, filter)) {
        if (seen.has(step.node.id)) continue;
        seen.add(step.node.id);
        const fullStep = { ...step, depth: current.depth + 1 };
        out.push(fullStep);
        queue.push({ id: step.node.id, depth: fullStep.depth });
      }
    }

    return out;
  }

  shortestPath(sourceId: string, targetId: string, options: GraphWalkOptions = {}): GraphPath | null {
    const source = this.nodesById.get(sourceId);
    const target = this.nodesById.get(targetId);
    if (!source || !target) return null;
    if (sourceId === targetId) return { nodes: [source], edges: [] };

    const { direction, filter, maxDepth } = normalizeWalkOptions(options);
    const seen = new Set([sourceId]);
    const queue: { id: string; depth: number }[] = [{ id: sourceId, depth: 0 }];
    const prev = new Map<string, { from: string; edge: GraphEdgeData }>();

    for (let i = 0; i < queue.length; i++) {
      const current = queue[i]!;
      if (current.depth >= maxDepth) continue;
      for (const step of this.adjacent(current.id, direction, filter)) {
        if (seen.has(step.node.id)) continue;
        seen.add(step.node.id);
        prev.set(step.node.id, { from: current.id, edge: step.edge });
        if (step.node.id === targetId) return this.buildPath(sourceId, targetId, prev);
        queue.push({ id: step.node.id, depth: current.depth + 1 });
      }
    }

    return null;
  }

  impact(rootId: string, options: GraphWalkOptions = {}): GraphImpact | null {
    const root = this.nodesById.get(rootId);
    if (!root) return null;
    const { direction, filter, maxDepth } = normalizeWalkOptions(options);
    const steps = this.reachable(rootId, { ...options, kinds: filter.kinds });
    return {
      root,
      direct:
        maxDepth < 1
          ? []
          : this.adjacent(rootId, direction, filter).map((step) => ({ ...step, depth: 1 })),
      transitive: steps,
    };
  }

  private adjacent(
    id: string,
    direction: GraphDirection,
    filter: NormalizedGraphEdgeFilter,
  ): Omit<GraphStep, "depth">[] {
    const out: Omit<GraphStep, "depth">[] = [];
    if (direction === "out" || direction === "both") {
      for (const edge of this.outgoing(id, filter)) {
        const node = this.nodesById.get(edge.target);
        if (node) out.push({ node, edge, direction: "out" });
      }
    }
    if (direction === "in" || direction === "both") {
      for (const edge of this.incoming(id, filter)) {
        const node = this.nodesById.get(edge.source);
        if (node) out.push({ node, edge, direction: "in" });
      }
    }
    return out;
  }

  private resolveEdge(edgeOrId: GraphEdgeData | string): GraphEdgeData | undefined {
    return typeof edgeOrId === "string" ? this.edge(edgeOrId) : edgeOrId;
  }

  private filteredEdges(
    buckets: Map<string, GraphEdgeData[]>,
    id: string,
    filter: GraphEdgeFilter,
  ): GraphEdgeData[] {
    const normalized = normalizeFilter(filter);
    return (buckets.get(id) ?? []).filter((edge) => edgeAllowed(edge, normalized));
  }

  private buildPath(
    sourceId: string,
    targetId: string,
    prev: Map<string, { from: string; edge: GraphEdgeData }>,
  ): GraphPath | null {
    const nodes: GraphNodeData[] = [];
    const edges: GraphEdgeData[] = [];
    let current = targetId;
    while (current !== sourceId) {
      const hop = prev.get(current);
      const node = this.nodesById.get(current);
      if (!hop || !node) return null;
      nodes.push(node);
      edges.push(hop.edge);
      current = hop.from;
    }
    const source = this.nodesById.get(sourceId);
    if (!source) return null;
    nodes.push(source);
    nodes.reverse();
    edges.reverse();
    return { nodes, edges };
  }
}

function compareNode(a: GraphNodeData, b: GraphNodeData): number {
  return (
    String(a.schema ?? "").localeCompare(String(b.schema ?? "")) ||
    String(a.parent ?? "").localeCompare(String(b.parent ?? "")) ||
    (NODE_TYPE_ORDER[a.type] ?? Number.MAX_SAFE_INTEGER) -
      (NODE_TYPE_ORDER[b.type] ?? Number.MAX_SAFE_INTEGER) ||
    (a.ord ?? Number.MAX_SAFE_INTEGER) - (b.ord ?? Number.MAX_SAFE_INTEGER) ||
    String(a.label).localeCompare(String(b.label)) ||
    a.type.localeCompare(b.type) ||
    a.id.localeCompare(b.id)
  );
}

function compareEdge(a: GraphEdgeData, b: GraphEdgeData): number {
  const aKindRank = EDGE_KIND_ORDER.indexOf(a.kind);
  const bKindRank = EDGE_KIND_ORDER.indexOf(b.kind);
  return (
    (aKindRank < 0 ? Number.MAX_SAFE_INTEGER : aKindRank) -
      (bKindRank < 0 ? Number.MAX_SAFE_INTEGER : bKindRank) ||
    a.source.localeCompare(b.source) ||
    a.target.localeCompare(b.target) ||
    Number(Boolean(a.detail)) - Number(Boolean(b.detail)) ||
    Number(Boolean(a.agg)) - Number(Boolean(b.agg)) ||
    a.id.localeCompare(b.id)
  );
}
