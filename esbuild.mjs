import { build } from "esbuild";
import { cp, mkdir, readdir } from "node:fs/promises";

const nodeBundle = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
};
await mkdir("dist/viewer", { recursive: true });
await Promise.all([
  build({
    ...nodeBundle,
    entryPoints: ["editors/vscode/extension.ts"],
    outdir: "editors/vscode/dist",
  }),
  build({
    bundle: true,
    platform: "browser",
    target: "es2022",
    entryPoints: ["viewer/main.ts"],
    outfile: "dist/viewer/main.js",
  }),
  ...["index.html", "style.css"].map((name) => cp("viewer/" + name, "dist/viewer/" + name)),
]);
await cp("dist/viewer", "editors/vscode/dist/viewer", { recursive: true });
if (process.argv.includes("--smoke")) {
  const tests = (await readdir("test")).filter((name) => name.endsWith(".ts"));
  await build({
    ...nodeBundle,
    entryPoints: tests.map((name) => "test/" + name),
    outdir: "dist-test",
  });
}
