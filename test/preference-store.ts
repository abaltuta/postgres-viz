import assert from "node:assert/strict";
import { SerializedMementoWriter } from "../src/preference-store";

class DeferredMemento {
  readonly started: { key: string; value: unknown }[] = [];
  readonly pending: { resolve: () => void; reject: (error: Error) => void }[] = [];

  update(key: string, value: unknown): Promise<void> {
    this.started.push({ key, value });
    return new Promise<void>((resolve, reject) => this.pending.push({ resolve, reject }));
  }
}

async function main(): Promise<void> {
  const memento = new DeferredMemento();
  const errors: unknown[] = [];
  const writer = new SerializedMementoWriter(memento, (error) => errors.push(error));

  writer.update("prefs", { edgeMode: "off" });
  writer.update("prefs", { edgeMode: "cards" });
  await Promise.resolve();
  assert.deepEqual(
    memento.started.map((entry) => entry.value),
    [{ edgeMode: "off" }],
    "only the first persistence write starts immediately",
  );
  memento.pending[0]!.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    memento.started.map((entry) => entry.value),
    [{ edgeMode: "off" }, { edgeMode: "cards" }],
    "later preference writes preserve invocation order",
  );

  memento.pending[1]!.reject(new Error("disk unavailable"));
  writer.update("prefs", { edgeMode: "all" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1, "write failures are reported");
  assert.deepEqual(memento.started.at(-1)?.value, { edgeMode: "all" });
  memento.pending.at(-1)!.resolve();
  await writer.flush();

  console.log("preference-store OK - ordered writes, recovery, and flush");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
