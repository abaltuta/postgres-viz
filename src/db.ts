import { Client, type QueryResult, type QueryResultRow } from "pg";

export interface PgClientLike {
  connect(): Promise<unknown>;
  end(): Promise<void>;
}

export type DatabaseClient = PgClientLike & QueryClient;

export interface QueryClient {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export class LeasedQueryClientPool implements QueryClient {
  private readonly available: QueryClient[];
  private readonly queue: {
    queryText: string;
    values?: unknown[];
    resolve: (value: QueryResult<QueryResultRow>) => void;
    reject: (reason: unknown) => void;
  }[] = [];

  constructor(clients: QueryClient[]) {
    this.available = [...clients];
  }

  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<R>> {
    return new Promise<QueryResult<R>>((resolve, reject) => {
      this.queue.push({
        queryText,
        values,
        resolve: resolve as unknown as (value: QueryResult<QueryResultRow>) => void,
        reject,
      });
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.available.length > 0 && this.queue.length > 0) {
      const client = this.available.pop()!;
      const job = this.queue.shift()!;
      void client
        .query(job.queryText, job.values)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.available.push(client);
          this.dispatch();
        });
    }
  }
}

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested?(listener: () => void): { dispose(): unknown };
}

export class ClientCancelledError extends Error {
  constructor() {
    super("database operation cancelled");
    this.name = "ClientCancelledError";
  }
}

export class ClientPoolUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super("database client pool is unavailable");
    this.name = "ClientPoolUnavailableError";
  }
}

export type Settled<T> = { ok: true; value: T } | { ok: false; reason: unknown };

export async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (reason) {
    return { ok: false, reason };
  }
}

function createClient(conn: string): Client {
  return new Client({
    connectionString: conn,
    application_name: "postgres-viz",
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    query_timeout: 90_000,
  });
}

export async function withClient<T>(
  conn: string,
  fn: (client: Client) => Promise<T>,
  cancellation?: CancellationLike,
): Promise<T> {
  // hard timeouts: a wrong host or a blocked catalog query should fail with a
  // real error instead of spinning on "introspecting catalogs…" forever
  const client = createClient(conn);
  return withConnectedClient(client, fn, cancellation);
}

export async function withConsistentSnapshot<T>(
  clients: QueryClient[],
  fn: (client: QueryClient) => Promise<T>,
): Promise<T> {
  if (clients.length === 0) throw new Error("snapshot client list must not be empty");
  const begun: QueryClient[] = [];
  const rollback = async (): Promise<Settled<void>[]> =>
    Promise.all(begun.map((client) => settle(async () => void (await client.query("ROLLBACK")))));
  try {
    const leader = clients[0]!;
    await leader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    begun.push(leader);
    const snapshot = String(
      (await leader.query("SELECT pg_export_snapshot() AS snapshot")).rows[0]?.snapshot ?? "",
    );
    if (!snapshot) throw new Error("pg_export_snapshot() returned no snapshot id");
    for (const follower of clients.slice(1)) {
      await follower.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      begun.push(follower);
      await follower.query(`SET TRANSACTION SNAPSHOT '${snapshot.replaceAll("'", "''")}'`);
    }
  } catch (error) {
    await rollback();
    throw new ClientPoolUnavailableError(error);
  }
  const result = await settle(() => fn(new LeasedQueryClientPool(clients)));
  const cleanup = await rollback();
  if (!result.ok) throw result.reason;
  const cleanupFailure = cleanup.find((item) => !item.ok);
  if (cleanupFailure && !cleanupFailure.ok) throw cleanupFailure.reason;
  return result.value;
}

export async function withClientPool<T>(
  conn: string,
  fn: (client: QueryClient) => Promise<T>,
  cancellation?: CancellationLike,
  clientFactory: () => DatabaseClient = () => createClient(conn),
): Promise<T> {
  const clients = Array.from({ length: 3 }, clientFactory);
  try {
    return await withConnectedClientPool(
      clients,
      (connected) => withConsistentSnapshot(connected, fn),
      cancellation,
    );
  } catch (error) {
    if (cancellation?.isCancellationRequested || error instanceof ClientCancelledError) throw error;
    if (!(error instanceof ClientPoolUnavailableError)) throw error;
    return withConnectedClient(
      clientFactory(),
      (client) => withConsistentSnapshot([client], fn),
      cancellation,
    );
  }
}

export async function withConnectedClientPool<T, C extends PgClientLike>(
  clients: C[],
  fn: (clients: C[]) => Promise<T>,
  cancellation?: CancellationLike,
): Promise<T> {
  if (clients.length === 0) throw new Error("client pool must not be empty");
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let closeResult: Promise<Settled<void>> | undefined;
  const closeClients = async (): Promise<void> => {
    const results = await Promise.all(clients.map((client) => settle(() => client.end())));
    const failed = results.find((result) => !result.ok);
    if (failed && !failed.ok) throw failed.reason;
  };
  const cancellationDisposable = cancellation?.onCancellationRequested?.(() => {
    closeResult ??= settle(closeClients);
  });
  try {
    if (cancellation?.isCancellationRequested) throw new ClientCancelledError();
    await Promise.race([
      Promise.all(clients.map((client) => client.connect())),
      new Promise<never>((_, reject) => {
        connectTimer = setTimeout(() => reject(new Error("connect timed out after 15s")), 15_000);
      }),
    ]);
  } catch (error) {
    await (closeResult ??= settle(closeClients));
    cancellationDisposable?.dispose();
    throw cancellation?.isCancellationRequested
      ? new ClientCancelledError()
      : new ClientPoolUnavailableError(error);
  } finally {
    clearTimeout(connectTimer);
  }
  const result = await settle(() => fn(clients));
  const closed = await (closeResult ??= settle(closeClients));
  cancellationDisposable?.dispose();
  if (cancellation?.isCancellationRequested) throw new ClientCancelledError();
  if (!result.ok) throw result.reason;
  if (!closed.ok) throw closed.reason;
  return result.value;
}

export async function withConnectedClient<T, C extends PgClientLike>(
  client: C,
  fn: (client: C) => Promise<T>,
  cancellation?: CancellationLike,
): Promise<T> {
  // belt and braces on top of connectionTimeoutMillis — never hang on connect
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let closeResult: Promise<Settled<void>> | undefined;
  const cancellationDisposable = cancellation?.onCancellationRequested?.(() => {
    closeResult ??= settle(() => client.end());
  });
  try {
    if (cancellation?.isCancellationRequested) throw new ClientCancelledError();
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) => {
        connectTimer = setTimeout(() => reject(new Error("connect timed out after 15s")), 15_000);
      }),
    ]);
  } catch (err) {
    await (closeResult ??= settle(() => client.end()));
    cancellationDisposable?.dispose();
    throw cancellation?.isCancellationRequested ? new ClientCancelledError() : err;
  } finally {
    clearTimeout(connectTimer);
  }
  const result = await settle(() => fn(client));
  const closed = await (closeResult ??= settle(() => client.end()));
  cancellationDisposable?.dispose();
  if (cancellation?.isCancellationRequested) throw new ClientCancelledError();
  if (!result.ok) throw result.reason;
  if (!closed.ok) throw closed.reason;
  return result.value;
}
