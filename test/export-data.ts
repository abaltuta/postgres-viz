import assert from "node:assert/strict";
import cytoscape, { type EdgeSingular, type NodeSingular } from "cytoscape";
import {
  decodePngExport,
  pngDataUriLengthWithinLimit,
  svgTextIsSafe,
  svgTextWithinLimit,
  validateSvgText,
} from "../src/export-data";
import { MAX_PNG_DATA_URI_LENGTH } from "../src/export-limits";
import { GraphExporter } from "../webview/graph-exporter";

const signatureAndPayload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const valid = `data:image/png;base64,${signatureAndPayload.toString("base64")}`;
assert.deepEqual(decodePngExport(valid), signatureAndPayload, "bounded PNG payload is decoded");
assert.equal(decodePngExport("data:image/png;base64,AAAA"), undefined, "signature is required");
assert.ok(pngDataUriLengthWithinLimit(MAX_PNG_DATA_URI_LENGTH));
assert.ok(!pngDataUriLengthWithinLimit(MAX_PNG_DATA_URI_LENGTH + 1), "oversized PNG is rejected");
assert.ok(svgTextWithinLimit("<svg></svg>"));
assert.ok(!svgTextWithinLimit("é".repeat(8 * 1_024 * 1_024 + 1)), "SVG limit uses UTF-8 bytes");
assert.deepEqual(validateSvgText("not svg"), { ok: false, reason: "invalid-root" });
assert.deepEqual(validateSvgText("é".repeat(8 * 1_024 * 1_024 + 1)), {
  ok: false,
  reason: "too-large",
});
assert.deepEqual(validateSvgText("<svg><script/></svg>"), {
  ok: false,
  reason: "unsafe-content",
});
assert.ok(svgTextIsSafe('<svg><line x1="0" y1="0" x2="1" y2="1"/></svg>'));
assert.ok(!svgTextIsSafe("<svg><script>alert(1)</script></svg>"), "scripts are rejected");
assert.ok(!svgTextIsSafe('<svg><circle onload="alert(1)"/></svg>'), "event handlers are rejected");
assert.ok(
  !svgTextIsSafe('<svg><use href="https://example.com/a.svg#x"/></svg>'),
  "external references are rejected",
);

const graph = cytoscape({
  headless: true,
  elements: {
    nodes: [
      { data: { id: "left", type: "table", label: "orders<&" } },
      { data: { id: "right", type: "function", label: "refresh" } },
    ],
    edges: [{ data: { id: "reads", source: "right", target: "left", kind: "reads" } }],
  },
});
graph.getElementById("left").position({ x: 0, y: 0 });
graph.getElementById("right").position({ x: 100_000, y: 100_000 });
let pngOptions: unknown;
(graph as unknown as { png: (options: unknown) => string }).png = (options) => {
  pngOptions = options;
  return "data:image/png;base64,fake";
};
const graphExporter = new GraphExporter({
  graph: () => graph,
  dark: () => false,
  nodeShown: (_node: NodeSingular) => true,
  edgeShown: (_edge: EdgeSingular) => true,
  nodeColors: { table: "#112233", function: "#445566" },
  edgeColors: { reads: "#778899" },
});
assert.equal(graphExporter.png(), "data:image/png;base64,fake");
assert.deepEqual(
  pngOptions,
  { full: false, scale: 2, bg: "#ffffff" },
  "oversized PNG falls back to the viewport",
);
const svg = graphExporter.svg()!;
assert.match(svg, /width="8192" height="8192"/, "SVG display dimensions are capped");
assert.match(svg, /orders&#60;&#38;/, "SVG labels are escaped");
assert.match(svg, /stroke="#778899"/, "SVG keeps relationship colors");
assert.equal(
  new GraphExporter({
    graph: () => null,
    dark: () => false,
    nodeShown: () => true,
    edgeShown: () => true,
    nodeColors: {},
    edgeColors: {},
  }).svg(),
  undefined,
  "export is a no-op without a graph",
);

console.log("export-data OK - validates payload limits and bounded graph exports");
