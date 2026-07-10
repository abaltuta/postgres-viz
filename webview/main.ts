import cytoscape, { Core, EdgeSingular, NodeSingular } from "cytoscape";
import * as dagre from "dagre";
import {
  DEFAULT_PREFS,
  type HostToWebviewMessage,
  normalizePrefs,
  type Prefs,
  type WebviewToHostMessage,
} from "../src/protocol";
import type { EdgeKind, GraphEdgeData, GraphNodeData, GraphPayload } from "../src/types";
import {
  aggregateMemberLabels,
  allCardUnits as coreCardUnits,
  callTreeClosure,
  fitTarget,
  isShownByClasses,
  type PositionSnapshot,
  snapshotPositions,
  suppressRedundantAggs,
  unitOf,
} from "./core";
import {
  applyCallTreeColumnFilter as adapterApplyCallTreeColumnFilter,
  applyEdgeSegments,
  applyFilterClasses,
  applyFocusedRowFilter,
  applyKeepMask,
  applySchemaGrouping as adapterApplySchemaGrouping,
  applySelectionClasses,
  clearEdgeRouting as adapterClearEdgeRouting,
  clearHotEdges,
  clearHoverReveal,
  clearSelectionClasses,
  collectCallTreeTouchedRows,
  DATA_KINDS,
  dematerializeAll as adapterDematerializeAll,
  dematerializeCardsWithoutTouchedRows,
  edgeHidden,
  edgeShownByClasses,
  initializeVirtualCards,
  materializeCard as adapterMaterializeCard,
  materializeNeighborhood as adapterMaterializeNeighborhood,
  type EdgeDef,
  markCallTreeHot,
  markSingleCardEdgesOrthogonal,
  moveUnitTo,
  type NodeDef,
  resetViewState,
  restackRows as adapterRestackRows,
  restoreViewPositions,
  revealCallTreeEdges,
  setHoverReveal,
} from "./cytoscape-adapter";
import { ObstacleIndex } from "./router";

const vscode = acquireVsCodeApi();

function postToHost(message: WebviewToHostMessage): void {
  vscode.postMessage(message);
}

const NODE_COLORS: Record<string, string> = {
  table: "#4C9AFF",
  view: "#57D9A3",
  matview: "#00C7E6",
  foreign: "#998DD9",
  column: "#7A869A",
  function: "#FFAB00",
  trigger: "#FF5630",
  constraint: "#6554C0",
  index: "#84CC16",
  schema: "#57606A",
};

const EDGE_COLORS: Record<string, string> = {
  selects: "#36B37E",
  reads: "#4C9AFF",
  inserts: "#4CC38A",
  updates: "#FFA657",
  deletes: "#F85149",
  writes: "#FF5630",
  modifies: "#C792EA",
  calls: "#FFAB00",
  executes: "#FF7452",
  "update-of": "#FF8F73",
  fk: "#8993A4",
  constrains: "#6554C0",
  indexes: "#84CC16",
  default: "#998DD9",
};

const ROW_TYPES = new Set(["column", "trigger", "constraint", "index"]);

let cy: Core | null = null;
let database = "";

/**
 * Virtual rows: the full row set lives in these maps; column/trigger/constraint
 * row nodes (and their detail edges) are added to cytoscape only when a card is
 * interacted with. Idle cards draw their column list as an SVG background.
 */
const rowsByCard = new Map<string, NodeDef[]>();
const detailEdgesByCard = new Map<string, EdgeDef[]>();
const cardOfNode = new Map<string, string>(); // row id → card id
const nodeDefById = new Map<string, NodeDef>();
const materialized = new Set<string>();
const MATERIALIZE_CAP = 30;
const MATERIALIZE_ALL_ROWS_CAP = 4_000;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function hidePanel(): void {
  el("panel").classList.add("hidden");
  requestAnimationFrame(() => cy?.resize());
}

function materializationState() {
  return {
    rowsByCard,
    detailEdgesByCard,
    cardOfNode,
    materialized,
    materializeCap: MATERIALIZE_CAP,
    materializeAllRowsCap: MATERIALIZE_ALL_ROWS_CAP,
  };
}

/** Mirrored from the extension host; native chrome owns preference changes. */
let prefs: Prefs = { ...DEFAULT_PREFS };
const edgeMode = (): Prefs["edgeMode"] => prefs.edgeMode;

const isDark = (): boolean =>
  document.body.classList.contains("vscode-dark") ||
  document.body.classList.contains("vscode-high-contrast");

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

// ── card art: the column list of an idle card, rendered as one SVG image ──

const ROW_H = 15;
const HEADER_H = 22;
/** Art is a preview, not the ERD — a 200-column table must not dwarf the graph. */
const MAX_ART_ROWS = 30;

function buildCardArt(card: NodeDef): void {
  const rowTypeFilter = new Set(prefs.filterNodeTypes);
  const all = (rowsByCard.get(card.data.id) ?? []).filter(
    (row) => rowTypeFilter.size === 0 || rowTypeFilter.has(row.data.type),
  );
  const rows = all.slice(0, MAX_ART_ROWS);
  const extra = all.length - rows.length;
  let maxLabelLength = card.data.label.length;
  for (const row of rows) maxLabelLength = Math.max(maxLabelLength, String(row.data.label).length);
  const w = Math.max(90, maxLabelLength * 6.2 + 24);
  const h = HEADER_H + (rows.length + (extra > 0 ? 1 : 0)) * ROW_H + 8;
  const dark = isDark();
  const textColor = dark ? "#9fadbc" : "#57606a";
  const stripe = dark ? "#ffffff" : "#000000";
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h - HEADER_H}">`,
  ];
  rows.forEach((r, i) => {
    const y = i * ROW_H;
    const accent = NODE_COLORS[r.data.type] ?? textColor;
    if (i % 2 === 1) {
      parts.push(
        `<rect x="2" y="${y}" width="${w - 4}" height="${ROW_H}" fill="${stripe}" opacity="0.04"/>`,
      );
    }
    if (r.data.type !== "column") {
      parts.push(
        `<rect x="2" y="${y}" width="3" height="${ROW_H}" fill="${accent}" opacity="0.9"/>`,
      );
    }
    parts.push(
      `<text x="10" y="${y + 11}" font-family="Helvetica,Arial,sans-serif" font-size="9" fill="${r.data.type === "column" ? textColor : accent}">${esc(r.data.label)}</text>`,
    );
  });
  if (extra > 0) {
    parts.push(
      `<text x="10" y="${rows.length * ROW_H + 11}" font-family="Helvetica,Arial,sans-serif" font-size="9" font-style="italic" fill="${textColor}" opacity="0.75">… +${extra} more</text>`,
    );
  }
  parts.push("</svg>");
  card.data.svg = `data:image/svg+xml;utf8,${encodeURIComponent(parts.join(""))}`;
  card.data.cardW = w;
  card.data.cardH = h;
}

// ── materialization: swap a card's SVG rows for real nodes + detail edges ──

function materializeCard(cardId: string): void {
  if (!cy) return;
  adapterMaterializeCard(cy, materializationState(), cardId);
}

/** Materialize a card plus the counterpart cards of its detail edges (capped). */
function materializeNeighborhood(unitId: string): void {
  if (!cy) return;
  adapterMaterializeNeighborhood(cy, materializationState(), unitId);
}

function dematerializeAll(): void {
  if (!cy) return;
  adapterDematerializeAll(cy, materializationState());
}

// ── styles ──

function buildStyle(): cytoscape.StylesheetJson {
  const dark = isDark();
  const text = dark ? "#d8dee9" : "#24292f";
  const chipBg = dark ? "#1c2128" : "#f6f8fa";
  const cardBorders = ["table", "view", "matview", "foreign"].map((t) => ({
    selector: `node.virtual-card[type="${t}"], node:parent[type="${t}"]`,
    style: { "border-color": NODE_COLORS[t]!, color: NODE_COLORS[t]! },
  }));
  const styles: { selector: string; style: Record<string, unknown> }[] = [
    {
      selector: "node",
      style: {
        label: "data(label)",
        "font-size": 9,
        "min-zoomed-font-size": 7,
        color: text,
        "text-valign": "center",
        "text-halign": "center",
        shape: "round-rectangle",
        width: "label",
        height: 18,
        padding: "6px",
        "background-color": "#888888",
        "background-opacity": 0.9,
        "border-width": 0.5,
        "border-color": dark ? "#0d1117" : "#d0d7de",
      },
    },
    ...Object.entries(NODE_COLORS).map(([type, color]) => ({
      selector: `node[type="${type}"]`,
      style: { "background-color": color },
    })),
    // ERD rows (only exist while their card is materialized)
    {
      selector: 'node[type="column"]',
      style: {
        "font-size": 9,
        "min-zoomed-font-size": 8,
        height: 14,
        shape: "rectangle",
        "background-opacity": 0.18,
        "border-width": 0,
        padding: "1px",
      },
    },
    {
      selector: 'node[type="trigger"], node[type="constraint"], node[type="index"]',
      style: {
        "font-size": 8,
        "min-zoomed-font-size": 8,
        height: 14,
        shape: "rectangle",
        "background-opacity": 0.35,
        "border-width": 0,
        padding: "1px",
      },
    },
    // materialized ERD card (compound)
    {
      selector: ":parent",
      style: {
        shape: "round-rectangle",
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": 14,
        "font-weight": "bold",
        "font-size": 10,
        "min-zoomed-font-size": 5,
        "background-opacity": 0.92,
        "background-color": chipBg,
        "border-width": 1.5,
        padding: "12px",
        "min-width": "70px",
        "min-height": "20px",
      },
    },
    // idle ERD card: plain node, column list painted as an SVG background
    {
      selector: "node.virtual-card",
      style: {
        shape: "round-rectangle",
        width: "data(cardW)",
        height: "data(cardH)",
        "background-image": "data(svg)",
        "background-fit": "none",
        "background-position-x": "0px",
        "background-position-y": `${HEADER_H}px`,
        "background-color": chipBg,
        "background-opacity": 0.92,
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": 14,
        "font-weight": "bold",
        "font-size": 10,
        "min-zoomed-font-size": 5,
        "border-width": 1.5,
        padding: "0px",
      },
    },
    ...cardBorders,
    {
      selector: 'node[type="schema"]',
      style: {
        // fully click-through: drags pan, clicks land on the cards beneath —
        // a schema box spans most of the viewport and must never eat input
        events: "no",
        "background-opacity": 0.02,
        "background-color": "#57606A",
        "border-width": 2,
        "border-style": "dashed",
        "border-color": "#57606A",
        color: text,
        "font-size": 14,
        "min-zoomed-font-size": 5,
        "text-margin-y": -6,
        padding: "28px",
      },
    },
    {
      selector: 'node[type="function"]',
      style: { "font-size": 8.5, height: 14, "background-opacity": 0.8 },
    },
    {
      selector: "edge",
      style: {
        width: 1,
        "curve-style": "bezier",
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.6,
        "line-color": "#8993A4",
        "target-arrow-color": "#8993A4",
        opacity: 0.35,
      },
    },
    ...Object.entries(EDGE_COLORS).map(([kind, color]) => ({
      selector: `edge[kind="${kind}"]`,
      style: { "line-color": color, "target-arrow-color": color },
    })),
    { selector: 'edge[kind="fk"]', style: { "line-style": "dashed" } },
    { selector: 'edge[kind="calls"]', style: { "line-style": "dashed" } },
    { selector: 'edge[kind="default"]', style: { "line-style": "dotted" } },
    {
      selector: "edge[?agg]",
      style: {
        width: 1.4,
        opacity: 0.55,
        label: "data(displayLabel)",
        "line-color": "#8993A4",
        "target-arrow-color": "#8993A4",
        "font-size": 8,
        "min-zoomed-font-size": 7,
        color: text,
        "text-rotation": "autorotate",
        "text-background-color": chipBg,
        "text-background-opacity": 0.85,
        "text-background-padding": "1px",
        "text-background-shape": "round-rectangle",
      },
    },
    {
      selector: "edge.ortho",
      style: {
        "curve-style": "round-taxi",
        "taxi-direction": "vertical",
        "taxi-turn": "50%",
        "taxi-turn-min-distance": "12px",
        "taxi-radius": "8px",
      },
    },
    { selector: ".dimmed", style: { opacity: 0.15, "text-opacity": 0 } },
    { selector: "edge.hot", style: { opacity: 0.95, width: 1.8, "z-index": 9 } },
    { selector: "edge.edge-off", style: { display: "none" } },
    { selector: "edge.revealed", style: { display: "element" } },
    { selector: "edge.hover-reveal", style: { display: "element", opacity: 0.8, width: 1.5 } },
    { selector: "edge.agg-suppressed", style: { display: "none" } },
    { selector: ".hidden-el", style: { display: "none" } },
    { selector: ".facet-hidden", style: { display: "none" } },
    { selector: ".isolated-hidden", style: { display: "none" } },
    { selector: ".focus-hidden", style: { display: "none" } },
    { selector: ".untouched-hidden", style: { display: "none" } },
    {
      selector: ".matched",
      style: { "border-width": 2, "border-color": "#FFD700", "background-opacity": 1 },
    },
    { selector: "node:selected", style: { "border-width": 2.5, "border-color": "#FFD700" } },
  ];
  return styles as unknown as cytoscape.StylesheetJson;
}

// ── render ──

function render(graph: GraphPayload): void {
  el("empty").style.display = "none";
  hideCrumb();
  rowsByCard.clear();
  detailEdgesByCard.clear();
  cardOfNode.clear();
  nodeDefById.clear();
  materialized.clear();

  const liveNodes: NodeDef[] = [];
  for (const n of graph.nodes) nodeDefById.set(n.data.id, n);
  for (const n of graph.nodes) {
    if (ROW_TYPES.has(n.data.type)) {
      const card = n.data.parent!;
      if (!rowsByCard.has(card)) rowsByCard.set(card, []);
      rowsByCard.get(card)!.push(n);
      cardOfNode.set(n.data.id, card);
    } else {
      liveNodes.push(n);
    }
  }
  for (const rows of rowsByCard.values()) {
    rows.sort((a, b) => (a.data.ord ?? 0) - (b.data.ord ?? 0));
  }
  for (const e of graph.edges) {
    if (!e.data.detail) continue;
    for (const end of [e.data.source, e.data.target]) {
      const card = cardOfNode.get(end);
      if (card) {
        if (!detailEdgesByCard.has(card)) detailEdgesByCard.set(card, []);
        detailEdgesByCard.get(card)!.push(e);
      }
    }
  }
  for (const n of liveNodes) {
    if (rowsByCard.has(n.data.id)) buildCardArt(n);
  }
  const liveEdges = graph.edges.filter((e) => !e.data.detail);

  cy?.destroy();
  cy = cytoscape({
    container: el("cy"),
    elements: {
      nodes: liveNodes,
      edges: liveEdges,
    } as unknown as cytoscape.ElementsDefinition,
    style: buildStyle(),
    layout: { name: "preset" },
    wheelSensitivity: 0.2,
    hideEdgesOnViewport: true,
    motionBlur: true,
    pixelRatio: 1,
    boxSelectionEnabled: false,
    // dragging always pans the canvas — node positions are layout-owned
    autoungrabify: true,
  });
  initializeVirtualCards(cy, rowsByCard);
  // a graph push while a view was active must clear EVERYTHING the view
  // owned: the spec, the canvas tint, the pending zoom nudge, the panel
  view = null;
  window.clearTimeout(zoomNudge);
  clearViewUiState();
  hidePanel();
  applySchemaGrouping(false);
  applyFilters();
  runLayout();
  updateStats();
  cy.on("tap", "node", (ev) => {
    const n = ev.target as NodeSingular;
    const unit = unitOf(n);
    if (rowsByCard.has(unit.id()) && !materialized.has(unit.id()) && !view) {
      materializeNeighborhood(unit.id());
      applyFilters();
    }
    selectNode(n);
  });
  cy.on("tap", (ev) => {
    if (ev.target === cy) clearSelection();
  });
  cy.on("dbltap", "node", (ev) => focusNode(ev.target as NodeSingular));
  wireHoverPreview();
}

function applyFilters(): void {
  if (!cy) return;
  applyFilterClasses(cy, materializationState(), prefs, edgeMode(), Boolean(view));
  restackRows();
  updateStats();
  buildLegend();
}

/**
 * ERD pass: stack each materialized card's visible children (columns by attnum,
 * then triggers and constraints) as uniform-width rows inside the card.
 * Compound positions are DERIVED from children in cytoscape, so this must
 * re-run after anything that moves cards or changes row visibility — layouts,
 * filters, materialization — or edges anchor to stale row positions. The card
 * center is snapshotted before the loop because moving rows shifts it.
 */
function restackRows(): void {
  if (!cy) return;
  adapterRestackRows(cy);
}

/** Move tables/views/functions in or out of their schema compound. */
function applySchemaGrouping(relayout: boolean): void {
  if (!cy) return;
  exitView(false);
  adapterApplySchemaGrouping(cy, prefs.schemaGroup);
  if (relayout) {
    applyFilters();
    runLayout();
  }
}

// ── card-level layouts ──

const GAP = 36;
const PILL_GAP = 14;

function canvasAspect(): number {
  const c = el("cy");
  const raw = c.clientWidth / Math.max(1, c.clientHeight);
  // shelf packing wastes some height — bias wider
  return Math.min(5, Math.max(1, raw)) * 1.3;
}

/** Animated fit — every viewport change eases instead of teleporting. */
function fitView(eles?: cytoscape.CollectionArgument, padding = 50): void {
  if (!cy) return;
  cy.stop();
  // class-derived shown set, never `:visible` — computed style is stale right
  // after the batched class changes of focus/call-tree, so `:visible` fits
  // would cover the long-hidden full-graph extent and zoom way out
  const target = eles ?? fitTarget(cy);
  cy.animate({
    fit: { eles: target as never, padding },
    duration: 250,
    easing: "ease-in-out-cubic",
  } as never);
}

// visibility/unit helpers live in core.ts so headless tests can cover them
const isShown = isShownByClasses;

/** Layout units: the currently shown cards and standalone nodes. */
function cardUnits(): NodeSingular[] {
  return coreCardUnits(cy!).filter((n) => isShown(n));
}

function unitBox(u: NodeSingular) {
  return u.boundingBox({ includeLabels: true });
}

/** Shelf-pack members into rows of the given width starting at (x0, y0); returns height used. */
function packShelf(
  members: NodeSingular[],
  x0: number,
  y0: number,
  rowWidth: number,
  gap: number,
): number {
  let x = 0;
  let y = y0;
  let rowH = 0;
  for (const u of members) {
    const b = unitBox(u);
    if (x > 0 && x + b.w > rowWidth) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    moveUnitTo(u, x0 + x + b.w / 2, y + b.h / 2);
    x += b.w + gap;
    rowH = Math.max(rowH, b.h);
  }
  return y + rowH - y0;
}

/** One schema block: relations shelved on top, function pills densely below. */
function layoutCardBlock(
  members: NodeSingular[],
  x0: number,
  y0: number,
  rowWidth: number,
): number {
  const byLabel = (a: NodeSingular, b: NodeSingular): number =>
    String(a.data("label")).localeCompare(String(b.data("label")));
  const rels = members.filter((u) => u.data("type") !== "function").sort(byLabel);
  const pills = members.filter((u) => u.data("type") === "function").sort(byLabel);
  let h = 0;
  if (rels.length > 0) h += packShelf(rels, x0, y0, rowWidth, GAP);
  if (pills.length > 0) {
    if (rels.length > 0) h += GAP;
    h += packShelf(pills, x0, y0 + h, rowWidth, PILL_GAP);
  }
  return h;
}

/**
 * Schema-blocked grid, packed to the viewport's aspect ratio.
 * Geometry: a region of area A laid out at aspect ratio r has width
 * W = sqrt(A·r) — applied twice: each schema block gets its width from its own
 * area share, and the outer shelf width comes from the total. Shelf packing
 * wastes 10–25% height, hence the ×1.15 bias in canvasAspect() and ×1.1 on the
 * outer width. Blocks pack tallest-first (FFDH) to keep shelves dense.
 */
function layoutGridCards(units: NodeSingular[]): void {
  const groups = new Map<string, NodeSingular[]>();
  for (const u of units) {
    const key = String(u.data("schema") ?? "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(u);
  }
  const aspect = canvasAspect();
  // estimate each block's footprint to derive its width and the outer shelf width
  const blocks = [...groups.entries()].map(([key, members]) => {
    let area = 0;
    let widest = 0;
    for (const u of members) {
      const b = unitBox(u);
      area += (b.w + GAP) * (b.h + GAP);
      widest = Math.max(widest, b.w);
    }
    return { key, members, area, width: Math.max(widest + GAP, Math.sqrt(area * aspect)) };
  });
  const totalArea = blocks.reduce((s, b) => s + b.area, 0);
  const outerWidth = Math.max(
    blocks.reduce((m, b) => Math.max(m, b.width), 0),
    Math.sqrt(totalArea * aspect) * 1.1,
  );
  // FFDH-ish outer shelf: tallest-estimate blocks first
  blocks.sort((a, b) => b.area / b.width - a.area / a.width);
  const BLOCK_GAP = GAP * 2.5;
  let x = 0;
  let y = 0;
  let shelfH = 0;
  for (const block of blocks) {
    if (x > 0 && x + block.width > outerWidth) {
      x = 0;
      y += shelfH + BLOCK_GAP;
      shelfH = 0;
    }
    const h = layoutCardBlock(block.members, x, y, block.width);
    x += block.width + BLOCK_GAP;
    shelfH = Math.max(shelfH, h);
  }
}

/** Unit-level adjacency from card-level edges (aggregates + real unit edges). */
function unitAdjacency(units: NodeSingular[]): {
  out: Map<string, Set<string>>;
  degree: Map<string, number>;
} {
  const ids = new Set(units.map((u) => u.id()));
  const out = new Map<string, Set<string>>();
  const degree = new Map<string, number>();
  for (const u of units) {
    out.set(u.id(), new Set());
    degree.set(u.id(), 0);
  }
  cy!.edges("[?agg]").forEach((e) => {
    if (edgeHidden(e as EdgeSingular)) return;
    const s = e.source().id();
    const t = e.target().id();
    if (s === t || !ids.has(s) || !ids.has(t)) return;
    if (!out.get(s)!.has(t)) {
      out.get(s)!.add(t);
      degree.set(s, (degree.get(s) ?? 0) + 1);
      degree.set(t, (degree.get(t) ?? 0) + 1);
    }
  });
  return { out, degree };
}

function layoutTreeCards(units: NodeSingular[]): void {
  const { out, degree } = unitAdjacency(units);
  const indeg = new Map<string, number>();
  for (const u of units) indeg.set(u.id(), 0);
  for (const targets of out.values()) {
    for (const t of targets) indeg.set(t, (indeg.get(t) ?? 0) + 1);
  }
  const level = new Map<string, number>();
  const seen = new Set<string>();
  let frontier = units.filter((u) => (indeg.get(u.id()) ?? 0) === 0).map((u) => u.id());
  if (frontier.length === 0 && units.length > 0) frontier = [units[0]!.id()];
  let l = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      level.set(id, l);
      for (const t of out.get(id) ?? []) if (!seen.has(t)) next.push(t);
    }
    frontier = next;
    l++;
  }
  for (const u of units) if (!level.has(u.id())) level.set(u.id(), l);
  const byLevel = new Map<number, NodeSingular[]>();
  for (const u of units) {
    const lv = level.get(u.id())!;
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv)!.push(u);
  }
  // wrap each dependency layer to the viewport's aspect so wide trees don't
  // fit-to-specks; busiest cards lead their layer
  const totalArea = units.reduce((s, u) => {
    const b = unitBox(u);
    return s + (b.w + GAP) * (b.h + GAP);
  }, 0);
  const maxW = Math.max(900, Math.sqrt(totalArea * canvasAspect()));
  let y = 0;
  for (const lv of [...byLevel.keys()].sort((a, b) => a - b)) {
    const row = byLevel
      .get(lv)!
      .sort((a, b) => (degree.get(b.id()) ?? 0) - (degree.get(a.id()) ?? 0));
    y += packShelf(row, 0, y, maxW, GAP) + GAP * 2;
  }
}

/** Grid step for the v2 layout: dagre's coordinates are snapped to multiples
 *  of this so cards line up cleanly. Small relative to nodesep/ranksep below,
 *  so snapping tidies fractional offsets without ever colliding cards. */
const V2_GRID = 24;

/**
 * v2 tree/call-graph layout — dagre's layered DAG engine over the unit graph.
 *
 * Where layoutTreeCards (v1) does BFS leveling + per-level shelf wrapping, this
 * hands the unit adjacency to dagre, which gives a proper Sugiyama layout:
 * longest-path ranks (every call edge points the same way, one rank per depth,
 * no wrapping), cycle breaking (recursion/mutual calls don't strand nodes), and
 * median crossing reduction. We run dagre HEADLESS on units only — never the
 * compound schema/column hierarchy it can't handle — then snap each unit's
 * centre to V2_GRID and place it with moveUnitTo, leaving materialization,
 * restack and routing untouched.
 */
function layoutTreeCardsV2(units: NodeSingular[]): void {
  if (units.length === 0) return;
  const { out } = unitAdjacency(units);
  const g = new dagre.graphlib.Graph({ multigraph: false, compound: false });
  g.setGraph({
    rankdir: "TB", // callers above callees — reads top-down like a call graph
    nodesep: GAP, // horizontal gap within a rank
    ranksep: GAP * 2, // vertical gap between ranks
    marginx: 0,
    marginy: 0,
    ranker: "network-simplex", // tight, balanced ranks
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const u of units) {
    const b = unitBox(u);
    g.setNode(u.id(), { width: b.w, height: b.h });
  }
  for (const [s, targets] of out) {
    for (const t of targets) g.setEdge(s, t);
  }
  dagre.layout(g);
  const snap = (v: number): number => Math.round(v / V2_GRID) * V2_GRID;
  for (const u of units) {
    const n = g.node(u.id()) as { x: number; y: number } | undefined;
    if (n) moveUnitTo(u, snap(n.x), snap(n.y));
  }
}

/** Dispatch the tree/call-graph layout to the engine the prefs select. */
function layoutTree(units: NodeSingular[]): void {
  if (prefs.engine === "v2") layoutTreeCardsV2(units);
  else layoutTreeCards(units);
}

// ── obstacle-avoiding edge routing (toggleable heuristic) ──
//
// Cytoscape has no built-in router that avoids node boxes. Since the card
// layouts are ours, a deterministic detour is enough: if an edge's straight
// line crosses any card, re-draw it as Manhattan segments that exit the
// source, run along the outer-left "bus" (always clear of cards), and enter
// the target from its open side. Routed edges use per-edge style bypasses
// (curve-style: segments), cleared and recomputed after every layout/reveal.

/** True when an edge is actually being drawn right now (class-derived). */
function edgeShownForRouting(e: EdgeSingular): boolean {
  if (e.hasClass("agg-suppressed") || edgeHidden(e)) return false;
  const revealed = e.hasClass("revealed") || e.hasClass("hover-reveal");
  if (!revealed) {
    const mode = edgeMode();
    if (mode === "off") return false;
    if (mode === "cards" && !e.data("agg")) return false;
    if (mode === "all" && e.data("agg")) return false;
  }
  return isShown(e.source() as NodeSingular) && isShown(e.target() as NodeSingular);
}

const routedEdges = new Set<string>();

function clearEdgeRouting(): void {
  if (!cy) return;
  adapterClearEdgeRouting(cy, routedEdges);
}

function routeEdgesAroundCards(): void {
  if (!cy) return;
  clearEdgeRouting();
  if (!prefs.route) return;
  const units = cardUnits();
  const boxes = units.map((u) => {
    const b = unitBox(u);
    return { id: u.id(), box: { x1: b.x1 - 10, y1: b.y1 - 10, x2: b.x2 + 10, y2: b.y2 + 10 } };
  });
  if (boxes.length === 0) return;
  const obstacleIndex = new ObstacleIndex(boxes);
  let inspected = 0;
  cy.edges().forEach((edge) => {
    const e = edge as EdgeSingular;
    if (!edgeShownForRouting(e) || inspected++ >= 2_000) return;
    const sU = unitOf(e.source() as NodeSingular).id();
    const tU = unitOf(e.target() as NodeSingular).id();
    if (sU === tU) return;
    const sp = e.source().position();
    const tp = e.target().position();
    const blocked = obstacleIndex.intersects(sp.x, sp.y, tp.x, tp.y, sU, tU);
    if (!blocked) return;
    const sBox = obstacleIndex.box(sU);
    const tBox = obstacleIndex.box(tU);
    const down = tp.y >= sp.y;
    const outY = down ? (sBox?.y2 ?? sp.y) + 6 : (sBox?.y1 ?? sp.y) - 6;
    const inY = down ? (tBox?.y1 ?? tp.y) - 6 : (tBox?.y2 ?? tp.y) + 6;
    // Absolute waypoints become cytoscape relative segment-weights/-distances.
    applyEdgeSegments(routedEdges, e, sp, tp, [
      { x: sp.x, y: outY },
      { x: obstacleIndex.busX, y: outY },
      { x: obstacleIndex.busX, y: inY },
      { x: tp.x, y: inY },
    ]);
  });
}

function runLayout(): void {
  if (!cy) return;
  // prefs.layout "tree" is what layoutTreeCards keys off as "breadthfirst"
  const name = prefs.layout === "tree" ? "breadthfirst" : "grid";
  // Taxi routing has no parallel-edge separation; parallel card pairs stay bezier.
  markSingleCardEdgesOrthogonal(cy);
  restackRows();
  const units = cardUnits();
  if (name === "breadthfirst") layoutTree(units);
  else layoutGridCards(units);
  routeEdgesAroundCards();
  fitView();
}

// ── selection ──

function selectNode(node: NodeSingular): void {
  if (!cy) return;
  // the call tree OWNS its revealed/agg-suppressed coating — selection only
  // drives the hot layer and the panel there (one stray tap used to wipe
  // every visible edge of the chain)
  if (view?.mode === "calltree") {
    clearHotEdges(cy);
    const unit = unitOf(node);
    markCallTreeHot(unit);
    renderPanel(node);
    return;
  }
  applySelectionClasses(cy, node, unitOf);
  routeEdgesAroundCards();
  renderPanel(node);
}

function clearSelection(): void {
  if (!cy) return;
  if (view?.mode === "calltree") {
    clearHotEdges(cy);
    hidePanel();
    return;
  }
  if (view?.mode === "focus") {
    // background tap re-selects the origin instead of blanking the view
    const root = cy.getElementById(view.rootId);
    if (root.nonempty()) {
      selectNode(root as unknown as NodeSingular);
      return;
    }
  }
  clearSelectionClasses(cy);
  hidePanel();
  if (!view && edgeMode() !== "all") {
    dematerializeAll();
    restackRows();
  }
  routeEdgesAroundCards();
}

// ── focus mode & call tree ──
//
// Views are DECLARATIVE: a ViewSpec describes the whole view, and entering
// one always goes base → spec (leaveToBase first), never diffing one view
// against another. That, plus class-group ownership in core.ts, is the fix
// for the "swapping focus corrupts state" family of bugs.

/** Declarative description of the active isolated view. */
interface ViewSpec {
  mode: "focus" | "calltree";
  /** the node the view was opened from — its panel button renders pressed */
  rootId: string;
  keep: Set<string>;
  crumb: string;
  /** base-state positions, snapshotted BEFORE the view mutated anything */
  saved: PositionSnapshot;
  /** call tree only */
  fns?: Set<string>;
  levels?: number;
  touchedRows?: Set<string>;
  onlyTouched?: boolean;
}
let view: ViewSpec | null = null;
/** the one pending readable-zoom nudge — re-entering a view cancels it */
let zoomNudge: number | undefined;
let hoverUnit: string | null = null;

function clearViewUiState(): void {
  hoverUnit = null;
  el("content").classList.remove("view-focus", "view-calltree");
}

function qualifiedNodeLabel(node: NodeSingular): string {
  return `${node.data("schema") ?? ""}.${node.data("label")}`;
}

/** Crumb bar rendered FROM the spec; listeners dispatch by rootId, never
 *  through captured elements (stale after dematerialize/materialize). */
function renderCrumb(): void {
  const crumb = el("crumb");
  if (!view) {
    crumb.classList.add("hidden");
    return;
  }
  crumb.classList.remove("hidden");
  const stepper =
    view.mode === "calltree"
      ? `<span class="crumb-opt">levels
           <button class="lvl-btn" id="crumb-lvl-dn" title="fewer levels">−</button>
           <span class="lvl-val">${view.levels ?? 2}</span>
           <button class="lvl-btn" id="crumb-lvl-up" title="more levels">+</button>
         </span>
         <label class="crumb-opt"><input type="checkbox" id="crumb-cols" ${
           view.onlyTouched !== false ? "checked" : ""
         } />touched columns only</label>`
      : "";
  crumb.innerHTML = `<span>${esc(view.crumb)}</span>${stepper}<button id="crumb-back">back</button>`;
  crumb.querySelector("#crumb-back")?.addEventListener("click", () => exitView(true));
  crumb.querySelector("#crumb-lvl-dn")?.addEventListener("click", () => {
    if (view && (view.levels ?? 2) > 1) showCallTreeById(view.rootId, (view.levels ?? 2) - 1);
  });
  crumb.querySelector("#crumb-lvl-up")?.addEventListener("click", () => {
    if (view) showCallTreeById(view.rootId, (view.levels ?? 2) + 1);
  });
  crumb.querySelector("#crumb-cols")?.addEventListener("change", (ev) => {
    if (view?.mode !== "calltree") return;
    view.onlyTouched = (ev.target as HTMLInputElement).checked;
    applyCallTreePresentation();
  });
}

function hideCrumb(): void {
  el("crumb").classList.add("hidden");
}

/** Call-tree neatness: hide rows the chain doesn't touch (crumb toggle). */
function applyCallTreeColumnFilter(): void {
  if (!cy || view?.mode !== "calltree") return;
  const onlyTouched = view.onlyTouched !== false;
  const touched = view.touchedRows ?? new Set<string>();
  adapterApplyCallTreeColumnFilter(cy, onlyTouched, touched);
}

/** Return to the canonical base state (no refit) — safe from any state. */
function leaveToBase(): void {
  if (!cy || !view) return;
  const { saved } = view;
  view = null;
  window.clearTimeout(zoomNudge);
  clearViewUiState();
  dematerializeAll();
  resetViewState(cy);
  restoreViewPositions(cy, saved);
  hideCrumb();
  // re-establish what the view bypassed: edge-mode "all" re-materializes,
  // the isolated mask recomputes, stale view-anchored routing is replaced
  applyFilters();
  routeEdgesAroundCards();
}

function exitView(refit: boolean): void {
  if (!view) return;
  leaveToBase();
  if (refit) fitView();
}

/** Enter (or switch to) an isolated view: always base → spec. */
function enterView(spec: Omit<ViewSpec, "saved">): void {
  if (!cy) return;
  leaveToBase(); // no-op when already in base
  const saved = snapshotPositions(cy); // TRUE base positions, pre-mutation
  view = { ...spec, saved };
  resetViewState(cy); // strip selection highlights left in base
  clearViewUiState();
  applyKeepMask(cy, view.keep);
  el("content").classList.add(`view-${view.mode}`);
  renderCrumb();
}

/** 1-hop card neighborhood, isolated, re-laid-out, with the origin selected. */
function focusNode(node: NodeSingular): void {
  if (!cy) return;
  const unit = unitOf(node);
  const keep = new Set<string>([unit.id()]);
  cy.edges("[?agg]").forEach((e) => {
    if (edgeHidden(e as EdgeSingular)) return;
    if (e.source().id() === unit.id()) keep.add(e.target().id());
    if (e.target().id() === unit.id()) keep.add(e.source().id());
  });
  const label = qualifiedNodeLabel(node);
  enterView({ mode: "focus", rootId: node.id(), keep, crumb: `Focused: ${label} · 1 hop` });
  if (node.id() !== unit.id()) materializeNeighborhood(unit.id());
  else materializeCard(unit.id());
  applyFilters();
  // the focused ITEM is the star: when it's a row, collapse its (possibly
  // huge) table to the clicked row plus rows related outside the card —
  // a 200-column table must not dwarf the thing being focused
  if (node.id() !== unit.id()) {
    applyFocusedRowFilter(cy, node, unit, keep, unitOf);
  }
  runLayout();
  // leaveToBase (inside enterView) dematerializes rows: the clicked row node
  // may have been REMOVED and re-added — a stale reference has no edges, so
  // the panel would render "no connections". Re-resolve by id.
  const live = cy.getElementById(node.id());
  selectNode((live.nonempty() ? live : unit) as unknown as NodeSingular);
}

/** Rebuild the call-tree presentation from the current spec — the crumb's
 *  column toggle re-runs this; the depth stepper re-enters the whole view. */
function applyCallTreePresentation(): void {
  if (!cy || view?.mode !== "calltree") return;
  const spec = view;
  const keep = spec.keep;
  const fns = spec.fns ?? new Set<string>();
  const onlyTouched = spec.onlyTouched !== false;
  const onChain = (kind: string, srcUnit: string, tgtUnit: string, tgtId: string): boolean => {
    if (!keep.has(srcUnit) || !keep.has(tgtUnit)) return false;
    if (kind === "executes") return fns.has(tgtId) || fns.has(tgtUnit);
    if (kind === "calls") return fns.has(srcUnit) || fns.has(tgtUnit);
    if (DATA_KINDS.has(kind)) return fns.has(srcUnit);
    return false;
  };

  // make the chain's column detail available, then reveal ONLY the chain
  for (const id of keep) materializeCard(id);
  applyFilters();
  const touchedRows = collectCallTreeTouchedRows(cy, ROW_TYPES, unitOf, onChain);

  // tables the chain touches only at WHOLE-TABLE level (no column detail —
  // think regex-fallback inserts/deletes) have zero touched rows; hiding
  // all rows makes their compound render as NOTHING. Collapse them back to
  // compact virtual cards instead — the agg pass below still draws their
  // edges because no detail pair survives to suppress it.
  if (onlyTouched) {
    dematerializeCardsWithoutTouchedRows(cy, materializationState(), keep, touchedRows);
  }

  revealCallTreeEdges(cy, unitOf, onChain);
  spec.touchedRows = touchedRows;
  applyCallTreeColumnFilter();
  restackRows();
  layoutTree(cardUnits());
  routeEdgesAroundCards();
  fitView();
}

/** Crumb stepper entry point — resolves the live root by id. */
function showCallTreeById(id: string, levels: number): void {
  const n = cy?.getElementById(id);
  if (n && n.nonempty()) showCallTree(n as unknown as NodeSingular, levels);
}

/**
 * Call tree: from a trigger/function, follow executes/calls up to `levels`
 * deep, plus the root's direct callers for context, plus every table the
 * closure touches.
 */
function showCallTree(node: NodeSingular, levels = 2): void {
  if (!cy) return;
  const { fns, keep } = callTreeClosure(cy, node, levels);
  const label = qualifiedNodeLabel(node);
  // re-entering the same root (depth stepper) keeps the column-filter choice
  const onlyTouched =
    view?.mode === "calltree" && view.rootId === node.id() ? view.onlyTouched !== false : true;
  enterView({
    mode: "calltree",
    rootId: node.id(),
    keep,
    fns,
    levels,
    onlyTouched,
    crumb: `Call tree: ${label}`,
  });
  applyCallTreePresentation();
  // leaveToBase (inside enterView) may have removed and re-created the
  // clicked row — re-resolve so panel/zoom see the live node
  const live = cy.getElementById(node.id());
  if (live.nonempty()) node = live as unknown as NodeSingular;

  // wide trees fit to specks — one readable-zoom nudge; entering any other
  // view first cancels it (stored handle + rootId guard)
  window.clearTimeout(zoomNudge);
  const rootId = node.id();
  zoomNudge = window.setTimeout(() => {
    if (!cy || view?.rootId !== rootId || cy.zoom() >= 0.3) return;
    const root = cy.getElementById(rootId);
    if (root.nonempty()) {
      cy.animate({ zoom: 0.5, center: { eles: root }, duration: 200 } as never);
    }
  }, 300);
  renderPanel(node);
}

function wireHoverPreview(): void {
  if (!cy) return;
  cy.on("mouseover", "node", (ev) => {
    const unit = unitOf(ev.target as NodeSingular);
    if (hoverUnit === unit.id()) return;
    clearHoverReveal(cy!);
    hoverUnit = unit.id();
    setHoverReveal(unit);
  });
  cy.on("mouseout", "node", () => {
    hoverUnit = null;
    clearHoverReveal(cy!);
  });
  // cursor affordance: pointer over interactive nodes, default for panning
  const container = el("cy");
  cy.on("mouseover", "node", () => {
    container.style.cursor = "pointer";
  });
  cy.on("mouseout", "node", () => {
    container.style.cursor = "";
  });
}

// ── panel ──

/** Incoming relationships read passively: X *is called by* Y, never "Y calls". */
const PASSIVE_KIND: Record<string, string> = {
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

function renderPanel(node: NodeSingular): void {
  const d = node.data() as GraphNodeData;
  el("panel").classList.remove("hidden");
  requestAnimationFrame(() => {
    cy?.resize();
    if (cy) cy.animate({ center: { eles: node }, duration: 150 } as never);
  });
  const panel = el("panel-body");
  postToHost({ type: "nodeSelected", id: node.id() });
  const isCard = rowsByCard.has(node.id()) || node.isParent();
  const edges = (
    isCard ? node.union(node.descendants()).connectedEdges("[?agg]") : node.connectedEdges("[!agg]")
  ).filter((e) => edgeShownByClasses(e as EdgeSingular));
  const records: {
    kind: string;
    counterUnit: string;
    out: boolean;
    agg?: boolean;
    detail?: boolean;
    data: GraphEdgeData;
    other: NodeSingular;
  }[] = [];
  edges.forEach((e: EdgeSingular) => {
    const data = e.data() as GraphEdgeData;
    const outgoing = node.union(node.descendants()).contains(e.source());
    const other = (outgoing ? e.target() : e.source()) as NodeSingular;
    records.push({
      kind: data.kind,
      counterUnit: unitOf(other).id(),
      out: outgoing,
      agg: data.agg,
      detail: data.detail,
      data,
      other,
    });
  });
  const outRows: string[] = [];
  const inRows: string[] = [];
  // when a relationship's columns are listed, its table-level rollup is noise
  for (const rec of suppressRedundantAggs(records)) {
    const { data, other, out: outgoing } = rec;
    const otherData = other.data() as GraphNodeData;
    const owner = ROW_TYPES.has(otherData.type)
      ? String(other.parent().first().data("label") ?? "")
      : "";
    const display = owner ? `${owner}.${otherData.label}` : otherData.label;
    const visibleKindCounts = data.kinds
      ? Object.fromEntries(
          Object.entries(data.kinds).filter(
            ([kind]) =>
              prefs.filterEdgeKinds.length === 0 ||
              prefs.filterEdgeKinds.includes(kind as EdgeKind),
          ),
        )
      : undefined;
    const kindLabel = visibleKindCounts
      ? Object.entries(visibleKindCounts)
          .map(
            ([kind, count]) =>
              `${outgoing ? kind : (PASSIVE_KIND[kind] ?? `${kind} by`)}${count > 1 ? ` ×${count}` : ""}`,
          )
          .join(", ")
      : `${outgoing ? data.kind : (PASSIVE_KIND[data.kind] ?? `${data.kind} by`)}${data.count && data.count > 1 ? ` ×${data.count}` : ""}`;
    // Aggregate edge members come from the payload when detail edges are not materialized.
    const cols = data.agg
      ? aggregateMemberLabels(
          { ...data, kinds: visibleKindCounts },
          detailEdgesByCard,
          nodeDefById,
          cardOfNode,
          ROW_TYPES,
        )
      : "";
    (outgoing ? outRows : inRows).push(`<li data-node="${esc(other.id())}">
        <span class="kind" style="color:${data.agg ? "#8993A4" : (EDGE_COLORS[data.kind] ?? "#8993A4")}">${outgoing ? "→" : "←"} ${esc(kindLabel)}</span>
        <span class="name">${esc(display)}</span>
        <small>${esc(otherData.type)}</small>
        ${cols ? `<span class="cols">${esc(cols)}</span>` : ""}
      </li>`);
  }
  const ownerTable = ROW_TYPES.has(d.type) ? String(node.parent().first().data("label") ?? "") : "";
  const where = ownerTable ? `${d.schema ?? ""}.${ownerTable}` : (d.schema ?? "");
  const canCallTree = d.type === "function" || d.type === "trigger";
  panel.innerHTML = `
    <button class="close" id="panel-close" title="close">✕</button>
    <h2>${esc(d.label)}</h2>
    <p class="meta">
      <span class="chip" style="background:${NODE_COLORS[d.type] ?? "#888"}">${esc(d.type)}</span>
      <span>${esc(where)}</span>
    </p>
    ${d.detail ? `<p class="detail">${esc(d.detail)}</p>` : ""}
    <div class="actions">
      ${d.type === "schema" ? "" : '<button id="def-btn" title="jump to source definition (.hcl, up.sql, then DDL)">Go to definition</button><button id="ddl-btn">Open DDL</button>'}
      <button id="focus-btn" class="${view?.mode === "focus" && view.rootId === node.id() ? "active-focus" : ""}">Focus</button>
      ${canCallTree ? `<button id="calltree-btn" class="${view?.mode === "calltree" && view.rootId === node.id() ? "active-calltree" : ""}">Call tree</button>` : ""}
    </div>
    ${outRows.length > 0 ? `<details ${outRows.length <= 12 ? "open" : ""}><summary>Uses (${outRows.length})</summary><ul class="edge-list">${outRows.join("")}</ul></details>` : ""}
    ${inRows.length > 0 ? `<details ${inRows.length <= 12 ? "open" : ""}><summary>Used by (${inRows.length})</summary><ul class="edge-list">${inRows.join("")}</ul></details>` : ""}
    ${outRows.length === 0 && inRows.length === 0 ? "<h3>No connections</h3>" : ""}`;
  panel.querySelector("#panel-close")?.addEventListener("click", () => {
    if (view) {
      // keep the view, just dismiss the panel — clearSelection in focus mode
      // re-selects the origin, which would immediately reopen it
      if (cy) clearHotEdges(cy);
      hidePanel();
    } else {
      clearSelection();
    }
  });

  // parent lookups resolved NOW, while the node is live — the panel outlives
  // view transitions that remove row nodes, and traversal on a removed
  // element returns nothing
  const ddlTarget = d.type === "column" ? (node.parent().first().data() as GraphNodeData) : d;
  panel.querySelector("#ddl-btn")?.addEventListener("click", () => {
    const td = ddlTarget;
    postToHost({
      type: "openDdl",
      nodeType: td.type,
      oid: td.oid,
      schema: td.schema ?? "",
      name: td.label,
      label: `${td.schema ?? ""}.${td.label}`,
    });
  });
  panel.querySelector("#def-btn")?.addEventListener("click", () => {
    const owner = ownerTable; // resolved at render time — see ddlTarget note
    postToHost({
      type: "openDefinition",
      nodeType: d.type,
      oid: d.oid,
      schema: d.schema ?? "",
      name: d.label,
      owner,
      label: `${d.schema ?? ""}.${d.label}`,
    });
  });
  // exiting/entering a view removes and re-adds row nodes — every handler
  // must re-resolve by id, never act on the node captured at render time
  const liveNode = (id: string): NodeSingular | null => {
    const direct = cy?.getElementById(id);
    if (direct && direct.nonempty()) return direct as unknown as NodeSingular;
    const card = cardOfNode.get(id);
    const fallback = card ? cy?.getElementById(card) : undefined;
    return fallback && fallback.nonempty() ? (fallback as unknown as NodeSingular) : null;
  };
  // toggles: pressing the active view's button on its origin node exits it
  panel.querySelector("#focus-btn")?.addEventListener("click", () => {
    const id = node.id();
    if (view?.mode === "focus" && view.rootId === id) {
      exitView(true);
      const live = liveNode(id);
      if (live) selectNode(live);
    } else {
      const live = liveNode(id);
      if (live) focusNode(live);
    }
  });
  panel.querySelector("#calltree-btn")?.addEventListener("click", () => {
    const id = node.id();
    if (view?.mode === "calltree" && view.rootId === id) {
      exitView(true);
      const live = liveNode(id);
      if (live) selectNode(live);
    } else {
      const live = liveNode(id);
      if (live) showCallTree(live);
    }
  });
  panel.querySelectorAll<HTMLElement>("li[data-node]").forEach((li) => {
    li.addEventListener("click", () => {
      const other = cy?.getElementById(li.dataset.node!);
      // never navigate to a node the current view hides — the camera would
      // fly to its off-view saved position and show blank space
      if (other && other.nonempty() && isShown(other as unknown as NodeSingular)) {
        selectNode(other as unknown as NodeSingular);
        cy?.animate({ center: { eles: other }, duration: 200 } as never);
      }
    });
  });
}

/** Isolate one schema's tables/views/functions (clicking a schema in the tree). */
function focusSchema(s: NodeSingular): void {
  if (!cy) return;
  const name = String(s.data("label"));
  const keep = new Set<string>();
  for (const u of coreCardUnits(cy)) {
    if (String(u.data("schema") ?? "") === name) keep.add(u.id());
  }
  enterView({ mode: "focus", rootId: s.id(), keep, crumb: `Schema: ${name}` });
  applyFilters();
  runLayout();
}

/** Tree click → focus view on that node (schemas isolate the whole schema). */
function jumpToNode(id: string): void {
  if (!cy) return;
  const target = cy.getElementById(id);
  if (target.nonempty() && target.data("type") === "schema") {
    focusSchema(target as unknown as NodeSingular);
    return;
  }
  exitView(false);
  // virtual rows only exist in cy once their card is materialized
  const card = cardOfNode.get(id);
  if (card && !materialized.has(card)) materializeCard(card);
  const ele = cy.getElementById(id);
  if (ele.empty()) return;
  focusNode(ele as unknown as NodeSingular);
}

function updateStats(): void {
  if (!cy) return;
  const units = coreCardUnits(cy);
  const visibleUnits = units.filter((node) => isShown(node)).length;
  const visibleEdges = cy
    .edges()
    .filter((edge) => edgeShownForRouting(edge as EdgeSingular)).length;
  const activeFilters =
    prefs.filterSchemas.length + prefs.filterNodeTypes.length + prefs.filterEdgeKinds.length;
  const totalRows = [...rowsByCard.values()].reduce((sum, rows) => sum + rows.length, 0);
  const liveRows = [...materialized].reduce(
    (sum, id) => sum + (rowsByCard.get(id)?.length ?? 0),
    0,
  );
  const parts = [
    `${visibleUnits}/${units.length} objects`,
    `${visibleEdges} connections`,
    activeFilters > 0 ? `${activeFilters} filters` : "",
    edgeMode() === "all" && liveRows < totalRows ? `detail budget ${liveRows}/${totalRows}` : "",
  ].filter(Boolean);
  const text = `${database ? `${database} · ` : ""}${parts.join(" · ")}`;
  // on-canvas overlay (bottom-right, like the legend)…
  el("stats").textContent = text;
  // …and the extension mirrors it into the status bar tooltip
  postToHost({ type: "stats", text });
}

function buildLegend(): void {
  if (!cy) {
    el("legend").textContent = "";
    return;
  }
  const nodeTypes = new Set(
    cy
      .nodes()
      .filter((node) => isShown(node as NodeSingular) && node.data("type") !== "schema")
      .map((node) => String(node.data("type"))),
  );
  const edgeKinds = new Set<string>();
  cy.edges("[?agg]").forEach((edge) => {
    if (!edgeShownByClasses(edge as EdgeSingular)) return;
    const kinds = edge.data("kinds") as Record<string, number> | undefined;
    for (const kind of kinds ? Object.keys(kinds) : [String(edge.data("kind"))]) {
      if (prefs.filterEdgeKinds.length === 0 || prefs.filterEdgeKinds.includes(kind as EdgeKind)) {
        edgeKinds.add(kind);
      }
    }
  });
  const groups = [
    { name: "data", color: EDGE_COLORS.reads, kinds: DATA_KINDS },
    { name: "calls", color: EDGE_COLORS.calls, kinds: new Set(["calls", "executes"]) },
    {
      name: "structure",
      color: EDGE_COLORS.fk,
      kinds: new Set(["fk", "constrains", "indexes", "default", "update-of"]),
    },
  ];
  const items = [
    ...Object.entries(NODE_COLORS)
      .filter(([name]) => nodeTypes.has(name))
      .map(
        ([name, color]) => `<span><i class="dot" style="background:${color}"></i>${name}</span>`,
      ),
    ...groups
      .filter((group) => [...group.kinds].some((kind) => edgeKinds.has(kind)))
      .map(
        (group) =>
          `<span><i class="line" style="background:${group.color}"></i>${group.name}</span>`,
      ),
  ];
  el("legend").innerHTML = items.join("");
  el("reset-filters").classList.toggle(
    "hidden",
    prefs.filterSchemas.length + prefs.filterNodeTypes.length + prefs.filterEdgeKinds.length === 0,
  );
}

// ── wiring ──

/** A reveal that arrived before the graph did — applied right after render. */
let pendingRevealId: string | null = null;

/**
 * Apply a prefs update from the extension, doing the minimal cytoscape work
 * for whatever actually changed (a full re-render is far too heavy for a
 * single toggle). Diffed against the previous mirror, then the mirror is
 * advanced.
 */
function applyPrefs(next: Prefs): void {
  const prev = prefs;
  prefs = next;
  if (!cy) return;
  if (!sameList(next.filterNodeTypes, prev.filterNodeTypes)) {
    for (const id of rowsByCard.keys()) {
      const definition = nodeDefById.get(id);
      if (!definition) continue;
      buildCardArt(definition);
      const card = cy.getElementById(id);
      if (card.nonempty()) {
        card.data("svg", definition.data.svg);
        card.data("cardW", definition.data.cardW);
        card.data("cardH", definition.data.cardH);
      }
    }
  }
  // engine swaps the tree/call-graph layout — re-run if it changed, or if the
  // layout shape changed. In a call-tree view, relayout in place so the chain
  // re-ranks without exiting the view.
  if (next.layout !== prev.layout || next.engine !== prev.engine) {
    if (view?.mode === "calltree") applyCallTreePresentation();
    else runLayout();
  }
  if (next.edgeMode !== prev.edgeMode) {
    // leaving "all" with no active view: collapse the rows it force-materialized
    if (prev.edgeMode === "all" && !view) dematerializeAll();
    applyFilters();
    routeEdgesAroundCards();
  }
  if (next.schemaGroup !== prev.schemaGroup) applySchemaGrouping(true);
  if (next.route !== prev.route) routeEdgesAroundCards();
  if (
    next.hideIsolated !== prev.hideIsolated ||
    !sameList(next.filterSchemas, prev.filterSchemas) ||
    !sameList(next.filterNodeTypes, prev.filterNodeTypes) ||
    !sameList(next.filterEdgeKinds, prev.filterEdgeKinds)
  ) {
    applyFilters();
    routeEdgesAroundCards();
  }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** searchGraph picker → light a card and centre on it (selection only, no view). */
function searchSelect(id: string): void {
  if (!cy) return;
  const card = cardOfNode.get(id);
  if (view) exitView(false);
  if (card) {
    materializeNeighborhood(card);
    applyFilters();
  }
  const ele = cy.getElementById(id);
  if (ele.empty()) return;
  selectNode(ele as unknown as NodeSingular);
  cy.animate({ center: { eles: ele }, duration: 200 } as never);
}

/** tree "Call Tree" → show the call tree for a function/trigger, else focus it. */
function callTreeById(id: string): void {
  if (!cy) return;
  exitView(false);
  const card = cardOfNode.get(id);
  if (card && !materialized.has(card)) materializeCard(card);
  const ele = cy.getElementById(id);
  if (ele.empty()) return;
  const node = ele as unknown as NodeSingular;
  const t = String(node.data("type"));
  if (t === "function" || t === "trigger") showCallTree(node);
  else focusNode(node);
}

function exportPng(): void {
  if (!cy) return;
  requestAnimationFrame(() => {
    if (!cy) return;
    postToHost({
      type: "pngExport",
      dataUri: cy.png({ full: true, scale: 2, bg: isDark() ? "#1e1e1e" : "#ffffff" }),
    });
  });
}

function exportSvg(): void {
  if (!cy) return;
  requestAnimationFrame(() => {
    if (!cy) return;
    const nodes = cy.nodes().filter((n) => isShown(n as NodeSingular));
    const edges = cy.edges().filter((e) => edgeShownForRouting(e as EdgeSingular));
    const bb = nodes.nonempty()
      ? nodes.boundingBox({ includeLabels: true, includeOverlays: false })
      : { x1: 0, y1: 0, w: 800, h: 600 };
    const pad = 48;
    const x0 = bb.x1 - pad;
    const y0 = bb.y1 - pad;
    const w = Math.max(1, bb.w + pad * 2);
    const h = Math.max(1, bb.h + pad * 2);
    const colorOf = (n: NodeSingular): string => NODE_COLORS[String(n.data("type"))] ?? "#8f9bb3";
    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w)}" height="${Math.ceil(h)}" viewBox="${x0} ${y0} ${w} ${h}">`,
      `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="${isDark() ? "#1e1e1e" : "#ffffff"}"/>`,
    ];
    edges.forEach((e) => {
      const s = e.source().position();
      const t = e.target().position();
      const color = EDGE_COLORS[String(e.data("kind"))] ?? "#6b778c";
      parts.push(
        `<line x1="${s.x}" y1="${s.y}" x2="${t.x}" y2="${t.y}" stroke="${color}" stroke-width="1.5" stroke-opacity="0.75"/>`,
      );
    });
    nodes.forEach((raw) => {
      const n = raw as NodeSingular;
      const p = n.position();
      const label = esc(n.data("label"));
      if (n.isParent()) {
        const box = n.boundingBox({ includeLabels: false, includeOverlays: false });
        parts.push(
          `<rect x="${box.x1}" y="${box.y1}" width="${box.w}" height="${box.h}" rx="6" fill="${colorOf(n)}" fill-opacity="0.08" stroke="${colorOf(n)}" stroke-opacity="0.35"/>`,
        );
      } else {
        parts.push(
          `<circle cx="${p.x}" cy="${p.y}" r="8" fill="${colorOf(n)}"/><text x="${p.x + 12}" y="${p.y + 4}" font-family="sans-serif" font-size="11" fill="${isDark() ? "#d4d4d4" : "#172b4d"}">${label}</text>`,
        );
      }
    });
    parts.push("</svg>");
    postToHost({ type: "svgExport", svg: parts.join("") });
  });
}

window.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as HostToWebviewMessage;
  if (msg.type === "graph") {
    database = msg.database ?? "";
    render(msg.graph);
    if (pendingRevealId) {
      const id = pendingRevealId;
      pendingRevealId = null;
      jumpToNode(id);
    }
  } else if (msg.type === "clear") {
    cy?.destroy();
    cy = null;
    hidePanel();
    hideCrumb();
    el("empty").style.display = "flex";
    el("empty").textContent = msg.message;
  } else if (msg.type === "prefs") {
    applyPrefs(normalizePrefs(msg.prefs));
  } else if (msg.type === "reveal") {
    if (cy) jumpToNode(String(msg.id ?? ""));
    else pendingRevealId = String(msg.id ?? "");
  } else if (msg.type === "searchSelect") {
    searchSelect(String(msg.id ?? ""));
  } else if (msg.type === "callTreeById") {
    callTreeById(String(msg.id ?? ""));
  } else if (msg.type === "fit") {
    fitView(undefined, 40);
  } else if (msg.type === "relayout") {
    runLayout();
  } else if (msg.type === "exitView") {
    exitView(true);
  } else if (msg.type === "exportPng") {
    exportPng();
  } else if (msg.type === "exportSvg") {
    exportSvg();
  } else if (msg.type === "status") {
    if (!cy) {
      el("empty").style.display = "flex";
      el("empty").textContent = String(msg.message ?? "");
    }
  } else if (msg.type === "error") {
    if (!cy) {
      el("empty").style.display = "flex";
      el("empty").textContent = `Error: ${msg.message ?? "unknown"}`;
    }
  }
});

window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") exitView(true);
});

// search / layout / edge-mode / filters / fit / relayout / refresh are all
// driven natively now — QuickPicks and title-bar actions post messages handled
// above. The webview only owns the canvas, crumb, legend, details panel.

// side panel resize: drag the left edge (no native webview splitter exists)
{
  const panelEl = el("panel");
  const handle = el("panel-resize");
  let resizing = false;
  handle.addEventListener("pointerdown", (ev) => {
    resizing = true;
    handle.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  handle.addEventListener("pointermove", (ev) => {
    if (!resizing) return;
    const width = Math.min(680, Math.max(220, window.innerWidth - ev.clientX - 8));
    panelEl.style.width = `${width}px`;
    cy?.resize();
  });
  handle.addEventListener("pointerup", (ev) => {
    resizing = false;
    handle.releasePointerCapture(ev.pointerId);
  });
}
buildLegend();
el("reset-filters").addEventListener("click", () => postToHost({ type: "resetFilters" }));
postToHost({ type: "ready" });
