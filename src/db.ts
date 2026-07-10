import { Client } from "pg";

export interface PgClientLike {
  connect(): Promise<unknown>;
  end(): Promise<void>;
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

type Settled<T> = { ok: true; value: T } | { ok: false; reason: unknown };

async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (reason) {
    return { ok: false, reason };
  }
}

export async function withClient<T>(
  conn: string,
  fn: (client: Client) => Promise<T>,
  cancellation?: CancellationLike,
): Promise<T> {
  // hard timeouts: a wrong host or a blocked catalog query should fail with a
  // real error instead of spinning on "introspecting catalogs…" forever
  const client = new Client({
    connectionString: conn,
    application_name: "postgres-viz",
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    query_timeout: 90_000,
  });
  return withConnectedClient(client, fn, cancellation);
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
