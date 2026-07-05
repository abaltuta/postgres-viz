import { Client } from "pg";

export interface PgClientLike {
  connect(): Promise<unknown>;
  end(): Promise<void>;
}

type Settled<T> = { ok: true; value: T } | { ok: false; reason: unknown };

async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (reason) {
    return { ok: false, reason };
  }
}

export async function withClient<T>(conn: string, fn: (client: Client) => Promise<T>): Promise<T> {
  // hard timeouts: a wrong host or a blocked catalog query should fail with a
  // real error instead of spinning on "introspecting catalogs…" forever
  const client = new Client({
    connectionString: conn,
    application_name: "postgres-viz",
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    query_timeout: 90_000,
  });
  return withConnectedClient(client, fn);
}

export async function withConnectedClient<T, C extends PgClientLike>(
  client: C,
  fn: (client: C) => Promise<T>,
): Promise<T> {
  // belt and braces on top of connectionTimeoutMillis — never hang on connect
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) => {
        connectTimer = setTimeout(() => reject(new Error("connect timed out after 15s")), 15_000);
      }),
    ]);
  } catch (err) {
    await settle(() => client.end());
    throw err;
  } finally {
    clearTimeout(connectTimer);
  }
  const result = await settle(() => fn(client));
  const closed = await settle(() => client.end());
  if (!result.ok) throw result.reason;
  if (!closed.ok) throw closed.reason;
  return result.value;
}
