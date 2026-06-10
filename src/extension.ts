import * as vscode from "vscode";
import { Client } from "pg";
import { analyzeAll, disposeParser } from "./analyze";
import { buildGraph } from "./graph";
import { introspect } from "./introspect";
import type { NodeType } from "./types";

const SECRET_KEY = "postgresViz.connectionString";

let panel: vscode.WebviewPanel | undefined;
let lastConnection: string | undefined;
let output: vscode.OutputChannel | undefined;

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

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("postgresViz.showLogs", () => getOutput().show(true)),
    vscode.commands.registerCommand("postgresViz.visualize", () => visualize(context)),
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
        await loadGraph(lastConnection);
      } else if (msg.type === "openDdl") {
        await openDdl(msg.nodeType as NodeType, Number(msg.oid), String(msg.label ?? ""));
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

async function loadGraph(conn: string): Promise<void> {
  if (loading) {
    logLine("load already in progress — ignoring request");
    return;
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
    <input id="conn" type="text" spellcheck="false"
           placeholder="postgres://user:password@localhost:5432/dbname" />
    <button id="connect">connect</button>
  </div>
  <div id="toolbar">
    <input id="search" type="text" placeholder="search nodes…" />
    <select id="layout" title="layout">
      <option value="fcose" selected>fcose</option>
      <option value="breadthfirst">tree</option>
      <option value="concentric">concentric</option>
      <option value="grid">grid</option>
    </select>
    <label><input type="checkbox" id="flt-schemagroup" checked />schemas</label>
    <label><input type="checkbox" id="flt-columns" checked />columns</label>
    <label><input type="checkbox" id="flt-views" checked />views</label>
    <label><input type="checkbox" id="flt-functions" checked />functions</label>
    <label><input type="checkbox" id="flt-triggers" checked />triggers</label>
    <label><input type="checkbox" id="flt-constraints" checked />constraints</label>
    <label><input type="checkbox" id="flt-fk" checked />FKs</label>
    <label title="cards: one rolled-up edge per pair of tables/functions; all: every per-column edge; off: click a node to reveal">edges
      <select id="edge-mode">
        <option value="off">off</option>
        <option value="cards" selected>cards</option>
        <option value="all">all</option>
      </select>
    </label>
    <label><input type="checkbox" id="flt-isolated" />hide isolated</label>
    <button id="relayout">layout</button>
    <button id="fit">fit</button>
    <button id="refresh">refresh</button>
    <span id="stats"></span>
  </div>
  <div id="content">
    <div id="cy"></div>
    <div id="crumb" class="hidden"></div>
    <aside id="panel" class="hidden"></aside>
  </div>
  <div id="legend"></div>
  <div id="empty">Connecting to the database…</div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
