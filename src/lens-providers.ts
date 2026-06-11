/**
 * Thin VS Code adapters over the pure logic in `src/lenses.ts`. The orchestrator
 * wires registration (and the `postgresViz.revealNode` / `postgresViz.treeCallTree`
 * commands) in extension.ts — these classes only translate documents into lenses
 * and hovers. They re-parse on demand; `getGraph()` supplies the current payload.
 */
import * as vscode from "vscode";
import { parseHclSymbols } from "./hcl";
import { buildLensAnchors, hoverMarkdown } from "./lenses";
import type { GraphPayload } from "./types";

export class HclLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly getGraph: () => GraphPayload | null) {}

  /** Fire when the graph (re)loads so VS Code re-requests lenses. */
  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const entries = parseHclSymbols(document.getText());
    const anchors = buildLensAnchors(entries, this.getGraph());
    const lenses: vscode.CodeLens[] = [];
    for (const a of anchors) {
      const range = new vscode.Range(a.line, a.col, a.line, a.col);
      if (a.graphId) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(graph) Show in graph",
            command: "postgresViz.revealNode",
            arguments: [a.graphId],
          }),
        );
        if (a.canCallTree) {
          lenses.push(
            new vscode.CodeLens(range, {
              title: "Call tree",
              command: "postgresViz.treeCallTree",
              arguments: [{ graphId: a.graphId }],
            }),
          );
        }
        if (a.summary) {
          // title-only lens: no command, just the relationship readout
          lenses.push(new vscode.CodeLens(range, { title: a.summary, command: "" }));
        }
      }
    }
    return lenses;
  }
}

export class HclHoverProvider implements vscode.HoverProvider {
  constructor(private readonly getGraph: () => GraphPayload | null) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const graph = this.getGraph();
    if (!graph) return undefined;
    const entries = parseHclSymbols(document.getText());
    const anchors = buildLensAnchors(entries, graph);
    const anchor = anchors.find((a) => a.line === position.line);
    if (!anchor) return undefined;
    const md = hoverMarkdown(anchor, graph);
    if (!md) return undefined;
    return new vscode.Hover(new vscode.MarkdownString(md));
  }
}
