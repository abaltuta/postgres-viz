import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { GraphPayload } from "../src/types";
import type { Prefs } from "../src/protocol";
import { DEFAULT_PREFS } from "../src/protocol";

type MessageHandler = (message: unknown) => void;

class FakeWebview {
  cspSource = "vscode-resource:\"&<>'";
  html = "";
  readonly messages: unknown[] = [];
  private messageHandler: MessageHandler | undefined;

  asWebviewUri(uri: { toString(): string }): { toString(): string } {
    return {
      toString: () => `webview://${uri.toString()}?x="&<>'`,
    };
  }

  postMessage(message: unknown): PromiseLike<boolean> {
    this.messages.push(message);
    return Promise.resolve(true);
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
  const controller = new WebviewController({
    extensionUri: { toString: () => "ext:\"&<>'" } as never,
    logLine: () => undefined,
    currentGraph: () => graph,
    currentDatabase: () => "db",
    prefs: () => prefs,
    onStats: () => undefined,
    onRefresh: async () => undefined,
    onOpenDdl: async (...args) => {
      openDdlCalls.push(args);
    },
    onOpenDefinition: async (...args) => {
      openDefinitionCalls.push(args);
    },
    onNodeSelected: () => undefined,
    onPngExport: () => undefined,
    onSvgExport: () => undefined,
    onError: (err) => {
      throw err;
    },
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

  controller.revealNode("first");
  controller.revealNode("second");
  controller.exportPng();
  assert.deepEqual(panel.webview.messages, [], "commands are queued until ready");

  panel.webview.receive({ type: "ready" });
  assert.deepEqual(
    panel.webview.messages,
    [
      { type: "graph", graph, database: "db" },
      { type: "prefs", prefs },
      { type: "reveal", id: "second" },
      { type: "exportPng" },
    ],
    "ready replay sends graph, prefs, and deduped pending commands in order",
  );

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
  assert.deepEqual(
    openDefinitionCalls,
    [],
    "malformed openDefinition messages are ignored",
  );

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
