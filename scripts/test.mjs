import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const tests = (await readdir("test")).filter(
  (name) => name.endsWith(".ts") && name !== "integration.ts",
);
const entries = [
  ...tests.map((name) => "dist-test/" + name.replace(/\.ts$/, ".js")),
  "test/cli.mjs",
  "test/editor-integrations.mjs",
  "test/editors-vscode.mjs",
];
for (const entry of entries) {
  const result = spawnSync(process.execPath, [entry], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
