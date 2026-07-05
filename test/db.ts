import assert from "node:assert/strict";
import { withConnectedClient, type PgClientLike } from "../src/db";

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

  console.log("db OK - client lifecycle cleanup preserves all rejection reasons");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
