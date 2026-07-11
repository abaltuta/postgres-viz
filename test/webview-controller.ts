import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { GraphPayload } from "../src/types";
import type { Prefs } from "../src/protocol";
import { DEFAULT_PREFS } from "../src/protocol";

type MessageHandler = (message: unknown) => void;

class FakeWebview {
  cspSource = "vscode-resource:\"&<>'";
  html = "";
  readonly messages: unknown[] = [];
  nextPostResult: boolean | Error | undefined;
  private messageHandler: MessageHandler | undefined;

  asWebviewUri(uri: { toString(): string }): { toString(): string } {
    return {
      toString: () => `webview://${uri.toString()}?x="&<>'`,
    };
  }

  postMessage(message: unknown): PromiseLike<boolean> {
    this.messages.push(message);
    const result = this.nextPostResult;
    this.nextPostResult = undefined;
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result ?? true);
  }

  onDidReceiveMessage(handler: MessageHandler): { dispose(): void } {
    this.messageHandler = handler;
    return { dispose: () => undefined };
  }

  receive(message: unknown): void {
    this.messageHandler?.(message);
  }
}

class FakePanel {
  readonly webview = new FakeWebview();
  readonly reveals: { preserveFocus?: boolean }[] = [];
  private disposeHandlers: (() => void)[] = [];

  reveal(_column?: unknown, preserveFocus?: boolean): void {
    this.reveals.push({ preserveFocus });
  }

  onDidDispose(handler: () => void): { dispose(): void } {
    this.disposeHandlers.push(handler);
    return { dispose: () => undefined };
  }

  dispose(): void {
    for (const handler of this.disposeHandlers) handler();
  }
}

const panels: FakePanel[] = [];
const fakeVscode = {
  ViewColumn: { One: 1 },
  Uri: {
    joinPath(base: { toString(): string }, ...parts: string[]): { toString(): string } {
      return {
        toString: () => `${base.toString()}/${parts.join("/")}`,
      };
    },
  },
  window: {
    createWebviewPanel(): FakePanel {
      const panel = new FakePanel();
      panels.push(panel);
      return panel;
    },
  },
};

type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const requireModule = createRequire(__filename);
const moduleWithLoad = requireModule("node:module") as { _load: ModuleLoader };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
  if (request === "vscode") return fakeVscode;
  return originalLoad(request, parent, isMain);
};

async function main(): Promise<void> {
  const { WebviewController } = await import("../src/webview-controller");
  const graph: GraphPayload = {
    nodes: [],
    edges: [],
    stats: {},
  };
  const prefs: Prefs = { ...DEFAULT_PREFS, edgeMode: "all" };
  const openDdlCalls: unknown[][] = [];
  const openDefinitionCalls: unknown[][] = [];
  const usageCalls: string[] = [];
  const usageOccurrenceCalls: unknown[][] = [];
  const openUsageCalls: string[] = [];
  const errors: unknown[] = [];
  let resetFiltersCalls = 0;
  const controller = new WebviewController({
    extensionUri: { toString: () => "ext:\"&<>'" } as never,
    logLine: () => undefined,
    currentGraph: () => graph,
    currentDatabase: () => "db",
    currentRevision: () => 7,
    prefs: () => prefs,
    onStats: () => undefined,
    onRefresh: async () => undefined,
    onResetFilters: () => {
      resetFiltersCalls++;
    },
    onOpenDdl: async (...args) => {
      openDdlCalls.push(args);
    },
    onOpenDefinition: async (...args) => {
      openDefinitionCalls.push(args);
    },
    onNodeSelected: () => undefined,
    onRequestColumnUsages: (columnId) => {
      usageCalls.push(columnId);
      return { columnId, groups: [] };
    },
    onRequestUsageOccurrences: (groupId, offset) => {
      usageOccurrenceCalls.push([groupId, offset]);
      return { groupId, offset, total: 0, occurrences: [] };
    },
    onOpenUsage: async (occurrenceId) => {
      openUsageCalls.push(occurrenceId);
    },
    onPngExport: () => undefined,
    onSvgExport: () => undefined,
    onError: (error) => errors.push(error),
  });

  controller.ensure();

  const panel = panels[0];
  assert.ok(panel, "ensure creates a webview panel");
  assert.match(
    panel.webview.html,
    /href="webview:\/\/ext:&quot;&amp;&lt;&gt;&#39;\/media\/style\.css\?x=&quot;&amp;&lt;&gt;&#39;"/,
    "stylesheet URI is escaped inside the href attribute",
  );
  assert.match(
    panel.webview.html,
    /src="webview:\/\/ext:&quot;&amp;&lt;&gt;&#39;\/media\/webview\.js\?x=&quot;&amp;&lt;&gt;&#39;"/,
    "script URI is escaped inside the src attribute",
  );
  assert.match(
    panel.webview.html,
    /script-src vscode-resource:&quot;&amp;&lt;&gt;&#39;;/,
    "CSP source is escaped inside the content attribute",
  );
  assert.match(
    panel.webview.html,
    /<div id="canvas">[\s\S]*<button id="reset-filters"[\s\S]*<\/div>\s*<aside id="panel"/,
    "canvas overlays share a bounded surface and the details panel is a flex sibling",
  );
  assert.match(
    panel.webview.html,
    /<footer id="canvas-footer">[\s\S]*id="legend"[\s\S]*id="stats"[\s\S]*<\/footer>/,
    "legend and stats share a responsive footer",
  );
  assert.match(
    panel.webview.html,
    /id="cy" role="region"[^>]*aria-label="Database graph\.[^"]+" tabindex="0"/,
    "the graph surface exposes keyboard navigation semantics",
  );
  assert.match(panel.webview.html, /id="empty" role="status"/);
  assert.match(panel.webview.html, /id="stats" aria-live="polite"/);
  assert.match(panel.webview.html, /id="panel" class="hidden" aria-label="Object details"/);
  assert.match(
    panel.webview.html,
    /id="panel-resize" role="separator"[\s\S]*aria-valuenow="300"[\s\S]*tabindex="0"/,
    "details splitter exposes keyboard separator semantics",
  );
  const style = readFileSync("media/style.css", "utf8");
  assert.match(style, /#canvas\s*\{[^}]*container-type:\s*inline-size/s);
  assert.match(style, /@container \(max-width: 700px\)/);
  assert.match(style, /@media \(max-width: 620px\)[\s\S]*flex-direction:\s*column/);
  assert.match(style, /#cy:focus-visible[\s\S]*vscode-focusBorder/);
  assert.match(style, /\.edge-link:focus-visible[\s\S]*vscode-focusBorder/);

  controller.revealNode("first");
  controller.revealNode("second");
  controller.exportPng();
  assert.deepEqual(panel.webview.messages, [], "commands are queued until ready");

  panel.webview.receive({ type: "ready" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    panel.webview.messages,
    [
      { type: "graph", graph, database: "db", revision: 7 },
      { type: "prefs", prefs },
      { type: "reveal", id: "second" },
      { type: "exportPng" },
    ],
    "ready replay sends graph, prefs, and deduped pending commands in order",
  );
  panel.webview.messages.length = 0;
  panel.webview.nextPostResult = false;
  controller.exportSvg();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(String(errors.at(-1)), /webview rejected host message: exportSvg/);
  panel.webview.receive({ type: "ready" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    panel.webview.messages.slice(-3),
    [
      { type: "graph", graph, database: "db", revision: 7 },
      { type: "prefs", prefs },
      { type: "exportSvg" },
    ],
    "failed commands remain queued until a successful ready replay",
  );
  panel.webview.receive({ type: "svgExport", svg: "<svg><script/></svg>" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(String(errors.at(-1)), /unsupported active or external content/);
  panel.webview.receive({ type: "resetFilters" });
  assert.equal(resetFiltersCalls, 1, "filter reset messages reach the host callback");

  panel.webview.receive({ type: "openDdl", nodeType: "schema", oid: 1, label: "public" });
  panel.webview.receive({ type: "openDdl", nodeType: "table", oid: 0, label: "orders" });
  panel.webview.receive({ type: "openDdl", nodeType: "table", oid: 0x100000000, label: "orders" });
  panel.webview.receive({ type: "openDdl", nodeType: "table", oid: null, label: "orders" });
  panel.webview.receive({
    type: "openDefinition",
    nodeType: "not-a-node-type",
    oid: 42,
    name: "orders",
  });
  assert.deepEqual(openDdlCalls, [], "malformed openDdl messages are ignored");
  assert.deepEqual(openDefinitionCalls, [], "malformed openDefinition messages are ignored");

  panel.webview.receive({
    type: "openDdl",
    nodeType: "table",
    oid: 42,
    label: "orders",
    schema: "public",
    name: "orders",
  });
  panel.webview.receive({
    type: "openDefinition",
    nodeType: "function",
    oid: 84,
    schema: "public",
    name: "refresh_orders",
    owner: "",
    label: "public.refresh_orders",
  });
  panel.webview.receive({
    type: "openDefinition",
    nodeType: "function",
    oid: 0x100000000,
    schema: "public",
    name: "ignored",
    label: "public.ignored",
  });
  assert.deepEqual(
    openDdlCalls,
    [["table", 42, "orders", "public", "orders"]],
    "valid openDdl messages reach the host callback",
  );
  assert.deepEqual(
    openDefinitionCalls,
    [["function", 84, "public", "refresh_orders", undefined, "public.refresh_orders"]],
    "valid openDefinition messages reach the host callback",
  );
  panel.webview.messages.length = 0;
  panel.webview.receive({
    type: "requestColumnUsages",
    revision: 7,
    requestId: 11,
    columnId: "c1_2",
  });
  panel.webview.receive({
    type: "requestUsageOccurrences",
    revision: 7,
    requestId: 12,
    groupId: "c1_2|f3|reads",
    offset: 50,
  });
  panel.webview.receive({ type: "openUsage", revision: 7, occurrenceId: "f3:4" });
  panel.webview.receive({
    type: "requestColumnUsages",
    revision: 6,
    requestId: 13,
    columnId: "c1_2",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(usageCalls, ["c1_2"], "current-revision column usage requests are accepted");
  assert.deepEqual(usageOccurrenceCalls, [["c1_2|f3|reads", 50]]);
  assert.deepEqual(openUsageCalls, ["f3:4"]);
  assert.deepEqual(panel.webview.messages, [
    {
      type: "columnUsages",
      revision: 7,
      requestId: 11,
      result: { columnId: "c1_2", groups: [] },
    },
    {
      type: "usageOccurrences",
      revision: 7,
      requestId: 12,
      page: { groupId: "c1_2|f3|reads", offset: 50, total: 0, occurrences: [] },
    },
  ]);
  console.log("webview-controller OK - HTML escaping, ready replay, message validation");
}

void main()
  .finally(() => {
    moduleWithLoad._load = originalLoad;
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
