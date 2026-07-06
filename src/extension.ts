import * as vscode from "vscode";
import { disposeParser } from "./analyze";
import {
  ConnectionProfileStore,
  defaultProfileName,
  type ConnectionProfile,
} from "./connection-profiles";
import { fetchDdl, type SqlObjectName } from "./ddl";
import { DdlDocumentSymbolProvider } from "./ddl-symbol-provider";
import { buildGraphDiffReport, type GraphSnapshot } from "./graph-diff";
import { GraphIndex } from "./graph-index";
import { buildImpactReport, buildPathReport, nodeDisplayName } from "./graph-reports";
import { indexEntries, keyVariants, type LocatedEntry, parseHclSymbols } from "./hcl";
import { HclHoverProvider, HclLensProvider } from "./lens-providers";
import { loadGraphFromDatabase, LoadCancelledError, type LoadDiagnostics } from "./load-service";
import { fuzzyIncludes } from "./match";
import {
  DEFAULT_PREFS,
  HIDE_ISOLATED_TOUCHED_KEY,
  normalizePrefs,
  PREFS_KEY,
  type HostToWebviewMessage,
  type Prefs,
} from "./protocol";
import { routineNameFromLabel } from "./routine-label";
import {
  indexSqlMigrationEntries,
  parseSqlMigrationSymbols,
  sqlMigrationKeyFromPath,
  type LocatedSqlMigrationEntry,
} from "./sql-migrations";
import { DbTreeProvider, type TreeNode } from "./tree-provider";
import type { EdgeKind, GraphNodeData, GraphPayload, NodeType } from "./types";
import { WebviewController } from "./webview-controller";

const SECRET_KEY = "postgresViz.connectionString";
const SNAPSHOT_KEY = "postgresViz.graphSnapshot";

/**
 * Connection strings are saved PER WORKSPACE FOLDER — opening an unrelated
 * folder must not auto-connect to (or even know about) another project's db.
 */
function workspaceId(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "no-folder";
}

function legacySecretKey(): string {
  return `${SECRET_KEY}:${workspaceId()}`;
}

let lastConnection: string | undefined;
let activeProfileName = "";
let lastDiagnostics: LoadDiagnostics | undefined;
let output: vscode.OutputChannel | undefined;
let webviewController: WebviewController | undefined;
let connectionProfiles: ConnectionProfileStore | undefined;

// ── view preferences (the native chrome owns these; the webview mirrors them) ──

/** set once the user touches "hide isolated" — after that we never auto-force it */
let prefs: Prefs = { ...DEFAULT_PREFS };
let workspaceState: vscode.Memento | undefined;
/** latest stats line from the webview — folded into the status bar tooltip */
let lastStatsText = "";

let statusItem: vscode.StatusBarItem | undefined;
/** lenses re-render when a graph loads (anchors resolve against it) */
let hclLensProvider: HclLensProvider | undefined;

function savePrefs(): void {
  void workspaceState?.update(PREFS_KEY, prefs);
}

function setPrefs(next: Prefs): void {
  prefs = next;
  savePrefs();
  postPrefs();
}

function postToWebview(message: HostToWebviewMessage): void {
  webviewController?.post(message);
}

/** Push the full prefs object to the webview (post-graph, on change, on replay). */
function postPrefs(): void {
  webviewController?.postPrefs();
}

function updateStatusItem(): void {
  if (!statusItem) return;
  const profile = activeProfileName ? ` (${activeProfileName})` : "";
  statusItem.text = currentGraph
    ? `$(database) ${currentDatabase}${profile}`
    : `$(database) Postgres Viz${profile}`;
  const lines = [
    currentGraph
      ? `Postgres Viz - ${currentDatabase}${profile}`
      : `Postgres Viz - not connected${profile}`,
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
  diagnostics?: LoadDiagnostics;
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

async function getActiveConnection(): Promise<string | undefined> {
  await connectionProfiles?.migrateLegacy();
  const active = await connectionProfiles?.activeConnection();
  if (!active) {
    lastConnection = undefined;
    activeProfileName = "";
    updateStatusItem();
    return undefined;
  }
  lastConnection = active.conn;
  activeProfileName = active.profile.name;
  updateStatusItem();
  return active.conn;
}

async function promptAndSaveProfile(existing?: ConnectionProfile): Promise<string | undefined> {
  const conn = await vscode.window.showInputBox({
    title: existing ? `Postgres Viz: edit ${existing.name}` : "Postgres Viz: add connection profile",
    prompt: "Postgres connection string",
    placeHolder: "postgres://user:password@localhost:5432/dbname",
    ignoreFocusOut: true,
    value: existing ? await connectionProfiles?.connection(existing.id) : undefined,
  });
  if (!conn?.trim()) return undefined;
  const trimmed = conn.trim();
  const name = await vscode.window.showInputBox({
    title: "Postgres Viz: profile name",
    prompt: "Connection profile name",
    value: existing?.name ?? defaultProfileName(trimmed),
    ignoreFocusOut: true,
  });
  if (!name?.trim()) return undefined;
  const profile = await connectionProfiles?.save(name.trim(), trimmed, existing?.id);
  if (!profile) return undefined;
  activeProfileName = profile.name;
  lastConnection = trimmed;
  updateStatusItem();
  return trimmed;
}

function clearLoadedGraph(): void {
  currentGraph = null;
  currentDatabase = "";
  lastDiagnostics = undefined;
  lastStatsText = "";
  treeProvider?.setGraph(null);
  updateStatusItem();
}

// ── native explorer: a real TreeView in the activity bar ──

let treeProvider: DbTreeProvider | undefined;
let treeView: vscode.TreeView<TreeNode> | undefined;

// ── jump-to-definition into Atlas .hcl schema files ──
//
// GP/BPO defines its schema in Atlas HCL; when a matching block exists in the
// workspace, symbols and "Open DDL" link straight to it. Databases without
// HCL (EOR/Hasura) fall back to the generated-DDL virtual document.

interface SourceLoc {
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
      vscode.workspace.onDidChangeWorkspaceFolders(invalidate),
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
  ): Promise<SourceLoc | undefined> {
    const kinds = HCL_KINDS[type];
    if (!kinds) return undefined;
    const name = type === "function" ? routineNameFromLabel(label) : label;
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

const SQL_MIGRATION_KINDS: Partial<Record<NodeType, string[]>> = {
  table: ["table"],
  foreign: ["table"],
  view: ["view"],
  matview: ["materialized", "view"],
  function: ["function", "procedure"],
  trigger: ["trigger"],
  index: ["index"],
  constraint: ["constraint"],
  column: ["column"],
};

class SqlMigrationIndex {
  private map: Promise<Map<string, LocatedSqlMigrationEntry>> | null = null;

  constructor(subscriptions: { dispose(): unknown }[]) {
    const watcher = vscode.workspace.createFileSystemWatcher("**/up.sql");
    const invalidate = (): void => {
      this.map = null;
    };
    watcher.onDidChange(invalidate);
    watcher.onDidCreate(invalidate);
    watcher.onDidDelete(invalidate);
    subscriptions.push(
      watcher,
      vscode.workspace.onDidChangeWorkspaceFolders(invalidate),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("postgresViz.sqlMigrationExcludeGlobs")) invalidate();
      }),
    );
  }

  async find(
    type: NodeType,
    schema: string | undefined,
    label: string,
    owner?: string,
  ): Promise<SourceLoc | undefined> {
    const kinds = SQL_MIGRATION_KINDS[type];
    if (!kinds) return undefined;
    const name = type === "function" ? routineNameFromLabel(label) : label;
    const map = await (this.map ??= this.build());
    for (const kind of kinds) {
      for (const key of keyVariants(kind, schema, owner, name)) {
        const hit = map.get(key);
        if (hit) return { uri: vscode.Uri.parse(hit.file), line: hit.line, col: hit.col };
      }
    }
    return undefined;
  }

  private async build(): Promise<Map<string, LocatedSqlMigrationEntry>> {
    const all: LocatedSqlMigrationEntry[] = [];
    const userGlobs = vscode.workspace
      .getConfiguration("postgresViz")
      .get<string[]>("sqlMigrationExcludeGlobs", ["**/.baltuta/**", "**/openspec/**"]);
    const exclude = `{${["**/node_modules/**", "**/.git/**", ...userGlobs].join(",")}}`;
    const files = await vscode.workspace.findFiles("**/up.sql", exclude, 1000);
    for (const uri of files) {
      let text: string;
      try {
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        continue;
      }
      const migrationKey = sqlMigrationKeyFromPath(uri.toString());
      for (const e of parseSqlMigrationSymbols(text)) {
        all.push({ ...e, file: uri.toString(), migrationKey });
      }
    }
    logLine(`sql migrations: indexed ${all.length} symbols from ${files.length} up.sql file(s)`);
    return indexSqlMigrationEntries(all);
  }
}

let sqlMigrationIndex: SqlMigrationIndex | undefined;

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
function graphDisplayName(schema: string | undefined, label: string): string {
  return schema ? `${schema}.${label}` : label;
}

function ddlUri(
  type: NodeType,
  oid: number,
  label: string,
  objectName?: SqlObjectName,
): vscode.Uri {
  const query =
    objectName?.name !== undefined
      ? new URLSearchParams([
          ["name", objectName.name],
          ...(objectName.schema ? [["schema", objectName.schema] as [string, string]] : []),
        ]).toString()
      : undefined;
  return vscode.Uri.from({
    scheme: "pgviz",
    path: `/${type}/${oid}/${encodeURIComponent(label)}.sql`,
    query,
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
      // prefer source definitions; fall back to the generated DDL document
      const hcl = await hclIndex?.find(d.type, d.schema, d.label, isRow ? owner : undefined);
      const migration = hcl
        ? undefined
        : await sqlMigrationIndex?.find(d.type, d.schema, d.label, isRow ? owner : undefined);
      // a column's DDL doc is its table's column listing (oid is the rel's)
      const docLabel = d.type === "column" ? graphDisplayName(d.schema, owner) : qualified;
      const ddlName =
        d.type === "column"
          ? { schema: d.schema, name: owner, display: docLabel }
          : { schema: d.schema, name: d.label, display: qualified };
      const source = hcl ?? migration;
      const location = source
        ? new vscode.Location(source.uri, new vscode.Position(source.line, source.col))
        : new vscode.Location(ddlUri(d.type, d.oid, docLabel, ddlName), new vscode.Position(0, 0));
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
    const params = new URLSearchParams(uri.query);
    const name = params.get("name") ?? undefined;
    const schema = params.get("schema") ?? undefined;
    try {
      return await fetchDdl(
        lastConnection,
        type as NodeType,
        Number(oid),
        label,
        name ? { schema, name, display: label } : undefined,
      );
    } catch (err) {
      return `-- failed to load DDL for ${label}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  hclIndex = new HclIndex(context.subscriptions);
  sqlMigrationIndex = new SqlMigrationIndex(context.subscriptions);
  workspaceState = context.workspaceState;
  connectionProfiles = new ConnectionProfileStore(
    context.workspaceState,
    context.secrets,
    workspaceId(),
    legacySecretKey(),
  );
  prefs = normalizePrefs(context.workspaceState.get(PREFS_KEY));

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = "postgresViz.connectionMenu";
  updateStatusItem();

  webviewController = new WebviewController({
    extensionUri: context.extensionUri,
    logLine,
    currentGraph: () => currentGraph,
    currentDatabase: () => currentDatabase,
    prefs: () => prefs,
    onStats: (text) => {
      lastStatsText = text;
      updateStatusItem();
    },
    onRefresh: reloadLastGraph,
    onOpenDdl: async (nodeType, oid, label, schema, name) => {
      await openDdl(nodeType, oid, label, name ? { schema, name, display: label } : undefined);
    },
    onOpenDefinition: openDefinition,
    onNodeSelected: async (id) => {
      if (!id) return;
      const item = treeProvider?.find(String(id));
      if (item && treeView?.visible) {
        await treeView.reveal(item, { select: true, focus: false, expand: true });
      }
    },
    onPngExport: savePngExport,
    onSvgExport: saveSvgExport,
    onError: showError,
  });

  treeProvider = new DbTreeProvider();
  treeView = vscode.window.createTreeView("postgresVizExplorer", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  hclLensProvider = new HclLensProvider(() => currentGraph);
  context.subscriptions.push(
    statusItem,
    webviewController,
    treeProvider,
    treeView,
    hclLensProvider,
    vscode.workspace.registerTextDocumentContentProvider("pgviz", new DdlContentProvider()),
    vscode.languages.registerWorkspaceSymbolProvider(new DbSymbolProvider()),
    // editor integration: lenses/hovers on Atlas schema files, outline (@)
    // inside generated-DDL virtual documents
    vscode.languages.registerCodeLensProvider({ pattern: "**/*.hcl" }, hclLensProvider),
    vscode.languages.registerHoverProvider(
      { pattern: "**/*.hcl" },
      new HclHoverProvider(() => currentGraph),
    ),
    vscode.languages.registerDocumentSymbolProvider(
      { scheme: "pgviz" },
      new DdlDocumentSymbolProvider(),
    ),
    vscode.commands.registerCommand("postgresViz.showLogs", () => getOutput().show(true)),
    vscode.commands.registerCommand("postgresViz.showLoadDiagnostics", showLoadDiagnostics),
    vscode.commands.registerCommand("postgresViz.visualize", visualize),
    vscode.commands.registerCommand("postgresViz.load", load),
    vscode.commands.registerCommand("postgresViz.connectionMenu", connectionMenu),
    vscode.commands.registerCommand("postgresViz.fit", () => postToWebview({ type: "fit" })),
    vscode.commands.registerCommand("postgresViz.relayout", () =>
      postToWebview({ type: "relayout" }),
    ),
    vscode.commands.registerCommand("postgresViz.refreshGraph", reloadLastGraph),
    vscode.commands.registerCommand("postgresViz.chooseLayout", chooseLayout),
    vscode.commands.registerCommand("postgresViz.chooseEdgeMode", chooseEdgeMode),
    vscode.commands.registerCommand("postgresViz.viewOptions", () => viewOptions(context)),
    vscode.commands.registerCommand("postgresViz.facetedFilters", facetedFilters),
    vscode.commands.registerCommand("postgresViz.searchGraph", searchGraph),
    vscode.commands.registerCommand("postgresViz.impactAnalysis", (n?: TreeNode) =>
      impactAnalysis(n),
    ),
    vscode.commands.registerCommand("postgresViz.findPath", (n?: TreeNode) => findPath(n)),
    vscode.commands.registerCommand("postgresViz.saveSnapshot", saveSnapshot),
    vscode.commands.registerCommand("postgresViz.diffSnapshot", diffSnapshot),
    vscode.commands.registerCommand("postgresViz.exportGraphJson", exportGraphJson),
    vscode.commands.registerCommand("postgresViz.exportGraphPng", exportGraphPng),
    vscode.commands.registerCommand("postgresViz.exportGraphSvg", exportGraphSvg),
    vscode.commands.registerCommand("postgresViz.revealNode", async (graphId: string) => {
      webviewController?.revealNode(graphId);
    }),
    vscode.commands.registerCommand("postgresViz.treeFocus", treeFocus),
    vscode.commands.registerCommand("postgresViz.treeCallTree", treeCallTree),
    vscode.commands.registerCommand("postgresViz.treeGoToDef", (n?: TreeNode) => treeGoToDef(n)),
    vscode.commands.registerCommand("postgresViz.treeOpenDdl", (n?: TreeNode) => treeOpenDdl(n)),
  );
  // a stored active profile loads in the background at startup — tree + Cmd+T
  // symbols are ready without opening the graph panel
  void getActiveConnection().then((conn) => {
    if (conn) {
      logLine(`startup: loading ${activeProfileName} ${redact(conn)} in the background`);
      return loadGraph(conn);
    }
  });
}

export function deactivate(): void {
  disposeParser();
}

async function visualize(): Promise<void> {
  webviewController?.ensure();
  const conn = await getActiveConnection();
  if (conn) {
    await loadGraph(conn);
  }
  // no stored profile -> the status bar item / sidebar drive connecting now
}

/** Load the graph WITHOUT opening the panel (sidebar welcome button / startup). */
async function load(): Promise<void> {
  let conn = await getActiveConnection();
  if (!conn) {
    conn = await promptAndSaveProfile();
    if (!conn) return;
  }
  await loadGraph(conn);
}

let loading = false;

async function reloadLastGraph(): Promise<void> {
  if (lastConnection) await loadGraph(lastConnection, { force: true });
}

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
      lastDiagnostics = cached.diagnostics;
      treeProvider?.setGraph(cached.graph);
      hclLensProvider?.refresh();
      applyInitialHideIsolated(cached.graph);
      postToWebview({
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
      { location: vscode.ProgressLocation.Notification, title: "Postgres Viz", cancellable: true },
      async (progress, token) => {
        const log = (msg: string): void => {
          logLine(msg);
          progress.report({ message: msg.length > 64 ? `${msg.slice(0, 61)}…` : msg });
          postToWebview({ type: "status", message: msg });
        };
        const analysisLog = (msg: string): void => {
          logLine(msg);
          const m = msg.match(/^\[(\d+)\/(\d+)\]/);
          const short = m ? `analyzing function bodies ${m[1]}/${m[2]}…` : msg.slice(0, 64);
          progress.report({ message: short });
          postToWebview({ type: "status", message: short });
        };
        const cfg = vscode.workspace.getConfiguration("postgresViz");
        const schemas = cfg.get<string[]>("schemas") ?? [];
        const excludeSchemas = cfg.get<string[]>("excludeSchemas") ?? [];
        const includeFks = cfg.get<boolean>("includeForeignKeys") ?? true;
        logLine(`─── visualize ${redact(conn)} ───`);
        log("connecting (10s timeout)…");
        const { graph, database, diagnostics } = await loadGraphFromDatabase({
          conn,
          schemas,
          excludeSchemas,
          includeFks,
          log,
          analysisLog,
          cancellation: token,
        });
        logLine(
          `graph ready: ${graph.nodes.length} nodes, ${graph.edges.length} edges ` +
            `(${JSON.stringify(graph.stats)}) — total ${diagnostics.elapsedMs} ms; ` +
            `${diagnostics.analysis.parserFallbacks} parser fallbacks`,
        );
        for (const warning of diagnostics.warnings) logLine(`note: ${warning}`);
        graphCache.delete(key); // re-insert so Map order stays LRU
        graphCache.set(key, { graph, database, diagnostics, builtAt: Date.now() });
        if (graphCache.size > GRAPH_CACHE_MAX) {
          const oldest = graphCache.keys().next().value;
          if (oldest !== undefined) graphCache.delete(oldest);
        }
        currentGraph = graph;
        currentDatabase = database;
        lastDiagnostics = diagnostics;
        treeProvider?.setGraph(graph);
        hclLensProvider?.refresh();
        applyInitialHideIsolated(graph);
        postToWebview({ type: "graph", graph, database });
        postPrefs();
        updateStatusItem();
      },
    );
  } catch (err) {
    if (err instanceof LoadCancelledError) {
      logLine("load cancelled");
      postToWebview({ type: "status", message: "load cancelled" });
      return;
    }
    logLine(`ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    postToWebview({
      type: "error",
      message: String(err instanceof Error ? err.message : err),
    });
    showError(err);
  } finally {
    loading = false;
  }
}

/** "Go to definition": source schema/migration SQL when available, DDL otherwise. */
async function openDefinition(
  nodeType: NodeType,
  oid: number,
  schema: string | undefined,
  name: string,
  owner: string | undefined,
  label: string,
): Promise<void> {
  const hcl = await hclIndex?.find(nodeType, schema, name, owner);
  const migration = hcl ? undefined : await sqlMigrationIndex?.find(nodeType, schema, name, owner);
  const source = hcl ?? migration;
  if (source) {
    const pos = new vscode.Position(source.line, source.col);
    await vscode.window.showTextDocument(source.uri, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      selection: new vscode.Range(pos, pos),
    });
    return;
  }
  const fallbackLabel = nodeType === "column" && owner ? graphDisplayName(schema, owner) : label;
  const fallbackName =
    nodeType === "column" && owner
      ? { schema, name: owner, display: fallbackLabel }
      : name
        ? { schema, name, display: fallbackLabel }
        : undefined;
  await openDdl(nodeType, oid, fallbackLabel, fallbackName);
}

async function openDdl(
  nodeType: NodeType,
  oid: number,
  label: string,
  objectName?: SqlObjectName,
): Promise<void> {
  if (!lastConnection || !Number.isFinite(oid)) return;
  const content = await fetchDdl(lastConnection, nodeType, oid, label, objectName);
  const doc = await vscode.workspace.openTextDocument({ language: "sql", content });
  await showGeneratedDocument(doc, true);
}

function showError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  vscode.window.showErrorMessage(`Postgres Viz: ${message}`);
}

async function showGeneratedDocument(doc: vscode.TextDocument, preview: boolean): Promise<void> {
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preview,
  });
}

const LOAD_DATABASE_FIRST = "Postgres Viz: load a database first.";
const CONNECT_DATABASE_FIRST = "Postgres Viz: connect to a database first.";

function requireGraph(message = LOAD_DATABASE_FIRST): GraphPayload | undefined {
  if (currentGraph) return currentGraph;
  vscode.window.showInformationMessage(message);
  return undefined;
}

function requireLoadDiagnostics(): LoadDiagnostics | undefined {
  if (lastDiagnostics) return lastDiagnostics;
  vscode.window.showInformationMessage(LOAD_DATABASE_FIRST);
  return undefined;
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

async function connectionMenu(): Promise<void> {
  await connectionProfiles?.migrateLegacy();
  const connected = Boolean(lastConnection);
  const graphDescription = currentGraph ? currentDatabase : "load first";
  type Item = vscode.QuickPickItem & { id: string };
  const profileItems: Item[] =
    connectionProfiles?.list().map((profile) => ({
      id: `profile:${profile.id}`,
      label: `${profile.name === activeProfileName ? "$(check) " : ""}${profile.name}`,
      description: "switch profile",
    })) ?? [];
  const items: Item[] = [
    ...profileItems,
    { id: "add", label: "$(plus) Add connection profile..." },
    {
      id: "reload",
      label: "$(sync) Reload from database",
      description: connected ? undefined : "connect first",
    },
    {
      id: "diagnostics",
      label: "$(pulse) Show load diagnostics",
      description: lastDiagnostics ? currentDatabase : "load first",
    },
    {
      id: "saveSnapshot",
      label: "$(save) Save graph snapshot",
      description: graphDescription,
    },
    {
      id: "diffSnapshot",
      label: "$(diff) Compare with saved snapshot",
      description: graphDescription,
    },
    {
      id: "exportJson",
      label: "$(json) Export graph JSON",
      description: graphDescription,
    },
    {
      id: "exportPng",
      label: "$(file-media) Export graph PNG",
      description: currentGraph ? "opens graph panel if needed" : "load first",
    },
    {
      id: "exportSvg",
      label: "$(file-code) Export graph SVG",
      description: currentGraph ? "opens graph panel if needed" : "load first",
    },
    {
      id: "facets",
      label: "$(filter) Faceted filters",
      description: currentGraph ? "schemas, object types, edge kinds" : "load first",
    },
    { id: "open", label: "$(graph) Open graph panel" },
    {
      id: "edit",
      label: "$(edit) Edit active profile...",
      description: connected ? activeProfileName : "connect first",
    },
    {
      id: "forget",
      label: "$(trash) Forget active profile",
      description: connected ? activeProfileName : "connect first",
    },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: "Postgres Viz" });
  if (!pick) return;
  if (pick.id.startsWith("profile:")) {
    const profileId = pick.id.slice("profile:".length);
    await connectionProfiles?.setActive(profileId);
    const conn = await getActiveConnection();
    if (conn) await loadGraph(conn);
    return;
  }
  switch (pick.id) {
    case "add": {
      const conn = await promptAndSaveProfile();
      if (!conn) return;
      getOutput().show(true);
      await loadGraph(conn, { force: true });
      break;
    }
    case "reload":
      await reloadLastGraph();
      break;
    case "diagnostics":
      await showLoadDiagnostics();
      break;
    case "saveSnapshot":
      await saveSnapshot();
      break;
    case "diffSnapshot":
      await diffSnapshot();
      break;
    case "exportJson":
      await exportGraphJson();
      break;
    case "exportPng":
      await exportGraphPng();
      break;
    case "exportSvg":
      await exportGraphSvg();
      break;
    case "facets":
      await facetedFilters();
      break;
    case "open":
      await visualize();
      break;
    case "edit": {
      const active = connectionProfiles?.activeProfile();
      if (!active) return;
      const conn = await promptAndSaveProfile(active);
      if (conn) await loadGraph(conn, { force: true });
      break;
    }
    case "forget": {
      const active = connectionProfiles?.activeProfile();
      if (active) await connectionProfiles?.delete(active.id);
      lastConnection = undefined;
      activeProfileName = connectionProfiles?.activeProfile()?.name ?? "";
      clearLoadedGraph();
      break;
    }
  }
}

async function chooseLayout(): Promise<void> {
  // The Tree layout has two interchangeable engines (A/B): v1 = hand-rolled BFS
  // layers, v2 = dagre layered DAG snapped to a grid. They're surfaced as
  // separate picks so flipping designs is a single menu choice.
  type Item = vscode.QuickPickItem & { value: Prefs["layout"]; engine?: Prefs["engine"] };
  const onTree = prefs.layout === "tree";
  const items: Item[] = [
    { value: "grid", label: "Grid", picked: prefs.layout === "grid" },
    {
      value: "tree",
      engine: "v1",
      label: "Tree (v1)",
      description: "dependency layers — hand-rolled",
      picked: onTree && prefs.engine === "v1",
    },
    {
      value: "tree",
      engine: "v2",
      label: "Tree (v2)",
      description: "dagre layered call graph, grid-aligned",
      picked: onTree && prefs.engine === "v2",
    },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: "Postgres Viz: layout" });
  if (!pick) return;
  const nextEngine = pick.engine ?? prefs.engine;
  if (pick.value === prefs.layout && nextEngine === prefs.engine) return;
  setPrefs({ ...prefs, layout: pick.value, engine: nextEngine });
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
  setPrefs({ ...prefs, edgeMode: pick.value });
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
  setPrefs(next);
}

async function facetedFilters(): Promise<void> {
  const graph = requireGraph();
  if (!graph) return;
  const schemas = sortedUnique(
    graph.nodes.map((n) => n.data.schema).filter((s): s is string => Boolean(s)),
  );
  const nodeTypes = sortedUnique(
    graph.nodes
      .map((n) => n.data.type)
      .filter((t): t is NodeType => t !== "schema"),
  );
  const edgeKinds = sortedUnique(graph.edges.map((e) => e.data.kind));

  const nextSchemas = await pickFacet("Postgres Viz: schemas", schemas, prefs.filterSchemas);
  if (!nextSchemas) return;
  const nextNodeTypes = await pickFacet(
    "Postgres Viz: object types",
    nodeTypes,
    prefs.filterNodeTypes,
  );
  if (!nextNodeTypes) return;
  const nextEdgeKinds = await pickFacet(
    "Postgres Viz: edge kinds",
    edgeKinds,
    prefs.filterEdgeKinds,
  );
  if (!nextEdgeKinds) return;

  setPrefs({
    ...prefs,
    filterSchemas: nextSchemas as string[],
    filterNodeTypes: nextNodeTypes as NodeType[],
    filterEdgeKinds: nextEdgeKinds as EdgeKind[],
  });
}

async function pickFacet<T extends string>(
  title: string,
  allValues: T[],
  selectedValues: T[],
): Promise<T[] | undefined> {
  const selected = new Set(selectedValues.length === 0 ? allValues : selectedValues);
  const picks = await vscode.window.showQuickPick(
    allValues.map((value) => ({ label: value, picked: selected.has(value) })),
    { title, canPickMany: true, placeHolder: "Select all to disable this facet" },
  );
  if (!picks) return undefined;
  const values = picks.map((p) => p.label as T).sort();
  return values.length === allValues.length ? [] : values;
}

function sortedUnique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort();
}

/** Parent (table) label of a row node, for qualified row labels in the picker. */
function labelByGraphId(): Map<string, string> {
  const m = new Map<string, string>();
  for (const { data: d } of currentGraph?.nodes ?? []) m.set(d.id, String(d.label));
  return m;
}

async function searchGraph(): Promise<void> {
  const graph = requireGraph(CONNECT_DATABASE_FIRST);
  if (!graph) return;
  const labelOf = labelByGraphId();
  type Item = vscode.QuickPickItem & { id: string };
  const items: Item[] = [];
  for (const { data: d } of graph.nodes) {
    if (d.type === "schema") continue;
    const owner = rowNode(d) ? (labelOf.get(d.parent ?? "") ?? "") : "";
    const label = owner ? `${d.schema ?? ""}.${owner}.${d.label}` : `${d.schema ?? ""}.${d.label}`;
    items.push({ id: d.id, label, description: String(d.type) });
  }
  const pick = await vscode.window.showQuickPick(items, {
    title: "Postgres Viz: search graph",
    placeHolder: "search nodes…",
    matchOnDescription: true,
  });
  if (!pick) return;
  webviewController?.searchSelect(pick.id);
}

const EDGE_FILTERS: (vscode.QuickPickItem & { kinds?: EdgeKind[] })[] = [
  { label: "All edge kinds" },
  { label: "Reads / selects", kinds: ["reads", "selects"] },
  { label: "Mutations", kinds: ["inserts", "updates", "deletes", "writes", "modifies"] },
  { label: "Calls / executes", kinds: ["calls", "executes"] },
  { label: "Keys / constraints / defaults", kinds: ["fk", "constrains", "indexes", "default"] },
];

type NodePick = vscode.QuickPickItem & { id: string };

function rowNode(d: GraphNodeData): boolean {
  return SYMBOL_ROWS.has(d.type);
}

function graphNodeItems(index: GraphIndex, excludeId?: string): NodePick[] {
  return [...index.nodesById.values()]
    .filter((d) => d.type !== "schema" && d.id !== excludeId)
    .map((d) => ({
      id: d.id,
      label: nodeDisplayName(index, d),
      description: String(d.type),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function pickGraphNode(index: GraphIndex, title: string, excludeId?: string): Promise<string | undefined> {
  const pick = await vscode.window.showQuickPick(graphNodeItems(index, excludeId), {
    title,
    placeHolder: "search nodes...",
    matchOnDescription: true,
  });
  return pick?.id;
}

async function pickEdgeFilter(): Promise<EdgeKind[] | undefined | null> {
  const pick = await vscode.window.showQuickPick(EDGE_FILTERS, {
    title: "Postgres Viz: edge filter",
  });
  return pick ? pick.kinds : null;
}

async function openMarkdownReport(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ language: "markdown", content });
  await showGeneratedDocument(doc, false);
}

function escapeMarkdownText(value: string): string {
  return value.replace(/[\\`*[\]<>]/g, "\\$&").replace(/\r?\n/g, " ");
}

function markdownList(values: string[], empty: string): string {
  return values.length > 0 ? values.map(escapeMarkdownText).join(", ") : empty;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGraphNodeEntry(value: unknown): value is { data: { id: string } } {
  if (!isRecord(value) || !isRecord(value.data)) return false;
  return typeof value.data.id === "string";
}

function isGraphEdgeEntry(
  value: unknown,
): value is { data: { id: string; source: string; target: string; kind: string } } {
  if (!isRecord(value) || !isRecord(value.data)) return false;
  return (
    typeof value.data.id === "string" &&
    typeof value.data.source === "string" &&
    typeof value.data.target === "string" &&
    typeof value.data.kind === "string"
  );
}

function isGraphPayload(value: unknown): value is GraphPayload {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.nodes) &&
    value.nodes.every(isGraphNodeEntry) &&
    Array.isArray(value.edges) &&
    value.edges.every(isGraphEdgeEntry) &&
    isRecord(value.stats)
  );
}

function isGraphSnapshot(value: unknown): value is GraphSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.savedAt === "number" &&
    Number.isFinite(value.savedAt) &&
    typeof value.database === "string" &&
    isGraphPayload(value.graph)
  );
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function decodePngExport(dataUri: unknown): Buffer | undefined {
  if (typeof dataUri !== "string") return undefined;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUri.trim());
  const encoded = match?.[1];
  if (!encoded || encoded.length % 4 !== 0) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  return bytes.length > PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
    ? bytes
    : undefined;
}

function isSvgExport(svg: unknown): svg is string {
  if (typeof svg !== "string") return false;
  return /^<svg(?:\s|>)/i.test(svg.trimStart());
}

const EXPORT_FILENAME_FORBIDDEN = new Set(["<", ">", ":", "\"", "/", "\\", "|", "?", "*"]);

function sanitizeExportNamePart(value: string): string {
  let out = "";
  for (const char of value) {
    out += char.charCodeAt(0) < 32 || EXPORT_FILENAME_FORBIDDEN.has(char) ? "_" : char;
  }
  return out.replace(/\s+/g, " ").trim();
}

function exportDefaultUri(extension: "png" | "svg"): vscode.Uri {
  const source = currentDatabase || "graph";
  const safeName = sanitizeExportNamePart(source);
  const fileName = `postgres-viz-${safeName || "graph"}.${extension}`;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder ? vscode.Uri.joinPath(folder, fileName) : vscode.Uri.file(fileName);
}

async function showLoadDiagnostics(): Promise<void> {
  const d = requireLoadDiagnostics();
  if (!d) return;
  const warnings =
    d.warnings.length > 0
      ? d.warnings.map((w) => `- ${escapeMarkdownText(w)}`).join("\n")
      : "_None._";
  const stats = JSON.stringify(d.graph.stats);
  await openMarkdownReport(`# Postgres Viz Load Diagnostics

- Profile: ${activeProfileName ? escapeMarkdownText(activeProfileName) : "_none_"}
- Database: ${escapeMarkdownText(d.database)}
- Elapsed: ${d.elapsedMs} ms
- Schemas included: ${d.schemas.include ? markdownList(d.schemas.include, "none") : "all non-system"}
- Schemas excluded: ${markdownList(d.schemas.exclude, "none")}

## Catalog

- Relations: ${d.catalog.relations}
- Columns: ${d.catalog.columns}
- Functions: ${d.catalog.functions}
- Triggers: ${d.catalog.triggers}
- Constraints: ${d.catalog.constraints}
- Indexes: ${d.catalog.indexes}

## Analysis

- Analyzed functions: ${d.analysis.analyzedFunctions}
- Skipped functions: ${d.analysis.skippedFunctions}
- Parser fallbacks: ${d.analysis.parserFallbacks}

## Graph

- Nodes: ${d.graph.nodes}
- Edges: ${d.graph.edges}
- Stats: \`${stats}\`

## Warnings

${warnings}
`);
}

async function saveSnapshot(): Promise<void> {
  const graph = requireGraph();
  if (!graph) return;
  const snapshot: GraphSnapshot = {
    savedAt: Date.now(),
    database: currentDatabase,
    graph,
  };
  await workspaceState?.update(SNAPSHOT_KEY, snapshot);
  vscode.window.showInformationMessage(`Postgres Viz: saved snapshot for ${currentDatabase}.`);
}

async function diffSnapshot(): Promise<void> {
  const graph = requireGraph();
  if (!graph) return;
  const snapshot = workspaceState?.get<unknown>(SNAPSHOT_KEY);
  if (!snapshot) {
    vscode.window.showInformationMessage("Postgres Viz: save a graph snapshot first.");
    return;
  }
  if (!isGraphSnapshot(snapshot)) {
    vscode.window.showWarningMessage(
      "Postgres Viz: saved graph snapshot is invalid. Save a new snapshot and try again.",
    );
    return;
  }
  await openMarkdownReport(buildGraphDiffReport(snapshot, graph));
}

async function exportGraphJson(): Promise<void> {
  const graph = requireGraph();
  if (!graph) return;
  const doc = await vscode.workspace.openTextDocument({
    language: "json",
    content: JSON.stringify(
      {
        database: currentDatabase,
        exportedAt: new Date().toISOString(),
        graph,
      },
      null,
      2,
    ),
  });
  await showGeneratedDocument(doc, false);
}

async function exportGraphPng(): Promise<void> {
  if (!requireGraph()) return;
  webviewController?.exportPng();
}

async function exportGraphSvg(): Promise<void> {
  if (!requireGraph()) return;
  webviewController?.exportSvg();
}

async function savePngExport(dataUri: string): Promise<void> {
  const bytes = decodePngExport(dataUri);
  if (!bytes) {
    vscode.window.showErrorMessage("Postgres Viz: invalid PNG export data.");
    return;
  }
  const target = await vscode.window.showSaveDialog({
    title: "Postgres Viz: save graph PNG",
    defaultUri: exportDefaultUri("png"),
    filters: { "PNG image": ["png"] },
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, bytes);
  vscode.window.showInformationMessage(`Postgres Viz: saved ${target.fsPath}`);
}

async function saveSvgExport(svg: string): Promise<void> {
  if (!isSvgExport(svg)) {
    vscode.window.showErrorMessage("Postgres Viz: invalid SVG export data.");
    return;
  }
  const target = await vscode.window.showSaveDialog({
    title: "Postgres Viz: save graph SVG",
    defaultUri: exportDefaultUri("svg"),
    filters: { "SVG image": ["svg"] },
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, Buffer.from(svg, "utf8"));
  vscode.window.showInformationMessage(`Postgres Viz: saved ${target.fsPath}`);
}

async function impactAnalysis(n?: TreeNode): Promise<void> {
  const graph = requireGraph(CONNECT_DATABASE_FIRST);
  if (!graph) return;
  const index = new GraphIndex(graph);
  const rootId = n?.graphId ?? (await pickGraphNode(index, "Postgres Viz: impact analysis"));
  if (!rootId) return;
  const root = index.node(rootId);
  if (!root) return;
  const direction = await vscode.window.showQuickPick(
    [
      { label: "What depends on this?", direction: "in" as const },
      { label: "What does this affect?", direction: "out" as const },
    ],
    { title: `Postgres Viz: ${nodeDisplayName(index, root)}` },
  );
  if (!direction) return;
  const kinds = await pickEdgeFilter();
  if (kinds === null) return;
  await openMarkdownReport(
    buildImpactReport(graph, {
      rootId,
      direction: direction.direction,
      kinds,
      includeDetail: rowNode(root),
    }),
  );
}

async function findPath(n?: TreeNode): Promise<void> {
  const graph = requireGraph(CONNECT_DATABASE_FIRST);
  if (!graph) return;
  const index = new GraphIndex(graph);
  const sourceId = n?.graphId ?? (await pickGraphNode(index, "Postgres Viz: path source"));
  if (!sourceId) return;
  const targetId = await pickGraphNode(index, "Postgres Viz: path target", sourceId);
  if (!targetId) return;
  const direction = await vscode.window.showQuickPick(
    [
      { label: "Follow dependency direction", direction: "out" as const },
      { label: "Follow dependent direction", direction: "in" as const },
      { label: "Either direction", direction: "both" as const },
    ],
    { title: "Postgres Viz: path direction" },
  );
  if (!direction) return;
  const kinds = await pickEdgeFilter();
  if (kinds === null) return;
  const source = index.node(sourceId);
  const target = index.node(targetId);
  await openMarkdownReport(
    buildPathReport(graph, {
      sourceId,
      targetId,
      direction: direction.direction,
      kinds,
      includeDetail: Boolean((source && rowNode(source)) || (target && rowNode(target))),
    }),
  );
}

// ── tree context-menu actions ──

/** The graph node data behind a tree node, if the graph is still loaded. */
function graphDataOf(graphId: string): GraphNodeData | undefined {
  for (const { data: d } of currentGraph?.nodes ?? []) if (d.id === graphId) return d;
  return undefined;
}

async function treeFocus(n?: TreeNode): Promise<void> {
  if (!n?.graphId) return;
  webviewController?.revealNode(n.graphId);
}

async function treeCallTree(n?: TreeNode): Promise<void> {
  if (!n?.graphId) return;
  webviewController?.callTreeById(n.graphId);
}

async function treeGoToDef(n?: TreeNode): Promise<void> {
  const d = n?.graphId ? graphDataOf(n.graphId) : undefined;
  if (!d) return;
  const owner = ownerLabelOf(d);
  await openDefinition(
    d.type,
    d.oid,
    d.schema ?? undefined,
    d.label,
    owner || undefined,
    graphDisplayName(d.schema, d.label),
  );
}

async function treeOpenDdl(n?: TreeNode): Promise<void> {
  const d = n?.graphId ? graphDataOf(n.graphId) : undefined;
  if (!d || d.type === "schema") return;
  // a column's DDL is its parent table's column listing — resolve the parent
  if (d.type === "column") {
    const parent = d.parent ? graphDataOf(d.parent) : undefined;
    if (parent) {
      const label = graphDisplayName(parent.schema, parent.label);
      await openDdl(parent.type, parent.oid, label, {
        schema: parent.schema,
        name: parent.label,
        display: label,
      });
    }
    return;
  }
  const label = graphDisplayName(d.schema, d.label);
  await openDdl(d.type, d.oid, label, { schema: d.schema, name: d.label, display: label });
}

/** For row nodes, the owning table's label (owner arg for HCL lookups). */
function ownerLabelOf(d: GraphNodeData): string {
  if (!rowNode(d) || !d.parent) return "";
  return graphDataOf(d.parent)?.label ?? "";
}
