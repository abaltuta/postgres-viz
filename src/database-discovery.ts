import { execFile } from "node:child_process";
import { connect as connectSocket } from "node:net";
import { Client, type QueryResult } from "pg";

export const DEFAULT_DISCOVERY_PORTS = [
  5432, 5433, 5434, 5435, 5436, 5437, 5438, 5439, 5440, 6432, 6543, 54339,
] as const;

export interface PostgresEndpoint {
  host: string;
  port: number;
}

export interface DiscoveryClient {
  connect(): Promise<unknown>;
  query(queryText: string): Promise<QueryResult<{ datname: string }>>;
  end(): Promise<void>;
}

export type DiscoveryClientFactory = (
  connectionString: string,
  timeoutMs: number,
) => DiscoveryClient;

export type DiscoveryCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<string | undefined>;

export type PostgresEndpointProbe = (
  endpoint: PostgresEndpoint,
  timeoutMs: number,
) => Promise<boolean>;

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = values.length;
  let next = 0;
  const workerCount = Math.min(values.length, Math.max(1, Math.floor(concurrency) || 1));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await mapper(values[index]!, index);
      }
    }),
  );
  return results;
}

export function normalizeDiscoveryPorts(values: readonly unknown[], limit = 64): number[] {
  const ports = values
    .filter((value): value is number => Number.isInteger(value) && Number(value) > 0)
    .map(Number)
    .filter((value) => value <= 65_535);
  return [...new Set(ports)].slice(0, Math.max(0, limit));
}

export function parseListeningTcpPorts(output: string): number[] {
  const ports = output.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || (!trimmed.startsWith("n") && !/\bLISTEN(?:ING)?\b/i.test(trimmed))) return [];
    for (const token of trimmed.split(/\s+/)) {
      const match = /(?:[:.])(\d+)$/.exec(token);
      if (!match) continue;
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return [port];
    }
    return [];
  });
  return [...new Set(ports)];
}

export async function localListeningTcpPorts(
  platform = process.platform,
  runner: DiscoveryCommandRunner = (command, args) =>
    new Promise((resolve) => {
      execFile(
        command,
        [...args],
        { maxBuffer: 1_048_576, timeout: 1_000, windowsHide: true },
        (error, stdout) => resolve(error ? undefined : stdout),
      );
    }),
): Promise<number[]> {
  const commands: readonly [string, readonly string[]][] =
    platform === "win32"
      ? [["netstat", ["-ano", "-p", "tcp"]]]
      : platform === "darwin"
        ? [
            ["lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"]],
            ["netstat", ["-anv", "-p", "tcp"]],
          ]
        : [
            ["ss", ["-ltnH"]],
            ["netstat", ["-ltn"]],
          ];
  for (const [command, args] of commands) {
    const output = await runner(command, args);
    if (!output) continue;
    const ports = parseListeningTcpPorts(output);
    if (ports.length > 0) return ports;
  }
  return [];
}

export async function discoverLocalPostgres(
  ports: readonly number[],
  hosts: readonly string[] = ["127.0.0.1", "::1"],
  timeoutMs = 350,
  concurrency = 32,
  probe: PostgresEndpointProbe = (endpoint, timeout) =>
    new Promise<boolean>((resolve) => {
      const socket = connectSocket({ host: endpoint.host, port: endpoint.port });
      let settled = false;
      const finish = (found: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(found);
      };
      const timer = setTimeout(() => finish(false), timeout);
      socket.once("connect", () => {
        const request = Buffer.alloc(8);
        request.writeInt32BE(8, 0);
        request.writeInt32BE(80_877_103, 4);
        socket.write(request);
      });
      socket.once("data", (data) => finish(data[0] === 0x53 || data[0] === 0x4e));
      socket.once("error", () => finish(false));
      socket.once("end", () => finish(false));
    }),
): Promise<PostgresEndpoint[]> {
  const candidates = hosts.flatMap((host) => ports.map((port) => ({ host, port })));
  const results = await mapWithConcurrency(candidates, concurrency, async (endpoint) => ({
    endpoint,
    found: await probe(endpoint, timeoutMs),
  }));
  const found = results.filter((result) => result.found).map((result) => result.endpoint);
  const seenPorts = new Set<number>();
  return found.filter((endpoint) => {
    if (seenPorts.has(endpoint.port)) return false;
    seenPorts.add(endpoint.port);
    return true;
  });
}

export function parsePostgresConnectionString(connectionString: string): URL | undefined {
  try {
    const url = new URL(connectionString);
    return url.protocol === "postgres:" || url.protocol === "postgresql:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function connectionEndpoint(connectionString: string): PostgresEndpoint | undefined {
  const url = parsePostgresConnectionString(connectionString);
  if (!url) return undefined;
  const port = url.port ? Number(url.port) : 5432;
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return { host: url.hostname, port };
}

export function isLocalPostgresHost(host: string): boolean {
  return ["localhost", "127.0.0.1", "::1"].includes(host.toLowerCase().replace(/^\[|\]$/g, ""));
}

export function connectionStringForDatabase(
  connectionString: string,
  database: string,
): string | undefined {
  const url = parsePostgresConnectionString(connectionString);
  if (!url) return undefined;
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

export function databaseFromConnectionString(connectionString: string): string | undefined {
  const url = parsePostgresConnectionString(connectionString);
  if (!url) return undefined;
  try {
    const database = decodeURIComponent(url.pathname.slice(1));
    return database || "postgres";
  } catch {
    return undefined;
  }
}

export function localConnectionString(
  endpoint: PostgresEndpoint,
  username: string,
  database = "postgres",
): string {
  const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
  const url = new URL(`postgresql://${host}:${endpoint.port}`);
  url.username = username;
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

export async function listConnectableDatabases(
  connectionString: string,
  timeoutMs = 1_500,
  clientFactory: DiscoveryClientFactory = (conn, timeout) =>
    new Client({
      connectionString: conn,
      application_name: "postgres-viz-discovery",
      connectionTimeoutMillis: timeout,
      query_timeout: timeout,
      statement_timeout: timeout,
    }) as DiscoveryClient,
): Promise<string[]> {
  const client = clientFactory(connectionString, timeoutMs);
  try {
    await client.connect();
    const result = await client.query(
      "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate AND has_database_privilege(datname, 'CONNECT') ORDER BY datname",
    );
    return [
      ...new Set(
        result.rows.flatMap((row) =>
          typeof row.datname === "string" && row.datname ? [row.datname] : [],
        ),
      ),
    ];
  } finally {
    await client.end().catch(() => undefined);
  }
}
