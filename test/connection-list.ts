import assert from "node:assert/strict";
import cytoscape, { type NodeSingular } from "cytoscape";
import { DEFAULT_PREFS } from "../src/protocol";
import { ConnectionList } from "../webview/connection-list";
import type { EdgeDef, NodeDef } from "../webview/cytoscape-adapter";

class FakeElement {
  readonly dataset: Record<string, string>;

  constructor(dataset: Record<string, string>) {
    this.dataset = dataset;
  }

  closest(): this {
    return this;
  }
}

class FakeRoot {
  private clickListener: ((event: { target: FakeElement }) => void) | undefined;

  addEventListener(type: string, listener: (event: { target: unknown }) => void): void {
    if (type === "click") {
      this.clickListener = listener as unknown as (event: { target: FakeElement }) => void;
    }
  }

  click(dataset: Record<string, string>): void {
    this.clickListener?.({ target: new FakeElement(dataset) });
  }
}

async function main(): Promise<void> {
  const targets = Array.from({ length: 45 }, (_, index) => ({
    data: {
      id: `target${String(index).padStart(2, "0")}`,
      label: `Target ${index}`,
      type: "table",
    },
  }));
  const graph = cytoscape({
    headless: true,
    elements: {
      nodes: [{ data: { id: "hub", label: "Hub", type: "function" } }, ...targets],
      edges: [
        ...targets.map((target, index) => ({
          data: {
            id: `edge${index}`,
            source: "hub",
            target: target.data.id,
            kind: "calls",
            agg: true,
          },
        })),
        {
          data: {
            id: "extra-kind",
            source: "hub",
            target: "target00",
            kind: "reads",
            agg: true,
          },
        },
      ],
    },
  });
  const root = new FakeRoot();
  let selected = "";
  let html = "";
  let list!: ConnectionList;
  list = new ConnectionList({
    root,
    graph: () => graph,
    prefs: () => DEFAULT_PREFS,
    edgeColors: { calls: "#f0a", reads: "#0af" },
    detailEdgesByCard: new Map(),
    nodeDefById: new Map(),
    cardOfNode: new Map(),
    isShown: () => true,
    onSelect: (node) => {
      selected = node.id();
    },
    onPage: (page) => {
      html = page;
    },
  });
  const hub = graph.getElementById("hub") as unknown as NodeSingular;
  html = list.render(hub);
  assert.equal((html.match(/data-connection-node=/g) ?? []).length, 40);
  assert.match(html, /Uses \(45\)/, "duplicate neighbor edges are grouped");
  assert.match(html, /Show 5 more \(5 remaining\)/);
  assert.match(html, /type="button" class="edge-link"/);
  assert.match(html, /aria-label="Uses Target 0: calls, reads"/);
  assert.ok(html.indexOf("Target 0") < html.indexOf("Target 1"), "connections are sorted");

  graph.remove(graph.getElementById("edge44"));
  root.click({ more: "out" });
  assert.equal(
    (html.match(/data-connection-node=/g) ?? []).length,
    45,
    "paging slices the cached groups without rescanning the graph",
  );
  assert.doesNotMatch(html, /data-more="out"/);
  root.click({ connectionNode: "target00" });
  assert.equal(selected, "target00", "delegated connection buttons select their target");

  const cardGraph = cytoscape({
    headless: true,
    elements: {
      nodes: [
        { data: { id: "fn", label: "Function", type: "function" } },
        { data: { id: "orders", label: "Orders", type: "table" } },
      ],
      edges: [{ data: { id: "agg", source: "fn", target: "orders", kind: "reads", agg: true } }],
    },
  });
  const detailEdges = new Map<string, EdgeDef[]>([
    ["orders", [{ data: { id: "detail", source: "fn", target: "orders_total", kind: "reads" } }]],
  ]);
  const indexed = new ConnectionList({
    root: new FakeRoot(),
    graph: () => cardGraph,
    prefs: () => DEFAULT_PREFS,
    edgeColors: { reads: "#0af" },
    detailEdgesByCard: detailEdges,
    nodeDefById: new Map<string, NodeDef>([
      [
        "orders_total",
        {
          data: {
            id: "orders_total",
            label: "total",
            type: "column",
            parent: "orders",
            oid: 1,
          },
        },
      ],
    ]),
    cardOfNode: new Map([["orders_total", "orders"]]),
    isShown: () => true,
    onSelect: () => undefined,
    onPage: () => undefined,
  });
  indexed.reindex();
  assert.match(
    indexed.render(cardGraph.getElementById("fn") as unknown as NodeSingular),
    /reads: total/,
    "aggregate member labels come from the per-graph index",
  );
  console.log("connection-list OK - grouping, paging, buttons, and indexed aggregate labels");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
