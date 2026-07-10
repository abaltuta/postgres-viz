import type { Core, EdgeSingular, NodeSingular } from "cytoscape";
import { MAX_EXPORT_DIMENSION, MAX_EXPORT_PIXELS } from "../src/export-limits";

export interface GraphExporterOptions {
  graph: () => Core | null;
  dark: () => boolean;
  nodeShown: (node: NodeSingular) => boolean;
  edgeShown: (edge: EdgeSingular) => boolean;
  nodeColors: Readonly<Record<string, string>>;
  edgeColors: Readonly<Record<string, string>>;
}

export class GraphExporter {
  constructor(private readonly options: GraphExporterOptions) {}

  png(): string | undefined {
    const cy = this.options.graph();
    if (!cy) return undefined;
    const nodes = cy.nodes().filter((node) => this.options.nodeShown(node as NodeSingular));
    const bounds = (nodes.nonempty() ? nodes : cy.elements()).boundingBox({
      includeLabels: true,
      includeOverlays: false,
    });
    const width = Math.max(1, bounds.w);
    const height = Math.max(1, bounds.h);
    const scale = Math.min(
      2,
      MAX_EXPORT_DIMENSION / width,
      MAX_EXPORT_DIMENSION / height,
      Math.sqrt(MAX_EXPORT_PIXELS / (width * height)),
    );
    const full = scale >= 0.25;
    return cy.png({
      full,
      scale: full ? scale : 2,
      bg: this.options.dark() ? "#1e1e1e" : "#ffffff",
    });
  }

  svg(): string | undefined {
    const cy = this.options.graph();
    if (!cy) return undefined;
    const nodes = cy.nodes().filter((node) => this.options.nodeShown(node as NodeSingular));
    const edges = cy.edges().filter((edge) => this.options.edgeShown(edge as EdgeSingular));
    const bounds = nodes.nonempty()
      ? nodes.boundingBox({ includeLabels: true, includeOverlays: false })
      : { x1: 0, y1: 0, w: 800, h: 600 };
    const pad = 48;
    const x0 = bounds.x1 - pad;
    const y0 = bounds.y1 - pad;
    const width = Math.max(1, bounds.w + pad * 2);
    const height = Math.max(1, bounds.h + pad * 2);
    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.min(MAX_EXPORT_DIMENSION, Math.ceil(width))}" height="${Math.min(MAX_EXPORT_DIMENSION, Math.ceil(height))}" viewBox="${x0} ${y0} ${width} ${height}">`,
      `<rect x="${x0}" y="${y0}" width="${width}" height="${height}" fill="${this.options.dark() ? "#1e1e1e" : "#ffffff"}"/>`,
    ];
    edges.forEach((edge) => {
      const source = edge.source().position();
      const target = edge.target().position();
      const color = this.options.edgeColors[String(edge.data("kind"))] ?? "#6b778c";
      parts.push(
        `<line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" stroke="${color}" stroke-width="1.5" stroke-opacity="0.75"/>`,
      );
    });
    nodes.forEach((raw) => {
      const node = raw as NodeSingular;
      const position = node.position();
      const color = this.options.nodeColors[String(node.data("type"))] ?? "#8f9bb3";
      const label = String(node.data("label") ?? "").replace(
        /[&<>"']/g,
        (char) => `&#${char.charCodeAt(0)};`,
      );
      if (node.isParent()) {
        const box = node.boundingBox({ includeLabels: false, includeOverlays: false });
        parts.push(
          `<rect x="${box.x1}" y="${box.y1}" width="${box.w}" height="${box.h}" rx="6" fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-opacity="0.35"/>`,
        );
      } else {
        parts.push(
          `<circle cx="${position.x}" cy="${position.y}" r="8" fill="${color}"/><text x="${position.x + 12}" y="${position.y + 4}" font-family="sans-serif" font-size="11" fill="${this.options.dark() ? "#d4d4d4" : "#172b4d"}">${label}</text>`,
        );
      }
    });
    parts.push("</svg>");
    return parts.join("");
  }
}
