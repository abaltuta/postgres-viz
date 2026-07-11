import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Log } from "./introspect";
import type { Catalog, CatalogCol, CatalogFunc, CatalogRel } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface FuncRefs {
  /** relOid → attnums (0 = whole-table) */
  reads: Map<number, Set<number>>;
  inserts: Map<number, Set<number>>;
  updates: Map<number, Set<number>>;
  deletes: Map<number, Set<number>>;
  /** writes not attributable to one operation (MERGE, fallback) */
  writes: Map<number, Set<number>>;
  /** trigger NEW.col := … row mutations — not DML issued BY the function */
  modifies: Map<number, Set<number>>;
  calls: Set<number>;
  occurrences: ColumnOccurrence[];
  diagnostics: AnalysisDiagnostic[];
  /** relation fallbacks retained when a column reference cannot be resolved safely */
  unresolved: Map<AnalysisKind, Set<number>>;
  /** true when the real Postgres parser was used; false = regex fallback */
  parsed: boolean;
}

export type AnalysisKind = "reads" | "inserts" | "updates" | "deletes" | "writes" | "modifies";

export interface ColumnOccurrence {
  relOid: number;
  attnum: number;
  kind: AnalysisKind;
  /** UTF-16 offsets inside the full owning definition, when mapping is exact. */
  start?: number;
  end?: number;
  snippet: string;
}

export interface AnalysisDiagnostic {
  reason: "ambiguous" | "missing";
  identifier: string;
  snippet: string;
  candidates: BaseRef[];
}

type WriteOp = Exclude<AnalysisKind, "modifies">;

export interface PgParser {
  /** returns a raw-parse tree `{version, stmts: [...]}` or throws */
  parseQuery(sql: string): Promise<Json>;
  /** returns `{plpgsql_funcs: [...]}` or throws */
  parsePlPgSQL(sql: string): Promise<Json>;
}

let cachedParser: PgParser | null | undefined;

/** A parse stuck in synchronous WASM can only be recovered by killing the worker. */
const PARSE_TIMEOUT_MS = 5_000;
const WORKER_RECYCLE_AFTER = 500;

interface WorkerRes {
  id: number;
  ok: boolean;
  result?: Json;
  error?: string;
}

/**
 * Out-of-process parser backed by parser-worker.js. Hung parse calls time out,
 * the worker is SIGKILLed and respawned, and the affected function falls back
 * to regex extraction — a poisoned input can never freeze the host again.
 */
export interface ParserWorker extends PgParser {
  kill(): void;
}

export class WorkerParser implements ParserWorker {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { child: ChildProcess; resolve: (v: Json) => void; reject: (e: Error) => void }
  >();
  private requests = 0;

  constructor(
    private readonly workerPath: string,
    private readonly spawn: (workerPath: string) => ChildProcess = (workerPath) =>
      fork(workerPath, [], { silent: true }),
    private readonly recycleAfter = WORKER_RECYCLE_AFTER,
    private readonly timeoutMs = PARSE_TIMEOUT_MS,
  ) {}

  private ensure(): ChildProcess {
    if (this.child) return this.child;
    const child = this.spawn(this.workerPath);
    child.on("message", (res: WorkerRes) => {
      const p = this.pending.get(res.id);
      if (!p || p.child !== child) return;
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.result);
      else p.reject(new Error(res.error ?? "parse error"));
    });
    child.on("error", (error) => {
      if (this.child === child) this.child = null;
      child.kill("SIGKILL");
      this.rejectChild(child, error instanceof Error ? error : new Error(String(error)));
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      this.rejectChild(child, new Error("parser worker exited"));
    });
    // never keep the parent process alive: hold a ref only while a request is in flight
    child.unref();
    (child as Json).channel?.unref?.();
    this.child = child;
    this.requests = 0;
    return child;
  }

  /** drop the event-loop ref once no requests are pending */
  private idleUnref(): void {
    if (this.pending.size === 0) (this.child as Json)?.channel?.unref?.();
  }

  private rejectChild(child: ChildProcess, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.child !== child) continue;
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private request(op: "parseQuery" | "parsePlPgSQL", sql: string): Promise<Json> {
    if (this.requests >= this.recycleAfter) this.kill();
    const child = this.ensure();
    this.requests++;
    return new Promise<Json>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill();
        reject(new Error(`parse timed out: ${sql.slice(0, 60)}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        child,
        resolve: (v) => {
          clearTimeout(timer);
          this.idleUnref();
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          this.idleUnref();
          reject(e);
        },
      });
      try {
        child.send({ id, op, sql });
        (child as Json).channel?.ref?.();
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.kill();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  kill(): void {
    const child = this.child;
    this.child = null;
    child?.kill("SIGKILL");
  }

  parseQuery(sql: string): Promise<Json> {
    return this.request("parseQuery", sql);
  }

  parsePlPgSQL(sql: string): Promise<Json> {
    return this.request("parsePlPgSQL", sql);
  }
}

export class WorkerParserPool implements PgParser {
  private readonly workers: ParserWorker[];
  private readonly available: ParserWorker[];
  private readonly queue: {
    op: "parseQuery" | "parsePlPgSQL";
    sql: string;
    resolve: (value: Json) => void;
    reject: (error: Error) => void;
  }[] = [];
  private stopped = false;

  constructor(workerFactory: () => ParserWorker, size: number) {
    this.workers = Array.from({ length: size }, workerFactory);
    this.available = [...this.workers];
  }

  parseQuery(sql: string): Promise<Json> {
    return this.enqueue("parseQuery", sql);
  }

  parsePlPgSQL(sql: string): Promise<Json> {
    return this.enqueue("parsePlPgSQL", sql);
  }

  private enqueue(op: "parseQuery" | "parsePlPgSQL", sql: string): Promise<Json> {
    if (this.stopped) return Promise.reject(new Error("parser pool disposed"));
    return new Promise<Json>((resolve, reject) => {
      this.queue.push({ op, sql, resolve, reject });
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (!this.stopped && this.available.length > 0 && this.queue.length > 0) {
      const worker = this.available.pop()!;
      const job = this.queue.shift()!;
      const request =
        job.op === "parseQuery" ? worker.parseQuery(job.sql) : worker.parsePlPgSQL(job.sql);
      void request.then(job.resolve, job.reject).finally(() => {
        if (this.stopped) return;
        this.available.push(worker);
        this.dispatch();
      });
    }
  }

  kill(): void {
    this.stopped = true;
    for (const job of this.queue.splice(0)) job.reject(new Error("parser pool disposed"));
    for (const worker of this.workers) worker.kill();
  }
}

let workerParser: WorkerParserPool | null = null;
interface ParserInitialization {
  generation: number;
  parser: WorkerParserPool;
  promise: Promise<PgParser | null>;
}
let parserGeneration = 0;
let parserInitialization: ParserInitialization | null = null;

export function disposeParser(): void {
  parserGeneration++;
  parserInitialization?.parser.kill();
  parserInitialization = null;
  workerParser?.kill();
  workerParser = null;
  cachedParser = undefined;
}

/**
 * pg-query-emscripten runs only out of process. If the worker cannot start we
 * fall back to regex analysis rather than risking synchronous WASM in the host.
 */
export async function getParser(): Promise<PgParser | null> {
  if (cachedParser !== undefined) return cachedParser;
  if (parserInitialization) return parserInitialization.promise;
  const generation = parserGeneration;
  const parser = new WorkerParserPool(
    () => new WorkerParser(path.join(__dirname, "parser-worker.js")),
    2,
  );
  const initialization: ParserInitialization = {
    generation,
    parser,
    promise: initializeParser(parser, generation),
  };
  parserInitialization = initialization;
  try {
    return await initialization.promise;
  } finally {
    if (parserInitialization === initialization) parserInitialization = null;
  }
}

async function initializeParser(
  parser: WorkerParserPool,
  generation: number,
): Promise<PgParser | null> {
  // Prefer the out-of-process parser (killable on hang).
  try {
    const workerPath = path.join(__dirname, "parser-worker.js");
    if (existsSync(workerPath)) {
      await parser.parseQuery("SELECT 1"); // health check
      if (generation !== parserGeneration) {
        parser.kill();
        return null;
      }
      workerParser = parser;
      cachedParser = parser;
      return cachedParser;
    }
  } catch {
    // Fall through to the regex parser after closing a failed worker.
  }
  parser.kill();
  if (generation === parserGeneration) cachedParser = null;
  return null;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function preferredCandidate<T extends { schema: string }>(
  candidates: T[] | undefined,
  preferred: string,
): T | undefined {
  if (!candidates || candidates.length === 0) return undefined;
  return (
    candidates.find((item) => item.schema === preferred) ??
    candidates.find((item) => item.schema === "public") ??
    (candidates.length === 1 ? candidates[0] : undefined)
  );
}

export class Resolver {
  private relByQual = new Map<string, CatalogRel>();
  private relsByName = new Map<string, CatalogRel[]>();
  private colsByRel = new Map<number, Map<string, CatalogCol>>();
  private orderedColsByRel = new Map<number, CatalogCol[]>();
  private funcByQual = new Map<string, CatalogFunc>();
  private funcsByName = new Map<string, CatalogFunc[]>();

  constructor(catalog: Pick<Catalog, "rels" | "cols" | "funcs">) {
    for (const r of catalog.rels) {
      this.relByQual.set(`${r.schema}.${r.name}`, r);
      push(this.relsByName, r.name, r);
    }
    for (const c of catalog.cols) {
      let m = this.colsByRel.get(c.relOid);
      if (!m) this.colsByRel.set(c.relOid, (m = new Map()));
      m.set(c.name, c);
      const ordered = this.orderedColsByRel.get(c.relOid) ?? [];
      ordered.push(c);
      this.orderedColsByRel.set(c.relOid, ordered);
    }
    for (const f of catalog.funcs) {
      const qual = `${f.schema}.${f.name}`;
      if (!this.funcByQual.has(qual)) this.funcByQual.set(qual, f);
      push(this.funcsByName, f.name, f);
    }
  }

  resolveRel(name: string, schema: string | undefined, preferred: string): CatalogRel | undefined {
    if (schema) return this.relByQual.get(`${schema}.${name}`);
    return preferredCandidate(this.relsByName.get(name), preferred);
  }

  col(relOid: number, name: string): CatalogCol | undefined {
    return this.colsByRel.get(relOid)?.get(name);
  }

  columns(relOid: number): readonly CatalogCol[] {
    return this.orderedColsByRel.get(relOid) ?? [];
  }

  resolveFunc(
    name: string,
    schema: string | undefined,
    preferred: string,
  ): CatalogFunc | undefined {
    if (schema) return this.funcByQual.get(`${schema}.${name}`);
    return preferredCandidate(this.funcsByName.get(name), preferred);
  }
}

/**
 * Visit every object-valued entry of a parse tree; handlers match on the key.
 * libpg_query JSON wraps repeated-Node fields as `{ SelectStmt: {...} }` but
 * leaves singular typed fields (InsertStmt.relation, CallStmt.funccall, …)
 * UNWRAPPED — so visitors can't rely on tag names alone for those; see
 * isRangeVar() and the explicit CallStmt case in analyzeStmt().
 */
export function walk(node: Json, visit: (tag: string, value: Json) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (!value || typeof value !== "object") continue;
    visit(key, value);
    walk(value, visit);
  }
}

interface BodyCtx {
  resolver: Resolver;
  schema: string;
  selfOid: number;
  /** relations whose triggers execute this function (for NEW./OLD. attribution) */
  triggerRels: CatalogRel[];
  refs: FuncRefs;
  source?: {
    sql: string;
    definition?: string;
    definitionOffset?: number;
    locationDeltaBytes: number;
  };
}

function createRefs(): FuncRefs {
  return {
    reads: new Map(),
    inserts: new Map(),
    updates: new Map(),
    deletes: new Map(),
    writes: new Map(),
    modifies: new Map(),
    calls: new Set(),
    occurrences: [],
    diagnostics: [],
    unresolved: new Map(),
    parsed: false,
  };
}

function add(map: Map<number, Set<number>>, relOid: number, attnum: number): void {
  let s = map.get(relOid);
  if (!s) map.set(relOid, (s = new Set()));
  s.add(attnum);
}

/** Most typed RangeVar fields (InsertStmt.relation, …) arrive unwrapped, so duck-type. */
function isRangeVar(tag: string, v: Json): boolean {
  return tag === "RangeVar" || (typeof v?.relname === "string" && !Array.isArray(v));
}

function fieldName(f: Json): string | undefined {
  const s = f?.String;
  return typeof s?.sval === "string" ? s.sval : typeof s?.str === "string" ? s.str : undefined;
}

function isStar(f: Json): boolean {
  return !!f && typeof f === "object" && "A_Star" in f;
}

function nameList(list: Json): string[] {
  return ((list ?? []) as Json[]).map(fieldName).filter((s): s is string => !!s);
}

function addCall(funcname: Json, ctx: BodyCtx): void {
  const parts = nameList(funcname);
  if (parts.length === 0) return;
  const name = parts[parts.length - 1]!;
  const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
  const fn = ctx.resolver.resolveFunc(name, schema, ctx.schema);
  if (fn && fn.oid !== ctx.selfOid) ctx.refs.calls.add(fn.oid);
}

export function analyzeParsedQuery(parseTree: Json, ctx: BodyCtx): void {
  for (const s of parseTree?.stmts ?? []) {
    if (s?.stmt) analyzeStmt(s.stmt, ctx);
  }
}

function mergeOperation(commandType: unknown): WriteOp | undefined {
  switch (commandType) {
    case "CMD_INSERT":
      return "inserts";
    case "CMD_UPDATE":
      return "updates";
    case "CMD_DELETE":
      return "deletes";
    default:
      return undefined;
  }
}

/**
 * Two passes over each statement:
 *  1. a conservative whole-tree pass for table-level reads/writes, write columns
 *     and function calls (never misses a relation, may lack column precision);
 *  2. a scope-aware pass for column attribution that models FROM aliases, CTEs,
 *     derived tables (subquery aliases) and correlated subqueries, so a column
 *     reached through `WITH x AS (…) SELECT x.col` is traced to its base table.
 */
function analyzeStmt(stmt: Json, ctx: BodyCtx): void {
  const { resolver, schema, refs } = ctx;

  // CTE names shadow real relations of the same name (statement-global, conservative).
  const ctes = new Set<string>();
  walk(stmt, (tag, v) => {
    if (tag === "CommonTableExpr" && typeof v.ctename === "string") ctes.add(v.ctename);
  });

  const resolveRangeVar = (rv: Json): CatalogRel | undefined => {
    if (!rv || typeof rv.relname !== "string") return undefined;
    if (!rv.schemaname && ctes.has(rv.relname)) return undefined;
    return resolver.resolveRel(rv.relname, rv.schemaname, schema);
  };

  // Write targets, tracked by OBJECT IDENTITY (not name): the same relation can
  // appear as both a read and a write in one statement (UPDATE t … FROM t), and
  // only the specific RangeVar node sitting in `relation` is the write. The
  // statement tag tells us WHICH kind of write; MERGE stays generic (it can be
  // all three at once).
  const writeTargets = new Map<Json, WriteOp[]>();
  walk(stmt, (tag, v) => {
    switch (tag) {
      case "InsertStmt":
        if (v.relation) writeTargets.set(v.relation, ["inserts"]);
        break;
      case "UpdateStmt":
        if (v.relation) writeTargets.set(v.relation, ["updates"]);
        break;
      case "DeleteStmt":
        if (v.relation) writeTargets.set(v.relation, ["deletes"]);
        break;
      case "MergeStmt": {
        const operations = new Set<WriteOp>();
        for (const clause of v.mergeWhenClauses ?? []) {
          const op = mergeOperation(clause?.MergeWhenClause?.commandType);
          if (op) operations.add(op);
        }
        if (v.relation) writeTargets.set(v.relation, [...operations]);
        break;
      }
      case "RefreshMatViewStmt":
        if (v.relation) writeTargets.set(v.relation, ["writes"]);
        break;
      case "CopyStmt":
        if (v.relation && v.is_from) writeTargets.set(v.relation, ["inserts"]);
        break;
      case "TruncateStmt":
        for (const r of v.relations ?? []) {
          if (r?.RangeVar) writeTargets.set(r.RangeVar, ["deletes"]);
        }
        break;
    }
  });

  walk(stmt, (tag, v) => {
    if (isRangeVar(tag, v)) {
      const rel = resolveRangeVar(v);
      if (!rel) return;
      const operations = writeTargets.get(v);
      if (operations) for (const op of operations) add(refs[op], rel.oid, 0);
      else add(refs.reads, rel.oid, 0);
      return;
    }
    switch (tag) {
      case "FuncCall":
        addCall(v.funcname, ctx);
        return;
      case "CallStmt":
        if (v.funccall?.funcname) addCall(v.funccall.funcname, ctx);
        return;
      case "InsertStmt": {
        const rel = resolveRangeVar(v.relation);
        if (!rel) return;
        for (const c of v.cols ?? []) {
          const name: string | undefined = c?.ResTarget?.name;
          const col = name ? resolver.col(rel.oid, name) : undefined;
          if (col) {
            add(refs.inserts, rel.oid, col.attnum);
            recordTargetOccurrence(c.ResTarget, rel.oid, col.attnum, "inserts", ctx);
          }
        }
        for (const target of v.onConflictClause?.targetList ?? []) {
          const name: string | undefined = target?.ResTarget?.name;
          const col = name ? resolver.col(rel.oid, name) : undefined;
          if (col) {
            add(refs.updates, rel.oid, col.attnum);
            recordTargetOccurrence(target.ResTarget, rel.oid, col.attnum, "updates", ctx);
          }
        }
        return;
      }
      case "UpdateStmt": {
        const rel = resolveRangeVar(v.relation);
        if (!rel) return;
        for (const t of v.targetList ?? []) {
          const name: string | undefined = t?.ResTarget?.name;
          const col = name ? resolver.col(rel.oid, name) : undefined;
          if (col) {
            add(refs.updates, rel.oid, col.attnum);
            recordTargetOccurrence(t.ResTarget, rel.oid, col.attnum, "updates", ctx);
          }
        }
        return;
      }
      case "MergeStmt": {
        const rel = resolveRangeVar(v.relation);
        if (!rel) return;
        for (const clause of v.mergeWhenClauses ?? []) {
          const when = clause?.MergeWhenClause;
          const op = mergeOperation(when?.commandType);
          if (!op) continue;
          add(refs[op], rel.oid, 0);
          if (op === "deletes") continue;
          for (const target of when?.targetList ?? []) {
            const name: string | undefined = target?.ResTarget?.name;
            const col = name ? resolver.col(rel.oid, name) : undefined;
            if (col) {
              add(refs[op], rel.oid, col.attnum);
              recordTargetOccurrence(target.ResTarget, rel.oid, col.attnum, op, ctx);
            }
          }
        }
        return;
      }
    }
  });

  // Scope-aware column attribution.
  processStmtNode(stmt, new Scope(), ctx);
}

// ── Scoped column resolution ────────────────────────────────────────────────
//
// Every SELECT / DML statement, CTE body and derived table gets its own Scope.
// A scope maps FROM-clause names (aliases or bare relation names) to bindings:
// either a base catalog relation, or a "derived" relation (CTE / subquery)
// whose output columns carry provenance back to base table columns. Lookups
// climb the parent chain, which makes correlated subqueries resolve correctly,
// and alias collisions between sibling scopes can no longer cross-contaminate.

export interface BaseRef {
  relOid: number;
  attnum: number;
}

type ColumnResolution =
  | { status: "resolved"; refs: BaseRef[] }
  | { status: "ambiguous"; refs: BaseRef[] }
  | { status: "missing"; refs: BaseRef[] };

interface OutputCol {
  name: string | null;
  refs: BaseRef[];
}

interface BaseBinding {
  kind: "base";
  rel: CatalogRel;
}

interface DerivedBinding {
  kind: "derived";
  /** output name → base-table columns it was projected from (empty refs = expression) */
  cols: Map<string, BaseRef[]>;
  /**
   * star-passthrough sources: `SELECT * FROM t` can't enumerate outputs, so a
   * name miss falls through to the FROM bindings — but only resolves when
   * exactly ONE source has the column (ambiguity would be a SQL error anyway).
   */
  sources: Binding[];
  /** outputs in declaration order, for positional `WITH x(a, b)` renames */
  ordered: OutputCol[];
}

type Binding = BaseBinding | DerivedBinding;

class Scope {
  readonly bindings = new Map<string, Binding>();
  readonly ctes = new Map<string, DerivedBinding>();
  readonly mergedColumns = new Map<string, BaseRef[]>();
  constructor(readonly parent?: Scope) {}
}

const emptyDerived = (): DerivedBinding => ({
  kind: "derived",
  cols: new Map(),
  sources: [],
  ordered: [],
});

function lookupBinding(scope: Scope | undefined, name: string): Binding | undefined {
  for (let s = scope; s; s = s.parent) {
    const b = s.bindings.get(name);
    if (b) return b;
  }
  return undefined;
}

function lookupCte(scope: Scope | undefined, name: string): DerivedBinding | undefined {
  for (let s = scope; s; s = s.parent) {
    const d = s.ctes.get(name);
    if (d) return d;
  }
  return undefined;
}

/** Positional column rename: `WITH x(a, b) AS (…)` / `FROM (…) t(a, b)`. */
function applyColAliases(d: DerivedBinding, names: string[]): DerivedBinding {
  if (names.length === 0) return d;
  const out = emptyDerived();
  out.sources = d.sources;
  names.forEach((name, i) => {
    const refs = d.ordered[i]?.refs ?? [];
    out.cols.set(name, refs);
    out.ordered.push({ name, refs });
  });
  return out;
}

function colsInBinding(b: Binding, col: string, ctx: BodyCtx): BaseRef[] | null {
  if (b.kind === "base") {
    const c = ctx.resolver.col(b.rel.oid, col);
    return c ? [{ relOid: b.rel.oid, attnum: c.attnum }] : null;
  }
  const direct = b.cols.get(col);
  if (direct) return direct;
  const hits: BaseRef[][] = [];
  for (const s of b.sources) {
    const r = colsInBinding(s, col, ctx);
    if (r) hits.push(r);
  }
  return hits.length === 1 ? hits[0]! : null;
}

function outputsInBinding(binding: Binding, ctx: BodyCtx): OutputCol[] {
  if (binding.kind === "base") {
    return ctx.resolver.columns(binding.rel.oid).map((col) => ({
      name: col.name,
      refs: [{ relOid: binding.rel.oid, attnum: col.attnum }],
    }));
  }
  if (binding.ordered.length > 0) return binding.ordered;
  const out: OutputCol[] = [];
  for (const source of binding.sources) out.push(...outputsInBinding(source, ctx));
  return out;
}

function refsInBinding(binding: Binding, ctx: BodyCtx): BaseRef[] {
  return outputsInBinding(binding, ctx).flatMap((column) => column.refs);
}

/** Unqualified column: search each scope level without guessing ambiguous names. */
function findColumn(scope: Scope | undefined, name: string, ctx: BodyCtx): ColumnResolution {
  for (let s = scope; s; s = s.parent) {
    const merged = s.mergedColumns.get(name);
    if (merged) return { status: "resolved", refs: merged };
    const hits: BaseRef[][] = [];
    for (const b of s.bindings.values()) {
      const r = colsInBinding(b, name, ctx);
      if (r) hits.push(r);
    }
    if (hits.length === 1) return { status: "resolved", refs: hits[0]! };
    if (hits.length > 1) return { status: "ambiguous", refs: hits.flat() };
  }
  return { status: "missing", refs: [] };
}

function addSource(out: DerivedBinding, source: Binding): void {
  if (!out.sources.includes(source)) out.sources.push(source);
}

function addedBindings(scope: Scope, before: ReadonlySet<string>): Binding[] {
  const out: Binding[] = [];
  for (const [name, binding] of scope.bindings) {
    if (!before.has(name)) out.push(binding);
  }
  return out;
}

function emitRefs(refs: BaseRef[] | null, kind: AnalysisKind, ctx: BodyCtx): void {
  for (const r of refs ?? []) {
    if (r.attnum > 0) add(ctx.refs[kind], r.relOid, r.attnum);
  }
}

export function byteOffsetToIndex(text: string, byteOffset: number): number | undefined {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) return undefined;
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    if (bytes >= byteOffset) return bytes === byteOffset ? index : undefined;
    bytes += Buffer.byteLength(char);
    index += char.length;
  }
  return bytes === byteOffset ? index : undefined;
}

/** End of a possibly qualified/quoted ColumnRef starting at a parser location. */
export function columnRefEnd(sql: string, start: number): number {
  let i = start;
  let expectIdentifier = true;
  while (i < sql.length) {
    if (expectIdentifier) {
      while (/\s/.test(sql[i] ?? "")) i++;
      if (sql[i] === '"') {
        i++;
        while (i < sql.length) {
          if (sql[i] !== '"') {
            i++;
            continue;
          }
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
      } else if (sql[i] === "*") {
        i++;
      } else {
        const match = /^[A-Za-z_][\w$]*/.exec(sql.slice(i));
        if (!match) break;
        i += match[0].length;
      }
      expectIdentifier = false;
      continue;
    }
    const beforeDot = i;
    while (/\s/.test(sql[i] ?? "")) i++;
    if (sql[i] !== ".") return beforeDot;
    i++;
    expectIdentifier = true;
  }
  return i;
}

function recordResolution(
  cr: Json,
  resolution: ColumnResolution,
  kind: AnalysisKind,
  ctx: BodyCtx,
): void {
  const identifier = (cr?.fields ?? []).map(fieldName).filter(Boolean).join(".") || "column";
  const source = ctx.source;
  const parserLocation = typeof cr?.location === "number" ? cr.location : undefined;
  const localByte =
    parserLocation === undefined || !source
      ? undefined
      : parserLocation + source.locationDeltaBytes;
  const localIndex =
    localByte === undefined || !source ? undefined : byteOffsetToIndex(source.sql, localByte);
  let snippet = identifier;
  if (source && localIndex !== undefined) {
    const lineStart = source.sql.lastIndexOf("\n", localIndex - 1) + 1;
    const nextLine = source.sql.indexOf("\n", localIndex);
    const lineEnd = nextLine < 0 ? source.sql.length : nextLine;
    snippet = source.sql.slice(lineStart, lineEnd).trim().replace(/\s+/g, " ").slice(0, 240);
  }
  if (resolution.status !== "resolved") {
    ctx.refs.diagnostics.push({
      reason: resolution.status,
      identifier,
      snippet,
      candidates: resolution.refs,
    });
    for (const candidate of resolution.refs) {
      let relations = ctx.refs.unresolved.get(kind);
      if (!relations) ctx.refs.unresolved.set(kind, (relations = new Set()));
      relations.add(candidate.relOid);
    }
    return;
  }
  emitRefs(resolution.refs, kind, ctx);
  for (const ref of resolution.refs) {
    const mappedStart =
      localIndex !== undefined && source?.definitionOffset !== undefined
        ? source.definitionOffset + localIndex
        : undefined;
    const mappedEnd =
      mappedStart !== undefined && source
        ? source.definitionOffset! + columnRefEnd(source.sql, localIndex!)
        : undefined;
    ctx.refs.occurrences.push({
      ...ref,
      kind,
      ...(mappedStart === undefined ? {} : { start: mappedStart, end: mappedEnd }),
      snippet,
    });
  }
}

function recordTargetOccurrence(
  target: Json,
  relOid: number,
  attnum: number,
  kind: AnalysisKind,
  ctx: BodyCtx,
): void {
  const name = target?.name;
  if (typeof name !== "string") return;
  recordResolution(
    { fields: [{ String: { sval: name } }], location: target.location },
    { status: "resolved", refs: [{ relOid, attnum }] },
    kind,
    ctx,
  );
}

function resolveColumnRefRefs(cr: Json, scope: Scope, ctx: BodyCtx): ColumnResolution {
  const fields: Json[] = cr?.fields ?? [];
  if (fields.length === 0) return { status: "missing", refs: [] };
  const star = isStar(fields[fields.length - 1]);
  const names = fields.map(fieldName);
  if (fields.length === 1) {
    const colName = names[0];
    if (star) {
      const refs = [...scope.bindings.values()].flatMap((binding) => refsInBinding(binding, ctx));
      return { status: "resolved", refs };
    }
    if (!colName) return { status: "missing", refs: [] };
    return findColumn(scope, colName, ctx);
  }
  const qual = names[fields.length - 2];
  if (!qual) return { status: "missing", refs: [] };
  const colName = star ? null : (names[fields.length - 1] ?? null);
  // Order matters: a real FROM alias named "new"/"old" must shadow the trigger
  // pseudo-records, so bindings are consulted before the NEW/OLD fallback.
  let binding = lookupBinding(scope, qual);
  if (!binding) {
    const lower = qual.toLowerCase();
    if (lower === "new" || lower === "old") {
      if (!colName) return { status: "missing", refs: [] };
      const out: BaseRef[] = [];
      for (const rel of ctx.triggerRels) {
        const c = ctx.resolver.col(rel.oid, colName);
        if (c) out.push({ relOid: rel.oid, attnum: c.attnum });
      }
      return out.length > 0 ? { status: "resolved", refs: out } : { status: "missing", refs: [] };
    }
    // No FROM binding and not NEW/OLD: treat the qualifier as a relation name
    // (`schema.table.col` or bare `table.col`). This also intentionally covers
    // composite-type parameters (Hasura computed fields take `payrun
    // payroll.payrun`): attributing `payrun.cutoff_date` to the payroll.payrun
    // TABLE is semantically right — the param is a row of that table.
    const schemaName = fields.length >= 3 ? names[fields.length - 3] : undefined;
    const rel = ctx.resolver.resolveRel(qual, schemaName, ctx.schema);
    if (rel) binding = { kind: "base", rel };
  }
  if (!binding) return { status: "missing", refs: [] };
  if (!colName) return { status: "resolved", refs: refsInBinding(binding, ctx) };
  const refs = colsInBinding(binding, colName, ctx);
  if (refs) return { status: "resolved", refs };
  const relations = new Set(refsInBinding(binding, ctx).map((ref) => ref.relOid));
  return {
    status: "missing",
    refs: [...relations].map((relOid) => ({ relOid, attnum: 0 })),
  };
}

/** Walk expressions in a scope; recurse into subqueries with proper child scopes. */
function walkExprs(node: Json, scope: Scope, ctx: BodyCtx): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walkExprs(item, scope, ctx);
    return;
  }
  if (typeof node !== "object") return;
  if (node.ColumnRef) {
    const fields: Json[] = node.ColumnRef.fields ?? [];
    if (isStar(fields[fields.length - 1])) return;
    recordResolution(
      node.ColumnRef,
      resolveColumnRefRefs(node.ColumnRef, scope, ctx),
      "reads",
      ctx,
    );
    return;
  }
  if (node.SubLink) {
    walkExprs(node.SubLink.testexpr, scope, ctx);
    if (node.SubLink.subselect) processStmtNode(node.SubLink.subselect, scope, ctx);
    return;
  }
  if (node.SelectStmt) {
    processSelect(node.SelectStmt, scope, ctx);
    return;
  }
  // owned by bindFromItem / processWith — never descend generically
  if (node.RangeSubselect || node.CommonTableExpr || node.RangeVar) return;
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") walkExprs(value, scope, ctx);
  }
}

function bindFromItem(item: Json, scope: Scope, ctx: BodyCtx): void {
  if (!item || typeof item !== "object") return;
  if (item.RangeVar) {
    const rv = item.RangeVar;
    const alias: string | undefined = rv.alias?.aliasname;
    const colAliases = nameList(rv.alias?.colnames);
    if (!rv.schemaname && typeof rv.relname === "string") {
      const cte = lookupCte(scope, rv.relname);
      if (cte) {
        scope.bindings.set(alias ?? rv.relname, applyColAliases(cte, colAliases));
        return;
      }
    }
    const rel = ctx.resolver.resolveRel(rv.relname, rv.schemaname, ctx.schema);
    if (rel) {
      add(ctx.refs.reads, rel.oid, 0);
      scope.bindings.set(alias ?? rv.relname, { kind: "base", rel });
    }
    return;
  }
  if (item.RangeSubselect) {
    const rs = item.RangeSubselect;
    const derived = rs.subquery ? processStmtNode(rs.subquery, scope, ctx) : emptyDerived();
    const alias: string | undefined = rs.alias?.aliasname;
    if (alias) scope.bindings.set(alias, applyColAliases(derived, nameList(rs.alias?.colnames)));
    return;
  }
  if (item.JoinExpr) {
    const j = item.JoinExpr;
    const before = new Set(scope.bindings.keys());
    bindFromItem(j.larg, scope, ctx);
    const left = addedBindings(scope, before);
    const afterLeft = new Set(scope.bindings.keys());
    bindFromItem(j.rarg, scope, ctx);
    const right = addedBindings(scope, afterLeft);
    const joined = [...left, ...right];
    walkExprs(j.quals, scope, ctx);
    const usingNames = nameList(j.usingClause);
    if (j.isNatural && left.length > 0 && right.length > 0) {
      const leftNames = new Set(
        left.flatMap((binding) => outputsInBinding(binding, ctx)).map((column) => column.name),
      );
      for (const column of right.flatMap((binding) => outputsInBinding(binding, ctx))) {
        if (column.name && leftNames.has(column.name)) usingNames.push(column.name);
      }
    }
    const uniqueUsing = [...new Set(usingNames)];
    for (const name of uniqueUsing) {
      const refs = joined.flatMap((binding) => colsInBinding(binding, name, ctx) ?? []);
      emitRefs(refs, "reads", ctx);
      scope.mergedColumns.set(name, refs);
    }
    const alias: string | undefined = j.alias?.aliasname;
    if (alias) {
      const derived = emptyDerived();
      for (const name of uniqueUsing) {
        const refs = joined.flatMap((binding) => colsInBinding(binding, name, ctx) ?? []);
        derived.cols.set(name, refs);
        derived.ordered.push({ name, refs });
      }
      for (const binding of joined) {
        for (const output of outputsInBinding(binding, ctx)) {
          if (output.name && uniqueUsing.includes(output.name)) continue;
          if (output.name) derived.cols.set(output.name, output.refs);
          derived.ordered.push(output);
        }
      }
      for (const name of scope.bindings.keys()) if (!before.has(name)) scope.bindings.delete(name);
      scope.bindings.set(alias, applyColAliases(derived, nameList(j.alias?.colnames)));
    }
    return;
  }
  if (item.RangeFunction) {
    const alias: string | undefined = item.RangeFunction.alias?.aliasname;
    if (alias) scope.bindings.set(alias, emptyDerived());
    walkExprs(item.RangeFunction.functions, scope, ctx); // LATERAL args may be correlated
    return;
  }
  walkExprs(item, scope, ctx);
}

/** Output provenance of a SELECT/RETURNING target list, for CTE / subquery aliases. */
function buildOutputs(targetList: Json[], scope: Scope, ctx: BodyCtx): DerivedBinding {
  const out = emptyDerived();
  for (const t of targetList) {
    const rt = t?.ResTarget;
    if (!rt) {
      out.ordered.push({ name: null, refs: [] });
      continue;
    }
    let name: string | null = rt.name ?? null;
    let refs: BaseRef[] = [];
    const cr = rt.val?.ColumnRef;
    if (cr) {
      const fields: Json[] = cr.fields ?? [];
      if (isStar(fields[fields.length - 1])) {
        recordResolution(cr, resolveColumnRefRefs(cr, scope, ctx), "reads", ctx);
        if (fields.length === 1) {
          for (const source of scope.bindings.values()) {
            addSource(out, source);
            for (const output of outputsInBinding(source, ctx)) {
              if (output.name) out.cols.set(output.name, output.refs);
              out.ordered.push(output);
            }
          }
        } else {
          const qual = fieldName(fields[fields.length - 2]);
          const source = qual ? lookupBinding(scope, qual) : undefined;
          if (source) {
            addSource(out, source);
            for (const output of outputsInBinding(source, ctx)) {
              if (output.name) out.cols.set(output.name, output.refs);
              out.ordered.push(output);
            }
          }
        }
        continue;
      }
      const resolution = resolveColumnRefRefs(cr, scope, ctx);
      refs = resolution.status === "resolved" ? resolution.refs : [];
      if (!name) name = fieldName(fields[fields.length - 1]) ?? null;
    } else if (rt.val) {
      const seen = new Map<string, BaseRef>();
      walk(rt.val, (tag, value) => {
        if (tag !== "ColumnRef") return;
        const resolution = resolveColumnRefRefs(value, scope, ctx);
        if (resolution.status !== "resolved") return;
        for (const ref of resolution.refs) seen.set(`${ref.relOid}:${ref.attnum}`, ref);
      });
      refs = [...seen.values()];
    }
    if (name) out.cols.set(name, refs);
    out.ordered.push({ name, refs });
  }
  return out;
}

function processWith(withClause: Json, scope: Scope, ctx: BodyCtx): void {
  for (const item of withClause?.ctes ?? []) {
    const cte = item?.CommonTableExpr;
    if (!cte || typeof cte.ctename !== "string") continue;
    // placeholder first, so a recursive CTE's self-reference resolves to the
    // (empty) CTE instead of a real table that happens to share the name
    scope.ctes.set(cte.ctename, emptyDerived());
    const derived = cte.ctequery ? processStmtNode(cte.ctequery, scope, ctx) : emptyDerived();
    scope.ctes.set(cte.ctename, applyColAliases(derived, nameList(cte.aliascolnames)));
  }
}

function processSelect(sel: Json, parentScope: Scope, ctx: BodyCtx): DerivedBinding {
  const scope = new Scope(parentScope);
  processWith(sel.withClause, scope, ctx);
  if (sel.op && sel.op !== "SETOP_NONE") {
    const left = sel.larg ? processSelect(sel.larg, scope, ctx) : emptyDerived();
    if (sel.rarg) processSelect(sel.rarg, scope, ctx);
    return left; // set-op outputs follow the left arm
  }
  for (const f of sel.fromClause ?? []) bindFromItem(f, scope, ctx);
  walkExprs(
    [
      sel.targetList,
      sel.whereClause,
      sel.groupClause,
      sel.havingClause,
      sel.windowClause,
      sel.limitOffset,
      sel.limitCount,
      sel.valuesLists,
    ],
    scope,
    ctx,
  );
  const outputs = buildOutputs(sel.targetList ?? [], scope, ctx);
  const outputScope = new Scope(scope);
  outputScope.bindings.set("$select", outputs);
  walkExprs([sel.sortClause, sel.distinctClause], outputScope, ctx);
  return outputs;
}

function bindTargetRel(relation: Json, scope: Scope, ctx: BodyCtx): BaseBinding | null {
  if (!relation || typeof relation.relname !== "string") return null;
  const rel = ctx.resolver.resolveRel(relation.relname, relation.schemaname, ctx.schema);
  if (!rel) return null;
  const binding: BaseBinding = { kind: "base", rel };
  scope.bindings.set(relation.alias?.aliasname ?? relation.relname, binding);
  return binding;
}

function processInsert(ins: Json, parentScope: Scope, ctx: BodyCtx): DerivedBinding {
  const scope = new Scope(parentScope);
  processWith(ins.withClause, scope, ctx);
  // the source SELECT must not see the target relation
  if (ins.selectStmt) processStmtNode(ins.selectStmt, scope, ctx);
  const targetScope = new Scope(scope);
  const target = bindTargetRel(ins.relation, targetScope, ctx);
  if (ins.onConflictClause && target) {
    const cScope = new Scope(targetScope);
    cScope.bindings.set("excluded", target);
    walkExprs(
      [
        ins.onConflictClause.targetList,
        ins.onConflictClause.whereClause,
        ins.onConflictClause.infer,
      ],
      cScope,
      ctx,
    );
  }
  walkExprs(ins.returningList, targetScope, ctx);
  return buildOutputs(ins.returningList ?? [], targetScope, ctx);
}

function processUpdate(u: Json, parentScope: Scope, ctx: BodyCtx): DerivedBinding {
  const scope = new Scope(parentScope);
  processWith(u.withClause, scope, ctx);
  bindTargetRel(u.relation, scope, ctx);
  for (const f of u.fromClause ?? []) bindFromItem(f, scope, ctx);
  walkExprs([u.targetList, u.whereClause, u.returningList], scope, ctx);
  return buildOutputs(u.returningList ?? [], scope, ctx);
}

function processDelete(d: Json, parentScope: Scope, ctx: BodyCtx): DerivedBinding {
  const scope = new Scope(parentScope);
  processWith(d.withClause, scope, ctx);
  bindTargetRel(d.relation, scope, ctx);
  for (const f of d.usingClause ?? []) bindFromItem(f, scope, ctx);
  walkExprs([d.whereClause, d.returningList], scope, ctx);
  return buildOutputs(d.returningList ?? [], scope, ctx);
}

function processMerge(m: Json, parentScope: Scope, ctx: BodyCtx): DerivedBinding {
  const scope = new Scope(parentScope);
  processWith(m.withClause, scope, ctx);
  bindTargetRel(m.relation, scope, ctx);
  if (m.sourceRelation) bindFromItem(m.sourceRelation, scope, ctx);
  walkExprs([m.joinCondition, m.mergeWhenClauses, m.returningList], scope, ctx);
  return buildOutputs(m.returningList ?? [], scope, ctx);
}

function processStmtNode(stmtNode: Json, parentScope: Scope, ctx: BodyCtx): DerivedBinding {
  if (!stmtNode || typeof stmtNode !== "object") return emptyDerived();
  if (stmtNode.SelectStmt) return processSelect(stmtNode.SelectStmt, parentScope, ctx);
  if (stmtNode.InsertStmt) return processInsert(stmtNode.InsertStmt, parentScope, ctx);
  if (stmtNode.UpdateStmt) return processUpdate(stmtNode.UpdateStmt, parentScope, ctx);
  if (stmtNode.DeleteStmt) return processDelete(stmtNode.DeleteStmt, parentScope, ctx);
  if (stmtNode.MergeStmt) return processMerge(stmtNode.MergeStmt, parentScope, ctx);
  walkExprs(stmtNode, parentScope, ctx);
  return emptyDerived();
}

// ── Parsing entry points ────────────────────────────────────────────────────

/**
 * The WASM parse calls are synchronous, so a long analysis run would otherwise
 * starve the event loop (frozen progress UI in the extension host). A real
 * macrotask yield lets queued messages paint.
 */
const yieldEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * `target := …` / `target[i] := …` prefix of PL/pgSQL assignment expressions.
 * libpg_query keeps the WHOLE statement text in PLpgSQL_stmt_assign's expr
 * query — `needs_review := EXISTS (…)` — which neither parses as a statement
 * nor as `SELECT <it>`. Stripping the prefix recovers the RHS; without this,
 * everything referenced inside assignments was silently invisible.
 */
const ASSIGN_PREFIX = /^\s*[a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)*(?:\[[^\]]*\])?\s*:=\s*/;

const isTimeout = (e: unknown): boolean => String(e).includes("parse timed out");

/**
 * Parse cascade for PL/pgSQL expression fragments: full statement → wrapped as
 * `SELECT <expr>` (bare expressions like `a + b`) → RHS of an assignment.
 * Each failed attempt is a real round-trip into the C parser, so a timed-out
 * (killed-worker) attempt must NOT retry variants — the next two would each
 * eat another full timeout on input that already proved poisonous.
 */
interface ParsedSql {
  tree: Json;
  sql: string;
  locationDeltaBytes: number;
}

async function tryParse(parser: PgParser, sql: string): Promise<ParsedSql | null> {
  try {
    return { tree: await parser.parseQuery(sql), sql, locationDeltaBytes: 0 };
  } catch (e) {
    if (isTimeout(e)) return null; // hung worker was killed — don't retry variants
    // PL/pgSQL expressions ("a + b") aren't full statements — retry as a SELECT.
    try {
      return {
        tree: await parser.parseQuery(`SELECT ${sql}`),
        sql,
        locationDeltaBytes: -Buffer.byteLength("SELECT "),
      };
    } catch (e2) {
      if (isTimeout(e2)) return null;
      // assignment statements keep their "var := " prefix in the parse tree
      const rhs = sql.replace(ASSIGN_PREFIX, "");
      if (rhs === sql) return null;
      try {
        return {
          tree: await parser.parseQuery(`SELECT ${rhs}`),
          sql,
          locationDeltaBytes:
            Buffer.byteLength(sql.slice(0, sql.length - rhs.length)) - Buffer.byteLength("SELECT "),
        };
      } catch {
        return null;
      }
    }
  }
}

function analyzeParsedSql(
  parsed: ParsedSql,
  definition: string | null | undefined,
  ctx: BodyCtx,
): void {
  const definitionOffset = definition?.indexOf(parsed.sql) ?? -1;
  ctx.source = {
    sql: parsed.sql,
    definition: definition ?? undefined,
    definitionOffset:
      definitionOffset >= 0 && definition?.lastIndexOf(parsed.sql) === definitionOffset
        ? definitionOffset
        : undefined,
    locationDeltaBytes: parsed.locationDeltaBytes,
  };
  analyzeParsedQuery(parsed.tree, ctx);
}

/**
 * Generic trigger functions (Hasura's set_current_timestamp_updated_at, audit
 * triggers, …) assign `NEW.col := …` / `_new."col" = …` — assignment targets the
 * SQL parser never sees, and bodies using an untyped `record` variable don't even
 * parse as PL/pgSQL (the plpgsql parser rejects `_new."x"` with "not a known
 * variable"), so the AST route is a dead end for exactly these functions. Scan
 * the source text instead and attribute a MODIFIES (not a write — mutating NEW
 * in a BEFORE trigger changes the in-flight row, the function issues no DML) to
 * EVERY table whose trigger executes the function — one generic fn attached to
 * 100 tables gets 100 edges, which is the desired blast-radius answer.
 * Statement-start anchors
 * (`;`, BEGIN, THEN, ELSE, LOOP) keep `IF NEW.x = 1` comparisons from matching,
 * and the `(?![=<>])` tail keeps `!=`, `<=`, `>=` out.
 */
const TRIGGER_ASSIGN_RE =
  /(?:^|;|\bbegin\b|\bthen\b|\belse\b|\bloop\b)\s*"?(_?new|_?old)"?\s*\.\s*(?:"((?:""|[^"])*)"|([a-zA-Z_][\w$]*))\s*:?=(?![=<>])/gim;

function triggerAssignWrites(src: string, ctx: BodyCtx): void {
  if (ctx.triggerRels.length === 0 || !src) return;
  for (const m of src.matchAll(TRIGGER_ASSIGN_RE)) {
    const colName = m[2] !== undefined ? m[2].replace(/""/g, '"') : m[3]!;
    for (const rel of ctx.triggerRels) {
      const col = ctx.resolver.col(rel.oid, colName);
      if (col) add(ctx.refs.modifies, rel.oid, col.attnum);
    }
  }
}

/**
 * Crude lexical fallback when the WASM parser is unavailable (or a body failed
 * to parse). Table-level only. Knowingly over-matches — `UPDATE` also matches
 * `FOR UPDATE` / `UPDATE OF`, and `callRe` matches every `ident(` — but every
 * candidate must resolve against the live catalog, which drops nearly all of
 * the noise; what survives is at worst a plausible table-level edge.
 */
export function regexAnalyze(src: string, ctx: BodyCtx): void {
  const cleaned = src.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const ident = String.raw`([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)?)`;
  const writePatterns: [WriteOp, RegExp][] = [
    ["inserts", new RegExp(String.raw`\binsert\s+into\s+(?:only\s+)?${ident}`, "gi")],
    ["updates", new RegExp(String.raw`\bupdate\s+(?:only\s+)?${ident}`, "gi")],
    [
      "deletes",
      new RegExp(
        String.raw`\b(?:delete\s+from|truncate\s+(?:table\s+)?)\s*(?:only\s+)?${ident}`,
        "gi",
      ),
    ],
    ["writes", new RegExp(String.raw`\bmerge\s+into\s+(?:only\s+)?${ident}`, "gi")],
  ];
  const readRe = new RegExp(String.raw`\b(?:from|join)\s+(?:only\s+)?${ident}`, "gi");
  const callRe = /\b([a-zA-Z_][\w$]*)\s*\(/g;

  const resolve = (raw: string): CatalogRel | undefined => {
    const parts = raw.split(".");
    const name = parts[parts.length - 1]!;
    return ctx.resolver.resolveRel(name, parts.length > 1 ? parts[0] : undefined, ctx.schema);
  };

  for (const [op, re] of writePatterns) {
    for (const m of cleaned.matchAll(re)) {
      const rel = resolve(m[1]!);
      if (rel) add(ctx.refs[op], rel.oid, 0);
    }
  }
  for (const m of cleaned.matchAll(readRe)) {
    const rel = resolve(m[1]!);
    if (rel) add(ctx.refs.reads, rel.oid, 0);
  }
  for (const m of cleaned.matchAll(callRe)) {
    const fn = ctx.resolver.resolveFunc(m[1]!, undefined, ctx.schema);
    if (fn && fn.oid !== ctx.selfOid) ctx.refs.calls.add(fn.oid);
  }
}

export async function analyzeFunc(
  fn: CatalogFunc,
  resolver: Resolver,
  triggerRels: CatalogRel[],
  parser: PgParser | null,
): Promise<FuncRefs> {
  const refs = createRefs();
  const ctx: BodyCtx = { resolver, schema: fn.schema, selfOid: fn.oid, triggerRels, refs };

  if (parser) {
    try {
      if (fn.language === "plpgsql" && fn.def) {
        const tree = await parser.parsePlPgSQL(fn.def);
        const exprs: string[] = [];
        walk(tree?.plpgsql_funcs ?? tree, (tag, v) => {
          if (tag === "PLpgSQL_expr" && typeof v.query === "string") exprs.push(v.query);
        });
        for (let i = 0; i < exprs.length; i++) {
          if (i > 0 && i % 20 === 0) await yieldEventLoop();
          const parsed = await tryParse(parser, exprs[i]!);
          if (parsed) analyzeParsedSql(parsed, fn.def, ctx);
        }
        refs.parsed = true;
      } else if (fn.language === "sql" && fn.src) {
        const parsed = await tryParse(parser, fn.src);
        if (parsed) {
          analyzeParsedSql(parsed, fn.def ?? fn.src, ctx);
          refs.parsed = true;
        }
      }
    } catch {
      refs.parsed = false;
    }
  }
  if (!refs.parsed) regexAnalyze(fn.src ?? fn.def ?? "", ctx);
  if (fn.language === "plpgsql") triggerAssignWrites(fn.src ?? fn.def ?? "", ctx);
  return refs;
}

export async function analyzeView(
  rel: CatalogRel,
  resolver: Resolver,
  parser: PgParser | null,
): Promise<FuncRefs> {
  const refs = createRefs();
  if (!parser || !rel.definition) return refs;
  const ctx: BodyCtx = {
    resolver,
    schema: rel.schema,
    selfOid: rel.oid,
    triggerRels: [],
    refs,
  };
  try {
    const parsed = await tryParse(parser, rel.definition);
    if (parsed) {
      analyzeParsedSql(parsed, rel.definition, ctx);
      refs.parsed = true;
    }
  } catch {
    refs.parsed = false;
  }
  return refs;
}

export async function analyzeViews(
  catalog: Catalog,
  log: Log = () => {},
): Promise<Map<number, FuncRefs>> {
  const candidates = catalog.rels.filter(
    (rel) => (rel.kind === "view" || rel.kind === "matview") && Boolean(rel.definition),
  );
  const parser = await getParser();
  const resolver = new Resolver(catalog);
  const out = new Map<number, FuncRefs>();
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, candidates.length) }, async () => {
      for (;;) {
        const rel = candidates[next++];
        if (!rel) return;
        await yieldEventLoop();
        const refs = await analyzeView(rel, resolver, parser);
        out.set(rel.oid, refs);
        done++;
        if (done === candidates.length || done % 25 === 0) {
          log(`analyzing view definitions ${done}/${candidates.length}...`);
        }
      }
    }),
  );
  return out;
}

export async function analyzeAll(
  catalog: Catalog,
  log: Log = () => {},
): Promise<Map<number, FuncRefs>> {
  const resolver = new Resolver(catalog);
  const relByOid = new Map(catalog.rels.map((r) => [r.oid, r]));
  const triggerRelsByFunc = new Map<number, CatalogRel[]>();
  for (const t of catalog.triggers) {
    const rel = relByOid.get(t.relOid);
    if (!rel) continue;
    const list = triggerRelsByFunc.get(t.funcOid) ?? [];
    if (!list.includes(rel)) list.push(rel);
    triggerRelsByFunc.set(t.funcOid, list);
  }

  const parser = await getParser();
  log(
    parser
      ? `SQL parser: pg-query-emscripten loaded (${parser === workerParser ? "worker process, killable on hang" : "in-process WASM"})`
      : "SQL parser unavailable — regex fallback only (table-level precision)",
  );

  // BEGIN ATOMIC bodies are skipped: pg_depend already has exact deps (see sqlBodyDeps).
  const candidates = catalog.funcs.filter(
    (fn) =>
      (fn.language === "plpgsql" || fn.language === "sql") &&
      !(fn.language === "sql" && fn.hasSqlBody),
  );
  log(
    `analyzing ${candidates.length} function bodies ` +
      `(of ${catalog.funcs.length} functions; BEGIN ATOMIC and non-SQL languages skipped)`,
  );

  const out = new Map<number, FuncRefs>();
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, candidates.length) }, async () => {
      for (;;) {
        const index = next++;
        const fn = candidates[index];
        if (!fn) return;
        await yieldEventLoop();
        const start = Date.now();
        const refs = await analyzeFunc(fn, resolver, triggerRelsByFunc.get(fn.oid) ?? [], parser);
        out.set(fn.oid, refs);
        done++;
        log(
          `[${done}/${candidates.length}] ${fn.schema}.${fn.name}(): ` +
            `${refs.parsed ? "parsed" : "regex fallback"} — ` +
            `${refs.reads.size} read rels, ${refs.inserts.size + refs.updates.size + refs.deletes.size + refs.writes.size} write rels, ` +
            `${refs.modifies.size} modified rels, ${refs.calls.size} calls (${Date.now() - start} ms)`,
        );
      }
    }),
  );
  return out;
}
