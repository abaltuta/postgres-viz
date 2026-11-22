import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const name = process.platform === "win32" ? "postgres-viz.exe" : "postgres-viz";
const bin = fileURLToPath(new URL("../dist/" + name, import.meta.url));
const cwd = await mkdtemp(join(tmpdir(), "Prism CLI test "));
const executable = join(cwd, name);
await copyFile(process.argv[2] ?? bin, executable);
const env = { ...process.env, DATABASE_URL: "", PATH: "" };
const runWithEnv = (env, ...args) =>
  spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout: 3_000 });
const run = (...args) => runWithEnv(env, ...args);
let server;
try {
  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /postgres-viz scan/);
  assert.match(help.stdout, /postgres-viz demo/);
  const commandHelp = run("refs", "--depth", "1", "-h");
  assert.equal(commandHelp.status, 0, commandHelp.stderr);
  assert.equal(commandHelp.stdout, help.stdout);
  for (const arg of ["--unknown", "--help"]) {
    const positional = run("demo", "--", arg);
    assert.equal(positional.status, 1);
    assert.match(positional.stderr, /demo takes no positional arguments/);
  }
  const file = join(cwd, "my catalog.pgviz.json");
  await writeFile(file, "existing snapshot");
  const failed = run("scan", "--out", file);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /DATABASE_URL/);
  const malformedURI = "postgresql://private-user:private-password@[";
  for (const args of [
    [malformedURI, "--out", file],
    ["--out", file, malformedURI],
  ]) {
    const invalid = run("scan", ...args);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /cannot connect to PostgreSQL/);
    assert.doesNotMatch(invalid.stderr, /private-user|private-password/);
  }
  const missingOutput = run("scan", malformedURI);
  assert.equal(missingOutput.status, 1);
  assert.match(missingOutput.stderr, /scan requires --out FILE/);
  const envConnection = runWithEnv({ ...env, DATABASE_URL: malformedURI }, "scan", "--out", file);
  assert.equal(envConnection.status, 1);
  assert.match(envConnection.stderr, /cannot connect to PostgreSQL/);
  const explicitConnection = runWithEnv(
    { ...env, DATABASE_URL: "not-a-uri" },
    "scan",
    "--out",
    file,
    malformedURI,
  );
  assert.equal(explicitConnection.status, 1);
  assert.match(explicitConnection.stderr, /cannot connect to PostgreSQL/);
  assert.equal(await readFile(file, "utf8"), "existing snapshot");
  const invalidSnapshot = run("open", file, "--no-browser");
  assert.equal(invalidSnapshot.status, 1, invalidSnapshot.stderr);
  assert.match(invalidSnapshot.stderr, /invalid snapshot JSON/);
  assert.equal(invalidSnapshot.stdout, "");
  const sql = "SELECT total FROM billing.invoices";
  await writeFile(
    file,
    JSON.stringify({
      format: "postgres-viz",
      version: 1,
      capturedAt: "2026-01-01T00:00:00Z",
      database: "demo",
      schemas: { include: null, exclude: [] },
      objects: [
        { id: "t", schema: "billing", name: "invoices", kind: "table" },
        { id: "v", schema: "billing", name: "totals", kind: "view" },
      ],
      columns: [{ id: "c", name: "total", position: 1, type: "numeric", objectId: "t" }],
      relationships: [
        { id: "r", source: "v", target: "c", kind: "selects", provenance: "catalog" },
      ],
      definitions: [{ ownerId: "v", sql }],
      evidence: [
        { id: "e", relationshipId: "r", ownerId: "v", provenance: "catalog", snippet: "" },
      ],
      diagnostics: { warnings: [], unresolved: [] },
    }),
  );
  await copyFile(file, join(cwd, "--help"));
  const references = run("refs", "--file", "--help", "--column", "billing.invoices.total");
  assert.equal(references.status, 0, references.stderr);
  assert.ok(
    references.stdout.includes(sql),
    "catalog evidence should display its captured definition",
  );
  const simple = join(cwd, "simple.pgviz.json");
  await copyFile(new URL("../examples/simple/simple.pgviz.json", import.meta.url), simple);
  const refArgs = ["refs", "--file", simple, "--column", "ledger.invoices.total", "--json"];
  for (const depth of [undefined, "1", "2"]) {
    const result = run(...refArgs, ...(depth ? ["--depth", depth] : []));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const refs = JSON.parse(result.stdout);
    assert.equal(refs.database, "simple");
    assert.equal(refs.column.name, "total");
    assert.deepEqual(
      refs.paths.map((path) => path.map((hop) => hop.sourceName)),
      [
        ["ledger.invoice_total(bigint)"],
        ...(depth === "1" ? [] : [["ledger.invoice_total(bigint)", "ledger.invoice_summary"]]),
      ],
    );
  }
  for (const depth of ["0", "3", "1.5"]) {
    const result = run(...refArgs, "--depth", depth);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /--depth must be 1 or 2/);
    assert.equal(result.stdout, "");
  }
  await copyFile(file, join(cwd, "-"));
  const viewers = [
    [["open", file, "--no-browser"], "demo", file],
    [["demo", "--no-browser=true"], "commerce"],
    [["open", "-", "--no-browser"], "demo", file],
  ];
  if (process.platform !== "win32") {
    viewers.push([["open", file], "demo", file, true]);
    viewers.push([["open", file, "--no-browser=false"], "demo", file, true]);
  }
  for (const [args, database, snapshot, opensBrowser] of viewers) {
    server = spawn(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    let stderr = "";
    server.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const launcherFailed = opensBrowser
      ? once(server.stderr, "data", { signal: AbortSignal.timeout(3_000) }).catch(() => [])
      : null;
    const closed = once(server, "close");
    const lines = createInterface({ input: server.stdout });
    const [url] = await Promise.race([
      once(lines, "line"),
      closed.then(([code]) => {
        throw Error("viewer exited early: " + code + "\n" + stderr);
      }),
    ]);
    assert.equal(new URL(url).hostname, "127.0.0.1");
    assert.equal(new URL(url).searchParams.get("source"), "cli");
    assert.match(await (await fetch(url)).text(), /<html/i);
    const response = await fetch(new URL("/snapshot.json", url));
    assert.equal(response.status, 200);
    const payload = await response.text();
    assert.equal(JSON.parse(payload).database, database);
    if (snapshot) assert.equal(payload, await readFile(snapshot, "utf8"));
    for (const asset of ["main.js", "style.css"])
      assert.equal((await fetch(new URL(asset, url))).status, 200);
    assert.equal((await fetch(new URL("/package.json", url))).status, 404);
    await launcherFailed;
    server.kill("SIGINT");
    const [code, signal] = await closed;
    server = null;
    if (process.platform !== "win32") {
      assert.equal(signal, null);
      assert.equal(code, 0, stderr);
    }
    assert.equal(stderr, opensBrowser ? "Open the printed URL in your browser.\n" : "");
  }
  console.log("CLI arguments, failed refresh, references, offline viewer, and shutdown passed");
} finally {
  server?.kill("SIGTERM");
  await rm(cwd, { recursive: true, force: true });
}
