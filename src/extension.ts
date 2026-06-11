import * as vscode from "vscode";
import { Client } from "pg";
import { analyzeAll, disposeParser } from "./analyze";
import { buildGraph } from "./graph";
import { indexEntries, keyVariants, type LocatedEntry, parseHclSymbols } from "./hcl";
import { fuzzyIncludes } from "./match";
import { introspect } from "./introspect";
import type { GraphNodeData, GraphPayload, NodeType } from "./types";

const SECRET_KEY = "postgresViz.connectionString";

/**
 * Connection strings are saved PER WORKSPACE FOLDER — opening an unrelated
 * folder must not auto-connect to (or even know about) another project's db.
 */
function secretKey(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "no-folder";
  return `${SECRET_KEY}:${folder}`;
}

let panel: vscode.WebviewPanel | undefined;
let lastConnection: string | undefined;
let output: vscode.OutputChannel | undefined;
/** reveal requested while the webview was still booting — sent after "ready" */
let pendingReveal: string | null = null;
/** call-tree requested before the webview was listening — sent after "ready" */
let pendingCallTree: string | null = null;
/** search-select requested before the webview was listening — sent after "ready" */
let pendingSearch: string | null = null;

// ── view preferences (the native chrome owns these; the webview mirrors them) ──

interface Prefs {
  layout: "grid" | "tree";
  edgeMode: "off" | "cards" | "all";
  schemaGroup: boolean;
  route: boolean;
  hideIsolated: boolean;
}
const DEFAULT_PREFS: Prefs = {
  layout: "grid",
  edgeMode: "off",
  schemaGroup: true,
  route: false,
  hideIsolated: false,
};
const PREFS_KEY = "postgresViz.prefs";
/** set once the user touches "hide isolated" — after that we never auto-force it */
const HIDE_ISOLATED_TOUCHED_KEY = "postgresViz.userTouchedHideIsolated";
let prefs: Prefs = { ...DEFAULT_PREFS };
let workspaceState: vscode.Memento | undefined;
/** latest stats line from the webview — folded into the status bar tooltip */
let lastStatsText = "";

let statusItem: vscode.StatusBarItem | undefined;

function savePrefs(): void {
  void workspaceState?.update(PREFS_KEY, prefs);
}

/** Push the full prefs object to the webview (post-graph, on change, on replay). */
function postPrefs(): void {
  panel?.webview.postMessage({ type: "prefs", prefs });
}

function updateStatusItem(): void {
  if (!statusItem) return;
  statusItem.text = currentGraph ? `$(database) ${currentDatabase}` : "$(database) Postgres Viz";
  const lines = [
    currentGraph ? `Postgres Viz — ${currentDatabase}` : "Postgres Viz — not connected",
  ];
  if (lastStatsText) lines.push(lastStatsText);
  lines.push("Click for connection actions");
  statusItem.tooltip = lines.join("\n");
  statusItem.show();
}

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
  index: "key",
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
    const ROWS = new Set(["column", "trigger", "constraint", "index"]);
    // schema graph nodes exist in the payload — clicking a schema in the tree
    // focuses that schema in the graph
    const schemaGraphIds = new Map<string, string>();
    for (const { data: d } of graph.nodes) {
      if (d.type === "schema") schemaGraphIds.set(String(d.label), d.id);
    }
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
        s = node(key, "schema", undefined, schemaGraphIds.get(key));
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
    // contextValue drives the view/item/context menus — the node type, except
    // groups (which carry no actions)
    if (n.type !== "group") item.contextValue = n.type;
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

// ── jump-to-definition into Atlas .hcl schema files ──
//
// GP/BPO defines its schema in Atlas HCL; when a matching block exists in the
// workspace, symbols and "Open DDL" link straight to it. Databases without
// HCL (EOR/Hasura) fall back to the generated-DDL virtual document.

interface HclLoc {
  uri: vscode.Uri;
  line: number;
  col: number;
}

const HCL_KINDS: Partial<Record<NodeType, string[]>> = {
  table: ["table"],
  foreign: ["table"],
  view: ["view"],
  matview: ["materialized", "view"],
  function: ["function", "procedure"],
  trigger: ["trigger"],
  index: ["index"],
  constraint: ["check", "unique", "foreign_key", "index"],
  column: ["column"],
};

class HclIndex {
  private map: Promise<Map<string, LocatedEntry>> | null = null;

  constructor(subscriptions: { dispose(): unknown }[]) {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.hcl");
    const invalidate = (): void => {
      this.map = null;
    };
    watcher.onDidChange(invalidate);
    watcher.onDidCreate(invalidate);
    watcher.onDidDelete(invalidate);
    subscriptions.push(
      watcher,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("postgresViz.hclExcludeGlobs")) invalidate();
      }),
    );
  }

  /** Where `schema.label` (owned by `owner`, for rows) is defined, if anywhere. */
  async find(
    type: NodeType,
    schema: string | undefined,
    label: string,
    owner?: string,
  ): Promise<HclLoc | undefined> {
    const kinds = HCL_KINDS[type];
    if (!kinds) return undefined;
    const name = type === "function" ? label.replace(/\(\)$/, "") : label;
    const map = await (this.map ??= this.build());
    for (const kind of kinds) {
      for (const key of keyVariants(kind, schema, owner, name)) {
        const hit = map.get(key);
        if (hit) return { uri: vscode.Uri.parse(hit.file), line: hit.line, col: hit.col };
      }
    }
    return undefined;
  }

  private async build(): Promise<Map<string, LocatedEntry>> {
    const all: LocatedEntry[] = [];
    // configurable excludes: scratch/spec folders carry .hcl drafts that must
    // not win jump-to-definition over the real schema files
    const userGlobs = vscode.workspace
      .getConfiguration("postgresViz")
      .get<string[]>("hclExcludeGlobs", ["**/.baltuta/**", "**/openspec/**"]);
    const exclude = `{${["**/node_modules/**", "**/.git/**", ...userGlobs].join(",")}}`;
    const files = await vscode.workspace.findFiles("**/*.hcl", exclude, 500);
    for (const uri of files) {
      let text: string;
      try {
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        continue;
      }
      for (const e of parseHclSymbols(text)) all.push({ ...e, file: uri.toString() });
    }
    logLine(`hcl: indexed ${all.length} symbols from ${files.length} file(s)`);
    return indexEntries(all);
  }
}

let hclIndex: HclIndex | undefined;

// ── workspace symbols: every db object reachable from Cmd+T ──

/** the most recently loaded graph — backs the symbol provider */
let currentGraph: GraphPayload | null = null;
let currentDatabase = "";

const SYMBOL_KINDS: Partial<Record<NodeType, vscode.SymbolKind>> = {
  table: vscode.SymbolKind.Class,
  foreign: vscode.SymbolKind.Class,
  view: vscode.SymbolKind.Interface,
  // distinct icon — views and materialized views must be tellable apart
  matview: vscode.SymbolKind.Struct,
  function: vscode.SymbolKind.Function,
  column: vscode.SymbolKind.Field,
  trigger: vscode.SymbolKind.Event,
  constraint: vscode.SymbolKind.Key,
  index: vscode.SymbolKind.Key,
};

/** picker text after the symbol name — spells the object type out */
const SYMBOL_TYPE_LABEL: Partial<Record<NodeType, string>> = {
  table: "table",
  foreign: "foreign table",
  view: "view",
  matview: "materialized view",
  function: "function",
  column: "column",
  trigger: "trigger",
  constraint: "constraint",
  index: "index",
};

const SYMBOL_ROWS = new Set<string>(["column", "trigger", "constraint", "index"]);
const SYMBOL_CAP = 2000;

/** Virtual document a symbol points at; the content provider serves its DDL. */
function ddlUri(type: NodeType, oid: number, label: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: "pgviz",
    path: `/${type}/${oid}/${encodeURIComponent(label)}.sql`,
  });
}

class DbSymbolProvider implements vscode.WorkspaceSymbolProvider {
  async provideWorkspaceSymbols(query: string): Promise<vscode.SymbolInformation[]> {
    if (!currentGraph) return [];
    const q = query.toLowerCase();
    const labelOf = new Map<string, string>();
    for (const { data: d } of currentGraph.nodes) labelOf.set(d.id, String(d.label));
    const out: vscode.SymbolInformation[] = [];
    for (const { data: d } of currentGraph.nodes) {
      const kind = SYMBOL_KINDS[d.type];
      if (!kind) continue; // schemas have no DDL document of their own
      const isRow = SYMBOL_ROWS.has(d.type);
      const owner = isRow ? (labelOf.get(d.parent ?? "") ?? "") : "";
      // QUALIFIED name: VS Code's picker re-filters against the symbol NAME
      // only, so "payroll.instruction" must BE the name or '#' queries miss
      const qualified = isRow
        ? `${d.schema ?? ""}.${owner}.${d.label}`
        : `${d.schema ?? ""}.${d.label}`;
      if (!fuzzyIncludes(q, qualified)) continue;
      // prefer the Atlas HCL definition site; fall back to the DDL document
      const hcl = await hclIndex?.find(d.type, d.schema, d.label, isRow ? owner : undefined);
      // a column's DDL doc is its table's column listing (oid is the rel's)
      const docLabel = d.type === "column" ? `${d.schema ?? ""}.${owner}` : qualified;
      const location = hcl
        ? new vscode.Location(hcl.uri, new vscode.Position(hcl.line, hcl.col))
        : new vscode.Location(ddlUri(d.type, d.oid, docLabel), new vscode.Position(0, 0));
      out.push(
        new vscode.SymbolInformation(
          qualified,
          kind,
          SYMBOL_TYPE_LABEL[d.type] ?? String(d.type),
          location,
        ),
      );
      if (out.length >= SYMBOL_CAP) break;
    }
    return out;
  }
}

class DdlContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const [, type, oid, file] = uri.path.split("/");
    const label = decodeURIComponent(file ?? "").replace(/\.sql$/, "");
    try {
      return await fetchDdl(type as NodeType, Number(oid), label);
    } catch (err) {
      return `-- failed to load DDL for ${label}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  hclIndex = new HclIndex(context.subscriptions);
  workspaceState = context.workspaceState;
  const saved = context.workspaceState.get<Partial<Prefs>>(PREFS_KEY);
  prefs = saved ? { ...DEFAULT_PREFS, ...saved } : { ...DEFAULT_PREFS };

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = "postgresViz.connectionMenu";
  updateStatusItem();

  treeProvider = new DbTreeProvider();
  treeView = vscode.window.createTreeView("postgresVizExplorer", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(
    statusItem,
    treeView,
    vscode.workspace.registerTextDocumentContentProvider("pgviz", new DdlContentProvider()),
    vscode.languages.registerWorkspaceSymbolProvider(new DbSymbolProvider()),
    vscode.commands.registerCommand("postgresViz.showLogs", () => getOutput().show(true)),
    vscode.commands.registerCommand("postgresViz.visualize", () => visualize(context)),
    vscode.commands.registerCommand("postgresViz.load", () => load(context)),
    vscode.commands.registerCommand("postgresViz.connectionMenu", () => connectionMenu(context)),
    vscode.commands.registerCommand("postgresViz.fit", () =>
      panel?.webview.postMessage({ type: "fit" }),
    ),
    vscode.commands.registerCommand("postgresViz.relayout", () =>
      panel?.webview.postMessage({ type: "relayout" }),
    ),
    vscode.commands.registerCommand("postgresViz.refreshGraph", async () => {
      if (lastConnection) await loadGraph(lastConnection, { force: true });
    }),
    vscode.commands.registerCommand("postgresViz.chooseLayout", chooseLayout),
    vscode.commands.registerCommand("postgresViz.chooseEdgeMode", chooseEdgeMode),
    vscode.commands.registerCommand("postgresViz.viewOptions", () => viewOptions(context)),
    vscode.commands.registerCommand("postgresViz.searchGraph", () => searchGraph(context)),
    vscode.commands.registerCommand("postgresViz.revealNode", async (graphId: string) => {
      const hadPanel = Boolean(panel);
      if (!panel) await visualize(context);
      panel?.reveal(undefined, true);
      // a freshly created webview is not listening yet — its messages are
      // silently dropped; deliver the reveal after the "ready" handshake
      if (hadPanel) panel?.webview.postMessage({ type: "reveal", id: graphId });
      else pendingReveal = graphId;
    }),
    vscode.commands.registerCommand("postgresViz.treeFocus", (n: TreeNode) =>
      treeFocus(context, n),
    ),
    vscode.commands.registerCommand("postgresViz.treeCallTree", (n: TreeNode) =>
      treeCallTree(context, n),
    ),
    vscode.commands.registerCommand("postgresViz.treeGoToDef", (n: TreeNode) => treeGoToDef(n)),
    vscode.commands.registerCommand("postgresViz.treeOpenDdl", (n: TreeNode) => treeOpenDdl(n)),
  );
  // a stored connection loads in the background at startup — tree + Cmd+T
  // symbols are ready without opening the graph panel
  void context.secrets.get(secretKey()).then((conn) => {
    if (conn) {
      lastConnection = conn;
      logLine(`startup: loading ${redact(conn)} in the background`);
      return loadGraph(conn);
    }
  });
}

export function deactivate(): void {
  disposeParser();
}

async function visualize(context: vscode.ExtensionContext): Promise<void> {
  ensurePanel(context);
  const conn = await context.secrets.get(secretKey());
  if (conn) {
    lastConnection = conn;
    await loadGraph(conn);
  }
  // no stored connection → the status bar item / sidebar drive connecting now
}

/** Load the graph WITHOUT opening the panel (sidebar welcome button / startup). */
async function load(context: vscode.ExtensionContext): Promise<void> {
  let conn = await context.secrets.get(secretKey());
  if (!conn) {
    conn = await vscode.window.showInputBox({
      title: "Postgres Viz: connect",
      prompt: "Postgres connection string",
      placeHolder: "postgres://user:password@localhost:5432/dbname",
      ignoreFocusOut: true,
    });
    if (!conn?.trim()) return;
    conn = conn.trim();
    await context.secrets.store(secretKey(), conn);
  }
  lastConnection = conn;
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
      logLine(`webview → ${String(msg.type)}`);
      if (msg.type === "ready") {
        // messages posted before the webview JS was listening are dropped —
        // replay the already-loaded graph (startup/background loads) here,
        // then the current prefs, then any queued navigation
        if (currentGraph) {
          panel?.webview.postMessage({
            type: "graph",
            graph: currentGraph,
            database: currentDatabase,
          });
        }
        postPrefs();
        if (pendingReveal) {
          panel?.webview.postMessage({ type: "reveal", id: pendingReveal });
          pendingReveal = null;
        }
        if (pendingCallTree) {
          panel?.webview.postMessage({ type: "callTreeById", id: pendingCallTree });
          pendingCallTree = null;
        }
        if (pendingSearch) {
          panel?.webview.postMessage({ type: "searchSelect", id: pendingSearch });
          pendingSearch = null;
        }
      } else if (msg.type === "stats") {
        lastStatsText = String(msg.text ?? "");
        updateStatusItem();
      } else if (msg.type === "refresh" && lastConnection) {
        await loadGraph(lastConnection, { force: true });
      } else if (msg.type === "openDdl") {
        await openDdl(msg.nodeType as NodeType, Number(msg.oid), String(msg.label ?? ""));
      } else if (msg.type === "openDefinition") {
        await openDefinition(
          msg.nodeType as NodeType,
          Number(msg.oid),
          String(msg.schema ?? "") || undefined,
          String(msg.name ?? ""),
          String(msg.owner ?? "") || undefined,
          String(msg.label ?? ""),
        );
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
      currentGraph = cached.graph;
      currentDatabase = cached.database;
      treeProvider?.setGraph(cached.graph);
      applyInitialHideIsolated(cached.graph);
      panel?.webview.postMessage({
        type: "graph",
        graph: cached.graph,
        database: cached.database,
      });
      postPrefs();
      updateStatusItem();
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
        currentGraph = graph;
        currentDatabase = database;
        treeProvider?.setGraph(graph);
        applyInitialHideIsolated(graph);
        panel?.webview.postMessage({ type: "graph", graph, database });
        postPrefs();
        updateStatusItem();
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

/** "Go to definition": the .hcl definition site when one exists, DDL otherwise. */
async function openDefinition(
  nodeType: NodeType,
  oid: number,
  schema: string | undefined,
  name: string,
  owner: string | undefined,
  label: string,
): Promise<void> {
  const hcl = await hclIndex?.find(nodeType, schema, name, owner);
  if (hcl) {
    const pos = new vscode.Position(hcl.line, hcl.col);
    await vscode.window.showTextDocument(hcl.uri, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      selection: new vscode.Range(pos, pos),
    });
    return;
  }
  await openDdl(nodeType, oid, label);
}

async function openDdl(nodeType: NodeType, oid: number, label: string): Promise<void> {
  if (!lastConnection || !Number.isFinite(oid)) return;
  const content = await fetchDdl(nodeType, oid, label);
  const doc = await vscode.workspace.openTextDocument({ language: "sql", content });
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: true,
  });
}

async function fetchDdl(nodeType: NodeType, oid: number, label: string): Promise<string> {
  if (!lastConnection || !Number.isFinite(oid)) {
    return `-- ${label}: connect in the Postgres Viz panel first`;
  }
  return withClient(lastConnection, async (client) => {
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
      case "index": {
        const def = (await client.query("SELECT pg_get_indexdef($1::oid, 0, true) AS def", [oid]))
          .rows[0]?.def;
        return `${def ?? ""};`;
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
}

function showError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  vscode.window.showErrorMessage(`Postgres Viz: ${message}`);
}

// ── native chrome: connection menu, layout / edge-mode / view-option pickers ──

/**
 * Big graphs are unreadable with every isolated node drawn, so the first time
 * we load a >600-node graph we default "hide isolated" on — but only if the
 * user has never set it themselves (then their choice always wins).
 */
function applyInitialHideIsolated(graph: GraphPayload): void {
  const touched = workspaceState?.get<boolean>(HIDE_ISOLATED_TOUCHED_KEY) ?? false;
  if (touched) return;
  const want = graph.nodes.length > 600;
  if (prefs.hideIsolated !== want) {
    prefs = { ...prefs, hideIsolated: want };
    savePrefs();
  }
}

/** Ensure the panel exists and is focused; queue work via pending* when cold. */
async function ensurePanelRevealed(context: vscode.ExtensionContext): Promise<boolean> {
  const hadPanel = Boolean(panel);
  if (!panel) await visualize(context);
  panel?.reveal(undefined, true);
  return hadPanel;
}

async function connectionMenu(context: vscode.ExtensionContext): Promise<void> {
  const connected = Boolean(lastConnection);
  type Item = vscode.QuickPickItem & { id: string };
  const items: Item[] = [
    { id: "connect", label: "$(plug) Connect / change connection…" },
    {
      id: "reload",
      label: "$(sync) Reload from database",
      description: connected ? undefined : "connect first",
    },
    { id: "open", label: "$(graph) Open graph panel" },
    { id: "forget", label: "$(trash) Forget stored connection" },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: "Postgres Viz" });
  if (!pick) return;
  switch (pick.id) {
    case "connect": {
      const conn = await vscode.window.showInputBox({
        title: "Postgres Viz: connect",
        prompt: "Postgres connection string",
        placeHolder: "postgres://user:password@localhost:5432/dbname",
        ignoreFocusOut: true,
      });
      if (!conn?.trim()) return;
      const trimmed = conn.trim();
      getOutput().show(true);
      await context.secrets.store(secretKey(), trimmed);
      lastConnection = trimmed;
      await loadGraph(trimmed, { force: true });
      break;
    }
    case "reload":
      if (lastConnection) await loadGraph(lastConnection, { force: true });
      break;
    case "open":
      await visualize(context);
      break;
    case "forget": {
      await context.secrets.delete(secretKey());
      lastConnection = undefined;
      currentGraph = null;
      currentDatabase = "";
      lastStatsText = "";
      treeProvider?.setGraph(null);
      updateStatusItem();
      break;
    }
  }
}

async function chooseLayout(): Promise<void> {
  type Item = vscode.QuickPickItem & { value: Prefs["layout"] };
  const items: Item[] = [
    { value: "grid", label: "Grid", picked: prefs.layout === "grid" },
    { value: "tree", label: "Tree", description: "dependency layers", picked: prefs.layout === "tree" },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: "Postgres Viz: layout" });
  if (!pick || pick.value === prefs.layout) return;
  prefs = { ...prefs, layout: pick.value };
  savePrefs();
  postPrefs();
}

async function chooseEdgeMode(): Promise<void> {
  type Item = vscode.QuickPickItem & { value: Prefs["edgeMode"] };
  const items: Item[] = [
    {
      value: "off",
      label: "Off",
      description: "click a node to reveal its edges",
      picked: prefs.edgeMode === "off",
    },
    {
      value: "cards",
      label: "Cards",
      description: "one rolled-up edge per pair of tables/functions",
      picked: prefs.edgeMode === "cards",
    },
    {
      value: "all",
      label: "All",
      description: "every per-column edge",
      picked: prefs.edgeMode === "all",
    },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: "Postgres Viz: edges" });
  if (!pick || pick.value === prefs.edgeMode) return;
  prefs = { ...prefs, edgeMode: pick.value };
  savePrefs();
  postPrefs();
}

async function viewOptions(context: vscode.ExtensionContext): Promise<void> {
  type Item = vscode.QuickPickItem & { id: "schemaGroup" | "route" | "hideIsolated" };
  const items: Item[] = [
    { id: "schemaGroup", label: "Group by schema", picked: prefs.schemaGroup },
    {
      id: "route",
      label: "Avoid boxes",
      description: "experimental edge routing",
      picked: prefs.route,
    },
    { id: "hideIsolated", label: "Hide isolated nodes", picked: prefs.hideIsolated },
  ];
  const picks = await vscode.window.showQuickPick(items, {
    title: "Postgres Viz: view options",
    canPickMany: true,
  });
  if (!picks) return; // dismissed — leave prefs untouched
  const chosen = new Set(picks.map((p) => p.id));
  const next: Prefs = {
    ...prefs,
    schemaGroup: chosen.has("schemaGroup"),
    route: chosen.has("route"),
    hideIsolated: chosen.has("hideIsolated"),
  };
  // remember that the user has an opinion on hide-isolated — stop auto-forcing it
  if (next.hideIsolated !== prefs.hideIsolated) {
    void context.workspaceState.update(HIDE_ISOLATED_TOUCHED_KEY, true);
  }
  prefs = next;
  savePrefs();
  postPrefs();
}

/** Parent (table) label of a row node, for qualified row labels in the picker. */
function labelByGraphId(): Map<string, string> {
  const m = new Map<string, string>();
  for (const { data: d } of currentGraph?.nodes ?? []) m.set(d.id, String(d.label));
  return m;
}

async function searchGraph(context: vscode.ExtensionContext): Promise<void> {
  if (!currentGraph) {
    vscode.window.showInformationMessage("Postgres Viz: connect to a database first.");
    return;
  }
  const ROWS = new Set(["column", "trigger", "constraint", "index"]);
  const labelOf = labelByGraphId();
  type Item = vscode.QuickPickItem & { id: string };
  const items: Item[] = [];
  for (const { data: d } of currentGraph.nodes) {
    if (d.type === "schema") continue;
    const owner = ROWS.has(d.type) ? (labelOf.get(d.parent ?? "") ?? "") : "";
    const label = owner
      ? `${d.schema ?? ""}.${owner}.${d.label}`
      : `${d.schema ?? ""}.${d.label}`;
    items.push({ id: d.id, label, description: String(d.type) });
  }
  const pick = await vscode.window.showQuickPick(items, {
    title: "Postgres Viz: search graph",
    placeHolder: "search nodes…",
    matchOnDescription: true,
  });
  if (!pick) return;
  const hadPanel = await ensurePanelRevealed(context);
  if (hadPanel) panel?.webview.postMessage({ type: "searchSelect", id: pick.id });
  else pendingSearch = pick.id;
}

// ── tree context-menu actions ──

/** The graph node data behind a tree node, if the graph is still loaded. */
function graphDataOf(graphId: string): GraphNodeData | undefined {
  for (const { data: d } of currentGraph?.nodes ?? []) if (d.id === graphId) return d;
  return undefined;
}

async function treeFocus(context: vscode.ExtensionContext, n: TreeNode): Promise<void> {
  if (!n.graphId) return;
  const hadPanel = await ensurePanelRevealed(context);
  // reveal already enters the focus view in the webview
  if (hadPanel) panel?.webview.postMessage({ type: "reveal", id: n.graphId });
  else pendingReveal = n.graphId;
}

async function treeCallTree(context: vscode.ExtensionContext, n: TreeNode): Promise<void> {
  if (!n.graphId) return;
  const hadPanel = await ensurePanelRevealed(context);
  if (hadPanel) panel?.webview.postMessage({ type: "callTreeById", id: n.graphId });
  else pendingCallTree = n.graphId;
}

async function treeGoToDef(n: TreeNode): Promise<void> {
  const d = n.graphId ? graphDataOf(n.graphId) : undefined;
  if (!d) return;
  const owner = ownerLabelOf(d);
  await openDefinition(
    d.type,
    d.oid,
    d.schema ?? undefined,
    d.label,
    owner || undefined,
    `${d.schema ?? ""}.${d.label}`,
  );
}

async function treeOpenDdl(n: TreeNode): Promise<void> {
  const d = n.graphId ? graphDataOf(n.graphId) : undefined;
  if (!d) return;
  // a column's DDL is its parent table's column listing — resolve the parent
  if (d.type === "column") {
    const parent = d.parent ? graphDataOf(d.parent) : undefined;
    if (parent) await openDdl(parent.type, parent.oid, `${parent.schema ?? ""}.${parent.label}`);
    return;
  }
  await openDdl(d.type, d.oid, `${d.schema ?? ""}.${d.label}`);
}

/** For row nodes, the owning table's label (owner arg for HCL lookups). */
function ownerLabelOf(d: GraphNodeData): string {
  const ROWS = new Set(["column", "trigger", "constraint", "index"]);
  if (!ROWS.has(d.type) || !d.parent) return "";
  return graphDataOf(d.parent)?.label ?? "";
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
  <div id="content">
    <div id="cy"></div>
    <div id="crumb" class="hidden"></div>
    <div id="legend"></div>
    <div id="stats"></div>
    <aside id="panel" class="hidden">
      <div id="panel-resize" title="drag to resize"></div>
      <div id="panel-body"></div>
    </aside>
    <div id="empty">No connection — use the Postgres Viz status bar item or the sidebar to connect.</div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
