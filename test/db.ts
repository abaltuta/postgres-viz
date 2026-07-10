import assert from "node:assert/strict";
import type { QueryResult, QueryResultRow } from "pg";
import {
  ClientCancelledError,
  ClientPoolUnavailableError,
  LeasedQueryClientPool,
  withClientPool,
  withConsistentSnapshot,
  withConnectedClient,
  withConnectedClientPool,
  type PgClientLike,
  type DatabaseClient,
  type QueryClient,
} from "../src/db";
import { introspect } from "../src/introspect";

class FakeClient implements PgClientLike {
  calls: string[] = [];
  connectError?: Error;
  endError?: unknown;

  async connect(): Promise<void> {
    this.calls.push("connect");
    if (this.connectError) throw this.connectError;
  }

  async end(): Promise<void> {
    this.calls.push("end");
    if (this.endError) throw this.endError;
  }
}

class FakeQueryClient implements QueryClient {
  readonly requests: { sql: string; resolve: () => void }[] = [];
  active = 0;
  maxActive = 0;

  query<R extends QueryResultRow = QueryResultRow>(queryText: string): Promise<QueryResult<R>> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    return new Promise<QueryResult<R>>((resolve) => {
      this.requests.push({
        sql: queryText,
        resolve: () => {
          this.active--;
          resolve({ rows: [] } as unknown as QueryResult<R>);
        },
      });
    });
  }
}

class SnapshotClient implements QueryClient {
  readonly queries: string[] = [];

  async query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
  ): Promise<QueryResult<R>> {
    this.queries.push(queryText);
    const rows = queryText.includes("pg_export_snapshot") ? [{ snapshot: "0001-0002-1" }] : [];
    return { rows } as unknown as QueryResult<R>;
  }
}

class SnapshotDatabaseClient extends SnapshotClient implements DatabaseClient {
  connected = false;
  ended = false;
  connectError?: Error;

  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
    this.connected = true;
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

class FailingIntrospectionClient implements QueryClient {
  private relationDelayed = false;

  query<R extends QueryResultRow = QueryResultRow>(queryText: string): Promise<QueryResult<R>> {
    if (queryText.includes("SELECT p.oid AS oid")) {
      return Promise.reject(new Error("early function query failure"));
    }
    if (!this.relationDelayed && queryText.includes("FROM pg_class c")) {
      this.relationDelayed = true;
      return new Promise<QueryResult<R>>((resolve) => {
        setTimeout(() => resolve({ rows: [] } as unknown as QueryResult<R>), 20);
      });
    }
    return Promise.resolve({ rows: [] } as unknown as QueryResult<R>);
  }
}

async function main(): Promise<void> {
  const rejectionReason = async (promise: Promise<unknown>): Promise<unknown> => {
    let rejected = false;
    let reason: unknown;
    try {
      await promise;
    } catch (err) {
      rejected = true;
      reason = err;
    }
    assert.equal(rejected, true, "expected operation to reject");
    return reason;
  };

  {
    const client = new FakeClient();
    const value = await withConnectedClient(client, async () => 42);
    assert.equal(value, 42);
    assert.deepEqual(client.calls, ["connect", "end"], "successful use closes the client");
  }

  {
    const clients = [new FakeClient(), new FakeClient(), new FakeClient()];
    const value = await withConnectedClientPool(clients, async (connected) => connected.length);
    assert.equal(value, 3);
    assert.ok(
      clients.every((client) => client.calls.join(",") === "connect,end"),
      "pooled clients are all connected and closed",
    );
  }

  {
    const clients = [new SnapshotClient(), new SnapshotClient(), new SnapshotClient()];
    const value = await withConsistentSnapshot(clients, async () => 42);
    assert.equal(value, 42);
    assert.ok(clients.every((client) => client.queries.at(-1) === "ROLLBACK"));
    assert.match(clients[1]!.queries[1]!, /SET TRANSACTION SNAPSHOT '0001-0002-1'/);
    assert.match(clients[2]!.queries[1]!, /SET TRANSACTION SNAPSHOT '0001-0002-1'/);
  }

  {
    const clients = Array.from({ length: 4 }, () => new SnapshotDatabaseClient());
    clients[1]!.connectError = new Error("connection limit reached");
    let next = 0;
    const value = await withClientPool(
      "unused",
      async (client) => {
        await client.query("SELECT application_work()");
        return 42;
      },
      undefined,
      () => clients[next++]!,
    );
    assert.equal(value, 42, "pool connection failure falls back to one client");
    assert.ok(
      clients.every((client) => client.ended),
      "failed pool and fallback clients close",
    );
    assert.ok(
      clients[3]!.queries.includes("SELECT application_work()"),
      "application work runs on the fallback client",
    );
  }

  {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await assert.rejects(
        introspect(new FailingIntrospectionClient(), { include: null, exclude: [] }),
        /early function query failure/,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(unhandled, [], "early catalog failure is handled immediately");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }

  {
    const clients = [new FakeQueryClient(), new FakeQueryClient()];
    const pool = new LeasedQueryClientPool(clients);
    const requests = [pool.query("one"), pool.query("two"), pool.query("three")];
    assert.equal(
      clients.reduce((total, client) => total + client.requests.length, 0),
      2,
      "catalog requests lease idle clients",
    );
    clients
      .find((client) => client.requests.some((request) => request.sql === "one"))!
      .requests.find((request) => request.sql === "one")!
      .resolve();
    await requests[0];
    await Promise.resolve();
    assert.equal(
      clients.reduce((total, client) => total + client.requests.length, 0),
      3,
      "queued catalog request dispatches when a client becomes idle",
    );
    for (const client of clients) {
      for (const request of client.requests) {
        if (client.active > 0 && request.sql !== "one") request.resolve();
      }
      assert.equal(client.maxActive, 1, "one in-flight query per client");
    }
    await Promise.all(requests);
  }

  {
    const clients = [new FakeClient(), new FakeClient(), new FakeClient()];
    clients[1]!.connectError = new Error("pool connect failed");
    await assert.rejects(
      withConnectedClientPool(clients, async () => 42),
      (error) =>
        error instanceof ClientPoolUnavailableError && error.cause === clients[1]!.connectError,
    );
    assert.ok(
      clients.every((client) => client.calls.includes("end")),
      "partial pool is closed",
    );
  }

  {
    const client = new FakeClient();
    let cancelled = false;
    let cancelListener = (): void => undefined;
    let finish = (_value: number): void => undefined;
    const operation = withConnectedClient(
      client,
      async () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
      {
        get isCancellationRequested() {
          return cancelled;
        },
        onCancellationRequested(listener) {
          cancelListener = listener;
          return { dispose: () => undefined };
        },
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    cancelled = true;
    cancelListener();
    finish(42);
    await assert.rejects(
      operation,
      ClientCancelledError,
      "cancellation closes active database work",
    );
    assert.equal(
      client.calls.filter((call) => call === "end").length,
      1,
      "cancellation closes once",
    );
  }

  {
    const client = new FakeClient();
    client.endError = new Error("end failed");
    await assert.rejects(
      withConnectedClient(client, async () => 42),
      (err) => err === client.endError,
      "cleanup errors surface when the operation succeeded",
    );
  }

  {
    const client = new FakeClient();
    const operationError = new Error("query failed");
    client.endError = new Error("end failed");
    await assert.rejects(
      withConnectedClient(client, async () => {
        throw operationError;
      }),
      (err) => err === operationError,
      "cleanup errors must not hide the operation error",
    );
  }

  {
    const client = new FakeClient();
    client.connectError = new Error("connect failed");
    client.endError = new Error("end failed");
    await assert.rejects(
      withConnectedClient(client, async () => 42),
      (err) => err === client.connectError,
      "cleanup errors must not hide the connection error",
    );
    assert.deepEqual(client.calls, ["connect", "end"], "failed connect still attempts cleanup");
  }

  {
    const client = new FakeClient();
    const reason = await rejectionReason(
      withConnectedClient(client, async () => {
        throw undefined;
      }),
    );
    assert.equal(reason, undefined, "undefined operation errors are still preserved");
    assert.deepEqual(client.calls, ["connect", "end"], "undefined operation errors still clean up");
  }

  {
    const client = new FakeClient();
    client.endError = undefined;
    client.end = async (): Promise<void> => {
      client.calls.push("end");
      throw undefined;
    };
    const reason = await rejectionReason(withConnectedClient(client, async () => 42));
    assert.equal(reason, undefined, "undefined cleanup errors still reject after success");
  }

  console.log("db OK - client lifecycle cleanup, cancellation, and rejection reasons");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
