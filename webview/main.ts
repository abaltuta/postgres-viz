import "@vscode-elements/elements/dist/bundled.js";
import cytoscape, { Core, EdgeSingular, NodeSingular } from "cytoscape";
import type { GraphEdgeData, GraphNodeData, GraphPayload } from "../src/types";
import { callTreeClosure, DATA_KINDS, fitTarget, isShownByClasses, unitOf } from "./core";

const vscode = acquireVsCodeApi();

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

type NodeDef = { data: GraphNodeData };
type EdgeDef = { data: GraphEdgeData };

let cy: Core | null = null;
let database = "";
let lastStats: Record<string, number> = {};

/**
 * Virtual rows: the full payload lives here; column/trigger/constraint row
 * nodes (and their detail edges) are added to cytoscape only when a card is
 * interacted with. Idle cards draw their column list as an SVG background.
 */
let payload: GraphPayload | null = null;
const rowsByCard = new Map<string, NodeDef[]>();
const detailEdgesByCard = new Map<string, EdgeDef[]>();
const cardOfNode = new Map<string, string>(); // row id → card id
const nodeDefById = new Map<string, NodeDef>();
const materialized = new Set<string>();
const MATERIALIZE_CAP = 30;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
// vscode-elements web components expose .checked/.value like native inputs
const checked = (id: string): boolean =>
  Boolean((el(id) as unknown as { checked?: boolean }).checked);
const valueOf = (id: string): string =>
  String((el(id) as unknown as { value?: string }).value ?? "");
const edgeMode = (): string => valueOf("edge-mode") || "off";

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

function cardDims(label: string, rows: NodeDef[], extraLines = 0): { w: number; h: number } {
  let maxLen = label.length;
  for (const r of rows) maxLen = Math.max(maxLen, String(r.data.label).length);
  const w = Math.max(90, maxLen * 6.2 + 24);
  const h = HEADER_H + (rows.length + extraLines) * ROW_H + 8;
  return { w, h };
}

function buildCardArt(card: NodeDef): void {
  const all = rowsByCard.get(card.data.id) ?? [];
  const rows = all.slice(0, MAX_ART_ROWS);
  const extra = all.length - rows.length;
  const { w, h } = cardDims(card.data.label, rows, extra > 0 ? 1 : 0);
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
  if (!cy || materialized.has(cardId) || !rowsByCard.has(cardId)) return;
  const card = cy.getElementById(cardId);
  if (card.empty()) return;
  const center = { ...card.position() };
  const rows = rowsByCard.get(cardId)!;
  materialized.add(cardId);
  cy.batch(() => {
    card.removeClass("virtual-card");
    cy!.add(
      rows.map((r, i) => ({
        group: "nodes" as const,
        data: r.data,
        position: { x: center.x, y: center.y + i }, // restack trues this up
      })),
    );
    for (const e of detailEdgesByCard.get(cardId) ?? []) {
      if (cy!.getElementById(e.data.id).nonempty()) continue;
      if (
        cy!.getElementById(e.data.source).nonempty() &&
        cy!.getElementById(e.data.target).nonempty()
      ) {
        cy!.add({ group: "edges" as const, data: e.data });
      }
    }
  });
}

/** Materialize a card plus the counterpart cards of its detail edges (capped). */
function materializeNeighborhood(unitId: string): void {
  materializeCard(unitId);
  const counters = new Set<string>();
  for (const e of detailEdgesByCard.get(unitId) ?? []) {
    for (const end of [e.data.source, e.data.target]) {
      const card = cardOfNode.get(end);
      if (card && card !== unitId) counters.add(card);
    }
  }
  let n = 0;
  for (const c of counters) {
    if (n++ >= MATERIALIZE_CAP) break;
    materializeCard(c);
  }
}

function materializeAll(): void {
  for (const id of rowsByCard.keys()) materializeCard(id);
}

/** Collapse one card back to its SVG-art form (callers wrap in cy.batch). */
function dematerializeCard(id: string): void {
  if (!cy || !materialized.has(id)) return;
  const card = cy.getElementById(id);
  if (card.empty()) return;
  const pos = { ...card.position() };
  cy.remove(card.children()); // incident detail edges go with the rows
  card.position(pos);
  card.addClass("virtual-card");
  materialized.delete(id);
}

function dematerializeAll(): void {
  if (!cy || materialized.size === 0) return;
  // iterate a copy — entries are deleted mid-loop
  const ids = Array.from(materialized);
  cy.batch(() => {
    for (const id of ids) dematerializeCard(id);
  });
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
        label: "data(label)",
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
  if (graph.nodes.length > 600) {
    el<HTMLInputElement>("flt-isolated").checked = true;
  }
  payload = graph;
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
  cy.nodes().forEach((n) => {
    if (rowsByCard.has(n.id())) n.addClass("virtual-card");
  });
  viewState = null;
  lastStats = graph.stats;
  applySchemaGrouping(false);
  applyFilters();
  runLayout();
  updateStats();
  cy.on("tap", "node", (ev) => {
    const n = ev.target as NodeSingular;
    const unit = unitOf(n);
    if (rowsByCard.has(unit.id()) && !materialized.has(unit.id()) && !viewState) {
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
  const g = cy;
  if (edgeMode() === "all" && materialized.size < rowsByCard.size && !viewState) {
    materializeAll();
  }
  g.batch(() => {
    const mode = edgeMode();
    g.edges().removeClass("edge-off");
    if (mode === "off") g.edges().addClass("edge-off");
    else if (mode === "cards") g.edges("[?detail]").addClass("edge-off");

    g.nodes().removeClass("isolated-hidden");
    if (checked("flt-isolated")) {
      // keep anything participating in at least one card-level relationship
      const keep = new Set<string>();
      g.edges("[!detail]").forEach((e) => {
        if (e.hasClass("hidden-el")) return;
        keep.add(e.source().id());
        keep.add(e.target().id());
      });
      g.nodes().forEach((n) => {
        if (keep.has(n.id())) {
          n.ancestors().forEach((a) => {
            keep.add(a.id());
          });
          n.descendants().forEach((d) => {
            keep.add(d.id());
          });
        }
      });
      g.nodes().forEach((n) => {
        if (!keep.has(n.id()) && !n.hasClass("hidden-el")) n.addClass("isolated-hidden");
      });
    }
  });
  restackRows();
  updateStats();
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
  cy.batch(() => {
    cy!.nodes(':parent[type != "schema"]').forEach((p) => {
      // class checks, NOT `:visible` — freshly materialized rows have no
      // computed style yet, so `:visible` returns empty and leaves the pile
      const rows = p
        .children()
        .filter(
          (d) =>
            !d.hasClass("hidden-el") &&
            !d.hasClass("isolated-hidden") &&
            !d.hasClass("focus-hidden") &&
            !d.hasClass("untouched-hidden"),
        )
        .sort((a, b) => (Number(a.data("ord")) || 0) - (Number(b.data("ord")) || 0));
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

/** Move tables/views/functions in or out of their schema compound. */
function applySchemaGrouping(relayout: boolean): void {
  if (!cy) return;
  exitView(false);
  const grouped = checked("flt-schemagroup");
  cy.batch(() => {
    cy!.nodes("[schemaParent]").forEach((n) => {
      const target = grouped ? (n.data("schemaParent") as string) : null;
      if ((n.data("parent") ?? null) !== target) n.move({ parent: target });
    });
    cy!.nodes('[type="schema"]').toggleClass("hidden-el", !grouped);
  });
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

/** Every card/standalone unit, regardless of current visibility. */
function allCardUnits(): NodeSingular[] {
  const out: NodeSingular[] = [];
  cy!.nodes().forEach((n) => {
    if (n.data("type") === "schema") return;
    if (ROW_TYPES.has(String(n.data("type")))) return;
    const p = n.parent().first();
    if (p.empty() || p.data("type") === "schema") out.push(n as NodeSingular);
  });
  return out;
}

/** Layout units: the currently shown cards and standalone nodes. */
function cardUnits(): NodeSingular[] {
  return allCardUnits().filter((n) => isShown(n));
}

function shiftUnit(u: NodeSingular, dx: number, dy: number): void {
  (u.isParent() ? u.descendants() : u).shift({ x: dx, y: dy });
}

function moveUnitTo(u: NodeSingular, x: number, y: number): void {
  const bb = u.boundingBox({ includeLabels: false });
  shiftUnit(u, x - (bb.x1 + bb.x2) / 2, y - (bb.y1 + bb.y2) / 2);
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
    const b = u.boundingBox({ includeLabels: true });
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
      const b = u.boundingBox({ includeLabels: true });
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
  cy!.edges("[!detail]").forEach((e) => {
    if (e.hasClass("hidden-el")) return;
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
    const b = u.boundingBox({ includeLabels: true });
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

// ── obstacle-avoiding edge routing (toggleable heuristic) ──
//
// Cytoscape has no built-in router that avoids node boxes. Since the card
// layouts are ours, a deterministic detour is enough: if an edge's straight
// line crosses any card, re-draw it as Manhattan segments that exit the
// source, run along the outer-left "bus" (always clear of cards), and enter
// the target from its open side. Routed edges use per-edge style bypasses
// (curve-style: segments), cleared and recomputed after every layout/reveal.

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Liang-Barsky style segment-vs-rect test. */
function segmentHitsBox(ax: number, ay: number, bx: number, by: number, r: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return (
    clip(-dx, ax - r.x1) &&
    clip(dx, r.x2 - ax) &&
    clip(-dy, ay - r.y1) &&
    clip(dy, r.y2 - ay) &&
    t0 <= t1
  );
}

/** True when an edge is actually being drawn right now (class-derived). */
function edgeShownForRouting(e: EdgeSingular): boolean {
  if (e.hasClass("agg-suppressed") || e.hasClass("hidden-el")) return false;
  const revealed = e.hasClass("revealed") || e.hasClass("hover-reveal");
  if (!revealed) {
    const mode = edgeMode();
    if (mode === "off") return false;
    if (mode === "cards" && e.data("detail")) return false;
  }
  return isShown(e.source() as NodeSingular) && isShown(e.target() as NodeSingular);
}

const routedEdges = new Set<string>();

function clearEdgeRouting(): void {
  if (!cy) return;
  for (const id of routedEdges) {
    const e = cy.getElementById(id);
    if (e.nonempty()) e.removeStyle("curve-style segment-weights segment-distances");
  }
  routedEdges.clear();
}

/** Absolute waypoints → cytoscape's relative segment-weights/-distances. */
function applySegments(
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

function routeEdgesAroundCards(): void {
  if (!cy) return;
  clearEdgeRouting();
  if (!checked("flt-route")) return;
  const units = cardUnits();
  const boxes = units.map((u) => {
    const b = u.boundingBox({ includeLabels: true });
    return { id: u.id(), box: { x1: b.x1 - 10, y1: b.y1 - 10, x2: b.x2 + 10, y2: b.y2 + 10 } };
  });
  if (boxes.length === 0) return;
  const busX = Math.min(...boxes.map((b) => b.box.x1)) - 60;
  cy.edges().forEach((edge) => {
    const e = edge as EdgeSingular;
    if (!edgeShownForRouting(e)) return;
    const sU = unitOf(e.source() as NodeSingular).id();
    const tU = unitOf(e.target() as NodeSingular).id();
    if (sU === tU) return;
    const sp = e.source().position();
    const tp = e.target().position();
    const blocked = boxes.some(
      (b) => b.id !== sU && b.id !== tU && segmentHitsBox(sp.x, sp.y, tp.x, tp.y, b.box),
    );
    if (!blocked) return;
    const sBox = boxes.find((b) => b.id === sU)?.box;
    const tBox = boxes.find((b) => b.id === tU)?.box;
    const down = tp.y >= sp.y;
    const outY = down ? (sBox?.y2 ?? sp.y) + 6 : (sBox?.y1 ?? sp.y) - 6;
    const inY = down ? (tBox?.y1 ?? tp.y) - 6 : (tBox?.y2 ?? tp.y) + 6;
    applySegments(e, sp, tp, [
      { x: sp.x, y: outY },
      { x: busX, y: outY },
      { x: busX, y: inY },
      { x: tp.x, y: inY },
    ]);
  });
}

function runLayout(): void {
  if (!cy) return;
  const name = valueOf("layout") || "grid";
  // taxi routing has NO parallel-edge separation — multiple edges between the
  // same pair (reads + writes to one table) would coincide exactly. Pairs with
  // more than one card-level edge stay bezier, which fans parallels apart.
  const pairCount = new Map<string, number>();
  const pairKey = (e: EdgeSingular): string => {
    const a = e.source().id();
    const b = e.target().id();
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  };
  cy.edges("[!detail]").forEach((e) => {
    const k = pairKey(e);
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
  });
  cy.edges("[!detail]").forEach((e) => {
    e.toggleClass("ortho", (pairCount.get(pairKey(e)) ?? 0) === 1);
  });
  restackRows();
  const units = cardUnits();
  if (name === "breadthfirst") layoutTreeCards(units);
  else layoutGridCards(units);
  routeEdgesAroundCards();
  fitView();
}

// ── selection ──

function selectNode(node: NodeSingular): void {
  if (!cy) return;
  cy.edges().removeClass("hot revealed agg-suppressed");
  const core = node.union(node.descendants());
  const detailEdges = core.connectedEdges("[?detail]");
  const unit = unitOf(node);
  const counterUnits = new Set<string>([unit.id()]);
  detailEdges.forEach((e) => {
    counterUnits.add(unitOf(e.source() as NodeSingular).id());
    counterUnits.add(unitOf(e.target() as NodeSingular).id());
  });
  unit
    .union(unit.descendants())
    .connectedEdges("[?agg]")
    .forEach((e) => {
      if (counterUnits.has(e.source().id()) && counterUnits.has(e.target().id())) {
        e.addClass("agg-suppressed");
      }
    });
  const revealed = detailEdges.union(core.connectedEdges("[!detail]"));
  revealed.addClass("revealed hot");
  const hood = core.closedNeighborhood().union(revealed.connectedNodes()).union(node.ancestors());
  const withParents = hood.union(hood.nodes().ancestors());
  cy.elements().addClass("dimmed");
  withParents.removeClass("dimmed");
  routeEdgesAroundCards();
  renderPanel(node);
}

function clearSelection(): void {
  if (!cy) return;
  cy.elements().removeClass("dimmed");
  cy.edges().removeClass("hot revealed agg-suppressed");
  el("panel").classList.add("hidden");
  if (!viewState && edgeMode() !== "all") {
    dematerializeAll();
    restackRows();
  }
  routeEdgesAroundCards();
}

// ── focus mode & call tree ──

interface ViewState {
  saved: Map<string, { x: number; y: number }>;
  mode: "focus" | "calltree";
  /** the node the view was opened from — its panel button renders pressed */
  rootId: string;
  /** row ids the call chain actually touches (others hideable) */
  touchedRows?: Set<string>;
}
let viewState: ViewState | null = null;

function showCrumb(text: string, extraHtml = ""): void {
  const crumb = el("crumb");
  crumb.classList.remove("hidden");
  crumb.innerHTML = `<span>${esc(text)}</span>${extraHtml}<button id="crumb-back">back</button>`;
  crumb.querySelector("#crumb-back")?.addEventListener("click", () => exitView(true));
}

/** Call-tree neatness: hide rows the chain doesn't touch (crumb toggle). */
function applyCallTreeColumnFilter(): void {
  if (!cy || !viewState || viewState.mode !== "calltree") return;
  const box = document.getElementById("crumb-cols") as HTMLInputElement | null;
  const onlyTouched = box?.checked ?? true;
  const touched = viewState.touchedRows ?? new Set<string>();
  cy.batch(() => {
    cy!.nodes(':parent[type != "schema"]').forEach((p) => {
      p.children().forEach((r) => {
        r.toggleClass("untouched-hidden", onlyTouched && !touched.has(r.id()));
      });
    });
  });
}

function hideCrumb(): void {
  el("crumb").classList.add("hidden");
}

function enterIsolatedView(
  keepUnits: Set<string>,
  crumb: string,
  mode: "focus" | "calltree",
  rootId: string,
): void {
  if (!cy) return;
  exitView(false);
  const saved = new Map<string, { x: number; y: number }>();
  cy.nodes().forEach((n) => {
    if (!n.isParent()) saved.set(n.id(), { ...n.position() });
  });
  cy.batch(() => {
    cy!.elements().removeClass("dimmed");
    cy!.edges().removeClass("revealed hot agg-suppressed");
    // ALL units, not just the visible ones — the keep set was computed from the
    // full graph, so the hide pass must cover the full graph too
    for (const u of allCardUnits()) {
      if (!keepUnits.has(u.id())) u.union(u.descendants()).addClass("focus-hidden");
    }
  });
  // class checks, not :visible — style state is stale inside the batch above
  cy.nodes('[type="schema"]').forEach((s) => {
    let anyVisible = false;
    s.children().forEach((d) => {
      if (
        !d.hasClass("focus-hidden") &&
        !d.hasClass("hidden-el") &&
        !d.hasClass("isolated-hidden")
      ) {
        anyVisible = true;
      }
    });
    if (!anyVisible) s.addClass("focus-hidden");
  });
  viewState = { saved, mode, rootId };
  el("content").classList.add(`view-${mode}`);
  showCrumb(crumb);
}

function exitView(refit: boolean): void {
  if (!cy || !viewState) return;
  const { saved } = viewState;
  viewState = null;
  el("content").classList.remove("view-focus", "view-calltree");
  dematerializeAll();
  cy.batch(() => {
    cy!.elements().removeClass("focus-hidden dimmed untouched-hidden");
    cy!.edges().removeClass("revealed hot agg-suppressed");
    saved.forEach((pos, id) => {
      const n = cy!.getElementById(id);
      if (n.nonempty() && !n.isParent()) n.position(pos);
    });
  });
  hideCrumb();
  restackRows();
  if (refit) fitView();
}

/** 1-hop card neighborhood, isolated, re-laid-out, with the origin selected. */
function focusNode(node: NodeSingular): void {
  if (!cy) return;
  const unit = unitOf(node);
  const keep = new Set<string>([unit.id()]);
  cy.edges("[!detail]").forEach((e) => {
    if (e.hasClass("hidden-el")) return;
    if (e.source().id() === unit.id()) keep.add(e.target().id());
    if (e.target().id() === unit.id()) keep.add(e.source().id());
  });
  const label = `${node.data("schema") ?? ""}.${node.data("label")}`;
  enterIsolatedView(keep, `Focused: ${label} · 1 hop`, "focus", node.id());
  materializeCard(unit.id());
  applyFilters();
  // the focused ITEM is the star: when it's a row, collapse its (possibly
  // huge) table to the clicked row plus rows related outside the card —
  // a 200-column table must not dwarf the thing being focused
  if (node.id() !== unit.id()) {
    const card = cy.getElementById(unit.id());
    cy.batch(() => {
      card.children().forEach((r) => {
        if (r.id() === node.id()) return;
        let involved = false;
        r.connectedEdges("[?detail]").forEach((e) => {
          const other = e.source().id() === r.id() ? e.target() : e.source();
          const ou = unitOf(other as NodeSingular).id();
          if (ou !== unit.id() && keep.has(ou)) involved = true;
        });
        r.toggleClass("untouched-hidden", !involved);
      });
    });
  }
  runLayout();
  // exitView (inside enterIsolatedView) dematerializes rows: the clicked row
  // node may have been REMOVED and re-added — a stale reference has no edges,
  // so the panel would render "no connections". Re-resolve by id.
  const live = cy.getElementById(node.id());
  selectNode((live.nonempty() ? live : unit) as unknown as NodeSingular);
}

/**
 * Call tree: from a trigger/function, follow executes/calls transitively, plus
 * the root's direct callers for context, plus every table the closure touches.
 */
function showCallTree(node: NodeSingular, levels = 2): void {
  if (!cy) return;
  const { fns, keep } = callTreeClosure(cy, node, levels);
  const label = `${node.data("schema") ?? ""}.${node.data("label")}`;
  enterIsolatedView(keep, `Call tree: ${label}`, "calltree", node.id());
  showCrumb(
    `Call tree: ${label}`,
    `<span class="crumb-opt">levels
       <button class="lvl-btn" id="crumb-lvl-dn" title="fewer levels">−</button>
       <span class="lvl-val">${levels}</span>
       <button class="lvl-btn" id="crumb-lvl-up" title="more levels">+</button>
     </span>
     <label class="crumb-opt"><input type="checkbox" id="crumb-cols" checked />touched columns only</label>`,
  );

  const onChain = (kind: string, srcUnit: string, tgtUnit: string, tgtId: string): boolean => {
    if (!keep.has(srcUnit) || !keep.has(tgtUnit)) return false;
    if (kind === "executes") return fns.has(tgtId) || fns.has(tgtUnit);
    if (kind === "calls") return fns.has(srcUnit) || fns.has(tgtUnit);
    if (DATA_KINDS.has(kind)) return fns.has(srcUnit);
    return false;
  };

  /** (Re)build the whole presentation — also runs when the crumb toggles. */
  const apply = (onlyTouched: boolean): void => {
    if (!cy) return;
    // make the chain's column detail available, then reveal ONLY the chain
    for (const id of keep) materializeCard(id);
    applyFilters();
    cy.edges().removeClass("revealed agg-suppressed");

    // which rows the chain touches — collected BEFORE any reveal classes
    const touchedRows = new Set<string>();
    cy.edges("[?detail]").forEach((e) => {
      const su = unitOf(e.source() as NodeSingular).id();
      const tu = unitOf(e.target() as NodeSingular).id();
      if (!onChain(String(e.data("kind")), su, tu, e.target().id())) return;
      for (const end of [e.source(), e.target()]) {
        if (ROW_TYPES.has(String(end.data("type")))) touchedRows.add(end.id());
      }
    });

    // tables the chain touches only at WHOLE-TABLE level (no column detail —
    // think regex-fallback inserts/deletes) have zero touched rows; hiding
    // all rows makes their compound render as NOTHING. Collapse them back to
    // compact virtual cards instead — the agg pass below still draws their
    // edges because no detail pair survives to suppress it.
    if (onlyTouched) {
      const touchedCards = new Set<string>();
      for (const id of touchedRows) {
        const c = cardOfNode.get(id);
        if (c) touchedCards.add(c);
      }
      cy.batch(() => {
        for (const id of keep) {
          if (materialized.has(id) && !touchedCards.has(id)) dematerializeCard(id);
        }
      });
    }

    const revealedPairs = new Set<string>();
    cy.edges("[?detail]").forEach((e) => {
      const su = unitOf(e.source() as NodeSingular).id();
      const tu = unitOf(e.target() as NodeSingular).id();
      const k = String(e.data("kind"));
      if (!onChain(k, su, tu, e.target().id())) return;
      e.addClass("revealed");
      revealedPairs.add(`${k}|${su}|${tu}`);
    });
    cy.edges("[!detail]").forEach((e) => {
      const su = e.source().id();
      const tu = e.target().id();
      const k = String(e.data("kind"));
      if (!onChain(k, su, tu, tu)) return;
      if (e.data("agg") && revealedPairs.has(`${k}|${su}|${tu}`)) e.addClass("agg-suppressed");
      else e.addClass("revealed");
    });

    if (viewState) viewState.touchedRows = touchedRows;
    applyCallTreeColumnFilter();
    restackRows();
    layoutTreeCards(cardUnits());
    routeEdgesAroundCards();
    fitView();
  };

  apply(true);
  // same stale-reference hazard as focusNode: exitView (inside
  // enterIsolatedView) may have removed and re-created the clicked row —
  // re-resolve so selection/panel/zoom see the live node, not a detached one
  const live = cy.getElementById(node.id());
  if (live.nonempty()) node = live as unknown as NodeSingular;

  el("crumb")
    .querySelector("#crumb-cols")
    ?.addEventListener("change", () => {
      const box = document.getElementById("crumb-cols") as HTMLInputElement | null;
      apply(box?.checked ?? true);
    });
  // depth stepper: a different level means a different closure — full re-run
  el("crumb")
    .querySelector("#crumb-lvl-dn")
    ?.addEventListener("click", () => {
      if (levels > 1) showCallTree(node, levels - 1);
    });
  el("crumb")
    .querySelector("#crumb-lvl-up")
    ?.addEventListener("click", () => {
      showCallTree(node, levels + 1);
    });
  // wide trees fit to specks — guarantee a readable zoom centered on the root
  window.setTimeout(() => {
    if (cy && viewState && cy.zoom() < 0.3) {
      cy.animate({ zoom: 0.5, center: { eles: node }, duration: 200 } as never);
    }
  }, 300);
  renderPanel(node);
}

// ── hover preview ──
let hoverUnit: string | null = null;

function wireHoverPreview(): void {
  if (!cy) return;
  cy.on("mouseover", "node", (ev) => {
    const unit = unitOf(ev.target as NodeSingular);
    if (hoverUnit === unit.id()) return;
    cy!.edges(".hover-reveal").removeClass("hover-reveal");
    hoverUnit = unit.id();
    unit.union(unit.descendants()).connectedEdges("[!detail]").addClass("hover-reveal");
  });
  cy.on("mouseout", "node", () => {
    hoverUnit = null;
    cy!.edges(".hover-reveal").removeClass("hover-reveal");
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

/**
 * The column pairs an aggregate edge stands for, from the payload (its member
 * detail edges may not be materialized): fk → "created_by→id, modified_by→id";
 * reads/writes/selects → the touched column names.
 */
function aggMembers(data: GraphEdgeData): string {
  const unitOfId = (id: string): string => cardOfNode.get(id) ?? id;
  const members = (detailEdgesByCard.get(data.source) ?? [])
    .filter(
      (e) =>
        e.data.kind === data.kind &&
        unitOfId(e.data.source) === data.source &&
        unitOfId(e.data.target) === data.target,
    )
    .map((e) => {
      const src = nodeDefById.get(e.data.source);
      const tgt = nodeDefById.get(e.data.target);
      const srcRow = src && ROW_TYPES.has(src.data.type);
      const tgtRow = tgt && ROW_TYPES.has(tgt.data.type);
      if (srcRow && tgtRow) return `${src.data.label}→${tgt.data.label}`;
      if (srcRow) return String(src!.data.label);
      if (tgtRow) return String(tgt!.data.label);
      return "";
    })
    .filter(Boolean);
  const MAX = 6;
  const shown = members.slice(0, MAX).join(", ");
  return members.length > MAX ? `${shown}, +${members.length - MAX} more` : shown;
}

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
  const panel = el("panel-body");
  syncExplorerSelection(node.id());
  const isCard = rowsByCard.has(node.id()) || node.isParent();
  const edges = (
    isCard ? node.union(node.descendants()).connectedEdges("[!detail]") : node.connectedEdges()
  ).filter((e) => !e.hasClass("hidden-el"));
  const outRows: string[] = [];
  const inRows: string[] = [];
  edges.forEach((e: EdgeSingular) => {
    const data = e.data() as GraphEdgeData;
    const outgoing = node.union(node.descendants()).contains(e.source());
    const other = outgoing ? e.target() : e.source();
    const otherData = other.data() as GraphNodeData;
    const owner = ROW_TYPES.has(otherData.type)
      ? String(other.parent().first().data("label") ?? "")
      : "";
    const display = owner ? `${owner}.${otherData.label}` : otherData.label;
    const kindWord = outgoing ? data.kind : (PASSIVE_KIND[data.kind] ?? `${data.kind} by`);
    const kindLabel = `${kindWord}${data.count && data.count > 1 ? ` ×${data.count}` : ""}`;
    const cols = data.agg ? aggMembers(data) : "";
    (outgoing ? outRows : inRows).push(`<li data-node="${esc(other.id())}">
        <span class="kind" style="color:${EDGE_COLORS[data.kind] ?? "#8993A4"}">${outgoing ? "→" : "←"} ${esc(kindLabel)}</span>
        <span class="name">${esc(display)}</span>
        <small>${esc(otherData.type)}</small>
        ${cols ? `<span class="cols">${esc(cols)}</span>` : ""}
      </li>`);
  });
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
      ${d.type === "schema" ? "" : '<button id="def-btn" title="jump to the .hcl definition (DDL when none exists)">Go to definition</button><button id="ddl-btn">Open DDL</button>'}
      <button id="focus-btn" class="${viewState?.mode === "focus" && viewState.rootId === node.id() ? "active-focus" : ""}">Focus</button>
      ${canCallTree ? `<button id="calltree-btn" class="${viewState?.mode === "calltree" && viewState.rootId === node.id() ? "active-calltree" : ""}">Call tree</button>` : ""}
    </div>
    ${outRows.length > 0 ? `<details open><summary>Uses (${outRows.length})</summary><ul class="edge-list">${outRows.join("")}</ul></details>` : ""}
    ${inRows.length > 0 ? `<details open><summary>Used by (${inRows.length})</summary><ul class="edge-list">${inRows.join("")}</ul></details>` : ""}
    ${outRows.length === 0 && inRows.length === 0 ? "<h3>No connections</h3>" : ""}`;
  panel.querySelector("#panel-close")?.addEventListener("click", () => clearSelection());

  panel.querySelector("#ddl-btn")?.addEventListener("click", () => {
    const td = d.type === "column" ? (node.parent().first().data() as GraphNodeData) : d;
    vscode.postMessage({
      type: "openDdl",
      nodeType: td.type,
      oid: td.oid,
      label: `${td.schema ?? ""}.${td.label}`,
    });
  });
  panel.querySelector("#def-btn")?.addEventListener("click", () => {
    const owner = ROW_TYPES.has(d.type) ? String(node.parent().first().data("label") ?? "") : "";
    vscode.postMessage({
      type: "openDefinition",
      nodeType: d.type,
      oid: d.oid,
      schema: d.schema ?? "",
      name: d.label,
      owner,
      label: `${d.schema ?? ""}.${d.label}`,
    });
  });
  // toggles: pressing the active view's button on its origin node exits it
  panel.querySelector("#focus-btn")?.addEventListener("click", () => {
    if (viewState?.mode === "focus" && viewState.rootId === node.id()) {
      exitView(true);
      selectNode(node);
    } else {
      focusNode(node);
    }
  });
  panel.querySelector("#calltree-btn")?.addEventListener("click", () => {
    if (viewState?.mode === "calltree" && viewState.rootId === node.id()) {
      exitView(true);
      selectNode(node);
    } else {
      showCallTree(node);
    }
  });
  panel.querySelectorAll<HTMLElement>("li[data-node]").forEach((li) => {
    li.addEventListener("click", () => {
      const other = cy?.getElementById(li.dataset.node!);
      if (other && other.nonempty()) {
        selectNode(other as unknown as NodeSingular);
        cy?.animate({ center: { eles: other }, duration: 200 } as never);
      }
    });
  });
}

/** The explorer is a native VS Code TreeView now — sync selection to it. */
function syncExplorerSelection(id: string): void {
  vscode.postMessage({ type: "nodeSelected", id });
}

/** Isolate one schema's tables/views/functions (clicking a schema in the tree). */
function focusSchema(s: NodeSingular): void {
  if (!cy) return;
  const name = String(s.data("label"));
  const keep = new Set<string>();
  for (const u of allCardUnits()) {
    if (String(u.data("schema") ?? "") === name) keep.add(u.id());
  }
  enterIsolatedView(keep, `Schema: ${name}`, "focus", s.id());
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
  const parts = Object.entries(lastStats)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => {
      const name = k.replace(/([A-Z])/g, (m) => ` ${m.toLowerCase()}`);
      return `${n} ${name}${n === 1 || name.endsWith("s") ? "" : "s"}`;
    });
  el("stats").textContent = `${database ? `${database} · ` : ""}${parts.join(" · ")}`;
}

function buildLegend(): void {
  const items = [
    ...Object.entries(NODE_COLORS).map(
      ([name, color]) => `<span><i class="dot" style="background:${color}"></i>${name}</span>`,
    ),
    ...Object.entries(EDGE_COLORS).map(
      ([name, color]) => `<span><i class="line" style="background:${color}"></i>${name}</span>`,
    ),
  ];
  el("legend").innerHTML = items.join("");
}

// ── wiring ──
window.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg?.type === "graph") {
    database = msg.database ?? "";
    render(msg.graph as GraphPayload);
  } else if (msg?.type === "reveal") {
    jumpToNode(String(msg.id ?? ""));
  } else if (msg?.type === "connection") {
    const connEl = el("conn") as unknown as { value: string };
    if (!connEl.value) connEl.value = msg.value ?? "";
    if (!msg.value && !cy) {
      el("empty").textContent = "Enter a Postgres connection string above and press connect.";
    }
  } else if (msg?.type === "status") {
    if (!cy) {
      el("empty").style.display = "flex";
      el("empty").textContent = String(msg.message ?? "");
    }
  } else if (msg?.type === "error") {
    if (!cy) {
      el("empty").style.display = "flex";
      el("empty").textContent = `Error: ${msg.message ?? "unknown"}`;
    }
  }
});

window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") exitView(true);
});

function doConnect(): void {
  const value = valueOf("conn").trim();
  if (!value) return;
  el("empty").style.display = "flex";
  el("empty").textContent = "Connecting…";
  vscode.postMessage({ type: "connect", connectionString: value });
}

el("connect").addEventListener("click", doConnect);
el("conn").addEventListener("keydown", (ev) => {
  if ((ev as KeyboardEvent).key === "Enter") doConnect();
});

let searchTimer: number | undefined;
el("search").addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    if (!cy || !payload) return;
    const q = valueOf("search").trim().toLowerCase();
    cy.nodes().removeClass("matched");
    if (!q) return;
    // virtual rows live in the payload, not in cy — a column hit lights its card
    const hitIds = new Set<string>();
    for (const n of payload.nodes) {
      if (!String(n.data.label).toLowerCase().includes(q)) continue;
      hitIds.add(ROW_TYPES.has(n.data.type) ? (cardOfNode.get(n.data.id) ?? n.data.id) : n.data.id);
    }
    const matched = cy.nodes().filter((n) => hitIds.has(n.id()) && n.visible());
    matched.addClass("matched");
    if (matched.nonempty()) {
      cy.animate({ fit: { eles: matched, padding: 80 }, duration: 200 } as never);
    }
  }, 200);
});

el("flt-isolated").addEventListener("change", applyFilters);
el("edge-mode").addEventListener("change", () => {
  if (edgeMode() !== "all" && !viewState) dematerializeAll();
  applyFilters();
  routeEdgesAroundCards();
});
el("flt-route").addEventListener("change", () => routeEdgesAroundCards());
el("flt-schemagroup").addEventListener("change", () => applySchemaGrouping(true));
el("layout").addEventListener("change", runLayout);
el("relayout").addEventListener("click", runLayout);
el("fit").addEventListener("click", () => fitView(undefined, 40));

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
  });
  handle.addEventListener("pointerup", (ev) => {
    resizing = false;
    handle.releasePointerCapture(ev.pointerId);
  });
}
el("refresh").addEventListener("click", () => {
  exitView(false);
  el("empty").style.display = "flex";
  el("empty").textContent = "Refreshing…";
  vscode.postMessage({ type: "refresh" });
});

buildLegend();
vscode.postMessage({ type: "ready" });
