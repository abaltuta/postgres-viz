import assert from "node:assert/strict";
import Module from "node:module";
import type { GraphPayload } from "../src/types";

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
    this.start = new Position(startLine, startCharacter);
    this.end = new Position(endLine, endCharacter);
  }

  contains(position: Position): boolean {
    if (position.line < this.start.line || position.line > this.end.line) return false;
    if (position.line === this.start.line && position.character < this.start.character) return false;
    if (position.line === this.end.line && position.character > this.end.character) return false;
    return true;
  }
}

interface Command {
  title: string;
  command: string;
  arguments?: unknown[];
}

class CodeLens {
  constructor(
    readonly range: Range,
    readonly command?: Command,
  ) {}
}

class MarkdownString {
  constructor(readonly value: string) {}
}

class Hover {
  constructor(
    readonly contents: MarkdownString,
    readonly range?: Range,
  ) {}
}

class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  private disposed = false;

  readonly event = (listener: (value: T) => void): { dispose(): void } => {
    if (!this.disposed) this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener(value);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
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

const fakeVscode = { CodeLens, EventEmitter, Hover, MarkdownString, Range };
const moduleWithLoad = Module as unknown as { _load: LoadModule };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function load(this: unknown, request, parent, isMain) {
  if (request === "vscode") return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};

const graph: GraphPayload = {
  nodes: [
    { data: { id: "table_orders", label: "orders", type: "table", schema: "public", oid: 1 } },
    {
      data: {
        id: "table_escaped",
        label: 'employment "cost" group',
        type: "table",
        schema: "public",
        oid: 2,
      },
    },
  ],
  edges: [],
  stats: {},
};

function pos(line: number, character: number): Position {
  return new Position(line, character);
}

async function main(): Promise<void> {
  const { HclHoverProvider, HclLensProvider } = await import("../src/lens-providers");
  type DocumentArg = Parameters<InstanceType<typeof HclLensProvider>["provideCodeLenses"]>[0];
  type PositionArg = Parameters<InstanceType<typeof HclHoverProvider>["provideHover"]>[1];

  const refreshProvider = new HclLensProvider(() => graph);
  let refreshes = 0;
  const subscription = refreshProvider.onDidChangeCodeLenses(() => {
    refreshes += 1;
  });
  refreshProvider.refresh();
  assert.equal(refreshes, 1, "refresh fires a CodeLens change event");
  subscription.dispose();
  refreshProvider.dispose();

  const text = 'table "public" "orders" { } # trailing text on the same line';
  const document = new MockDocument(text) as unknown as DocumentArg;
  const ordersStart = text.indexOf("orders");
  const ordersEnd = ordersStart + "orders".length;

  const lensProvider = new HclLensProvider(() => graph);
  const lenses = lensProvider.provideCodeLenses(document);
  const revealLens = lenses[0];
  assert.ok(revealLens, "resolved HCL object gets a reveal CodeLens");
  assert.equal(revealLens.command?.command, "postgresViz.revealNode");
  assert.equal(revealLens.range.start.character, ordersStart);
  assert.equal(revealLens.range.end.character, ordersEnd);

  const hoverProvider = new HclHoverProvider(() => graph);
  assert.equal(
    hoverProvider.provideHover(document, pos(0, text.indexOf("table")) as unknown as PositionArg),
    undefined,
    "hover does not trigger on the block keyword",
  );
  assert.equal(
    hoverProvider.provideHover(document, pos(0, text.indexOf("#") + 2) as unknown as PositionArg),
    undefined,
    "hover does not trigger on same-line trailing text",
  );
  assert.equal(
    hoverProvider.provideHover(document, pos(0, ordersEnd) as unknown as PositionArg),
    undefined,
    "hover does not include the closing quote after a label",
  );

  const hover = hoverProvider.provideHover(
    document,
    pos(0, ordersStart + 1) as unknown as PositionArg,
  );
  assert.ok(hover, "hover triggers inside the object label");
  assert.equal(hover.range?.start.character, ordersStart);
  assert.equal(hover.range?.end.character, ordersEnd);
  const hoverContents = hover.contents as unknown as MarkdownString;
  assert.ok(hoverContents.value.includes("public\\.orders"), "hover still renders graph markdown");

  const escapedText = String.raw`table "public" "employment \"cost\" group" { }`;
  const escapedDocument = new MockDocument(escapedText) as unknown as DocumentArg;
  const escapedStart = escapedText.indexOf("employment");
  const escapedEnd = escapedText.indexOf('" {');
  const escapedHover = hoverProvider.provideHover(
    escapedDocument,
    pos(0, escapedText.indexOf("cost")) as unknown as PositionArg,
  );
  assert.ok(escapedHover, "hover range spans escaped quotes inside a label");
  assert.equal(escapedHover.range?.start.character, escapedStart);
  assert.equal(escapedHover.range?.end.character, escapedEnd);
  assert.equal(
    hoverProvider.provideHover(
      escapedDocument,
      pos(0, escapedEnd) as unknown as PositionArg,
    ),
    undefined,
    "escaped-label hover does not include the closing quote",
  );
  assert.equal(
    hoverProvider.provideHover(
      escapedDocument,
      pos(0, escapedText.length - 1) as unknown as PositionArg,
    ),
    undefined,
    "hover stays within the escaped label range",
  );

  console.log("lens-providers OK - CodeLens ranges and scoped hovers");
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    moduleWithLoad._load = originalLoad;
  });
