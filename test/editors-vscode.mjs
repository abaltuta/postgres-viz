import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, posix } from "node:path";
import { setTimeout } from "node:timers/promises";
import { build } from "esbuild";

const uri = (path) => ({ path, toString: () => `file://${path}` });
const assets = uri("/extension/dist/viewer");
const file = uri("/space folder/database.pgviz.json");
const workspaceSource = uri("/space folder/migrations/001/up.sql");
const sql = "CREATE VIEW inventory AS SELECT id FROM item;";
const evidence = {
  id: "proof",
  relationshipId: "read",
  ownerId: "inventory",
  provenance: "parsed",
  snippet: "id",
  start: sql.indexOf("id"),
  end: sql.indexOf("id") + 2,
};
const definitionEvidence = {
  id: "definition-proof",
  relationshipId: "read",
  ownerId: "inventory",
  provenance: "catalog",
  snippet: "",
};
const snapshot = {
  format: "postgres-viz",
  version: 1,
  capturedAt: "2026-01-01T00:00:00Z",
  database: "old",
  schemas: { include: null, exclude: [] },
  objects: [
    { id: "inventory", schema: "public", name: "inventory", kind: "view" },
    { id: "item", schema: "public", name: "item", kind: "table" },
  ],
  columns: [{ id: "item-id", objectId: "item", name: "id", type: "int", position: 1 }],
  relationships: [
    { id: "read", source: "inventory", target: "item-id", kind: "reads", provenance: "parsed" },
  ],
  definitions: [{ ownerId: "inventory", sql }],
  evidence: [evidence, definitionEvidence],
  diagnostics: { warnings: [], unresolved: [] },
};
const files = new Map([
  [file.path, JSON.stringify(snapshot)],
  [workspaceSource.path, `-- migration\n${sql}`],
  [
    `${assets.path}/index.html`,
    await readFile(new URL("../viewer/index.html", import.meta.url), "utf8"),
  ],
]);

const shown = [];
const navigationErrors = [];
const listeners = new Map();
let watched;
let cleaned = false;
const watcher = {
  onDidChange: (fn) => subscribe("change", fn),
  onDidCreate: (fn) => subscribe("create", fn),
  onDidDelete: (fn) => subscribe("delete", fn),
  dispose: () => {
    cleaned = true;
  },
};
const vscode = {
  Uri: { joinPath: (base, ...parts) => uri(posix.join(base.path, ...parts)) },
  RelativePattern: class {
    constructor(base, pattern) {
      Object.assign(this, { base, pattern });
    }
  },
  Range: class {
    constructor(start, end) {
      Object.assign(this, { start, end });
    }
  },
  ViewColumn: { Beside: -2 },
  workspace: {
    createFileSystemWatcher(pattern) {
      watched = pattern;
      return watcher;
    },
    getConfiguration: () => ({ get: () => undefined }),
    fs: {
      async readFile({ path }) {
        if (!files.has(path)) throw new Error("File not found");
        return new TextEncoder().encode(files.get(path));
      },
    },
    textDocuments: [],
    findFiles: async (pattern) => (pattern.endsWith("up.sql") ? [workspaceSource] : []),
    openTextDocument: async (input) => ({
      uri: input.path ? input : uri("/untitled"),
      getText: () => (input.path ? files.get(input.path) : input.content),
      positionAt: (offset) => offset,
    }),
  },
  window: {
    async showTextDocument(document, options) {
      shown.push({ document, options });
    },
    async showErrorMessage(message) {
      navigationErrors.push(message);
    },
  },
};

function subscribe(name, fn) {
  listeners.set(name, fn);
  return { dispose: () => listeners.delete(name) };
}

async function loadEditorModule(entryPoint, mocks) {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    external: Object.keys(mocks),
  });
  const require = createRequire(import.meta.url);
  const module = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(
    (name) => mocks[name] ?? require(name),
    module,
    module.exports,
  );
  return module.exports;
}

const { PRISM_EDITOR, PrismEditor } = await loadEditorModule("editors/vscode/prism-editor.ts", {
  vscode,
});
const manifest = JSON.parse(
  await readFile(new URL("../editors/vscode/package.json", import.meta.url), "utf8"),
);
assert.deepEqual(manifest.contributes.customEditors, [
  {
    viewType: PRISM_EDITOR,
    displayName: "postgres-viz",
    selector: [{ filenamePattern: "*.pgviz.json" }],
    priority: "default",
  },
]);

const sent = [];
const panel = {
  webview: {
    asWebviewUri: (local) => `webview:${local.path}`,
    cspSource: "webview:",
    onDidReceiveMessage: (fn) => subscribe("message", fn),
    async postMessage(message) {
      sent.push(message);
      return true;
    },
  },
  onDidDispose: (fn) => subscribe("dispose", fn),
};
const editor = new PrismEditor(assets);
await editor.resolveCustomEditor(editor.openCustomDocument(file), panel);
assert.equal(watched.base.path, "/space folder");
assert.equal(watched.pattern, "*");
assert.match(panel.webview.html, /Content-Security-Policy/);
assert.match(panel.webview.html, /webview:\/extension\/dist\/viewer\/main\.js/);
assert.match(panel.webview.html, /webview:\/extension\/dist\/viewer\/style\.css/);
assert.deepEqual(sent, []);

await listeners.get("message")({ type: "ready" });
assert.deepEqual(sent, [{ type: "snapshot", snapshot, preserveSelection: true }]);
await listeners.get("message")({ type: "openEvidence", evidenceId: "proof" });
assert.equal(shown[0].document.uri, workspaceSource);
assert.equal(shown[0].options.selection.start, "-- migration\n".length + evidence.start);
await listeners.get("message")({ type: "openEvidence", evidenceId: definitionEvidence.id });
assert.equal(shown[1].document.uri, workspaceSource);
assert.deepEqual(
  shown[1].options.selection,
  new vscode.Range("-- migration\n".length, "-- migration\n".length + sql.length),
);
files.set(workspaceSource.path, "-- unrelated migration");
await listeners.get("message")({ type: "openEvidence", evidenceId: "proof" });
assert.equal(shown[2].document.getText(), sql);
assert.equal(shown[2].options.selection.start, evidence.start);
await listeners.get("message")({ type: "openEvidence", evidenceId: definitionEvidence.id });
assert.equal(shown[3].document.getText(), sql);
assert.deepEqual(shown[3].options.selection, new vscode.Range(0, sql.length));

async function expectCapturedEvidence(context) {
  const count = shown.length;
  await listeners.get("message")({ type: "openEvidence", evidenceId: evidence.id });
  assert.equal(shown.length, count + 1, context);
  assert.equal(shown.at(-1).document.uri.path, "/untitled", context);
  assert.equal(shown.at(-1).document.getText(), sql);
  assert.deepEqual(shown.at(-1).options.selection, new vscode.Range(evidence.start, evidence.end));
}

files.set(workspaceSource.path, `${sql}\n${sql}`);
await expectCapturedEvidence("duplicate definition in one file");

files.set(workspaceSource.path, sql);
const findFiles = vscode.workspace.findFiles;
const otherSource = uri("/space folder/schema.hcl");
files.set(otherSource.path, sql);
vscode.workspace.findFiles = async (pattern) =>
  pattern.endsWith("*.hcl") ? [otherSource] : findFiles(pattern);
await expectCapturedEvidence("duplicate definition across SQL and HCL files");

vscode.workspace.findFiles = findFiles;
vscode.workspace.textDocuments.push({
  uri: workspaceSource,
  getText: () => "-- unsaved changes",
});
await expectCapturedEvidence("the definition changed in an unsaved buffer");
vscode.workspace.textDocuments.pop();

vscode.workspace.findFiles = async (pattern) => {
  if (pattern.endsWith("*.hcl")) throw new Error("Workspace search unavailable");
  return findFiles(pattern);
};
await expectCapturedEvidence("workspace search failed");
assert.deepEqual(navigationErrors, []);
vscode.workspace.findFiles = findFiles;

files.delete(file.path);
listeners.get("delete")(file);
files.set(file.path, JSON.stringify({ ...snapshot, database: "regenerated" }));
listeners.get("create")(file);
listeners.get("change")(uri("/space folder/unrelated"));
await setTimeout(150);
assert.equal(sent.length, 2);
assert.equal(sent[1].snapshot.database, "regenerated");
assert.equal(sent[1].preserveSelection, true);

files.set(file.path, JSON.stringify({ ...snapshot, version: 2 }));
listeners.get("change")(file);
await setTimeout(150);
assert.equal(sent[2].type, "error");
assert.match(sent[2].message, /unsupported version 2/);
listeners.get("change")(file);
listeners.get("dispose")();
assert.equal(cleaned, true);
assert.equal(listeners.has("change"), false);
await setTimeout(150);
assert.equal(sent.length, 3);

console.log("VS Code provider loaded the viewer, refreshed snapshots, and opened verified evidence");

const launches = [];
let behavior;
const childProcess = {
  spawn(executable, args, options) {
    const child = new EventEmitter();
    launches.push({ executable, args, options, child });
    void behavior(child, args[2], options);
    return child;
  },
};
const { captureSnapshot } = await loadEditorModule("editors/vscode/capture.ts", {
  "node:child_process": childProcess,
});
const executable = "/extension with spaces/dist/postgres-viz";
const connection = "postgresql://user:test-password@localhost/database";
const configuration = {
  schemas: ["Mixed Case", "-leading-dash"],
  excludeSchemas: ["unused.schema"],
  includeFks: false,
};

behavior = async (child, output) => {
  await writeFile(output, JSON.stringify(snapshot));
  child.emit("close", 0);
};
assert.deepEqual(
  await captureSnapshot(executable, connection, configuration, new AbortController().signal),
  snapshot,
);
const first = launches[0];
const outputPath = first.args[2];
assert.equal(first.executable, executable);
assert.deepEqual(first.args, [
  "scan",
  "--out",
  outputPath,
  "--schema",
  "Mixed Case",
  "--schema",
  "-leading-dash",
  "--exclude-schema",
  "unused.schema",
  "--no-fks",
]);
assert.equal(first.options.env.DATABASE_URL, connection);
assert.equal(first.options.shell, undefined);
assert.equal(first.options.windowsHide, true);
assert.ok(!first.args.join(" ").includes(connection));
await assert.rejects(stat(dirname(outputPath)), { code: "ENOENT" });

behavior = (child) => {
  queueMicrotask(() => {
    child.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" }));
    child.emit("close", -2);
  });
};
await assert.rejects(
  captureSnapshot(executable, connection, configuration, new AbortController().signal),
  /Reinstall/,
);
await assert.rejects(stat(dirname(launches.at(-1).args[2])), { code: "ENOENT" });

behavior = (child) => queueMicrotask(() => child.emit("close", 1));
await assert.rejects(
  captureSnapshot(executable, connection, configuration, new AbortController().signal),
  (error) => {
    assert.match(error.message, /exit code 1/);
    assert.ok(!error.message.includes(connection));
    return true;
  },
);
await assert.rejects(stat(dirname(launches.at(-1).args[2])), { code: "ENOENT" });

behavior = async (child, output) => {
  await writeFile(output, "{}");
  child.emit("close", 0);
};
await assert.rejects(
  captureSnapshot(executable, connection, configuration, new AbortController().signal),
  /Invalid snapshot/,
);

const cancelled = new AbortController();
behavior = (child, _output, { signal }) => {
  signal.addEventListener(
    "abort",
    () => {
      child.emit("error", Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    },
    { once: true },
  );
  queueMicrotask(() => cancelled.abort());
};
await assert.rejects(captureSnapshot(executable, connection, configuration, cancelled.signal), {
  name: "AbortError",
});
assert.equal(launches.at(-1).options.signal, cancelled.signal);
await assert.rejects(stat(dirname(launches.at(-1).args[2])), { code: "ENOENT" });

console.log(
  "VS Code capture used the packaged CLI, validated output, and cleaned up after failure or cancellation",
);

const commands = new Map();
const executed = [];
const errors = [];
const renames = [];
const subscription = { dispose() {} };
const exportFile = uri("/space folder/export.pgviz.json");
const workspaceFolder = uri("/space folder");
const workspaceState = new Map();
const key = "postgresViz.connectionString:" + workspaceFolder.toString();
const secrets = new Map([[key, connection]]);
let output = file;
let cancellation;
let cancelProgress;
let cancellationDisposed;

class TabInputCustom {
  uri = file;
  viewType = PRISM_EDITOR;
}
Object.assign(vscode, {
  TabInputCustom,
  ProgressLocation: { Notification: 15 },
  commands: {
    registerCommand(id, fn) {
      commands.set(id, fn);
      return subscription;
    },
    executeCommand: async (...args) => executed.push(args),
  },
});
Object.assign(vscode.window, {
  registerCustomEditorProvider: () => subscription,
  tabGroups: { activeTabGroup: { activeTab: { input: new TabInputCustom() } } },
  showSaveDialog: async () => output,
  showErrorMessage: async (message) => errors.push(message),
  showInformationMessage: async () => {},
  async withProgress(_options, task) {
    cancellation = { isCancellationRequested: false };
    cancellation.onCancellationRequested = (listener) => {
      cancelProgress = () => {
        cancellation.isCancellationRequested = true;
        listener();
      };
      return {
        dispose: () => {
          cancellationDisposed = true;
        },
      };
    };
    cancellationDisposed = false;
    return task({}, cancellation);
  },
});
Object.assign(vscode.workspace, {
  workspaceFolders: [{ uri: workspaceFolder }],
  getConfiguration: (_section, scope) => {
    assert.equal(scope, file);
    return {
      get: (name) =>
        ({ schemas: ["configured"], excludeSchemas: [], includeForeignKeys: false })[name],
    };
  },
});
Object.assign(vscode.workspace.fs, {
  async writeFile(target, bytes) {
    files.set(target.path, new TextDecoder().decode(bytes));
  },
  async rename(from, to, options) {
    renames.push({ from, to, options });
    files.set(to.path, files.get(from.path));
    files.delete(from.path);
  },
  async delete(target) {
    files.delete(target.path);
  },
});

const { activate } = await loadEditorModule("editors/vscode/extension.ts", {
  vscode,
  "node:child_process": childProcess,
});
activate({
  extensionUri: uri("/extension with spaces"),
  asAbsolutePath: (relative) => "/extension with spaces/" + relative,
  subscriptions: [],
  workspaceState: {
    get: (id) => workspaceState.get(id),
    update: async (id, value) => workspaceState.set(id, value),
  },
  secrets: {
    get: async (id) => secrets.get(id),
    store: async (id, value) => secrets.set(id, value),
  },
});

behavior = async (child, destination) => {
  await writeFile(destination, JSON.stringify(snapshot));
  child.emit("close", 0);
};
await commands.get("postgresViz.load")();
assert.deepEqual(errors, []);
const name = process.platform === "win32" ? "postgres-viz.exe" : "postgres-viz";
assert.equal(launches.at(-1).executable, "/extension with spaces/dist/" + name);
assert.equal(launches.at(-1).options.env.DATABASE_URL, connection);
assert.deepEqual(launches.at(-1).args.slice(3), ["--schema", "configured", "--no-fks"]);
assert.deepEqual(executed, [["vscode.openWith", file, PRISM_EDITOR]]);
assert.equal(renames.length, 1);
assert.equal(posix.dirname(renames[0].from.path), workspaceFolder.path);
assert.deepEqual(renames[0].options, { overwrite: true });
assert.equal(cancellationDisposed, true);
assert.deepEqual(JSON.parse(files.get(file.path)), snapshot);

behavior = (child, _destination, { signal }) => {
  signal.addEventListener("abort", () => child.emit("close", null, "SIGTERM"), { once: true });
  queueMicrotask(cancelProgress);
};
await commands.get("postgresViz.refreshGraph")();
assert.equal(launches.at(-1).options.signal.aborted, true);
assert.equal(cancellationDisposed, true);
assert.deepEqual(errors, []);
assert.equal(renames.length, 1);

behavior = (child) => queueMicrotask(() => child.emit("close", 1));
await commands.get("postgresViz.refreshGraph")();
assert.match(errors[0], /exit code 1/);
assert.equal(renames.length, 1);
assert.deepEqual(JSON.parse(files.get(file.path)), snapshot);

output = exportFile;
await commands.get("postgresViz.exportGraphJson")();
assert.equal(renames.length, 2);
assert.deepEqual(JSON.parse(files.get(exportFile.path)), snapshot);

console.log(
  "VS Code capture commands mapped secret storage and settings, committed snapshots atomically, and preserved exports after failure",
);
