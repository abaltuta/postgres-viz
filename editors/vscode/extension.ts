import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { captureSnapshot } from "./capture";
import {
  ConnectionProfileStore,
  defaultProfileName,
  type ConnectionProfile,
} from "./connection-profiles";
import type { Snapshot } from "../../viewer/snapshot";
import { PRISM_EDITOR, PrismEditor } from "./prism-editor";

export function activate(context: vscode.ExtensionContext): void {
  const workspaceId = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "no-folder";
  const profiles = new ConnectionProfileStore(
    context.workspaceState,
    context.secrets,
    workspaceId,
    `postgresViz.connectionString:${workspaceId}`,
  );
  let latest: Snapshot | undefined;
  let activeCapture: AbortController | undefined;
  const executable = context.asAbsolutePath(
    process.platform === "win32" ? "dist/postgres-viz.exe" : "dist/postgres-viz",
  );

  async function saveProfile(): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
      title: "Postgres Viz: Add connection",
      prompt: "PostgreSQL connection URL",
      placeHolder: "postgresql://user:password@localhost:5432/database",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        URL.canParse(value.trim()) && /^postgres(ql)?:\/\//i.test(value.trim())
          ? undefined
          : "Enter a postgres:// or postgresql:// connection URL.",
    });
    if (!input?.trim()) return;
    const connection = input.trim();
    const name = await vscode.window.showInputBox({
      title: "Postgres Viz: Name connection",
      value: defaultProfileName(connection),
      ignoreFocusOut: true,
    });
    if (!name?.trim()) return;
    await profiles.save(name.trim(), connection);
    return connection;
  }

  async function manageConnections(): Promise<void> {
    await profiles.migrateLegacy();
    const addOption = { label: "Add connection", profile: undefined };
    const activeId = profiles.activeProfile()?.id;
    const connections = profiles.list().map((profile) => ({
      label: profile.name,
      description: profile.id === activeId ? "Active" : undefined,
      profile,
    }));
    const selected = await vscode.window.showQuickPick<
      vscode.QuickPickItem & { profile?: ConnectionProfile }
    >([addOption, ...connections], { title: "Postgres Viz: Connections" });
    if (!selected) return;
    if (!selected.profile) {
      await saveProfile();
      return;
    }
    const action = await vscode.window.showQuickPick(["Use connection", "Forget connection"], {
      title: selected.profile.name,
    });
    if (action === "Use connection") await profiles.setActive(selected.profile.id);
    if (action === "Forget connection") await profiles.delete(selected.profile.id);
  }

  async function capture(destination?: vscode.Uri): Promise<void> {
    if (activeCapture) {
      void vscode.window.showInformationMessage(
        "Postgres Viz: A database capture is already running.",
      );
      return;
    }
    const controller = new AbortController();
    activeCapture = controller;
    try {
      await profiles.migrateLegacy();
      const conn =
        (await profiles.activeConnection())?.conn ??
        process.env.DATABASE_URL ??
        (await saveProfile());
      if (!conn) return;
      const output = destination ?? (await chooseOutput());
      if (!output) return;
      const config = vscode.workspace.getConfiguration("postgresViz", output);
      const snapshot = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Postgres Viz: Capturing PostgreSQL",
          cancellable: true,
        },
        async (_progress, cancellation) => {
          const listener = cancellation.onCancellationRequested(() => controller.abort());
          if (cancellation.isCancellationRequested) controller.abort();
          try {
            const captured = await captureSnapshot(
              executable,
              conn,
              {
                schemas: config.get<string[]>("schemas") ?? [],
                excludeSchemas: config.get<string[]>("excludeSchemas") ?? [],
                includeFks: config.get<boolean>("includeForeignKeys") ?? true,
              },
              controller.signal,
            );
            await writeSnapshot(output, captured, controller.signal);
            return captured;
          } finally {
            listener.dispose();
          }
        },
      );
      latest = snapshot;
      if (!destination)
        await vscode.commands.executeCommand("vscode.openWith", output, PRISM_EDITOR);
    } catch (error) {
      if (controller.signal.aborted) return;
      throw error;
    } finally {
      activeCapture = undefined;
    }
  }

  async function exportSnapshot(): Promise<void> {
    const snapshot = latest;
    if (!snapshot) {
      void vscode.window.showInformationMessage("Postgres Viz: Capture a database snapshot first.");
      return;
    }
    const output = await chooseOutput();
    if (output) await writeSnapshot(output, snapshot);
  }

  const register = (id: string, run: () => Promise<void>) =>
    vscode.commands.registerCommand(id, async () => {
      try {
        await run();
      } catch (error) {
        void vscode.window.showErrorMessage(`Postgres Viz: ${String(error)}`);
      }
    });
  context.subscriptions.push(
    { dispose: () => activeCapture?.abort() },
    vscode.window.registerCustomEditorProvider(
      PRISM_EDITOR,
      new PrismEditor(vscode.Uri.joinPath(context.extensionUri, "dist", "viewer")),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    register("postgresViz.load", () => capture()),
    register("postgresViz.refreshGraph", () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      const destination =
        input instanceof vscode.TabInputCustom && input.viewType === PRISM_EDITOR
          ? input.uri
          : undefined;
      return capture(destination);
    }),
    register("postgresViz.exportGraphJson", exportSnapshot),
    register("postgresViz.connectionMenu", manageConnections),
  );
}

async function chooseOutput(): Promise<vscode.Uri | undefined> {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  const defaultUri = workspace ? vscode.Uri.joinPath(workspace, "database.pgviz.json") : undefined;
  const output = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { "Postgres Viz Snapshot": ["json"] },
  });
  if (output && !output.path.endsWith(".pgviz.json")) {
    throw new Error("Choose a file name ending in .pgviz.json.");
  }
  return output;
}

async function writeSnapshot(
  uri: vscode.Uri,
  snapshot: Snapshot,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const temporary = vscode.Uri.joinPath(uri, "..", `.pgviz-${randomUUID()}.tmp`);
  try {
    await vscode.workspace.fs.writeFile(
      temporary,
      new TextEncoder().encode(JSON.stringify(snapshot) + "\n"),
    );
    signal?.throwIfAborted();
    await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
  } catch (error) {
    await vscode.workspace.fs.delete(temporary).then(undefined, () => undefined);
    throw error;
  }
}
