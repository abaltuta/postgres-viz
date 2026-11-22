import * as vscode from "vscode";
import { readSnapshot, type Snapshot } from "../../viewer/snapshot";
import { openEvidence } from "./source";

export const PRISM_EDITOR = "postgresViz.prism";

export class PrismEditor implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly assets: vscode.Uri) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose() {} };
  }

  async resolveCustomEditor(
    { uri }: vscode.CustomDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [this.assets] };
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(uri, ".."), "*"),
    );
    let ready = false;
    let disposed = false;
    let revision = 0;
    let snapshot: Snapshot | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async (): Promise<void> => {
      const requestedRevision = ++revision;
      let next: Snapshot;
      try {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        next = readSnapshot(JSON.parse(text));
      } catch (error) {
        if (!disposed && requestedRevision === revision) {
          snapshot = undefined;
          await webview.postMessage({ type: "error", message: String(error) });
        }
        return;
      }
      if (disposed || requestedRevision !== revision) return;
      snapshot = next;
      await webview.postMessage({ type: "snapshot", snapshot, preserveSelection: true });
    };
    const scheduleRefresh = (changed: vscode.Uri): void => {
      if (!ready || changed.toString() !== uri.toString()) return;
      revision++;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 100);
    };
    const subscriptions = [
      watcher,
      watcher.onDidChange(scheduleRefresh),
      watcher.onDidCreate(scheduleRefresh),
      watcher.onDidDelete(scheduleRefresh),
      webview.onDidReceiveMessage(async (message: unknown) => {
        if (disposed || !message || typeof message !== "object") return;
        if ("type" in message && message.type === "ready") {
          ready = true;
          clearTimeout(timer);
          await refresh();
        } else if (
          "type" in message &&
          message.type === "openEvidence" &&
          "evidenceId" in message &&
          typeof message.evidenceId === "string" &&
          snapshot
        ) {
          try {
            await openEvidence(snapshot, message.evidenceId);
          } catch (error) {
            void vscode.window.showErrorMessage(`Postgres Viz: ${String(error)}`);
          }
        }
      }),
    ];
    panel.onDidDispose(() => {
      disposed = true;
      clearTimeout(timer);
      for (const item of subscriptions) item.dispose();
    });

    const asset = (name: string) =>
      String(webview.asWebviewUri(vscode.Uri.joinPath(this.assets, name)));
    try {
      const html = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.assets, "index.html")),
      );
      if (disposed) return;
      const csp = `default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline';`;
      webview.html = html
        .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)
        .replace('"./main.js"', `"${asset("main.js")}"`)
        .replace('"./style.css"', `"${asset("style.css")}"`);
    } catch (error) {
      if (!disposed)
        void vscode.window.showErrorMessage(`Postgres Viz could not load Prism: ${String(error)}`);
    }
  }
}
