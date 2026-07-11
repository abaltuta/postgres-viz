import type { Core, EdgeSingular, NodeSingular } from "cytoscape";
import type { GraphEdgeData, GraphNodeData } from "../src/types";
import type { Prefs } from "../src/protocol";
import {
  allCardUnits,
  CONNECTION_EMPHASIS_CLASSES,
  DATA_KINDS,
  isShownByClasses,
  VIEW_OWNED_CLASSES,
  type ConnectionEmphasis,
  type PositionSnapshot,
} from "./core";

export type NodeDef = { data: GraphNodeData };
export type EdgeDef = { data: GraphEdgeData };

export interface MaterializationState {
  rowsByCard: Map<string, NodeDef[]>;
  detailEdgesByCard: Map<string, EdgeDef[]>;
  cardOfNode: Map<string, string>;
  materialized: Set<string>;
  limited: Set<string>;
  rowTypeFilter?: ReadonlySet<string>;
  materializeCap: number;
  materializeAllRowsCap?: number;
}

export const ROW_TYPES = new Set(["column", "trigger", "constraint", "index"]);

type UnitOfNode = (n: NodeSingular) => NodeSingular;

function edgeUnitIds(e: EdgeSingular, unitOfNode: UnitOfNode): { source: string; target: string } {
  return {
    source: unitOfNode(e.source() as NodeSingular).id(),
    target: unitOfNode(e.target() as NodeSingular).id(),
  };
}

function aggregateEdgeKey(kind: string, source: string, target: string): string {
  return `${kind}|${source}|${target}`;
}

export function initializeVirtualCards(cy: Core, rowsByCard: Map<string, NodeDef[]>): void {
  cy.nodes().forEach((n) => {
    if (rowsByCard.has(n.id())) n.addClass("virtual-card");
  });
}

export function applyConnectionEmphasis(
  cy: Core,
  classes: ReadonlyMap<string, ConnectionEmphasis>,
): void {
  cy.batch(() => {
    cy.nodes().removeClass(CONNECTION_EMPHASIS_CLASSES.join(" "));
    for (const [id, className] of classes) {
      cy.getElementById(id).addClass(className);
    }
  });
}

export interface RadialSummaryDefinition {
  id: string;
  target: string;
  label: string;
  category: string;
  kind: string;
}

export function addRadialSummary(
  cy: Core,
  ownedIds: Set<string>,
  summary: RadialSummaryDefinition,
): void {
  if (cy.getElementById(summary.target).empty()) return;
  const edgeId = `${summary.id}_edge`;
  cy.batch(() => {
    cy.add({
      group: "nodes",
      data: {
        id: summary.id,
        label: summary.label,
        category: summary.category,
      },
      classes: "radial-summary",
    });
    cy.add({
      group: "edges",
      data: {
        id: edgeId,
        source: summary.id,
        target: summary.target,
        kind: summary.kind,
      },
      classes: "radial-summary-edge",
    });
  });
  ownedIds.add(summary.id);
  ownedIds.add(edgeId);
}

export function revealOwnedRadialElements(cy: Core, ownedIds: ReadonlySet<string>): void {
  cy.batch(() => {
    for (const id of ownedIds) {
      const element = cy.getElementById(id);
      element.removeClass("dimmed");
      element.addClass(element.isEdge() ? "hot" : "revealed");
    }
  });
}

export function removeOwnedElements(cy: Core, ownedIds: Set<string>): void {
  cy.batch(() => {
    for (const id of ownedIds) cy.getElementById(id).remove();
  });
  ownedIds.clear();
}

function materializableRows(state: MaterializationState, cardId: string): NodeDef[] {
  const rows = state.rowsByCard.get(cardId) ?? [];
  return state.rowTypeFilter ? rows.filter((row) => state.rowTypeFilter!.has(row.data.type)) : rows;
}

export function materializationRowCounts(state: MaterializationState): {
  materialized: number;
  total: number;
} {
  let materialized = 0;
  let total = 0;
  for (const id of state.rowsByCard.keys()) {
    const count = materializableRows(state, id).length;
    total += count;
    if (state.materialized.has(id)) materialized += count;
  }
  return { materialized, total };
}

export function materializeCard(cy: Core, state: MaterializationState, cardId: string): void {
  if (state.materialized.has(cardId) || !state.rowsByCard.has(cardId)) return;
  const card = cy.getElementById(cardId);
  if (card.empty()) return;
  const center = { ...card.position() };
  const rows = materializableRows(state, cardId);
  if (rows.length === 0) return;
  state.materialized.add(cardId);
  state.limited.delete(cardId);
  cy.batch(() => {
    card.removeClass("virtual-card");
    cy.add(
      rows.map((r, i) => ({
        group: "nodes" as const,
        data: r.data,
        position: { x: center.x, y: center.y + i },
      })),
    );
    for (const e of state.detailEdgesByCard.get(cardId) ?? []) {
      const { id, source, target } = e.data;
      const endpointsPresent =
        cy.getElementById(source).nonempty() && cy.getElementById(target).nonempty();
      if (cy.getElementById(id).empty() && endpointsPresent) {
        cy.add({ group: "edges" as const, data: e.data });
      }
    }
  });
}

export function materializeNeighborhood(
  cy: Core,
  state: MaterializationState,
  unitId: string,
): void {
  materializeCard(cy, state, unitId);
  const counters = new Set<string>();
  for (const e of state.detailEdgesByCard.get(unitId) ?? []) {
    for (const end of [e.data.source, e.data.target]) {
      const card = state.cardOfNode.get(end);
      if (card && card !== unitId) counters.add(card);
    }
  }
  let n = 0;
  for (const c of counters) {
    if (n++ >= state.materializeCap) {
      state.limited.add(c);
      continue;
    }
    materializeCard(cy, state, c);
  }
}

export function materializeWithinBudget(
  cy: Core,
  state: MaterializationState,
  cardIds: Iterable<string>,
  rowCap = state.materializeAllRowsCap ?? 4_000,
): void {
  let rows = 0;
  for (const id of state.materialized) rows += materializableRows(state, id).length;
  for (const id of cardIds) {
    if (state.materialized.has(id) || state.limited.has(id)) continue;
    const definitions = materializableRows(state, id);
    if (definitions.length === 0) continue;
    if (rows + definitions.length > rowCap) {
      state.limited.add(id);
      continue;
    }
    materializeCard(cy, state, id);
    rows += definitions.length;
  }
}

export function materializeAll(cy: Core, state: MaterializationState, prefs: Prefs): void {
  const schemaFilter = new Set(prefs.filterSchemas);
  const typeFilter = new Set<string>(prefs.filterNodeTypes);
  const extent = cy.extent();
  const center = { x: (extent.x1 + extent.x2) / 2, y: (extent.y1 + extent.y2) / 2 };
  const candidates: { id: string; priority: number; distance: number }[] = [];
  for (const [id, definitions] of state.rowsByCard) {
    const card = cy.getElementById(id);
    if (card.empty()) continue;
    const schema = String(card.data("schema") ?? "");
    const type = String(card.data("type") ?? "");
    if (schemaFilter.size > 0 && !schemaFilter.has(schema)) continue;
    if (
      typeFilter.size > 0 &&
      !typeFilter.has(type) &&
      !definitions.some((row) => typeFilter.has(row.data.type))
    ) {
      continue;
    }
    const position = card.position();
    const inViewport =
      position.x >= extent.x1 &&
      position.x <= extent.x2 &&
      position.y >= extent.y1 &&
      position.y <= extent.y2;
    candidates.push({
      id,
      priority: card.selected() ? 0 : inViewport ? 1 : 2,
      distance: Math.hypot(position.x - center.x, position.y - center.y),
    });
  }
  candidates.sort((a, b) => a.priority - b.priority || a.distance - b.distance);
  materializeWithinBudget(
    cy,
    state,
    candidates.map((candidate) => candidate.id),
  );
}

export function dematerializeCard(cy: Core, state: MaterializationState, id: string): void {
  if (!state.materialized.has(id)) return;
  const card = cy.getElementById(id);
  if (card.empty()) {
    state.materialized.delete(id);
    return;
  }
  const pos = { ...card.position() };
  cy.remove(card.children());
  card.position(pos);
  card.addClass("virtual-card");
  state.materialized.delete(id);
}

export function dematerializeAll(cy: Core, state: MaterializationState): void {
  if (state.materialized.size === 0) return;
  const ids = Array.from(state.materialized);
  cy.batch(() => {
    for (const id of ids) dematerializeCard(cy, state, id);
  });
}

function hasFacetHiddenAncestor(n: NodeSingular): boolean {
  let current: NodeSingular = n;
  for (;;) {
    if (current.hasClass("facet-hidden")) return true;
    const parent = current.parent().first();
    if (parent.empty()) return false;
    current = parent as NodeSingular;
  }
}

export function applyFilterClasses(
  cy: Core,
  state: MaterializationState,
  prefs: Prefs,
  edgeMode: Prefs["edgeMode"],
  viewActive: boolean,
): void {
  const schemaFilter = new Set<string>(prefs.filterSchemas ?? []);
  const typeFilter = new Set<string>(prefs.filterNodeTypes ?? []);
  const edgeKindFilter = new Set<string>(prefs.filterEdgeKinds ?? []);
  state.rowTypeFilter =
    typeFilter.size === 0
      ? undefined
      : new Set([...typeFilter].filter((type) => ROW_TYPES.has(type)));
  if (edgeMode === "all" && state.materialized.size < state.rowsByCard.size && !viewActive) {
    materializeAll(cy, state, prefs);
  }
  cy.batch(() => {
    cy.elements().removeClass("facet-hidden");
    cy.edges().removeClass("edge-off");
    if (schemaFilter.size > 0 || typeFilter.size > 0) {
      cy.nodes().forEach((n) => {
        const type = String(n.data("type"));
        const schema =
          type === "schema" ? String(n.data("label") ?? "") : String(n.data("schema") ?? "");
        const schemaHidden = schemaFilter.size > 0 && !schemaFilter.has(schema);
        const typeHidden =
          typeFilter.size > 0 &&
          type !== "schema" &&
          !typeFilter.has(type) &&
          !(state.rowsByCard.get(n.id()) ?? []).some((row) => typeFilter.has(row.data.type));
        if (schemaHidden || typeHidden) n.addClass("facet-hidden");
      });
      cy.nodes('[type="schema"]').forEach((s) => {
        let anyVisibleChild = false;
        s.children().forEach((child) => {
          if (!child.hasClass("hidden-el") && !child.hasClass("facet-hidden")) {
            anyVisibleChild = true;
          }
        });
        s.toggleClass("facet-hidden", s.hasClass("facet-hidden") || !anyVisibleChild);
      });
    }
    cy.edges().forEach((e) => {
      const kindCounts = e.data("kinds") as Record<string, number> | undefined;
      if (kindCounts) {
        const visibleKinds = Object.entries(kindCounts).filter(
          ([kind]) => edgeKindFilter.size === 0 || edgeKindFilter.has(kind),
        );
        const visibleCount = visibleKinds.reduce((sum, entry) => sum + entry[1], 0);
        e.data(
          "displayLabel",
          edgeKindFilter.size === 0
            ? String(e.data("label") ?? "")
            : visibleKinds.length > 1
              ? `${visibleKinds.length} kinds · ×${visibleCount}`
              : visibleCount > 1
                ? `×${visibleCount}`
                : "",
        );
      }
      if (
        (edgeKindFilter.size > 0 &&
          !(kindCounts
            ? Object.keys(kindCounts).some((kind) => edgeKindFilter.has(kind))
            : edgeKindFilter.has(String(e.data("kind"))))) ||
        hasFacetHiddenAncestor(e.source() as NodeSingular) ||
        hasFacetHiddenAncestor(e.target() as NodeSingular)
      ) {
        e.addClass("facet-hidden");
      }
    });
    if (edgeMode === "off") cy.edges().addClass("edge-off");
    else if (edgeMode === "cards") cy.edges("[!agg]").addClass("edge-off");
    else cy.edges("[?agg]").addClass("edge-off");

    cy.nodes().removeClass("isolated-hidden");
    if (prefs.hideIsolated) {
      const keep = new Set<string>();
      cy.edges("[?agg]").forEach((e) => {
        if (edgeHidden(e as EdgeSingular)) return;
        keep.add(e.source().id());
        keep.add(e.target().id());
      });
      cy.nodes().forEach((n) => {
        if (keep.has(n.id())) {
          n.ancestors().forEach((a) => {
            keep.add(a.id());
          });
          n.descendants().forEach((d) => {
            keep.add(d.id());
          });
        }
      });
      cy.nodes().forEach((n) => {
        if (!keep.has(n.id()) && !n.hasClass("hidden-el") && !n.hasClass("facet-hidden")) {
          n.addClass("isolated-hidden");
        }
      });
    }
  });
}

export function restackRows(cy: Core): void {
  cy.batch(() => {
    cy.nodes(':parent[type != "schema"]').forEach((p) => {
      const rows = p
        .children()
        .filter(
          (d) =>
            !d.hasClass("hidden-el") &&
            !d.hasClass("facet-hidden") &&
            !d.hasClass("isolated-hidden") &&
            !d.hasClass("focus-hidden") &&
            !d.hasClass("untouched-hidden"),
        )
        .sort((a, b) => rowOrderValue(a.data("ord")) - rowOrderValue(b.data("ord")));
      if (rows.length === 0) return;
      let maxLen = String(p.data("label") ?? "").length;
      rows.forEach((r) => {
        maxLen = Math.max(maxLen, String(r.data("label") ?? "").length);
      });
      const rowW = Math.max(70, maxLen * 6.5 + 14);
      const rowH = 17;
      const cx = p.position("x");
      const top = p.position("y") - (rows.length * rowH) / 2;
      rows.forEach((r, i) => {
        r.position({ x: cx, y: top + i * rowH + rowH / 2 });
        r.style({ width: rowW });
      });
    });
  });
}

function rowOrderValue(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

export function applySchemaGrouping(cy: Core, grouped: boolean): void {
  cy.batch(() => {
    cy.nodes("[schemaParent]").forEach((n) => {
      const target = grouped ? (n.data("schemaParent") as string) : null;
      if ((n.data("parent") ?? null) !== target) n.move({ parent: target });
    });
    cy.nodes('[type="schema"]').toggleClass("hidden-el", !grouped);
  });
}

export function edgeHidden(e: EdgeSingular): boolean {
  return e.hasClass("hidden-el") || e.hasClass("facet-hidden");
}

export function edgeShownByClasses(e: EdgeSingular): boolean {
  return (
    !edgeHidden(e) &&
    isShownByClasses(e.source() as NodeSingular) &&
    isShownByClasses(e.target() as NodeSingular)
  );
}

export function shiftUnit(u: NodeSingular, dx: number, dy: number): void {
  (u.isParent() ? u.descendants() : u).shift({ x: dx, y: dy });
}

export function moveUnitTo(u: NodeSingular, x: number, y: number): void {
  const bb = u.boundingBox({ includeLabels: false });
  shiftUnit(u, x - (bb.x1 + bb.x2) / 2, y - (bb.y1 + bb.y2) / 2);
}

export function clearEdgeRouting(cy: Core, routedEdges: Set<string>): void {
  for (const id of routedEdges) {
    const e = cy.getElementById(id);
    if (e.nonempty()) e.removeStyle("curve-style segment-weights segment-distances");
  }
  routedEdges.clear();
}

export function markSingleCardEdgesOrthogonal(cy: Core): void {
  const pairCount = new Map<string, number>();
  const pairKey = (e: EdgeSingular): string => {
    const a = e.source().id();
    const b = e.target().id();
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  };
  cy.edges("[?agg]").forEach((e) => {
    const edge = e as EdgeSingular;
    if (edgeHidden(edge)) return;
    const k = pairKey(edge);
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
  });
  cy.edges("[?agg]").forEach((e) => {
    const edge = e as EdgeSingular;
    edge.toggleClass("ortho", !edgeHidden(edge) && (pairCount.get(pairKey(edge)) ?? 0) === 1);
  });
}

export function applyEdgeSegments(
  routedEdges: Set<string>,
  e: EdgeSingular,
  s: { x: number; y: number },
  t: { x: number; y: number },
  pts: { x: number; y: number }[],
): void {
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1) return;
  const ws: number[] = [];
  const ds: number[] = [];
  for (const p of pts) {
    const px = p.x - s.x;
    const py = p.y - s.y;
    ws.push((px * dx + py * dy) / len2);
    ds.push((px * dy - py * dx) / Math.sqrt(len2));
  }
  e.style({
    "curve-style": "segments",
    "segment-weights": ws.join(" "),
    "segment-distances": ds.join(" "),
  });
  routedEdges.add(e.id());
}

export function clearSelectionClasses(cy: Core): void {
  cy.nodes().unselect();
  cy.elements().removeClass("dimmed");
  cy.edges().removeClass("hot revealed agg-suppressed");
}

export function primarySelectedNode(cy: Core): NodeSingular | undefined {
  let primary: NodeSingular | undefined;
  let primaryDepth = -1;
  cy.nodes(":selected").forEach((candidate) => {
    const depth = candidate.ancestors().length;
    if (depth > primaryDepth) {
      primary = candidate as NodeSingular;
      primaryDepth = depth;
    }
  });
  return primary;
}

export function clearHotEdges(cy: Core): void {
  cy.edges().removeClass("hot");
}

export function markCallTreeHot(unit: NodeSingular): void {
  unit.union(unit.descendants()).connectedEdges(".revealed").addClass("hot");
}

export function applySelectionClasses(cy: Core, node: NodeSingular, unitOfNode: UnitOfNode): void {
  cy.nodes().unselect();
  cy.edges().removeClass("hot revealed agg-suppressed");
  const core = node.union(node.descendants());
  const detailEdges = core.connectedEdges("[?detail]");
  const unit = unitOfNode(node);
  node.select();
  unit.select();
  unit.union(unit.descendants()).connectedEdges("[?agg]").addClass("agg-suppressed");
  const revealed = detailEdges.union(core.connectedEdges("[!agg]"));
  revealed.addClass("revealed hot");
  const hood = core.closedNeighborhood().union(revealed.connectedNodes()).union(node.ancestors());
  const withParents = hood.union(hood.nodes().ancestors());
  cy.elements().addClass("dimmed");
  withParents.removeClass("dimmed");
}

export function applyCallTreeColumnFilter(
  cy: Core,
  onlyTouched: boolean,
  touchedRows: ReadonlySet<string>,
): void {
  cy.batch(() => {
    cy.nodes(':parent[type != "schema"]').forEach((p) => {
      p.children().forEach((r) => {
        r.toggleClass("untouched-hidden", onlyTouched && !touchedRows.has(r.id()));
      });
    });
  });
}

export function applyFocusedRowFilter(
  cy: Core,
  node: NodeSingular,
  unit: NodeSingular,
  keep: ReadonlySet<string>,
  unitOfNode: UnitOfNode,
): void {
  const card = cy.getElementById(unit.id());
  cy.batch(() => {
    card.children().forEach((r) => {
      if (r.id() === node.id()) return;
      let involved = false;
      r.connectedEdges("[?detail]").forEach((e) => {
        const other = e.source().id() === r.id() ? e.target() : e.source();
        const ou = unitOfNode(other as NodeSingular).id();
        if (ou !== unit.id() && keep.has(ou)) involved = true;
      });
      r.toggleClass("untouched-hidden", !involved);
    });
  });
}

export function collectCallTreeTouchedRows(
  cy: Core,
  rowTypes: ReadonlySet<string>,
  unitOfNode: UnitOfNode,
  onChain: (kind: string, srcUnit: string, tgtUnit: string, tgtId: string) => boolean,
): Set<string> {
  const touchedRows = new Set<string>();
  cy.edges("[?detail]").forEach((e) => {
    const unitIds = edgeUnitIds(e as EdgeSingular, unitOfNode);
    if (!onChain(String(e.data("kind")), unitIds.source, unitIds.target, e.target().id())) return;
    for (const end of [e.source(), e.target()]) {
      if (rowTypes.has(String(end.data("type")))) touchedRows.add(end.id());
    }
  });
  return touchedRows;
}

export function revealCallTreeEdges(
  cy: Core,
  unitOfNode: UnitOfNode,
  onChain: (kind: string, srcUnit: string, tgtUnit: string, tgtId: string) => boolean,
): void {
  cy.edges().removeClass("revealed agg-suppressed hot");
  const revealedPairs = new Set<string>();
  cy.edges("[?detail]").forEach((e) => {
    const unitIds = edgeUnitIds(e as EdgeSingular, unitOfNode);
    const k = String(e.data("kind"));
    if (!onChain(k, unitIds.source, unitIds.target, e.target().id())) return;
    e.addClass("revealed");
    revealedPairs.add(aggregateEdgeKey(k, unitIds.source, unitIds.target));
  });
  cy.edges("[!agg][!detail]").forEach((e) => {
    const su = e.source().id();
    const tu = e.target().id();
    const k = String(e.data("kind"));
    if (!onChain(k, su, tu, tu)) return;
    if (e.data("agg") && revealedPairs.has(aggregateEdgeKey(k, su, tu)))
      e.addClass("agg-suppressed");
    else e.addClass("revealed");
  });
}

export function dematerializeCardsWithoutTouchedRows(
  cy: Core,
  state: MaterializationState,
  keep: ReadonlySet<string>,
  touchedRows: ReadonlySet<string>,
): void {
  const touchedCards = new Set<string>();
  for (const id of touchedRows) {
    const c = state.cardOfNode.get(id);
    if (c) touchedCards.add(c);
  }
  cy.batch(() => {
    for (const id of keep) {
      if (state.materialized.has(id) && !touchedCards.has(id)) dematerializeCard(cy, state, id);
    }
  });
}

export function clearHoverReveal(cy: Core): void {
  cy.edges(".hover-reveal").removeClass("hover-reveal");
}

export function setHoverReveal(unit: NodeSingular): void {
  unit.union(unit.descendants()).connectedEdges("[?agg]").addClass("hover-reveal");
}

export function resetViewState(cy: Core): void {
  cy.batch(() => {
    cy.nodes().unselect();
    cy.elements().removeClass(VIEW_OWNED_CLASSES.join(" "));
  });
}

export function applyKeepMask(cy: Core, keep: ReadonlySet<string>): void {
  cy.batch(() => {
    for (const u of allCardUnits(cy)) {
      u.union(u.descendants()).toggleClass("focus-hidden", !keep.has(u.id()));
    }
    cy.nodes('[type="schema"]').forEach((s) => {
      let anyVisible = false;
      s.children().forEach((d) => {
        if (
          !d.hasClass("focus-hidden") &&
          !d.hasClass("hidden-el") &&
          !d.hasClass("facet-hidden") &&
          !d.hasClass("isolated-hidden")
        ) {
          anyVisible = true;
        }
      });
      s.toggleClass("focus-hidden", !anyVisible);
    });
  });
}

export function restoreViewPositions(cy: Core, saved: PositionSnapshot): void {
  cy.batch(() => {
    saved.forEach((pos, id) => {
      const n = cy.getElementById(id);
      if (n.nonempty() && n.isNode() && !n.isParent()) n.position(pos);
    });
  });
}

export { DATA_KINDS };
