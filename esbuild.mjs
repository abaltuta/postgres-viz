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
  entryPoints: ["test/smoke.ts", "test/integration.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outdir: "dist-test",
  external: ["pg-native"],
  sourcemap: true,
  logLevel: "info",
};

if (smoke) {
  await esbuild.build(smokeTest);
} else if (watch) {
  const c1 = await esbuild.context(extension);
  const c2 = await esbuild.context(webview);
  await Promise.all([c1.watch(), c2.watch()]);
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}
