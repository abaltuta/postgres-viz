import * as vscode from "vscode";
import type { GraphPayload, NodeType } from "./types";
import type { HostToWebviewMessage, Prefs } from "./protocol";

type PendingCommand = Extract<
  HostToWebviewMessage,
  | { type: "reveal" }
  | { type: "searchSelect" }
  | { type: "callTreeById" }
  | { type: "exportPng" }
  | { type: "exportSvg" }
>;

type DdlNodeType = Exclude<NodeType, "schema">;

const DDL_NODE_TYPES = new Set<string>([
  "table",
  "view",
  "matview",
  "foreign",
  "column",
  "function",
  "trigger",
  "constraint",
  "index",
]);
const PG_OID_MAX = 0xffffffff;

export interface WebviewControllerOptions {
  extensionUri: vscode.Uri;
  logLine: (msg: string) => void;
  currentGraph: () => GraphPayload | null;
  currentDatabase: () => string;
  prefs: () => Prefs;
  onStats: (text: string) => void;
  onRefresh: () => Promise<void>;
  onOpenDdl: (
    nodeType: NodeType,
    oid: number,
    label: string,
    schema: string | undefined,
    name: string | undefined,
  ) => Promise<void>;
  onOpenDefinition: (
    nodeType: NodeType,
    oid: number,
    schema: string | undefined,
    name: string,
    owner: string | undefined,
    label: string,
  ) => Promise<void>;
  onNodeSelected: (id: string | undefined) => Promise<void> | void;
  onPngExport: (dataUri: string) => Promise<void> | void;
  onSvgExport: (svg: string) => Promise<void> | void;
  onError: (err: unknown) => void;
}

export class WebviewController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private pendingCommands: PendingCommand[] = [];

  constructor(private readonly opts: WebviewControllerOptions) {}

  get hasPanel(): boolean {
    return Boolean(this.panel);
  }

  dispose(): void {
    const panel = this.panel;
    this.panel = undefined;
    this.ready = false;
    this.pendingCommands = [];
    panel?.dispose();
  }

  ensure(preserveFocus = false): void {
    if (this.panel) {
      this.panel.reveal(undefined, preserveFocus);
      return;
    }
    this.ready = false;
    const panel = vscode.window.createWebviewPanel(
      "postgresViz",
      "Postgres Viz",
      { viewColumn: vscode.ViewColumn.One, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.opts.extensionUri, "media")],
      },
    );
    this.panel = panel;
    panel.webview.html = panelHtml(panel.webview, this.opts.extensionUri);
    panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.panel = undefined;
      this.ready = false;
      this.pendingCommands = [];
    });
    panel.webview.onDidReceiveMessage((msg: unknown) => {
      if (this.panel !== panel) return;
      void this.handleMessage(msg);
    });
  }

  ensureRevealed(): void {
    this.ensure(true);
  }

  post(message: HostToWebviewMessage): void {
    void this.panel?.webview.postMessage(message);
  }

  postPrefs(): void {
    this.post({ type: "prefs", prefs: this.opts.prefs() });
  }

  revealNode(id: string): void {
    this.postWhenReady({ type: "reveal", id });
  }

  searchSelect(id: string): void {
    this.postWhenReady({ type: "searchSelect", id });
  }

  callTreeById(id: string): void {
    this.postWhenReady({ type: "callTreeById", id });
  }

  exportPng(): void {
    this.postWhenReady({ type: "exportPng" });
  }

  exportSvg(): void {
    this.postWhenReady({ type: "exportSvg" });
  }

  private async handleMessage(msg: unknown): Promise<void> {
    try {
      this.opts.logLine(`webview -> ${messageType(msg)}`);
      if (!isRecord(msg)) return;
      if (msg.type === "ready") {
        this.ready = true;
        this.replayReadyState();
      } else if (msg.type === "stats") {
        this.opts.onStats(String(msg.text ?? ""));
      } else if (msg.type === "refresh") {
        await this.opts.onRefresh();
      } else if (msg.type === "openDdl") {
        const payload = parseDdlPayload(msg);
        if (!payload) return;
        await this.opts.onOpenDdl(
          payload.nodeType,
          payload.oid,
          stringOrEmpty(msg.label),
          optionalString(msg.schema),
          optionalString(msg.name),
        );
      } else if (msg.type === "openDefinition") {
        const payload = parseDdlPayload(msg);
        if (!payload) return;
        await this.opts.onOpenDefinition(
          payload.nodeType,
          payload.oid,
          optionalString(msg.schema),
          stringOrEmpty(msg.name),
          optionalString(msg.owner),
          stringOrEmpty(msg.label),
        );
      } else if (msg.type === "nodeSelected") {
        await this.opts.onNodeSelected(optionalString(msg.id));
      } else if (msg.type === "pngExport") {
        if (typeof msg.dataUri === "string") await this.opts.onPngExport(msg.dataUri);
      } else if (msg.type === "svgExport") {
        if (typeof msg.svg === "string") await this.opts.onSvgExport(msg.svg);
      }
    } catch (err) {
      this.opts.onError(err);
    }
  }

  private replayReadyState(): void {
    const graph = this.opts.currentGraph();
    if (graph) {
      this.post({ type: "graph", graph, database: this.opts.currentDatabase() });
    }
    this.postPrefs();
    const pending = this.pendingCommands;
    this.pendingCommands = [];
    for (const command of pending) this.post(command);
  }

  private postWhenReady(command: PendingCommand): void {
    this.ensureRevealed();
    if (this.ready) this.post(command);
    else {
      this.pendingCommands = this.pendingCommands.filter(
        (pending) => pending.type !== command.type,
      );
      this.pendingCommands.push(command);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageType(value: unknown): string {
  return isRecord(value) && typeof value.type === "string" ? value.type : "<invalid>";
}

function ddlNodeType(value: unknown): DdlNodeType | undefined {
  return typeof value === "string" && DDL_NODE_TYPES.has(value)
    ? (value as DdlNodeType)
    : undefined;
}

function positiveOid(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= PG_OID_MAX
    ? value
    : undefined;
}

function parseDdlPayload(
  msg: Record<string, unknown>,
): { nodeType: DdlNodeType; oid: number } | undefined {
  const nodeType = ddlNodeType(msg.nodeType);
  const oid = positiveOid(msg.oid);
  return nodeType && oid !== undefined ? { nodeType, oid } : undefined;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function panelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "style.css"));
  const cspSource = escapeHtmlAttr(webview.cspSource);
  const escapedScriptUri = escapeHtmlAttr(String(scriptUri));
  const escapedStyleUri = escapeHtmlAttr(String(styleUri));
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data:;" />
  <link rel="stylesheet" href="${escapedStyleUri}" />
  <title>Postgres Viz</title>
</head>
<body>
  <div id="content">
    <div id="cy"></div>
    <div id="crumb" class="hidden"></div>
    <div id="legend"></div>
    <div id="stats"></div>
    <aside id="panel" class="hidden">
      <div id="panel-resize" title="drag to resize"></div>
      <div id="panel-body"></div>
    </aside>
    <div id="empty">No connection - use the Postgres Viz status bar item or the sidebar to connect.</div>
  </div>
  <script src="${escapedScriptUri}"></script>
</body>
</html>`;
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
