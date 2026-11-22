import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSnapshot, type Snapshot } from "../../viewer/snapshot";

interface CaptureConfiguration {
  schemas: readonly string[];
  excludeSchemas: readonly string[];
  includeFks: boolean;
}

export async function captureSnapshot(
  executable: string,
  connection: string,
  config: CaptureConfiguration,
  signal: AbortSignal,
): Promise<Snapshot> {
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "postgres-viz-"));
  try {
    const output = join(directory, "capture.pgviz.json");
    const args = ["scan", "--out", output];
    for (const schema of config.schemas) args.push("--schema", schema);
    for (const schema of config.excludeSchemas) args.push("--exclude-schema", schema);
    if (!config.includeFks) args.push("--no-fks");
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, {
        env: { ...process.env, DATABASE_URL: connection },
        signal,
        stdio: "ignore",
        windowsHide: true,
      });
      let failedToStart = false;
      child.on("error", () => {
        failedToStart = true;
      });
      // Abort sends SIGTERM. Wait for the process to close before removing its output directory.
      child.once("close", (code, exitSignal) => {
        if (signal.aborted) reject(signal.reason);
        else if (failedToStart) {
          reject(
            new Error(
              "Could not start the packaged CLI. Reinstall Postgres Viz for this platform.",
            ),
          );
        } else if (code !== 0) {
          reject(
            new Error(
              `Database capture failed (${code === null ? exitSignal : `exit code ${code}`}). Check the connection and capture settings.`,
            ),
          );
        } else resolve();
      });
    });
    const data = await readFile(output, { encoding: "utf8", signal });
    signal.throwIfAborted();
    return readSnapshot(JSON.parse(data));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
