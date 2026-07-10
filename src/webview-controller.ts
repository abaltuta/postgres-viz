import * as vscode from "vscode";
import type { GraphPayload, NodeType } from "./types";
import type { HostToWebviewMessage, Prefs } from "./protocol";
import { pngDataUriLengthWithinLimit, validateSvgText } from "./export-data";

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
  onResetFilters: () => void;
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
    void this.deliver(message);
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
      this.opts.logLine(
        `webview -> ${isRecord(msg) && typeof msg.type === "string" ? msg.type : "<invalid>"}`,
      );
      if (!isRecord(msg)) return;
      if (msg.type === "ready") {
        this.ready = true;
        await this.replayReadyState();
      } else if (msg.type === "stats") {
        this.opts.onStats(String(msg.text ?? ""));
      } else if (msg.type === "refresh") {
        await this.opts.onRefresh();
      } else if (msg.type === "resetFilters") {
        this.opts.onResetFilters();
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
        if (typeof msg.dataUri !== "string") return;
        if (!pngDataUriLengthWithinLimit(msg.dataUri.length)) {
          throw new Error("PNG export exceeds the 32 MB limit");
        }
        await this.opts.onPngExport(msg.dataUri);
      } else if (msg.type === "svgExport") {
        if (typeof msg.svg !== "string") return;
        const validation = validateSvgText(msg.svg);
        if (!validation.ok) {
          throw new Error(
            validation.reason === "too-large"
              ? "SVG export exceeds the 16 MB limit"
              : "SVG export contains unsupported active or external content",
          );
        }
        await this.opts.onSvgExport(msg.svg);
      }
    } catch (err) {
      this.opts.onError(err);
    }
  }

  private async replayReadyState(): Promise<void> {
    const graph = this.opts.currentGraph();
    if (graph) {
      await this.deliver({ type: "graph", graph, database: this.opts.currentDatabase() });
    }
    await this.deliver({ type: "prefs", prefs: this.opts.prefs() });
    const pending = this.pendingCommands;
    this.pendingCommands = [];
    for (const command of pending) {
      if (!(await this.deliver(command))) this.queuePending(command);
    }
  }

  private postWhenReady(command: PendingCommand): void {
    this.ensureRevealed();
    if (this.ready) {
      void this.deliver(command).then((delivered) => {
        if (!delivered) this.queuePending(command);
      });
    } else this.queuePending(command);
  }

  private queuePending(command: PendingCommand): void {
    this.pendingCommands = this.pendingCommands.filter((pending) => pending.type !== command.type);
    this.pendingCommands.push(command);
  }

  private async deliver(message: HostToWebviewMessage): Promise<boolean> {
    const panel = this.panel;
    if (!panel) return false;
    try {
      const delivered = await panel.webview.postMessage(message);
      if (!delivered && this.panel === panel) {
        throw new Error(`webview rejected host message: ${message.type}`);
      }
      return delivered;
    } catch (error) {
      if (this.panel === panel) this.opts.onError(error);
      return false;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseDdlPayload(
  msg: Record<string, unknown>,
): { nodeType: DdlNodeType; oid: number } | undefined {
  const nodeType =
    typeof msg.nodeType === "string" && DDL_NODE_TYPES.has(msg.nodeType)
      ? (msg.nodeType as DdlNodeType)
      : undefined;
  const oid =
    typeof msg.oid === "number" && Number.isInteger(msg.oid) && msg.oid > 0 && msg.oid <= PG_OID_MAX
      ? msg.oid
      : undefined;
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
    <div id="canvas">
      <div id="cy" role="region" aria-label="Database graph. Use arrow keys to navigate objects and Enter to open details." tabindex="0"></div>
      <div id="crumb" class="hidden"></div>
      <button id="reset-filters" class="hidden" title="clear active graph filters">Clear filters</button>
      <div id="empty" role="status">No connection - use the Postgres Viz status bar item or the sidebar to connect.</div>
      <footer id="canvas-footer">
        <div id="legend"></div>
        <div id="stats" aria-live="polite"></div>
      </footer>
    </div>
    <aside id="panel" class="hidden" aria-label="Object details">
      <div id="panel-resize" role="separator" aria-label="Resize details panel" aria-orientation="vertical" aria-valuemin="220" aria-valuemax="680" aria-valuenow="300" tabindex="0" title="drag or use arrow keys to resize"></div>
      <div id="panel-body"></div>
    </aside>
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
