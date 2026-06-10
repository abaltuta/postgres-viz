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

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function buildStyle(): cytoscape.StylesheetJson {
  const dark =
    document.body.classList.contains("vscode-dark") ||
    document.body.classList.contains("vscode-high-contrast");
  const text = dark ? "#d8dee9" : "#24292f";
  const styles: { selector: string; style: Record<string, unknown> }[] = [
    {
      selector: "node",
      style: {
        label: "data(label)",
        "font-size": 9,
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
        "background-opacity": 0.92,
        "background-color": dark ? "#1c2128" : "#f6f8fa",
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
    { selector: ".dimmed", style: { opacity: 0.12 } },
    { selector: "edge.hot", style: { opacity: 0.95, width: 1.8, "z-index": 9 } },
    // relationships are hidden by default; clicking a node reveals its edges
    { selector: "edge.edge-off", style: { display: "none" } },
    { selector: "edge.revealed", style: { display: "element" } },
    { selector: ".hidden-el", style: { display: "none" } },
    { selector: ".isolated-hidden", style: { display: "none" } },
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
  });
  lastStats = graph.stats;
  applySchemaGrouping(false);
  applyFilters();
  runLayout();
  updateStats();
  cy.on("tap", "node", (ev) => selectNode(ev.target as NodeSingular));
  cy.on("tap", (ev) => {
    if (ev.target === cy) clearSelection();
  });
}

function applyFilters(): void {
  if (!cy) return;
  const g = cy;
  g.batch(() => {
    const showCols = checked("flt-columns");
    g.nodes('[type="column"]').toggleClass("hidden-el", !showCols);
    g.edges("[?dup]").toggleClass("hidden-el", showCols);
    g.nodes('[type="view"], [type="matview"]').toggleClass("hidden-el", !checked("flt-views"));
    g.nodes('[type="function"]').toggleClass("hidden-el", !checked("flt-functions"));
    g.nodes('[type="trigger"]').toggleClass("hidden-el", !checked("flt-triggers"));
    g.nodes('[type="constraint"]').toggleClass("hidden-el", !checked("flt-constraints"));
    g.edges('[kind="fk"]').toggleClass("hidden-el", !checked("flt-fk"));

    // relationships on demand: hide all edges unless the toggle is on; edges
    // revealed by a selection keep showing (`.revealed` wins over `.edge-off`)
    g.edges().toggleClass("edge-off", !checked("flt-edges"));

    g.nodes().removeClass("isolated-hidden");
    if (checked("flt-isolated")) {
      const keep = new Set<string>();
      g.edges().forEach((e) => {
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

function runLayout(): void {
  if (!cy) return;
  const name = el<HTMLSelectElement>("layout").value;
  const options: Record<string, object> = {
    fcose: {
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
    },
    breadthfirst: { name: "breadthfirst", directed: true, spacingFactor: 1.6 },
    concentric: { name: "concentric", minNodeSpacing: 60 },
    grid: { name: "grid", avoidOverlapPadding: 30 },
  };
  const layout = cy
    .elements(":visible")
    .layout((options[name] ?? options.fcose) as cytoscape.LayoutOptions);
  layout.one("layoutstop", () => restackRows());
  layout.run();
}

function selectNode(node: NodeSingular): void {
  if (!cy) return;
  cy.edges().removeClass("hot revealed");
  // a table click also reveals the edges of its columns/triggers/constraints
  const core = node.union(node.descendants());
  const hood = core.closedNeighborhood().union(node.ancestors());
  cy.elements().addClass("dimmed");
  hood.removeClass("dimmed");
  core.connectedEdges().addClass("revealed hot");
  renderPanel(node);
}

function clearSelection(): void {
  cy?.elements().removeClass("dimmed");
  cy?.edges().removeClass("hot revealed");
  el("panel").classList.add("hidden");
}

function renderPanel(node: NodeSingular): void {
  const d = node.data() as GraphNodeData;
  const panel = el("panel");
  panel.classList.remove("hidden");
  const edges = node.connectedEdges().filter((e) => !e.hasClass("hidden-el"));
  const rows = edges
    .map((e: EdgeSingular) => {
      const data = e.data() as GraphEdgeData;
      const outgoing = data.source === node.id();
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
      return `<li data-node="${esc(other.id())}">
        <span class="kind" style="color:${EDGE_COLORS[data.kind] ?? "#8993A4"}">${outgoing ? "→" : "←"} ${esc(data.kind)}</span>
        <span class="name">${esc(display)}</span>
        <small>${esc(otherData.type)}</small>
      </li>`;
    })
    .join("");
  panel.innerHTML = `
    <h2>${esc(d.label)}</h2>
    <p class="meta">
      <span class="chip" style="background:${NODE_COLORS[d.type] ?? "#888"}">${esc(d.type)}</span>
      <span>${esc(d.schema ?? "")}</span>
    </p>
    ${d.detail ? `<p class="detail">${esc(d.detail)}</p>` : ""}
    ${d.type === "schema" ? "" : '<div class="actions"><button id="ddl-btn">Open DDL</button></div>'}
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
    .map(([k, n]) => `${n} ${k}${k === "edges" || n === 1 ? "" : "s"}`);
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
  "flt-edges",
  "flt-isolated",
]) {
  el(id).addEventListener("change", applyFilters);
}
el("flt-schemagroup").addEventListener("change", () => applySchemaGrouping(true));
el("layout").addEventListener("change", runLayout);
el("relayout").addEventListener("click", runLayout);
el("fit").addEventListener("click", () => cy?.fit(undefined, 40));
el("refresh").addEventListener("click", () => {
  el("empty").style.display = "flex";
  el("empty").textContent = "Refreshing…";
  vscode.postMessage({ type: "refresh" });
});

buildLegend();
vscode.postMessage({ type: "ready" });
