import assert from "node:assert/strict";
import Module from "node:module";
import type { DdlSymbol } from "../src/ddl-symbols";

type LoadModule = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    assert.ok(startLine >= 0, "range start line must be non-negative");
    assert.ok(startCharacter >= 0, "range start character must be non-negative");
    assert.ok(endLine >= startLine, "range end line must not precede start line");
    if (endLine === startLine) {
      assert.ok(
        endCharacter >= startCharacter,
        "same-line range end character must not precede start character",
      );
    }
    this.start = new Position(startLine, startCharacter);
    this.end = new Position(endLine, endCharacter);
  }
}

const SymbolKind = {
  Class: 5,
  Interface: 11,
  Function: 12,
  Event: 24,
  Key: 20,
  Field: 7,
  Method: 6,
};

class DocumentSymbol {
  children: DocumentSymbol[] = [];

  constructor(
    readonly name: string,
    readonly detail: string,
    readonly kind: number,
    readonly range: Range,
    readonly selectionRange: Range,
  ) {}
}

class MockDocument {
  private readonly lines: string[];

  constructor(private readonly text: string) {
    this.lines = text.split("\n");
  }

  get lineCount(): number {
    return this.lines.length;
  }

  getText(): string {
    return this.text;
  }

  lineAt(line: number): { text: string } {
    const text = this.lines[line];
    if (text === undefined) throw new Error(`missing mock document line ${line}`);
    return { text };
  }
}

const fakeVscode = { DocumentSymbol, Range, SymbolKind };
const moduleWithLoad = Module as unknown as { _load: LoadModule };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function load(this: unknown, request, parent, isMain) {
  if (request === "vscode") return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};

async function main(): Promise<void> {
  const { DdlDocumentSymbolProvider, ddlSymbolToDocumentSymbol } = await import(
    "../src/ddl-symbol-provider"
  );
  type TextDocumentArg = Parameters<typeof ddlSymbolToDocumentSymbol>[0];

  const document = new MockDocument("CREATE TABLE public.orders (\n  id integer\n);");
  const malformed = {
    name: "bad",
    kind: "table",
    line: -4,
    col: -9,
    endLine: -2,
    children: [
      {
        name: "far_child",
        kind: "column",
        line: 99,
        col: 999,
        endLine: 120,
        children: [],
      },
      {
        name: "nan_child",
        kind: "column",
        line: Number.NaN,
        col: Number.POSITIVE_INFINITY,
        endLine: Number.NEGATIVE_INFINITY,
      },
    ],
  } as unknown as DdlSymbol;

  const symbol = ddlSymbolToDocumentSymbol(document as unknown as TextDocumentArg, malformed);
  assert.equal(symbol.range.start.line, 0, "negative symbol lines clamp to the first line");
  assert.equal(symbol.range.end.line, 0, "negative end lines clamp to a valid range");
  assert.equal(symbol.selectionRange.start.character, 0, "negative columns clamp to column zero");
  assert.equal(symbol.children.length, 2, "malformed child arrays still map valid children");

  const farChild = symbol.children[0]!;
  assert.equal(farChild.range.start.line, 2, "oversized child lines clamp to the last line");
  assert.equal(farChild.selectionRange.start.character, 2, "oversized columns clamp to line length");
  assert.equal(farChild.selectionRange.end.character, 2, "clamped child selection stays valid");

  const nanChild = symbol.children[1]!;
  assert.equal(nanChild.range.start.line, 0, "NaN child lines clamp to the first line");
  assert.equal(nanChild.selectionRange.start.character, 0, "non-finite columns clamp to column zero");
  assert.deepEqual(nanChild.children, [], "missing child arrays are treated as empty");

  const provider = new DdlDocumentSymbolProvider();
  const parsedSymbols = provider.provideDocumentSymbols(document as never);
  assert.equal(parsedSymbols[0]?.name, "public.orders");
  assert.equal(parsedSymbols[0]?.children[0]?.name, "id");

  console.log("ddl-symbol-provider OK - clamped ranges and malformed child safety");
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    moduleWithLoad._load = originalLoad;
  });
