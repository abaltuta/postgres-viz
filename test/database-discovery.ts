import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  connectionEndpoint,
  connectionStringForDatabase,
  databaseFromConnectionString,
  discoverLocalPostgres,
  isLocalPostgresHost,
  listConnectableDatabases,
  localListeningTcpPorts,
  localConnectionString,
  mapWithConcurrency,
  normalizeDiscoveryPorts,
  parseListeningTcpPorts,
  parsePostgresConnectionString,
  type DiscoveryClient,
} from "../src/database-discovery";

async function main(): Promise<void> {
  assert.deepEqual(
    normalizeDiscoveryPorts([5432, 5432, 0, -1, 65_536, 6432, "5433"]),
    [5432, 6432],
  );
  assert.deepEqual(
    parseListeningTcpPorts(
      "LISTEN 0 128 127.0.0.1:5544 0.0.0.0:*\nTCP 0.0.0.0:6432 0.0.0.0:0 LISTENING\nn*:6543",
    ),
    [5544, 6432, 6543],
  );
  const commands: string[] = [];
  assert.deepEqual(
    await localListeningTcpPorts("linux", async (command) => {
      commands.push(command);
      return command === "netstat" ? "tcp 0 0 127.0.0.1:7432 0.0.0.0:* LISTEN" : undefined;
    }),
    [7432],
  );
  assert.deepEqual(commands, ["ss", "netstat"], "listener lookup falls back when ss is absent");
  assert.equal(parsePostgresConnectionString("https://localhost/app"), undefined);
  assert.equal(parsePostgresConnectionString("postgresql:///app")?.pathname, "/app");
  assert.deepEqual(connectionEndpoint("postgresql://user@db.local/app"), {
    host: "db.local",
    port: 5432,
  });
  assert.deepEqual(connectionEndpoint("postgres://user@[::1]:6432/app"), {
    host: "[::1]",
    port: 6432,
  });
  assert.equal(connectionEndpoint("https://db.local/app"), undefined);
  assert.equal(isLocalPostgresHost("localhost"), true);
  assert.equal(isLocalPostgresHost("[::1]"), true);
  assert.equal(isLocalPostgresHost("db.example.com"), false);
  assert.equal(databaseFromConnectionString("postgres://db.local/app%20db"), "app db");
  assert.equal(databaseFromConnectionString("postgresql://db.local"), "postgres");
  assert.equal(
    connectionStringForDatabase(
      "postgres://user:secret@localhost:5432/old?sslmode=require",
      "new db",
    ),
    "postgres://user:secret@localhost:5432/new%20db?sslmode=require",
  );
  assert.equal(
    localConnectionString({ host: "::1", port: 5433 }, "local user"),
    "postgresql://local%20user@[::1]:5433/postgres",
  );

  const postgresServer = createServer((socket) => {
    socket.once("data", () => socket.end("N"));
  });
  await new Promise<void>((resolve) => postgresServer.listen(0, "127.0.0.1", resolve));
  const address = postgresServer.address();
  assert.ok(address && typeof address !== "string");
  try {
    assert.deepEqual(await discoverLocalPostgres([address.port], ["127.0.0.1"], 500), [
      { host: "127.0.0.1", port: address.port },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      postgresServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  assert.deepEqual(await discoverLocalPostgres([address.port], ["127.0.0.1"], 100), []);

  let activeProbes = 0;
  let maxActiveProbes = 0;
  await discoverLocalPostgres(
    Array.from({ length: 80 }, (_, index) => 10_000 + index),
    ["127.0.0.1"],
    100,
    7,
    async () => {
      activeProbes++;
      maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeProbes--;
      return false;
    },
  );
  assert.equal(maxActiveProbes, 7, "port probing respects its concurrency bound");
  assert.deepEqual(
    await mapWithConcurrency([4, 3, 2, 1], 2, async (value) => value * 2),
    [8, 6, 4, 2],
    "bounded mapping preserves input order",
  );
  assert.deepEqual(
    await mapWithConcurrency([undefined, 2], 2, async (value) => value ?? "missing"),
    ["missing", 2],
    "bounded mapping does not treat an undefined value as the end of input",
  );

  const calls: string[] = [];
  const databases = await listConnectableDatabases(
    "postgres://local/test",
    123,
    (connectionString, timeoutMs): DiscoveryClient => ({
      async connect() {
        calls.push(`connect:${connectionString}:${timeoutMs}`);
      },
      async query(queryText) {
        calls.push(queryText);
        return { rows: [{ datname: "app" }, { datname: "app" }, { datname: "postgres" }] } as never;
      },
      async end() {
        calls.push("end");
      },
    }),
  );
  assert.deepEqual(databases, ["app", "postgres"]);
  assert.match(calls[1]!, /FROM pg_database/);
  assert.equal(calls.at(-1), "end");

  let endedAfterFailure = false;
  await assert.rejects(
    listConnectableDatabases("postgres://local/failure", 123, () => ({
      async connect() {},
      async query() {
        throw new Error("enumeration failed");
      },
      async end() {
        endedAfterFailure = true;
      },
    })),
    /enumeration failed/,
  );
  assert.equal(endedAfterFailure, true, "failed enumeration closes its client");

  console.log("database-discovery OK - port probing, URLs, and database enumeration");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
