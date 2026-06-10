import cytoscape, { Core, EdgeSingular, NodeSingular } from "cytoscape";
import fcose from "cytoscape-fcose";
import type { GraphEdgeData, GraphNodeData, GraphPayload } from "../src/types";

cytoscape.use(fcose);

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
  schema: "#57606A",
};

const EDGE_COLORS: Record<string, string> = {
  selects: "#36B37E",
  reads: "#4C9AFF",
  writes: "#FF5630",
  calls: "#FFAB00",
  executes: "#FF7452",
  "update-of": "#FF8F73",
  fk: "#8993A4",
  constrains: "#6554C0",
  default: "#998DD9",
};

const ROW_TYPES = new Set(["column", "trigger", "constraint"]);

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
const materialized = new Set<string>();
const MATERIALIZE_CAP = 30;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const checked = (id: string): boolean => el<HTMLInputElement>(id).checked;
const edgeMode = (): string => el<HTMLSelectElement>("edge-mode").value;

const isDark = (): boolean =>
  document.body.classList.contains("vscode-dark") ||
  document.body.classList.contains("vscode-high-contrast");

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

// ── card art: the column list of an idle card, rendered as one SVG image ──

const ROW_H = 15;
const HEADER_H = 22;

function cardDims(label: string, rows: NodeDef[]): { w: number; h: number } {
  let maxLen = label.length;
  for (const r of rows) maxLen = Math.max(maxLen, String(r.data.label).length);
  const w = Math.max(90, maxLen * 6.2 + 24);
  const h = HEADER_H + rows.length * ROW_H + 8;
  return { w, h };
}

function buildCardArt(card: NodeDef): void {
  const showCols = checked("flt-columns");
  const rows = showCols ? (rowsByCard.get(card.data.id) ?? []) : [];
  const { w, h } = cardDims(card.data.label, rows);
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
  parts.push("</svg>");
  card.data.svg = `data:image/svg+xml;utf8,${encodeURIComponent(parts.join(""))}`;
  card.data.cardW = w;
  card.data.cardH = h;
}

function refreshCardArt(): void {
  if (!cy || !payload) return;
  cy.batch(() => {
    for (const n of payload!.nodes) {
      if (!rowsByCard.has(n.data.id) || materialized.has(n.data.id)) continue;
      buildCardArt(n);
      const ele = cy!.getElementById(n.data.id);
      if (ele.nonempty()) {
        ele.data({ svg: n.data.svg, cardW: n.data.cardW, cardH: n.data.cardH });
      }
    }
  });
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

function dematerializeAll(): void {
  if (!cy || materialized.size === 0) return;
  // iterate a copy — entries are deleted mid-loop
  const ids = Array.from(materialized);
  cy.batch(() => {
    for (const id of ids) {
      const card = cy!.getElementById(id);
      if (card.empty()) continue;
      const pos = { ...card.position() };
      cy!.remove(card.children()); // incident detail edges go with the rows
      card.position(pos);
      card.addClass("virtual-card");
      materialized.delete(id);
    }
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
      selector: 'node[type="trigger"], node[type="constraint"]',
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
  materialized.clear();

  const liveNodes: NodeDef[] = [];
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
  buildExplorer();
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
    g.nodes('[type="column"]').toggleClass("hidden-el", !checked("flt-columns"));
    g.nodes('[type="view"], [type="matview"]').toggleClass("hidden-el", !checked("flt-views"));
    g.nodes('[type="function"]').toggleClass("hidden-el", !checked("flt-functions"));
    g.nodes('[type="trigger"]').toggleClass("hidden-el", !checked("flt-triggers"));
    g.nodes('[type="constraint"]').toggleClass("hidden-el", !checked("flt-constraints"));
    g.edges('[kind="fk"]').toggleClass("hidden-el", !checked("flt-fk"));

    const mode = edgeMode();
    g.edges().removeClass("edge-off");
    if (mode === "off") g.edges().addClass("edge-off");
    else if (mode === "cards") g.edges("[?detail]").addClass("edge-off");

    g.nodes().removeClass("isolated-hidden");
    if (checked("flt-isolated")) {
      // isolation is about having relationships at all — endpoints hidden by a
      // TYPE filter still count, so hiding functions can't nuke their tables
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
 */
function restackRows(): void {
  if (!cy) return;
  cy.batch(() => {
    cy!.nodes(':parent[type != "schema"]').forEach((p) => {
      const rows = p
        .children(":visible")
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
  return Math.min(4, Math.max(1, raw)) * 1.15;
}

/** Layout units: whole cards and standalone nodes. */
function cardUnits(): NodeSingular[] {
  const out: NodeSingular[] = [];
  cy!.nodes(":visible").forEach((n) => {
    if (n.data("type") === "schema") return;
    if (ROW_TYPES.has(String(n.data("type")))) return;
    const p = n.parent().first();
    if (p.empty() || p.data("type") === "schema") out.push(n as NodeSingular);
  });
  return out;
}

/** The card a node belongs to (columns/triggers/constraints → their table). */
function unitOf(n: NodeSingular): NodeSingular {
  let u: NodeSingular = n;
  for (;;) {
    const p = u.parent().first();
    if (p.empty() || p.data("type") === "schema") return u;
    u = p as NodeSingular;
  }
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

/** Schema-blocked grid, packed to the viewport's aspect ratio. */
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

/** Push overlapping cards apart (organic layouts can collide after row restacking). */
function resolveOverlaps(units: NodeSingular[]): void {
  const MARGIN = 24;
  const boxes = units.map((u) => {
    const b = u.boundingBox({ includeLabels: true });
    return { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 };
  });
  for (let iter = 0; iter < 10; iter++) {
    let moved = false;
    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
        const oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        const apply = (idx: number, u: NodeSingular, dx: number, dy: number): void => {
          shiftUnit(u, dx, dy);
          const box = boxes[idx]!;
          box.x1 += dx;
          box.x2 += dx;
          box.y1 += dy;
          box.y2 += dy;
        };
        if (ox < oy) {
          const push = (ox + MARGIN) / 2;
          const dir = (a.x1 + a.x2) / 2 <= (b.x1 + b.x2) / 2 ? 1 : -1;
          apply(i, units[i]!, -dir * push, 0);
          apply(j, units[j]!, dir * push, 0);
        } else {
          const push = (oy + MARGIN) / 2;
          const dir = (a.y1 + a.y2) / 2 <= (b.y1 + b.y2) / 2 ? 1 : -1;
          apply(i, units[i]!, 0, -dir * push);
          apply(j, units[j]!, 0, dir * push);
        }
      }
    }
    if (!moved) break;
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
  let y = 0;
  for (const lv of [...byLevel.keys()].sort((a, b) => a - b)) {
    const row = byLevel
      .get(lv)!
      .sort((a, b) => (degree.get(b.id()) ?? 0) - (degree.get(a.id()) ?? 0));
    const boxes = row.map((u) => u.boundingBox({ includeLabels: true }));
    const width = boxes.reduce((s, b) => s + b.w, 0) + GAP * Math.max(0, row.length - 1);
    let x = -width / 2;
    let rowH = 0;
    row.forEach((u, i) => {
      const b = boxes[i]!;
      moveUnitTo(u, x + b.w / 2, y + b.h / 2);
      x += b.w + GAP;
      rowH = Math.max(rowH, b.h);
    });
    y += rowH + GAP * 2;
  }
}

function layoutConcentricCards(units: NodeSingular[]): void {
  const { degree } = unitAdjacency(units);
  const sorted = [...units].sort((a, b) => (degree.get(b.id()) ?? 0) - (degree.get(a.id()) ?? 0));
  const boxes = sorted.map((u) => u.boundingBox({ includeLabels: true }));
  const maxDim = boxes.reduce((m, b) => Math.max(m, b.w, b.h), 60);
  const avgW = boxes.reduce((s, b) => s + b.w, 0) / Math.max(1, boxes.length);
  let i = 0;
  let ring = 0;
  while (i < sorted.length) {
    if (ring === 0) {
      moveUnitTo(sorted[0]!, 0, 0);
      i = 1;
      ring = 1;
      continue;
    }
    const radius = ring * (maxDim + GAP);
    const capacity = Math.max(4, Math.floor((2 * Math.PI * radius) / (avgW + GAP)));
    const count = Math.min(capacity, sorted.length - i);
    for (let k = 0; k < count; k++) {
      const angle = (2 * Math.PI * k) / count + (ring % 2) * 0.3;
      moveUnitTo(sorted[i + k]!, radius * Math.cos(angle), radius * Math.sin(angle));
    }
    i += count;
    ring++;
  }
}

function runLayout(): void {
  if (!cy) return;
  const name = el<HTMLSelectElement>("layout").value;
  cy.edges("[!detail]").toggleClass("ortho", name === "breadthfirst" || name === "grid");
  if (name === "fcose") {
    const eles = cy
      .elements(":visible")
      .union(cy.edges("[!detail]").filter((e) => e.source().visible() && e.target().visible()));
    const layout = eles.layout({
      name: "fcose",
      animate: false,
      quality: "proof",
      randomize: true,
      nodeSeparation: 160,
      idealEdgeLength: 160,
      edgeElasticity: 0.45,
      nodeRepulsion: 50000,
      nestingFactor: 0.1,
      gravity: 0.2,
      gravityCompound: 1.5,
      numIter: 2500,
      tile: true,
      packComponents: true,
    } as cytoscape.LayoutOptions);
    layout.one("layoutstop", () => {
      restackRows();
      resolveOverlaps(cardUnits());
      cy?.fit(undefined, 50);
    });
    layout.run();
    return;
  }
  restackRows();
  const units = cardUnits();
  if (name === "breadthfirst") layoutTreeCards(units);
  else if (name === "concentric") layoutConcentricCards(units);
  else layoutGridCards(units);
  cy.fit(undefined, 50);
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
}

// ── focus mode & call tree ──

interface ViewState {
  saved: Map<string, { x: number; y: number }>;
}
let viewState: ViewState | null = null;

function showCrumb(text: string): void {
  const crumb = el("crumb");
  crumb.classList.remove("hidden");
  crumb.innerHTML = `<span>${esc(text)}</span><button id="crumb-back">back</button>`;
  crumb.querySelector("#crumb-back")?.addEventListener("click", () => exitView(true));
}

function hideCrumb(): void {
  el("crumb").classList.add("hidden");
}

function enterIsolatedView(keepUnits: Set<string>, crumb: string): void {
  if (!cy) return;
  exitView(false);
  const saved = new Map<string, { x: number; y: number }>();
  cy.nodes().forEach((n) => {
    if (!n.isParent()) saved.set(n.id(), { ...n.position() });
  });
  cy.batch(() => {
    cy!.elements().removeClass("dimmed");
    cy!.edges().removeClass("revealed hot agg-suppressed");
    for (const u of cardUnits()) {
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
  viewState = { saved };
  showCrumb(crumb);
}

function exitView(refit: boolean): void {
  if (!cy || !viewState) return;
  const { saved } = viewState;
  viewState = null;
  dematerializeAll();
  cy.batch(() => {
    cy!.elements().removeClass("focus-hidden dimmed");
    cy!.edges().removeClass("revealed hot agg-suppressed");
    saved.forEach((pos, id) => {
      const n = cy!.getElementById(id);
      if (n.nonempty() && !n.isParent()) n.position(pos);
    });
  });
  hideCrumb();
  restackRows();
  if (refit) cy.fit(undefined, 50);
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
  enterIsolatedView(keep, `Focused: ${label} · 1 hop`);
  materializeCard(unit.id());
  applyFilters();
  runLayout();
  selectNode(node);
}

/**
 * Call tree: from a trigger/function, follow executes/calls transitively, plus
 * the root's direct callers for context, plus every table the closure touches.
 */
function showCallTree(node: NodeSingular): void {
  if (!cy) return;
  const startUnit = unitOf(node);
  const fns = new Set<string>();
  const queue: string[] = [];
  if (node.data("type") === "trigger") {
    node.connectedEdges('[kind="executes"]').forEach((e) => {
      queue.push(e.target().id());
    });
  } else {
    queue.push(startUnit.id());
  }
  const roots = new Set(queue);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (fns.has(id)) continue;
    fns.add(id);
    cy.edges('[!detail][kind="calls"], [!detail][kind="executes"]').forEach((e) => {
      if (e.source().id() === id && !fns.has(e.target().id())) queue.push(e.target().id());
    });
  }
  const keep = new Set<string>(fns);
  keep.add(startUnit.id());
  cy.edges('[!detail][kind="reads"], [!detail][kind="writes"]').forEach((e) => {
    if (fns.has(e.source().id())) keep.add(e.target().id());
  });
  // context: who calls / fires the root
  cy.edges('[!detail][kind="calls"], [!detail][kind="executes"]').forEach((e) => {
    if (roots.has(e.target().id())) keep.add(e.source().id());
  });
  const label = `${node.data("schema") ?? ""}.${node.data("label")}`;
  enterIsolatedView(keep, `Call tree: ${label}`);

  // make the chain's column detail available, then reveal ONLY the chain
  for (const id of keep) materializeCard(id);
  applyFilters();

  const onChain = (kind: string, srcUnit: string, tgtUnit: string, tgtId: string): boolean => {
    if (!keep.has(srcUnit) || !keep.has(tgtUnit)) return false;
    if (kind === "executes") return fns.has(tgtId) || fns.has(tgtUnit);
    if (kind === "calls") return fns.has(srcUnit) || fns.has(tgtUnit);
    if (kind === "reads" || kind === "writes") return fns.has(srcUnit);
    return false;
  };
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

  restackRows();
  layoutTreeCards(cardUnits());
  cy.fit(undefined, 50);
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
}

// ── panel ──

function renderPanel(node: NodeSingular): void {
  const d = node.data() as GraphNodeData;
  const panel = el("panel");
  panel.classList.remove("hidden");
  const isCard = rowsByCard.has(node.id()) || node.isParent();
  const edges = (
    isCard ? node.union(node.descendants()).connectedEdges("[!detail]") : node.connectedEdges()
  ).filter((e) => !e.hasClass("hidden-el"));
  const rows = edges
    .map((e: EdgeSingular) => {
      const data = e.data() as GraphEdgeData;
      const outgoing = node.union(node.descendants()).contains(e.source());
      const other = outgoing ? e.target() : e.source();
      const otherData = other.data() as GraphNodeData;
      const owner = ROW_TYPES.has(otherData.type)
        ? String(other.parent().first().data("label") ?? "")
        : "";
      const display = owner ? `${owner}.${otherData.label}` : otherData.label;
      const kindLabel = `${data.kind}${data.count && data.count > 1 ? ` ×${data.count}` : ""}`;
      return `<li data-node="${esc(other.id())}">
        <span class="kind" style="color:${EDGE_COLORS[data.kind] ?? "#8993A4"}">${outgoing ? "→" : "←"} ${esc(kindLabel)}</span>
        <span class="name">${esc(display)}</span>
        <small>${esc(otherData.type)}</small>
      </li>`;
    })
    .join("");
  const ownerTable = ROW_TYPES.has(d.type) ? String(node.parent().first().data("label") ?? "") : "";
  const where = ownerTable ? `${d.schema ?? ""}.${ownerTable}` : (d.schema ?? "");
  const canCallTree = d.type === "function" || d.type === "trigger";
  panel.innerHTML = `
    <h2>${esc(d.label)}</h2>
    <p class="meta">
      <span class="chip" style="background:${NODE_COLORS[d.type] ?? "#888"}">${esc(d.type)}</span>
      <span>${esc(where)}</span>
    </p>
    ${d.detail ? `<p class="detail">${esc(d.detail)}</p>` : ""}
    <div class="actions">
      ${d.type === "schema" ? "" : '<button id="ddl-btn">Open DDL</button>'}
      <button id="focus-btn">Focus</button>
      ${canCallTree ? '<button id="calltree-btn">Call tree</button>' : ""}
    </div>
    <h3>Connections (${edges.length})</h3>
    <ul class="edge-list">${rows}</ul>`;

  panel.querySelector("#ddl-btn")?.addEventListener("click", () => {
    const td = d.type === "column" ? (node.parent().first().data() as GraphNodeData) : d;
    vscode.postMessage({
      type: "openDdl",
      nodeType: td.type,
      oid: td.oid,
      label: `${td.schema ?? ""}.${td.label}`,
    });
  });
  panel.querySelector("#focus-btn")?.addEventListener("click", () => focusNode(node));
  panel.querySelector("#calltree-btn")?.addEventListener("click", () => showCallTree(node));
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

// ── explorer: structured schema → object → column list ──

function explorerDot(type: string): string {
  return `<i class="dot" style="background:${NODE_COLORS[type] ?? "#888"}"></i>`;
}

function buildExplorer(): void {
  if (!payload) return;
  const bySchema = new Map<string, { rels: NodeDef[]; fns: NodeDef[] }>();
  for (const n of payload.nodes) {
    const t = n.data.type;
    if (t === "schema" || ROW_TYPES.has(t)) continue;
    const schema = String(n.data.schema ?? "");
    if (!bySchema.has(schema)) bySchema.set(schema, { rels: [], fns: [] });
    if (t === "function") bySchema.get(schema)!.fns.push(n);
    else bySchema.get(schema)!.rels.push(n);
  }
  const byLabel = (a: NodeDef, b: NodeDef): number =>
    String(a.data.label).localeCompare(String(b.data.label));
  const html: string[] = [];
  for (const schema of [...bySchema.keys()].sort()) {
    const { rels, fns } = bySchema.get(schema)!;
    rels.sort(byLabel);
    fns.sort(byLabel);
    html.push(
      `<details open><summary>${explorerDot("schema")}<b>${esc(schema)}</b><small>${rels.length} rel · ${fns.length} fn</small></summary>`,
    );
    for (const rel of rels) {
      const rows = rowsByCard.get(rel.data.id) ?? [];
      html.push(
        `<details><summary class="obj" data-node="${esc(rel.data.id)}">${explorerDot(rel.data.type)}${esc(rel.data.label)}<small>${esc(rel.data.type)}</small></summary><ul>`,
      );
      for (const r of rows) {
        html.push(
          `<li data-node="${esc(r.data.id)}">${explorerDot(r.data.type)}${esc(r.data.label)}<small>${esc(r.data.detail ?? r.data.type)}</small></li>`,
        );
      }
      html.push("</ul></details>");
    }
    if (fns.length > 0) {
      html.push(`<details><summary><small>functions (${fns.length})</small></summary><ul>`);
      for (const f of fns) {
        html.push(
          `<li data-node="${esc(f.data.id)}">${explorerDot("function")}${esc(f.data.label)}</li>`,
        );
      }
      html.push("</ul></details>");
    }
    html.push("</details>");
  }
  el("explorer-tree").innerHTML = html.join("");
}

/** Select + center a node from the explorer (materializing its card if needed). */
function jumpToNode(id: string): void {
  if (!cy) return;
  const card = cardOfNode.get(id);
  if (card && !materialized.has(card) && !viewState) {
    materializeNeighborhood(card);
    applyFilters();
  }
  const ele = cy.getElementById(id);
  if (ele.empty()) return;
  selectNode(ele as unknown as NodeSingular);
  const zoom = Math.max(cy.zoom(), 0.8);
  cy.animate({ center: { eles: ele }, zoom, duration: 200 } as never);
}

el("explorer-tree").addEventListener("click", (ev) => {
  const target = (ev.target as HTMLElement).closest<HTMLElement>("[data-node]");
  if (target?.dataset.node) {
    jumpToNode(target.dataset.node);
    ev.preventDefault();
  }
});

let explorerFilterTimer: number | undefined;
el<HTMLInputElement>("explorer-filter").addEventListener("input", () => {
  window.clearTimeout(explorerFilterTimer);
  explorerFilterTimer = window.setTimeout(() => {
    const q = el<HTMLInputElement>("explorer-filter").value.trim().toLowerCase();
    const tree = el("explorer-tree");
    tree.querySelectorAll<HTMLElement>("li, details").forEach((node) => {
      node.classList.remove("f-hide");
    });
    if (!q) return;
    // hide non-matching leaves; open + keep ancestors of matches
    tree.querySelectorAll<HTMLElement>("li").forEach((li) => {
      if (!li.textContent?.toLowerCase().includes(q)) li.classList.add("f-hide");
    });
    tree.querySelectorAll<HTMLDetailsElement>("details").forEach((d) => {
      const summaryText = d.querySelector(":scope > summary")?.textContent?.toLowerCase() ?? "";
      const hasVisibleLeaf = [...d.querySelectorAll("li")].some(
        (li) => !li.classList.contains("f-hide"),
      );
      if (summaryText.includes(q)) {
        // summary matches → show all its leaves
        d.querySelectorAll("li").forEach((li) => {
          li.classList.remove("f-hide");
        });
        d.open = true;
      } else if (hasVisibleLeaf) {
        d.open = true;
      } else {
        d.classList.add("f-hide");
      }
    });
    // un-hide ancestor chains of anything still visible
    tree.querySelectorAll<HTMLElement>("details:not(.f-hide)").forEach((d) => {
      let p = d.parentElement;
      while (p && p !== tree) {
        p.classList.remove("f-hide");
        if (p instanceof HTMLDetailsElement) p.open = true;
        p = p.parentElement;
      }
    });
  }, 150);
});

el("flt-explorer").addEventListener("change", () => {
  el("explorer").classList.toggle("hidden", !checked("flt-explorer"));
});

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
  } else if (msg?.type === "connection") {
    const connEl = el<HTMLInputElement>("conn");
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
  const value = el<HTMLInputElement>("conn").value.trim();
  if (!value) return;
  el("empty").style.display = "flex";
  el("empty").textContent = "Connecting…";
  vscode.postMessage({ type: "connect", connectionString: value });
}

el("connect").addEventListener("click", doConnect);
el<HTMLInputElement>("conn").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") doConnect();
});

let searchTimer: number | undefined;
el<HTMLInputElement>("search").addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    if (!cy || !payload) return;
    const q = el<HTMLInputElement>("search").value.trim().toLowerCase();
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

for (const id of [
  "flt-views",
  "flt-functions",
  "flt-triggers",
  "flt-constraints",
  "flt-fk",
  "flt-isolated",
]) {
  el(id).addEventListener("change", applyFilters);
}
el("flt-columns").addEventListener("change", () => {
  refreshCardArt();
  applyFilters();
  runLayout();
});
el("edge-mode").addEventListener("change", () => {
  if (edgeMode() !== "all" && !viewState) dematerializeAll();
  applyFilters();
});
el("flt-schemagroup").addEventListener("change", () => applySchemaGrouping(true));
el("layout").addEventListener("change", runLayout);
el("relayout").addEventListener("click", runLayout);
el("fit").addEventListener("click", () => cy?.fit(undefined, 40));
el("refresh").addEventListener("click", () => {
  exitView(false);
  el("empty").style.display = "flex";
  el("empty").textContent = "Refreshing…";
  vscode.postMessage({ type: "refresh" });
});

buildLegend();
vscode.postMessage({ type: "ready" });
