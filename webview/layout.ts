import { graphlib, layout } from "@dagrejs/dagre";

export interface LayoutUnit {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface LayoutPosition {
  x: number;
  y: number;
}

const DEFAULT_GAP = 36;
const DEFAULT_GRID = 24;

export function layoutTreeV2Positions(
  units: readonly LayoutUnit[],
  edges: readonly LayoutEdge[],
  gap = DEFAULT_GAP,
  grid = DEFAULT_GRID,
): Map<string, LayoutPosition> {
  if (units.length === 0) return new Map();
  const graph = new graphlib.Graph({ multigraph: false, compound: false });
  graph.setGraph({
    rankdir: "TB",
    nodesep: gap,
    ranksep: gap * 2,
    marginx: 0,
    marginy: 0,
    ranker: "network-simplex",
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const unit of units) {
    graph.setNode(unit.id, { width: unit.width, height: unit.height });
  }
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  layout(graph);

  const snap = (value: number): number => Math.round(value / grid) * grid;
  const positions = new Map<string, LayoutPosition>();
  for (const unit of units) {
    const node = graph.node(unit.id) as { x: number; y: number } | undefined;
    if (node) positions.set(unit.id, { x: snap(node.x), y: snap(node.y) });
  }
  return positions;
}
