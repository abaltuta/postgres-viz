import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

let nextId = 1;

function spawnWorker(): ChildProcess {
  return fork(path.join(__dirname, "parser-worker.js"), {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

function request(worker: ChildProcess, payload: Record<string, unknown>): Promise<WorkerResponse> {
  const id = nextId++;
  const message = { id, ...payload };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off("message", onMessage);
      reject(new Error(`parser worker timed out for request ${id}`));
    }, 10_000);
    const onMessage = (raw: unknown): void => {
      const res = raw as Partial<WorkerResponse>;
      if (res.id !== id) return;
      clearTimeout(timer);
      worker.off("message", onMessage);
      resolve(res as WorkerResponse);
    };
    worker.on("message", onMessage);
    worker.send(message, (error) => {
      if (!error) return;
      clearTimeout(timer);
      worker.off("message", onMessage);
      reject(error);
    });
  });
}

function sendRaw(worker: ChildProcess, message: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function expectNoMessage(worker: ChildProcess, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off("message", onMessage);
      resolve();
    }, 250);
    const onMessage = (raw: unknown): void => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      reject(new Error(`${label}: expected no worker response, got ${JSON.stringify(raw)}`));
    };
    worker.on("message", onMessage);
  });
}

async function main(): Promise<void> {
  const worker = spawnWorker();
  try {
    const parsed = await request(worker, { op: "parseQuery", sql: "SELECT 1" });
    assert.equal(parsed.ok, true, "valid SQL parses");
    assert.notEqual(parsed.result, undefined, "parseQuery returns a parse tree payload");

    const plpgsql = await request(worker, {
      op: "parsePlPgSQL",
      sql: "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;",
    });
    assert.equal(plpgsql.ok, true, "valid PL/pgSQL parses");
    assert.ok(
      Array.isArray((plpgsql.result as { plpgsql_funcs?: unknown[] }).plpgsql_funcs),
      "parsePlPgSQL returns a PL/pgSQL function payload",
    );

    const badOp = await request(worker, { op: "parseExplode", sql: "SELECT 1" });
    assert.equal(badOp.ok, false, "unsupported op is rejected");
    assert.match(badOp.error ?? "", /unsupported parser op/);

    const badSqlType = await request(worker, { op: "parseQuery", sql: 42 });
    assert.equal(badSqlType.ok, false, "malformed sql field is rejected");
    assert.match(badSqlType.error ?? "", /invalid parser request sql/);

    const syntax = await request(worker, { op: "parseQuery", sql: "SELECT FROM" });
    assert.equal(syntax.ok, false, "parser errors are returned");
    assert.ok(syntax.error, "parser error has a message");

    await sendRaw(worker, { op: "parseQuery", sql: "SELECT 1" });
    await expectNoMessage(worker, "missing request id");

    await sendRaw(worker, { id: "not-a-number", op: "parseQuery", sql: "SELECT 1" });
    await expectNoMessage(worker, "malformed request id");

    const afterMalformed = await request(worker, { op: "parseQuery", sql: "SELECT 2" });
    assert.equal(afterMalformed.ok, true, "worker survives uncorrelatable malformed messages");
  } finally {
    worker.disconnect();
  }

  console.log("parser-worker OK - IPC validation and parse responses");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
