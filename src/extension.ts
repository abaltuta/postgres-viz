import * as vscode from "vscode";
import { Client } from "pg";
import { analyzeAll } from "./analyze";
import { buildGraph } from "./graph";
import { introspect } from "./introspect";
import type { NodeType } from "./types";

const SECRET_KEY = "postgresViz.connectionString";

let panel: vscode.WebviewPanel | undefined;
let lastConnection: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("postgresViz.setConnection", async () => {
      await promptConnection(context);
    }),
    vscode.commands.registerCommand("postgresViz.clearConnection", async () => {
      await context.secrets.delete(SECRET_KEY);
      lastConnection = undefined;
      vscode.window.showInformationMessage("Postgres Viz: connection string cleared.");
    }),
    vscode.commands.registerCommand("postgresViz.visualize", () => visualize(context)),
  );
}

export function deactivate(): void {}

async function promptConnection(context: vscode.ExtensionContext): Promise<string | undefined> {
  // intentionally NOT a password field: connection strings are long and
  // easy to mistype, so keep them visible while editing (storage is still
  // the OS keychain via the VS Code secrets API)
  const value = await vscode.window.showInputBox({
    title: "Postgres connection string",
    placeHolder: "postgres://user:password@localhost:5432/dbname",
    ignoreFocusOut: true,
    value: (await context.secrets.get(SECRET_KEY)) ?? "",
  });
  if (value) await context.secrets.store(SECRET_KEY, value);
  return value || undefined;
}

async function getConnection(context: vscode.ExtensionContext): Promise<string | undefined> {
  return (await context.secrets.get(SECRET_KEY)) ?? promptConnection(context);
}

async function visualize(context: vscode.ExtensionContext): Promise<void> {
  const conn = await getConnection(context);
  if (!conn) return;
  lastConnection = conn;
  ensurePanel(context);
  await loadGraph(conn);
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
      if (msg.type === "refresh" && lastConnection) {
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
  const client = new Client({ connectionString: conn, application_name: "postgres-viz" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function loadGraph(conn: string): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Postgres Viz", cancellable: false },
      async (progress) => {
        const cfg = vscode.workspace.getConfiguration("postgresViz");
        const schemas = cfg.get<string[]>("schemas") ?? [];
        const includeFks = cfg.get<boolean>("includeForeignKeys") ?? true;
        const { graph, database } = await withClient(conn, async (client) => {
          progress.report({ message: "introspecting catalogs…" });
          const catalog = await introspect(client, schemas.length > 0 ? schemas : null);
          progress.report({ message: `analyzing ${catalog.funcs.length} functions…` });
          const analysis = await analyzeAll(catalog);
          const db: string = (await client.query("SELECT current_database() AS db")).rows[0].db;
          return { graph: buildGraph(catalog, analysis, { includeFks }), database: db };
        });
        panel?.webview.postMessage({ type: "graph", graph, database });
      },
    );
  } catch (err) {
    showError(err);
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
  <div id="toolbar">
    <input id="search" type="text" placeholder="search nodes…" />
    <select id="layout" title="layout">
      <option value="fcose" selected>fcose</option>
      <option value="breadthfirst">tree</option>
      <option value="concentric">concentric</option>
      <option value="grid">grid</option>
    </select>
    <label><input type="checkbox" id="flt-columns" checked />columns</label>
    <label><input type="checkbox" id="flt-views" checked />views</label>
    <label><input type="checkbox" id="flt-functions" checked />functions</label>
    <label><input type="checkbox" id="flt-triggers" checked />triggers</label>
    <label><input type="checkbox" id="flt-constraints" checked />constraints</label>
    <label><input type="checkbox" id="flt-fk" checked />FKs</label>
    <label><input type="checkbox" id="flt-isolated" />hide isolated</label>
    <button id="relayout">layout</button>
    <button id="fit">fit</button>
    <button id="refresh">refresh</button>
    <span id="stats"></span>
  </div>
  <div id="content">
    <div id="cy"></div>
    <aside id="panel" class="hidden"></aside>
  </div>
  <div id="legend"></div>
  <div id="empty">Connecting to the database…</div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
