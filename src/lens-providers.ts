/**
 * Thin VS Code adapters over the pure logic in `src/lenses.ts`. The orchestrator
 * wires registration (and the `postgresViz.revealNode` / `postgresViz.treeCallTree`
 * commands) in extension.ts — these classes only translate documents into lenses
 * and hovers. They re-parse on demand; `getGraph()` supplies the current payload.
 */
import * as vscode from "vscode";
import { parseHclSymbols } from "./hcl";
import { buildLensAnchors, hoverMarkdown } from "./lenses";
import type { LensAnchor } from "./lenses";
import type { GraphPayload } from "./types";

export class HclLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly getGraph: () => GraphPayload | null) {}

  dispose(): void {
    this.emitter.dispose();
  }

  /** Fire when the graph (re)loads so VS Code re-requests lenses. */
  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const entries = parseHclSymbols(document.getText());
    const anchors = buildLensAnchors(entries, this.getGraph());
    const lenses: vscode.CodeLens[] = [];
    for (const a of anchors) {
      const range = anchorLabelRange(document, a);
      if (!range) continue;
      if (a.graphId) {
        lenses.push(
          commandLens(range, "$(graph) Show in graph", "postgresViz.revealNode", [a.graphId]),
        );
        if (a.canCallTree) {
          lenses.push(
            commandLens(range, "Call tree", "postgresViz.treeCallTree", [{ graphId: a.graphId }]),
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

function commandLens(
  range: vscode.Range,
  title: string,
  command: string,
  args: unknown[],
): vscode.CodeLens {
  return new vscode.CodeLens(range, { title, command, arguments: args });
}

export class HclHoverProvider implements vscode.HoverProvider {
  constructor(private readonly getGraph: () => GraphPayload | null) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const graph = this.getGraph();
    if (!graph) return undefined;
    const entries = parseHclSymbols(document.getText());
    const anchors = buildLensAnchors(entries, graph);
    for (const anchor of anchors) {
      const range = anchorLabelRange(document, anchor);
      if (
        !range ||
        position.line < range.start.line ||
        position.line > range.end.line ||
        (position.line === range.start.line && position.character < range.start.character) ||
        (position.line === range.end.line && position.character >= range.end.character)
      ) {
        continue;
      }
      const md = hoverMarkdown(anchor, graph);
      if (md) return new vscode.Hover(new vscode.MarkdownString(md), range);
    }
    return undefined;
  }
}

function anchorLabelRange(
  document: vscode.TextDocument,
  anchor: LensAnchor,
): vscode.Range | undefined {
  if (!Number.isInteger(anchor.line) || anchor.line < 0 || anchor.line >= document.lineCount) {
    return undefined;
  }
  const text = document.lineAt(anchor.line).text;
  const start = Math.max(0, Math.min(anchor.col, text.length));
  let end = Math.min(text.length, start + Math.max(1, anchor.name.length));
  if (start > 0 && text[start - 1] === '"') {
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        end = i;
        break;
      }
    }
  }
  return new vscode.Range(anchor.line, start, anchor.line, end);
}
