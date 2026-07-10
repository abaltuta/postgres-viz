/**
 * Pure cytoscape-graph helpers shared by the webview and its headless tests.
 *
 * Everything here derives visibility and traversal from CLASSES and edge data,
 * never from `:visible` — computed style is stale right after batched class
 * changes, which has caused a string of view bugs (piled-up rows, stacked
 * views inheriting leftovers, fits that covered the long-hidden full graph).
 */
import type { CollectionReturnValue, Core, NodeSingular } from "cytoscape";

// ── class-group ownership ──
// Every cytoscape class belongs to exactly ONE group; a function may only
// write classes of the group it owns. This is the structural fix for the
// "state gets messed up on view swap" family of bugs.

/** whether an element renders at all (read via isShownByClasses) */
export const HIDE_CLASSES = [
  "hidden-el", // owned by filters / schema grouping
  "facet-hidden", // owned by faceted filters
  "isolated-hidden", // owned by the "hide isolated" filter
  "focus-hidden", // owned by views
  "untouched-hidden", // owned by views
] as const;

/** visual weight of an already-visible element — owned by views/selection */
export const HIGHLIGHT_CLASSES = [
  "dimmed",
  "revealed",
  "hot",
  "agg-suppressed",
  "hover-reveal",
  "matched",
] as const;

/** rendering form — owned by materialization (virtual-card) and edge config */
export const STRUCTURE_CLASSES = ["virtual-card", "edge-off", "ortho"] as const;

/** everything a view may have touched — stripped when (re)entering base state */
export const VIEW_OWNED_CLASSES = ["focus-hidden", "untouched-hidden", ...HIGHLIGHT_CLASSES];

// ── position snapshot across views ──

export type PositionSnapshot = Map<string, { x: number; y: number }>;

/** Snapshot every node — compound parents store their DERIVED center, so a
 *  card that was materialized before a view isn't lost (the drift bug:
 *  skipping parents stranded them at the view layout's position forever). */
export function snapshotPositions(cy: Core): PositionSnapshot {
  const saved: PositionSnapshot = new Map();
  cy.nodes().forEach((n) => {
    if (n.isParent()) {
      // midpoint of child positions, not boundingBox — deterministic in
      // headless tests and unaffected by label/style sizing
      let x1 = Infinity;
      let y1 = Infinity;
      let x2 = -Infinity;
      let y2 = -Infinity;
      n.children().forEach((k) => {
        const p = k.position();
        x1 = Math.min(x1, p.x);
        y1 = Math.min(y1, p.y);
        x2 = Math.max(x2, p.x);
        y2 = Math.max(y2, p.y);
      });
      saved.set(n.id(), { x: (x1 + x2) / 2, y: (y1 + y2) / 2 });
    } else {
      saved.set(n.id(), { ...n.position() });
    }
  });
  return saved;
}

// ── focus/call-tree helpers ──

/** Every card/standalone unit (children of schemas or roots), never rows. */
export function allCardUnits(cy: Core): NodeSingular[] {
  const out: NodeSingular[] = [];
  cy.nodes().forEach((n) => {
    if (n.data("type") === "schema") return;
    const p = n.parent().first();
    if (p.empty() || p.data("type") === "schema") out.push(n as NodeSingular);
  });
  return out;
}

/** Visibility from classes on self + ancestors (see module doc). */
export function isShownByClasses(n: NodeSingular): boolean {
  let e: NodeSingular = n;
  for (;;) {
    for (const c of HIDE_CLASSES) {
      if (e.hasClass(c)) return false;
    }
    const p = e.parent().first();
    if (p.empty()) return true;
    e = p as NodeSingular;
  }
}

/** The card a node belongs to (columns/triggers/constraints/indexes → their table). */
export function unitOf(n: NodeSingular): NodeSingular {
  let u: NodeSingular = n;
  for (;;) {
    const p = u.parent().first();
    if (p.empty() || p.data("type") === "schema") return u;
    u = p as NodeSingular;
  }
}

/** What a viewport fit should cover: the class-derived shown leaf nodes. */
export function fitTarget(cy: Core): CollectionReturnValue {
  const shown = cy.nodes().filter((n) => !n.isParent() && isShownByClasses(n as NodeSingular));
  return shown.length > 0 ? shown : cy.elements();
}

type AggregateMemberEdge = {
  data: { id?: string; source: string; target: string; kind: string };
};

type AggregateMemberNode = {
  data: { label: unknown; type: string };
};

/**
 * Human-readable row members behind a card-level aggregate edge. Detail edges
 * are indexed by every row endpoint's card, so aggregates whose row endpoint is
 * on the target side (function/view -> table.column) must search both cards.
 */
export function aggregateMemberLabels(
  data: {
    source: string;
    target: string;
    kind: string;
    kinds?: Partial<Record<string, number>>;
  },
  detailEdgesByCard: ReadonlyMap<string, readonly AggregateMemberEdge[]>,
  nodeDefById: ReadonlyMap<string, AggregateMemberNode>,
  cardOfNode: ReadonlyMap<string, string>,
  rowTypes: ReadonlySet<string>,
  max = 6,
): string {
  const unitOfId = (id: string): string => cardOfNode.get(id) ?? id;
  const labelOf = (id: string, n: AggregateMemberNode): string => {
    const label = String(n.data.label ?? "");
    return label || id;
  };
  const seen = new Set<string>();
  const members: string[] = [];
  const aggregateKinds = data.kinds ? new Set(Object.keys(data.kinds)) : undefined;
  for (const card of [data.source, data.target]) {
    for (const e of detailEdgesByCard.get(card) ?? []) {
      const edgeKey = e.data.id ?? `${e.data.kind}|${e.data.source}|${e.data.target}`;
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);
      if (
        (aggregateKinds ? !aggregateKinds.has(e.data.kind) : e.data.kind !== data.kind) ||
        unitOfId(e.data.source) !== data.source ||
        unitOfId(e.data.target) !== data.target
      ) {
        continue;
      }
      const src = nodeDefById.get(e.data.source);
      const tgt = nodeDefById.get(e.data.target);
      const srcRow = src && rowTypes.has(src.data.type);
      const tgtRow = tgt && rowTypes.has(tgt.data.type);
      if (srcRow && tgtRow)
        members.push(`${labelOf(e.data.source, src)}→${labelOf(e.data.target, tgt)}`);
      else if (srcRow) members.push(labelOf(e.data.source, src));
      else if (tgtRow) members.push(labelOf(e.data.target, tgt));
    }
  }
  const shown = members.slice(0, max).join(", ");
  return members.length > max ? `${shown}, +${members.length - max} more` : shown;
}

/** Edge kinds that mean "this unit touches that table's data". */
export const DATA_KINDS = new Set([
  "selects",
  "reads",
  "inserts",
  "updates",
  "deletes",
  "writes",
  "modifies",
]);

/**
 * Call-tree closure from a trigger/function node: a trigger seeds with the
 * function(s) it executes; functions follow outgoing calls/executes
 * level by level (cycle-safe) up to `maxLevels` deep (the seed functions are
 * level 1); `keep` adds every table the closure touches plus the root's
 * direct callers for context.
 */
export function callTreeClosure(
  cy: Core,
  node: NodeSingular,
  maxLevels = Number.POSITIVE_INFINITY,
): { fns: Set<string>; keep: Set<string>; roots: Set<string> } {
  const startUnit = unitOf(node);
  const outgoing = new Map<string, string[]>();
  const callers = new Map<string, string[]>();
  const dataTargets = new Map<string, string[]>();
  cy.edges().forEach((e) => {
    const source = e.source().id();
    const target = e.target().id();
    const kind = String(e.data("kind"));
    const aggregate = Boolean(e.data("agg"));
    const detail = Boolean(e.data("detail"));
    if (!aggregate && !detail && (kind === "calls" || kind === "executes")) {
      const targets = outgoing.get(source) ?? [];
      targets.push(target);
      outgoing.set(source, targets);
      const sources = callers.get(target) ?? [];
      sources.push(source);
      callers.set(target, sources);
    }
    const kinds = e.data("kinds") as Record<string, number> | undefined;
    if (
      (aggregate || !detail) &&
      (kinds
        ? Object.keys(kinds).some((edgeKind) => DATA_KINDS.has(edgeKind))
        : DATA_KINDS.has(kind))
    ) {
      const targets = dataTargets.get(source) ?? [];
      targets.push(target);
      dataTargets.set(source, targets);
    }
  });
  const fns = new Set<string>();
  let frontier: string[] = [];
  if (node.data("type") === "trigger") {
    node.connectedEdges('[kind="executes"]').forEach((e) => {
      frontier.push(e.target().id());
    });
  } else {
    frontier.push(startUnit.id());
  }
  const roots = new Set(frontier);
  for (let level = 1; frontier.length > 0 && level <= maxLevels; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (fns.has(id)) continue;
      fns.add(id);
      for (const target of outgoing.get(id) ?? []) {
        if (!fns.has(target)) next.push(target);
      }
    }
    frontier = next;
  }
  const keep = new Set<string>(fns);
  keep.add(startUnit.id());
  for (const id of fns) {
    for (const target of dataTargets.get(id) ?? []) keep.add(target);
  }
  // context: who calls / fires the root
  for (const root of roots) {
    for (const source of callers.get(root) ?? []) keep.add(source);
  }
  return { fns, keep, roots };
}
