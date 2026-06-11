import * as vscode from "vscode";
import { Client } from "pg";
import { analyzeAll, disposeParser } from "./analyze";
import { buildGraph } from "./graph";
import { introspect } from "./introspect";
import type { GraphNodeData, GraphPayload, NodeType } from "./types";

const SECRET_KEY = "postgresViz.connectionString";

let panel: vscode.WebviewPanel | undefined;
let lastConnection: string | undefined;
let output: vscode.OutputChannel | undefined;

/**
 * Memory cache for built graphs, alive as long as the extension host is —
 * reopening the panel or reconnecting to the same database is instant; the
 * refresh button forces a rebuild. Keyed by connection string plus every
 * setting that shapes the graph.
 */
interface GraphCacheEntry {
  graph: GraphPayload;
  database: string;
  builtAt: number;
}
const graphCache = new Map<string, GraphCacheEntry>();
const GRAPH_CACHE_MAX = 4;

function graphCacheKey(conn: string): string {
  const cfg = vscode.workspace.getConfiguration("postgresViz");
  return JSON.stringify([
    conn,
    cfg.get<string[]>("schemas") ?? [],
    cfg.get<string[]>("excludeSchemas") ?? [],
    cfg.get<boolean>("includeForeignKeys") ?? true,
  ]);
}

function getOutput(): vscode.OutputChannel {
  output ??= vscode.window.createOutputChannel("Postgres Viz");
  return output;
}

function logLine(msg: string): void {
  getOutput().appendLine(`${new Date().toISOString().slice(11, 23)}  ${msg}`);
}

/** Connection strings go to logs with the password stripped. */
function redact(conn: string): string {
  try {
    const u = new URL(conn);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable connection string)";
  }
}

// ── native explorer: a real TreeView in the activity bar ──

interface TreeNode {
  id: string;
  label: string;
  type: string;
  description?: string;
  children: TreeNode[];
  parent?: TreeNode;
  /** graph node id to reveal in the webview (groups have none) */
  graphId?: string;
}

const TREE_ICONS: Record<string, string> = {
  schema: "database",
  table: "symbol-structure",
  view: "eye",
  matview: "symbol-interface",
  foreign: "link-external",
  function: "symbol-method",
  column: "symbol-field",
  trigger: "zap",
  constraint: "lock",
};

class DbTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private roots: TreeNode[] = [];
  private byGraphId = new Map<string, TreeNode>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  setGraph(graph: GraphPayload | null): void {
    this.roots = [];
    this.byGraphId.clear();
    if (graph) this.build(graph);
    this.emitter.fire();
  }

  find(graphId: string): TreeNode | undefined {
    return this.byGraphId.get(graphId);
  }

  private build(graph: GraphPayload): void {
    const ROWS = new Set(["column", "trigger", "constraint"]);
    const node = (
      label: string,
      type: string,
      parent: TreeNode | undefined,
      graphId?: string,
      description?: string,
    ): TreeNode => {
      const n: TreeNode = {
        id: graphId ?? `grp:${parent?.id ?? ""}:${label}`,
        label,
        type,
        description,
        children: [],
        parent,
        graphId,
      };
      if (parent) parent.children.push(n);
      if (graphId) this.byGraphId.set(graphId, n);
      return n;
    };
    const bySchema = new Map<string, TreeNode>();
    const relNodes = new Map<string, TreeNode>();
    const rows: GraphNodeData[] = [];
    const schemaOf = (d: GraphNodeData): TreeNode => {
      const key = String(d.schema ?? "");
      let s = bySchema.get(key);
      if (!s) {
        s = node(key, "schema", undefined);
        bySchema.set(key, s);
        this.roots.push(s);
      }
      return s;
    };
    const groups = new Map<string, TreeNode>();
    const groupOf = (schema: TreeNode, type: string, title: string): TreeNode => {
      const key = `${schema.id}:${type}`;
      let g = groups.get(key);
      if (!g) {
        g = node(title, "group", schema);
        groups.set(key, g);
      }
      return g;
    };
    const sorted = [...graph.nodes].sort((a, b) =>
      String(a.data.label).localeCompare(String(b.data.label)),
    );
    for (const { data: d } of sorted) {
      if (d.type === "schema") continue;
      if (ROWS.has(d.type)) {
        rows.push(d);
        continue;
      }
      const schema = schemaOf(d);
      const title =
        d.type === "function"
          ? "functions"
          : d.type === "table"
            ? "tables"
            : d.type === "view"
              ? "views"
              : d.type === "matview"
                ? "materialized views"
                : "foreign tables";
      const rel = node(d.label, d.type, groupOf(schema, d.type, title), d.id);
      relNodes.set(d.id, rel);
    }
    for (const d of rows) {
      const parent = relNodes.get(d.parent ?? "");
      if (parent) node(d.label, d.type, parent, d.id, d.detail);
    }
    this.roots.sort((a, b) => a.label.localeCompare(b.label));
  }

  getTreeItem(n: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      n.label,
      n.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = n.id;
    item.description = n.description;
    if (n.type !== "group") item.iconPath = new vscode.ThemeIcon(TREE_ICONS[n.type] ?? "circle");
    if (n.graphId) {
      item.command = {
        command: "postgresViz.revealNode",
        title: "Reveal in graph",
        arguments: [n.graphId],
      };
    }
    return item;
  }

  getChildren(n?: TreeNode): TreeNode[] {
    return n ? n.children : this.roots;
  }

  getParent(n: TreeNode): TreeNode | undefined {
    return n.parent;
  }
}

let treeProvider: DbTreeProvider | undefined;
let treeView: vscode.TreeView<TreeNode> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  treeProvider = new DbTreeProvider();
  treeView = vscode.window.createTreeView("postgresVizExplorer", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand("postgresViz.showLogs", () => getOutput().show(true)),
    vscode.commands.registerCommand("postgresViz.visualize", () => visualize(context)),
    vscode.commands.registerCommand("postgresViz.revealNode", async (graphId: string) => {
      if (!panel) await visualize(context);
      panel?.reveal(undefined, true);
      panel?.webview.postMessage({ type: "reveal", id: graphId });
    }),
  );
}

export function deactivate(): void {
  disposeParser();
}

async function visualize(context: vscode.ExtensionContext): Promise<void> {
  ensurePanel(context);
  const conn = await context.secrets.get(SECRET_KEY);
  if (conn) {
    lastConnection = conn;
    await loadGraph(conn);
  }
  // no stored connection → the webview's connection bar takes over
}

function ensurePanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel("postgresViz", "Postgres Viz", vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
  });
  panel.webview.html = panelHtml(panel.webview, context.extensionUri);
  panel.onDidDispose(() => {
    panel = undefined;
  });
  panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
    try {
      logLine(`webview → ${String(msg.type)}`);
      if (msg.type === "ready") {
        const stored = (await context.secrets.get(SECRET_KEY)) ?? "";
        panel?.webview.postMessage({ type: "connection", value: stored });
      } else if (msg.type === "connect") {
        const conn = String(msg.connectionString ?? "").trim();
        if (!conn) return;
        getOutput().show(true);
        await context.secrets.store(SECRET_KEY, conn);
        lastConnection = conn;
        await loadGraph(conn);
      } else if (msg.type === "refresh" && lastConnection) {
        await loadGraph(lastConnection, { force: true });
      } else if (msg.type === "openDdl") {
        await openDdl(msg.nodeType as NodeType, Number(msg.oid), String(msg.label ?? ""));
      } else if (msg.type === "nodeSelected") {
        const item = treeProvider?.find(String(msg.id));
        if (item && treeView?.visible) {
          treeView
            .reveal(item, { select: true, focus: false, expand: true })
            .then(undefined, () => {});
        }
      }
    } catch (err) {
      showError(err);
    }
  });
}

async function withClient<T>(conn: string, fn: (client: Client) => Promise<T>): Promise<T> {
  // hard timeouts: a wrong host or a blocked catalog query should fail with a
  // real error instead of spinning on "introspecting catalogs…" forever
  const client = new Client({
    connectionString: conn,
    application_name: "postgres-viz",
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    query_timeout: 90_000,
  });
  // belt and braces on top of connectionTimeoutMillis — never hang on connect
  await Promise.race([
    client.connect(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("connect timed out after 15s")), 15_000),
    ),
  ]);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

let loading = false;

async function loadGraph(conn: string, opts: { force?: boolean } = {}): Promise<void> {
  if (loading) {
    logLine("load already in progress — ignoring request");
    return;
  }
  const key = graphCacheKey(conn);
  if (!opts.force) {
    const cached = graphCache.get(key);
    if (cached) {
      const age = Math.round((Date.now() - cached.builtAt) / 1000);
      logLine(`cache hit — serving graph built ${age}s ago (refresh to rebuild)`);
      treeProvider?.setGraph(cached.graph);
      panel?.webview.postMessage({
        type: "graph",
        graph: cached.graph,
        database: cached.database,
      });
      return;
    }
  }
  loading = true;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Postgres Viz", cancellable: false },
      async (progress) => {
        const log = (msg: string): void => {
          logLine(msg);
          progress.report({ message: msg.length > 64 ? `${msg.slice(0, 61)}…` : msg });
          panel?.webview.postMessage({ type: "status", message: msg });
        };
        const analysisLog = (msg: string): void => {
          logLine(msg);
          const m = msg.match(/^\[(\d+)\/(\d+)\]/);
          const short = m ? `analyzing function bodies ${m[1]}/${m[2]}…` : msg.slice(0, 64);
          progress.report({ message: short });
          panel?.webview.postMessage({ type: "status", message: short });
        };
        const startedAt = Date.now();
        const cfg = vscode.workspace.getConfiguration("postgresViz");
        const schemas = cfg.get<string[]>("schemas") ?? [];
        const excludeSchemas = cfg.get<string[]>("excludeSchemas") ?? [];
        const includeFks = cfg.get<boolean>("includeForeignKeys") ?? true;
        logLine(`─── visualize ${redact(conn)} ───`);
        log("connecting (10s timeout)…");
        const { graph, database } = await withClient(conn, async (client) => {
          log("connected; introspecting catalogs…");
          const catalog = await introspect(
            client,
            { include: schemas.length > 0 ? schemas : null, exclude: excludeSchemas },
            log,
          );
          const analysis = await analyzeAll(catalog, analysisLog);
          log("building graph…");
          const db: string = (await client.query("SELECT current_database() AS db")).rows[0].db;
          return { graph: buildGraph(catalog, analysis, { includeFks }), database: db };
        });
        logLine(
          `graph ready: ${graph.nodes.length} nodes, ${graph.edges.length} edges ` +
            `(${JSON.stringify(graph.stats)}) — total ${Date.now() - startedAt} ms`,
        );
        if (graph.nodes.length > 3000) {
          logLine(
            'note: large graph — set "postgresViz.schemas" to a subset (e.g. ["public"]) to trim it',
          );
        }
        graphCache.delete(key); // re-insert so Map order stays LRU
        graphCache.set(key, { graph, database, builtAt: Date.now() });
        if (graphCache.size > GRAPH_CACHE_MAX) {
          const oldest = graphCache.keys().next().value;
          if (oldest !== undefined) graphCache.delete(oldest);
        }
        treeProvider?.setGraph(graph);
        panel?.webview.postMessage({ type: "graph", graph, database });
      },
    );
  } catch (err) {
    logLine(`ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    panel?.webview.postMessage({
      type: "error",
      message: String(err instanceof Error ? err.message : err),
    });
    showError(err);
  } finally {
    loading = false;
  }
}

async function openDdl(nodeType: NodeType, oid: number, label: string): Promise<void> {
  if (!lastConnection || !Number.isFinite(oid)) return;
  const content = await withClient(lastConnection, async (client) => {
    switch (nodeType) {
      case "view":
      case "matview": {
        const def = (await client.query("SELECT pg_get_viewdef($1::oid, true) AS def", [oid]))
          .rows[0]?.def;
        return `-- ${label}\n${def ?? ""}`;
      }
      case "function":
        return (
          (await client.query("SELECT pg_get_functiondef($1::oid) AS def", [oid])).rows[0]?.def ??
          ""
        );
      case "trigger": {
        const def = (await client.query("SELECT pg_get_triggerdef($1::oid, true) AS def", [oid]))
          .rows[0]?.def;
        return `${def ?? ""};`;
      }
      case "constraint": {
        const def = (await client.query("SELECT pg_get_constraintdef($1::oid, true) AS def", [oid]))
          .rows[0]?.def;
        return `-- ${label}\n${def ?? ""}`;
      }
      default: {
        const rows = (
          await client.query(
            `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
                    a.attnotnull AS notnull, pg_get_expr(ad.adbin, ad.adrelid) AS def
             FROM pg_attribute a
             LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
             WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum`,
            [oid],
          )
        ).rows;
        const body = rows
          .map(
            (r) =>
              `  ${r.name} ${r.type}${r.notnull ? " NOT NULL" : ""}${r.def ? ` DEFAULT ${r.def}` : ""}`,
          )
          .join(",\n");
        return `-- ${label} (columns)\nCREATE TABLE ${label} (\n${body}\n);`;
      }
    }
  });
  const doc = await vscode.workspace.openTextDocument({ language: "sql", content });
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: true,
  });
}

function showError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  vscode.window.showErrorMessage(`Postgres Viz: ${message}`);
}

function panelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "style.css"));
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:;" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Postgres Viz</title>
</head>
<body>
  <div id="connbar">
    <vscode-textfield id="conn" spellcheck="false"
           placeholder="postgres://user:password@localhost:5432/dbname"></vscode-textfield>
    <vscode-button id="connect">connect</vscode-button>
  </div>
  <div id="toolbar">
    <vscode-textfield id="search" placeholder="search nodes…"></vscode-textfield>
    <vscode-single-select id="layout" title="layout">
      <vscode-option value="grid" selected>grid</vscode-option>
      <vscode-option value="fcose">organic</vscode-option>
      <vscode-option value="breadthfirst">tree</vscode-option>
      <vscode-option value="concentric">concentric</vscode-option>
    </vscode-single-select>
    <vscode-checkbox id="flt-schemagroup" checked>schemas</vscode-checkbox>
    <vscode-checkbox id="flt-columns" checked>columns</vscode-checkbox>
    <vscode-checkbox id="flt-views" checked>views</vscode-checkbox>
    <vscode-checkbox id="flt-functions" checked>functions</vscode-checkbox>
    <vscode-checkbox id="flt-triggers" checked>triggers</vscode-checkbox>
    <vscode-checkbox id="flt-constraints" checked>constraints</vscode-checkbox>
    <vscode-checkbox id="flt-fk" checked>FKs</vscode-checkbox>
    <label class="select-label" title="cards: one rolled-up edge per pair of tables/functions; all: every per-column edge; off: click a node to reveal">edges
      <vscode-single-select id="edge-mode">
        <vscode-option value="off" selected>off</vscode-option>
        <vscode-option value="cards">cards</vscode-option>
        <vscode-option value="all">all</vscode-option>
      </vscode-single-select>
    </label>
    <vscode-checkbox id="flt-route" title="experimental: re-route blocked edges around cards via the outer corridor">avoid boxes</vscode-checkbox>
    <vscode-checkbox id="flt-isolated">hide isolated</vscode-checkbox>
    <vscode-button id="relayout" secondary>layout</vscode-button>
    <vscode-button id="fit" secondary>fit</vscode-button>
    <vscode-button id="refresh" secondary>refresh</vscode-button>
    <span id="stats"></span>
  </div>
  <div id="content">
    <div id="cy"></div>
    <div id="crumb" class="hidden"></div>
    <div id="legend"></div>
    <aside id="panel" class="hidden">
      <div id="panel-resize" title="drag to resize"></div>
      <div id="panel-body"></div>
    </aside>
    <div id="empty">Connecting to the database…</div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
