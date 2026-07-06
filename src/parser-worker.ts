/**
 * Out-of-process SQL parser. The pg-query-emscripten parse calls are
 * synchronous WASM and have been observed to lock up permanently on real-world
 * databases; running them here lets the extension host enforce a hard timeout
 * and SIGKILL + respawn this process when that happens.
 */
import factory from "pg-query-emscripten";

interface WorkerReq {
  id: number;
  op: "parseQuery" | "parsePlPgSQL";
  sql: string;
}

interface WorkerRes {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

type ParserInstance = Awaited<ReturnType<typeof factory>>;
type ReadyState = { ok: true; instance: ParserInstance } | { ok: false; error: unknown };

const ready: Promise<ReadyState> = factory().then(
  (instance) => ({ ok: true, instance }),
  (error: unknown) => ({ ok: false, error }),
);

async function parserInstance(): Promise<ParserInstance> {
  const state = await ready;
  if (!state.ok) throw state.error;
  return state.instance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseReq(value: unknown): WorkerReq {
  if (!isRecord(value)) throw new Error("invalid parser request");
  if (typeof value.id !== "number" || !Number.isSafeInteger(value.id)) {
    throw new Error("invalid parser request id");
  }
  if (value.op !== "parseQuery" && value.op !== "parsePlPgSQL") {
    throw new Error(`unsupported parser op: ${String(value.op)}`);
  }
  if (typeof value.sql !== "string") throw new Error("invalid parser request sql");
  return { id: value.id, op: value.op, sql: value.sql };
}

function parseResult(req: WorkerReq, raw: unknown): unknown {
  if (isRecord(raw) && raw.error != null) {
    const { error } = raw;
    const message =
      isRecord(error) && typeof error.message === "string" ? error.message : "parse error";
    throw new Error(message);
  }
  if (!isRecord(raw)) throw new Error("parser returned a non-object result");

  if (req.op === "parseQuery") {
    if (!("parse_tree" in raw)) throw new Error("parser returned no parse_tree");
    return raw.parse_tree;
  }

  if (!Array.isArray(raw.plpgsql_funcs)) throw new Error("parser returned no plpgsql_funcs");
  return raw;
}

function send(res: WorkerRes): void {
  const sendToParent = process.send;
  if (typeof sendToParent !== "function" || !process.connected) {
    process.exit(0);
    return;
  }
  try {
    sendToParent.call(process, res, (error: Error | null) => {
      if (error) process.exit(0);
    });
  } catch {
    process.exit(0);
  }
}

process.on("message", (message: unknown) => {
  const id =
    isRecord(message) && typeof message.id === "number" && Number.isSafeInteger(message.id)
      ? message.id
      : undefined;
  void (async () => {
    try {
      const req = parseReq(message);
      const instance = await parserInstance();
      const raw =
        req.op === "parseQuery" ? instance.parse(req.sql) : instance.parsePlpgsql(req.sql);
      send({ id: req.id, ok: true, result: parseResult(req, raw) });
    } catch (e) {
      if (id !== undefined) {
        send({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  })();
});

// die with the parent — when the IPC channel closes there is nothing left to do
process.on("disconnect", () => process.exit(0));
