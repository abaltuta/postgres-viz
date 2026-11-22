import * as vscode from "vscode";
import type { Snapshot } from "../../viewer/snapshot";

function uniqueOffset(text: string, definition: string): number {
  const offset = text.indexOf(definition);
  return offset >= 0 && text.lastIndexOf(definition) === offset ? offset : -1;
}

async function verifiedSource(
  definition: string,
): Promise<{ document: vscode.TextDocument; offset: number } | undefined> {
  const config = vscode.workspace.getConfiguration("postgresViz");
  const builtInExclusions = ["**/node_modules/**", "**/.git/**"];
  const files = (pattern: string, key: string) =>
    vscode.workspace.findFiles(
      pattern,
      `{${[...builtInExclusions, ...(config.get<string[]>(key) ?? [])].join(",")}}`,
    );
  let candidates: vscode.Uri[];
  try {
    const [sql, hcl] = await Promise.all([
      files("**/up.sql", "sqlMigrationExcludeGlobs"),
      files("**/*.hcl", "hclExcludeGlobs"),
    ]);
    candidates = [...sql, ...hcl];
  } catch {
    return undefined;
  }
  const decoder = new TextDecoder();
  let match: vscode.Uri | undefined;
  for (const uri of candidates) {
    try {
      const open = vscode.workspace.textDocuments.find(
        (doc) => doc.uri.toString() === uri.toString(),
      );
      const text = open?.getText() ?? decoder.decode(await vscode.workspace.fs.readFile(uri));
      if (!text.includes(definition)) continue;
      if (match || uniqueOffset(text, definition) < 0) return undefined;
      match = uri;
    } catch {
      // A migration may have moved while searching.
    }
  }
  if (!match) return undefined;
  try {
    const document = await vscode.workspace.openTextDocument(match);
    const offset = uniqueOffset(document.getText(), definition);
    return offset >= 0 ? { document, offset } : undefined;
  } catch {
    return undefined;
  }
}

export async function openEvidence(snapshot: Snapshot, evidenceId: string): Promise<void> {
  const evidence = snapshot.evidence.find((item) => item.id === evidenceId);
  if (!evidence) return;
  const sql = snapshot.definitions.find(
    (definition) => definition.ownerId === evidence.ownerId,
  )?.sql;
  if (sql === undefined) return;
  const source = sql ? await verifiedSource(sql) : undefined;
  const document =
    source?.document ??
    (await vscode.workspace.openTextDocument({
      language: "sql",
      content: sql,
    }));
  const snippet = evidence.snippet || sql;
  const start = evidence.start ?? uniqueOffset(sql, snippet);
  const end = evidence.end ?? start + snippet.length;
  const offset = source?.offset ?? 0;
  const selection =
    start >= 0
      ? new vscode.Range(document.positionAt(offset + start), document.positionAt(offset + end))
      : undefined;
  await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: true,
    selection,
  });
}
