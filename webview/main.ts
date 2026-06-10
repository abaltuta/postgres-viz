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

let cy: Core | null = null;
let database = "";
let lastStats: Record<string, number> = {};

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const checked = (id: string): boolean => el<HTMLInputElement>(id).checked;
const edgeMode = (): string => el<HTMLSelectElement>("edge-mode").value;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function buildStyle(): cytoscape.StylesheetJson {
  const dark =
    document.body.classList.contains("vscode-dark") ||
    document.body.classList.contains("vscode-high-contrast");
  const text = dark ? "#d8dee9" : "#24292f";
  const chipBg = dark ? "#1c2128" : "#f6f8fa";
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
    // ERD rows: columns/triggers/constraints render as flat stripes inside the card
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
      selector: 'node[type="trigger"]',
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
    {
      selector: 'node[type="constraint"]',
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
    // ERD card: solid panel, title bar inside the top edge
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
    {
      selector: 'node:parent[type="table"]',
      style: { "border-color": NODE_COLORS.table!, color: NODE_COLORS.table! },
    },
    {
      selector: 'node:parent[type="view"]',
      style: { "border-color": NODE_COLORS.view!, color: NODE_COLORS.view! },
    },
    {
      selector: 'node:parent[type="matview"]',
      style: { "border-color": NODE_COLORS.matview!, color: NODE_COLORS.matview! },
    },
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
    // card-level rollups carry a ×N badge
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
    // orthogonal elbows between cards in the structured layouts
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
    // ghosted elements never render labels (the labels are what smears)
    { selector: ".dimmed", style: { opacity: 0.15, "text-opacity": 0 } },
    { selector: "edge.hot", style: { opacity: 0.95, width: 1.8, "z-index": 9 } },
    // edge visibility tiers: edge-off < revealed/hover-reveal < suppress/hidden
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

function render(graph: GraphPayload): void {
  el("empty").style.display = "none";
  hideCrumb();
  // large graphs start with isolated nodes hidden — the toggle brings them back
  if (graph.nodes.length > 600) {
    el<HTMLInputElement>("flt-isolated").checked = true;
  }
  cy?.destroy();
  cy = cytoscape({
    container: el("cy"),
    elements: { nodes: graph.nodes, edges: graph.edges } as cytoscape.ElementsDefinition,
    style: buildStyle(),
    layout: { name: "preset" },
    wheelSensitivity: 0.2,
    hideEdgesOnViewport: true,
    motionBlur: true,
  });
  viewState = null;
  lastStats = graph.stats;
  applySchemaGrouping(false);
  applyFilters();
  runLayout();
  updateStats();
  cy.on("tap", "node", (ev) => selectNode(ev.target as NodeSingular));
  cy.on("tap", (ev) => {
    if (ev.target === cy) clearSelection();
  });
  cy.on("dbltap", "node", (ev) => focusNode(ev.target as NodeSingular));
  wireHoverPreview();
}

function applyFilters(): void {
  if (!cy) return;
  const g = cy;
  g.batch(() => {
    g.nodes('[type="column"]').toggleClass("hidden-el", !checked("flt-columns"));
    g.nodes('[type="view"], [type="matview"]').toggleClass("hidden-el", !checked("flt-views"));
    g.nodes('[type="function"]').toggleClass("hidden-el", !checked("flt-functions"));
    g.nodes('[type="trigger"]').toggleClass("hidden-el", !checked("flt-triggers"));
    g.nodes('[type="constraint"]').toggleClass("hidden-el", !checked("flt-constraints"));
    g.edges('[kind="fk"]').toggleClass("hidden-el", !checked("flt-fk"));

    // edge tiers: off → nothing; cards (default) → aggregates + card-level only;
    // all → the full per-column wiring. `.revealed`/`.hover-reveal` override off.
    const mode = edgeMode();
    g.edges().removeClass("edge-off");
    if (mode === "off") g.edges().addClass("edge-off");
    else if (mode === "cards") g.edges("[?detail]").addClass("edge-off");

    g.nodes().removeClass("isolated-hidden");
    if (checked("flt-isolated")) {
      const keep = new Set<string>();
      // card-level edges are enough to decide connectivity, and 5x fewer
      g.edges("[!detail]").forEach((e) => {
        if (
          e.hasClass("hidden-el") ||
          e.source().hasClass("hidden-el") ||
          e.target().hasClass("hidden-el")
        ) {
          return;
        }
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
 * ERD pass: stack each relation's visible children (columns by attnum, then
 * triggers and constraints) as uniform-width rows inside the card, so a table
 * reads like an entity in an ER diagram and edges land on the exact row.
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

const GAP = 48;

/** Layout units: whole cards (table/view/matview parents) and standalone nodes. */
function cardUnits(): NodeSingular[] {
  const out: NodeSingular[] = [];
  cy!.nodes(":visible").forEach((n) => {
    if (n.data("type") === "schema") return;
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

function moveUnitTo(u: NodeSingular, x: number, y: number): void {
  const bb = u.boundingBox({ includeLabels: false });
  const delta = { x: x - (bb.x1 + bb.x2) / 2, y: y - (bb.y1 + bb.y2) / 2 };
  (u.isParent() ? u.descendants() : u).shift(delta);
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

function layoutGridCards(units: NodeSingular[]): void {
  const sorted = [...units].sort(
    (a, b) =>
      String(a.data("schema") ?? "").localeCompare(String(b.data("schema") ?? "")) ||
      String(a.data("type")).localeCompare(String(b.data("type"))) ||
      String(a.data("label")).localeCompare(String(b.data("label"))),
  );
  const boxes = sorted.map((u) => u.boundingBox({ includeLabels: true }));
  const totalArea = boxes.reduce((s, b) => s + (b.w + GAP) * (b.h + GAP), 0);
  const rowWidth = Math.max(800, Math.sqrt(totalArea) * 1.8);
  let x = 0;
  let y = 0;
  let rowH = 0;
  sorted.forEach((u, i) => {
    const b = boxes[i]!;
    if (x > 0 && x + b.w > rowWidth) {
      x = 0;
      y += rowH + GAP;
      rowH = 0;
    }
    moveUnitTo(u, x + b.w / 2, y + b.h / 2);
    x += b.w + GAP;
    rowH = Math.max(rowH, b.h);
  });
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
  // disconnected cards go to the bottom, sorted by degree so the busy ones lead
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
  // right-angle elbows read better in the structured layouts; organic keeps curves
  cy.edges("[!detail]").toggleClass("ortho", name === "breadthfirst" || name === "grid");
  if (name === "fcose") {
    const layout = cy.elements(":visible").layout({
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
    layout.one("layoutstop", () => restackRows());
    layout.run();
    return;
  }
  // discrete layouts move whole ERD cards, never individual rows
  restackRows();
  const units = cardUnits();
  if (name === "breadthfirst") layoutTreeCards(units);
  else if (name === "concentric") layoutConcentricCards(units);
  else layoutGridCards(units);
  cy.fit(undefined, 50);
}

function selectNode(node: NodeSingular): void {
  if (!cy) return;
  cy.edges().removeClass("hot revealed agg-suppressed");
  const core = node.union(node.descendants());
  const detailEdges = core.connectedEdges("[?detail]");
  // swap aggregates for their member edges so counts and members never double-render
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
  cy?.elements().removeClass("dimmed");
  cy?.edges().removeClass("hot revealed agg-suppressed");
  el("panel").classList.add("hidden");
}

// ── focus mode & call tree (isolated views over the same machinery) ──

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

function enterIsolatedView(keepUnits: Set<string>, crumb: string, revealDetail: boolean): void {
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
    // schema boxes with nothing left inside disappear too
    cy!.nodes('[type="schema"]').forEach((s) => {
      if (s.descendants(":visible").length === 0) s.addClass("focus-hidden");
    });
    if (revealDetail) {
      cy!.edges("[?detail]").forEach((e) => {
        if (
          keepUnits.has(unitOf(e.source() as NodeSingular).id()) &&
          keepUnits.has(unitOf(e.target() as NodeSingular).id())
        ) {
          e.addClass("revealed");
        }
      });
    }
  });
  viewState = { saved };
  showCrumb(crumb);
}

function exitView(refit: boolean): void {
  if (!cy || !viewState) return;
  const { saved } = viewState;
  viewState = null;
  cy.batch(() => {
    cy!.elements().removeClass("focus-hidden dimmed");
    cy!.edges().removeClass("revealed hot agg-suppressed");
    saved.forEach((pos, id) => {
      const n = cy!.getElementById(id);
      if (n.nonempty()) n.position(pos);
    });
  });
  hideCrumb();
  restackRows();
  if (refit) cy.fit(undefined, 50);
}

/** 1-hop card neighborhood, isolated and re-laid-out. */
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
  enterIsolatedView(keep, `Focused: ${label} · 1 hop`, false);
  runLayout();
}

/**
 * Call tree: from a trigger/function, follow executes/calls transitively, then
 * include every table each function in the closure reads or writes — laid out
 * as dependency layers with the per-column detail edges revealed.
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
  const label = `${node.data("schema") ?? ""}.${node.data("label")}`;
  enterIsolatedView(keep, `Call tree: ${label}`, true);
  restackRows();
  layoutTreeCards(cardUnits());
  cy.fit(undefined, 50);
}

// ── hover preview: peek at a card's wiring without clicking ──
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

function renderPanel(node: NodeSingular): void {
  const d = node.data() as GraphNodeData;
  const panel = el("panel");
  panel.classList.remove("hidden");
  // cards list their rolled-up card edges; rows list their exact detail edges
  const edges = (
    node.isParent()
      ? node.union(node.descendants()).connectedEdges("[!detail]")
      : node.connectedEdges()
  ).filter((e) => !e.hasClass("hidden-el"));
  const rows = edges
    .map((e: EdgeSingular) => {
      const data = e.data() as GraphEdgeData;
      const outgoing = node.union(node.descendants()).contains(e.source());
      const other = outgoing ? e.target() : e.source();
      const otherData = other.data() as GraphNodeData;
      // qualify children by their owning table: instruction.id, not just id
      const owner =
        otherData.type === "column" ||
        otherData.type === "trigger" ||
        otherData.type === "constraint"
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
  // the owning table for rows: schema.table next to the type chip
  const ownerTable =
    d.type === "column" || d.type === "trigger" || d.type === "constraint"
      ? String(node.parent().first().data("label") ?? "")
      : "";
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
    // columns have no DDL of their own — open the parent relation's
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
    if (!cy) return;
    const q = el<HTMLInputElement>("search").value.trim().toLowerCase();
    cy.nodes().removeClass("matched");
    if (!q) return;
    const matched = cy
      .nodes()
      .filter((n) => String(n.data("label")).toLowerCase().includes(q) && n.visible());
    matched.addClass("matched");
    if (matched.nonempty()) {
      cy.animate({ fit: { eles: matched, padding: 80 }, duration: 200 } as never);
    }
  }, 200);
});

for (const id of [
  "flt-columns",
  "flt-views",
  "flt-functions",
  "flt-triggers",
  "flt-constraints",
  "flt-fk",
  "flt-isolated",
]) {
  el(id).addEventListener("change", applyFilters);
}
el("edge-mode").addEventListener("change", applyFilters);
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
