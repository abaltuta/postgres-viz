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
};

const EDGE_COLORS: Record<string, string> = {
  selects: "#36B37E",
  reads: "#4C9AFF",
  writes: "#FF5630",
  calls: "#FFAB00",
  executes: "#FF7452",
  "update-of": "#FF8F73",
  fk: "#8993A4",
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
    {
      selector: 'node[type="column"]',
      style: { "font-size": 8, height: 13, "background-opacity": 0.5 },
    },
    {
      selector: 'node[type="trigger"]',
      style: { "font-size": 8, height: 13, shape: "diamond", padding: "8px" },
    },
    {
      selector: ":parent",
      style: {
        "text-valign": "top",
        "text-halign": "center",
        "font-weight": "bold",
        "font-size": 10,
        "background-opacity": 0.07,
        "border-width": 1.5,
        "border-color": "#8993A4",
        padding: "10px",
      },
    },
    {
      selector: "edge",
      style: {
        width: 1.2,
        "curve-style": "bezier",
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.7,
        "line-color": "#8993A4",
        "target-arrow-color": "#8993A4",
        opacity: 0.7,
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
  cy?.destroy();
  cy = cytoscape({
    container: el("cy"),
    elements: { nodes: graph.nodes, edges: graph.edges } as cytoscape.ElementsDefinition,
    style: buildStyle(),
    layout: { name: "preset" },
    wheelSensitivity: 0.2,
  });
  lastStats = graph.stats;
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
    g.edges('[kind="fk"]').toggleClass("hidden-el", !checked("flt-fk"));

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
  updateStats();
}

function runLayout(): void {
  if (!cy) return;
  const name = el<HTMLSelectElement>("layout").value;
  const options: Record<string, object> = {
    fcose: {
      name: "fcose",
      animate: false,
      quality: "default",
      nodeSeparation: 80,
      idealEdgeLength: 110,
      nestingFactor: 0.7,
      packComponents: true,
    },
    breadthfirst: { name: "breadthfirst", directed: true, spacingFactor: 1.1 },
    concentric: { name: "concentric", minNodeSpacing: 30 },
    grid: { name: "grid" },
  };
  cy.elements(":visible")
    .layout((options[name] ?? options.fcose) as cytoscape.LayoutOptions)
    .run();
}

function selectNode(node: NodeSingular): void {
  if (!cy) return;
  cy.elements().addClass("dimmed");
  node.closedNeighborhood().union(node.ancestors()).union(node.descendants()).removeClass("dimmed");
  renderPanel(node);
}

function clearSelection(): void {
  cy?.elements().removeClass("dimmed");
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
      return `<li data-node="${esc(other.id())}">
        <span class="kind" style="color:${EDGE_COLORS[data.kind] ?? "#8993A4"}">${outgoing ? "→" : "←"} ${esc(data.kind)}</span>
        <span class="name">${esc(otherData.label)}</span>
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
    <div class="actions"><button id="ddl-btn">Open DDL</button></div>
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
  }
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
  "flt-fk",
  "flt-isolated",
]) {
  el(id).addEventListener("change", applyFilters);
}
el("layout").addEventListener("change", runLayout);
el("relayout").addEventListener("click", runLayout);
el("fit").addEventListener("click", () => cy?.fit(undefined, 40));
el("refresh").addEventListener("click", () => {
  el("empty").style.display = "flex";
  el("empty").textContent = "Refreshing…";
  vscode.postMessage({ type: "refresh" });
});

buildLegend();
