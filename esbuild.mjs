import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const smoke = process.argv.includes("--smoke");

/** Extension host bundle (Node). pg-query-emscripten (embedded WASM blob) is bundled
 *  in so the .vsix needs no node_modules; pg-native is an optional dep of pg. */
const extension = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode", "pg-native"],
  sourcemap: true,
  logLevel: "info",
};

/** Out-of-process parser worker — killable when a sync WASM parse hangs. */
const worker = {
  entryPoints: ["src/parser-worker.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "dist/parser-worker.js",
  external: ["pg-native"],
  sourcemap: true,
  logLevel: "info",
};

const workerTest = { ...worker, outfile: "dist-test/parser-worker.js" };

/** Webview bundle (browser) — cytoscape + app code. */
const webview = {
  entryPoints: ["webview/main.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2020",
  outfile: "media/webview.js",
  sourcemap: true,
  logLevel: "info",
};

const smokeTest = {
  entryPoints: [
    "test/smoke.ts",
    "test/db.ts",
    "test/database-discovery.ts",
    "test/ddl.ts",
    "test/export-data.ts",
    "test/connection-profiles.ts",
    "test/cache-policy.ts",
    "test/preference-store.ts",
    "test/load-service.ts",
    "test/protocol.ts",
    "test/parser-worker-ipc.ts",
    "test/parser-pool.ts",
    "test/parser-lifecycle.ts",
    "test/integration.ts",
    "test/graph-diff.ts",
    "test/graph-index.ts",
    "test/graph-reports.ts",
    "test/tree-model.ts",
    "test/tree-provider.ts",
    "test/webview.ts",
    "test/usage-views.ts",
    "test/connection-list.ts",
    "test/column-usage.ts",
    "test/keyboard-navigator.ts",
    "test/webview-controller.ts",
    "test/router.ts",
    "test/hcl.ts",
    "test/sql-migrations.ts",
    "test/match.ts",
    "test/lenses.ts",
    "test/lens-providers.ts",
    "test/ddl-symbols.ts",
    "test/ddl-symbol-provider.ts",
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outdir: "dist-test",
  external: ["pg-native", "vscode"],
  sourcemap: true,
  logLevel: "info",
};

if (smoke) {
  await Promise.all([esbuild.build(smokeTest), esbuild.build(workerTest)]);
} else if (watch) {
  const c1 = await esbuild.context(extension);
  const c2 = await esbuild.context(webview);
  const c3 = await esbuild.context(worker);
  await Promise.all([c1.watch(), c2.watch(), c3.watch()]);
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview), esbuild.build(worker)]);
}
