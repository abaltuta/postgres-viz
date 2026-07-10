import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { WorkerParser, WorkerParserPool, type ParserWorker } from "../src/analyze";

type Json = Awaited<ReturnType<ParserWorker["parseQuery"]>>;

class FakeWorker implements ParserWorker {
  readonly requests: { sql: string; resolve: (value: Json) => void }[] = [];
  active = 0;
  maxActive = 0;
  killed = false;

  parseQuery(sql: string): Promise<Json> {
    return this.request(sql);
  }

  parsePlPgSQL(sql: string): Promise<Json> {
    return this.request(sql);
  }

  kill(): void {
    this.killed = true;
  }

  resolve(sql: string): void {
    const request = this.requests.find((candidate) => candidate.sql === sql);
    assert.ok(request, `request ${sql} was dispatched`);
    request.resolve({ sql });
  }

  private request(sql: string): Promise<Json> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    return new Promise<Json>((resolve) => {
      this.requests.push({
        sql,
        resolve: (value) => {
          this.active--;
          resolve(value);
        },
      });
    });
  }
}

class FakeChild extends EventEmitter {
  readonly channel = { ref: () => undefined, unref: () => undefined };
  readonly sent: { id: number; op: string; sql: string }[] = [];
  killed = false;

  send(message: { id: number; op: string; sql: string }): boolean {
    this.sent.push(message);
    return true;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  unref(): this {
    return this;
  }
}

async function main(): Promise<void> {
  const workers: FakeWorker[] = [];
  const pool = new WorkerParserPool(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, 2);

  const first = pool.parseQuery("first");
  const second = pool.parseQuery("second");
  const third = pool.parsePlPgSQL("third");
  assert.equal(
    workers.reduce((count, worker) => count + worker.requests.length, 0),
    2,
    "only one request is dispatched to each worker",
  );
  assert.ok(
    workers.every((worker) => worker.maxActive === 1),
    "workers never overlap requests",
  );

  const firstWorker = workers.find((worker) => worker.requests.some((r) => r.sql === "first"));
  assert.ok(firstWorker);
  firstWorker.resolve("first");
  await first;
  await Promise.resolve();
  assert.equal(
    workers.reduce((count, worker) => count + worker.requests.length, 0),
    3,
    "queued work dispatches as soon as a worker becomes idle",
  );

  for (const worker of workers) {
    for (const request of worker.requests) {
      if (worker.active > 0 && request.sql !== "first") worker.resolve(request.sql);
    }
  }
  await Promise.all([second, third]);
  assert.ok(workers.every((worker) => worker.maxActive === 1));

  const queuedPool = new WorkerParserPool(() => new FakeWorker(), 1);
  void queuedPool.parseQuery("running").catch(() => undefined);
  const queued = queuedPool.parseQuery("queued");
  queuedPool.kill();
  await assert.rejects(queued, /disposed/, "disposing rejects work that never dispatched");

  const oldChild = new FakeChild();
  const replacementChild = new FakeChild();
  const children = [oldChild, replacementChild];
  const parser = new WorkerParser(
    "fake-worker",
    () => children.shift() as unknown as ChildProcess,
    1,
    1_000,
  );
  const firstRequestPromise = parser.parseQuery("first");
  const firstRequest = oldChild.sent[0]!;
  oldChild.emit("message", { id: firstRequest.id, ok: true, result: { first: true } });
  await firstRequestPromise;

  const replacementRequestPromise = parser.parseQuery("replacement");
  assert.equal(oldChild.killed, true, "request limit recycles the old child");
  const replacementRequest = replacementChild.sent[0]!;
  oldChild.emit("exit", 0, null);
  replacementChild.emit("message", {
    id: replacementRequest.id,
    ok: true,
    result: { replacement: true },
  });
  assert.deepEqual(
    await replacementRequestPromise,
    { replacement: true },
    "an old child exit cannot reject a replacement child's request",
  );
  parser.kill();

  const failedChild = new FakeChild();
  const failingParser = new WorkerParser(
    "failing-worker",
    () => failedChild as unknown as ChildProcess,
    500,
    10_000,
  );
  const failedRequest = failingParser.parseQuery("fails immediately");
  failedChild.emit("error", new Error("spawn channel failed"));
  await assert.rejects(
    failedRequest,
    /spawn channel failed/,
    "child errors reject their request without waiting for the parse timeout",
  );

  console.log("parser-pool OK - leasing, disposal, generations, and immediate child failures");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
