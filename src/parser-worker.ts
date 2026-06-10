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

const ready = factory();

process.on("message", (req: WorkerReq) => {
  void (async () => {
    try {
      const instance = await ready;
      const raw =
        req.op === "parseQuery" ? instance.parse(req.sql) : instance.parsePlpgsql(req.sql);
      const r = raw as { error?: { message?: string } | null; parse_tree?: unknown };
      if (r?.error) throw new Error(String(r.error.message ?? "parse error"));
      process.send!({ id: req.id, ok: true, result: req.op === "parseQuery" ? r.parse_tree : r });
    } catch (e) {
      process.send!({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
});

// die with the parent — when the IPC channel closes there is nothing left to do
process.on("disconnect", () => process.exit(0));
