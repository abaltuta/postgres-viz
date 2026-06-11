/**
 * Thin VS Code adapter over the pure scanner in `src/ddl-symbols.ts`, so "@" /
 * Outline works inside an opened pgviz: DDL document. The orchestrator wires
 * registration in extension.ts — this class only maps DdlSymbol → DocumentSymbol.
 */
import * as vscode from "vscode";
import { type DdlSymbol, parseDdlSymbols } from "./ddl-symbols";

const SYMBOL_KINDS: Record<DdlSymbol["kind"], vscode.SymbolKind> = {
  table: vscode.SymbolKind.Class,
  view: vscode.SymbolKind.Interface,
  function: vscode.SymbolKind.Function,
  trigger: vscode.SymbolKind.Event,
  index: vscode.SymbolKind.Key,
  constraint: vscode.SymbolKind.Key,
  column: vscode.SymbolKind.Field,
  statement: vscode.SymbolKind.Method,
};

function toDocumentSymbol(document: vscode.TextDocument, sym: DdlSymbol): vscode.DocumentSymbol {
  const startLine = Math.min(sym.line, document.lineCount - 1);
  const endLine = Math.min(Math.max(sym.endLine, sym.line), document.lineCount - 1);
  const endChar = document.lineAt(endLine).text.length;
  const range = new vscode.Range(startLine, 0, endLine, endChar);
  // selection (the highlighted name) must stay within `range` — clamp to its line
  const lineLen = document.lineAt(startLine).text.length;
  const selCol = Math.min(sym.col, lineLen);
  const selection = new vscode.Range(startLine, selCol, startLine, lineLen);
  const out = new vscode.DocumentSymbol(
    sym.name,
    sym.detail ?? "",
    SYMBOL_KINDS[sym.kind],
    range,
    selection,
  );
  out.children = sym.children.map((c) => toDocumentSymbol(document, c));
  return out;
}

export class DdlDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    return parseDdlSymbols(document.getText()).map((s) => toDocumentSymbol(document, s));
  }
}
