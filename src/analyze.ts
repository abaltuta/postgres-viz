import type { Log } from "./introspect";
import type { Catalog, CatalogCol, CatalogFunc, CatalogRel } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface FuncRefs {
  /** relOid → attnums (0 = whole-table) */
  reads: Map<number, Set<number>>;
  writes: Map<number, Set<number>>;
  calls: Set<number>;
  /** true when the real Postgres parser was used; false = regex fallback */
  parsed: boolean;
}

export interface PgParser {
  /** returns a raw-parse tree `{version, stmts: [...]}` or throws */
  parseQuery(sql: string): Promise<Json>;
  /** returns `{plpgsql_funcs: [...]}` or throws */
  parsePlPgSQL(sql: string): Promise<Json>;
}

let cachedParser: PgParser | null | undefined;

/**
 * A long-lived pg-query-emscripten instance accumulates WASM heap state and,
 * after a few hundred parse calls, can lock up in a synchronous (and therefore
 * uninterruptible) loop. Instantiation costs ~2 ms, so recycle aggressively.
 */
const RECYCLE_AFTER_CALLS = 25;

/**
 * pg-query-emscripten (the real Postgres parser compiled to WASM) is optional at
 * runtime: if it fails to load we fall back to regexes. Its API reports parse
 * failures via an `error` field rather than throwing — normalize to throws.
 */
export async function getParser(): Promise<PgParser | null> {
  if (cachedParser !== undefined) return cachedParser;
  try {
    const mod: Json = await import("pg-query-emscripten");
    const factory = typeof mod === "function" ? mod : (mod?.default ?? mod);
    if (typeof factory !== "function") {
      cachedParser = null;
      return cachedParser;
    }
    let instance: Json = null;
    let calls = 0;
    const get = async (): Promise<Json> => {
      if (!instance || calls >= RECYCLE_AFTER_CALLS) {
        instance = await factory();
        calls = 0;
      }
      calls++;
      return instance;
    };
    const probe = await get();
    if (typeof probe?.parse !== "function" || typeof probe?.parsePlpgsql !== "function") {
      cachedParser = null;
      return cachedParser;
    }
    cachedParser = {
      async parseQuery(sql: string): Promise<Json> {
        const r = (await get()).parse(sql);
        if (r?.error) throw new Error(String(r.error.message ?? "parse error"));
        return r?.parse_tree;
      },
      async parsePlPgSQL(sql: string): Promise<Json> {
        const r = (await get()).parsePlpgsql(sql);
        if (r?.error) throw new Error(String(r.error.message ?? "parse error"));
        return r;
      },
    };
  } catch {
    cachedParser = null;
  }
  return cachedParser;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export class Resolver {
  private relByQual = new Map<string, CatalogRel>();
  private relsByName = new Map<string, CatalogRel[]>();
  private colsByRel = new Map<number, Map<string, CatalogCol>>();
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
    }
    for (const f of catalog.funcs) {
      const qual = `${f.schema}.${f.name}`;
      if (!this.funcByQual.has(qual)) this.funcByQual.set(qual, f);
      push(this.funcsByName, f.name, f);
    }
  }

  resolveRel(name: string, schema: string | undefined, preferred: string): CatalogRel | undefined {
    if (schema) return this.relByQual.get(`${schema}.${name}`);
    const cands = this.relsByName.get(name);
    if (!cands || cands.length === 0) return undefined;
    return (
      cands.find((r) => r.schema === preferred) ??
      cands.find((r) => r.schema === "public") ??
      (cands.length === 1 ? cands[0] : undefined)
    );
  }

  col(relOid: number, name: string): CatalogCol | undefined {
    return this.colsByRel.get(relOid)?.get(name);
  }

  resolveFunc(
    name: string,
    schema: string | undefined,
    preferred: string,
  ): CatalogFunc | undefined {
    if (schema) return this.funcByQual.get(`${schema}.${name}`);
    const cands = this.funcsByName.get(name);
    if (!cands || cands.length === 0) return undefined;
    return (
      cands.find((f) => f.schema === preferred) ??
      cands.find((f) => f.schema === "public") ??
      (cands.length === 1 ? cands[0] : undefined)
    );
  }
}

/** Visit every object-valued entry of a parse tree; handlers match on the key. */
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
  const parts = ((funcname ?? []) as Json[]).map(fieldName).filter((s): s is string => !!s);
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

function collectMergeTargets(mergeStmt: Json): Json[] {
  const out: Json[] = [];
  walk(mergeStmt.mergeWhenClauses ?? [], (tag, v) => {
    if (tag === "MergeWhenClause") for (const t of v.targetList ?? []) out.push(t);
  });
  return out;
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

  // Write targets, tracked by object identity so the generic RangeVar pass can classify them.
  const writeTargets = new Set<Json>();
  walk(stmt, (tag, v) => {
    switch (tag) {
      case "InsertStmt":
      case "UpdateStmt":
      case "DeleteStmt":
      case "MergeStmt":
      case "RefreshMatViewStmt":
        if (v.relation) writeTargets.add(v.relation);
        break;
      case "CopyStmt":
        if (v.relation && v.is_from) writeTargets.add(v.relation);
        break;
      case "TruncateStmt":
        for (const r of v.relations ?? []) if (r?.RangeVar) writeTargets.add(r.RangeVar);
        break;
    }
  });

  walk(stmt, (tag, v) => {
    if (isRangeVar(tag, v)) {
      const rel = resolveRangeVar(v);
      if (!rel) return;
      add(writeTargets.has(v) ? refs.writes : refs.reads, rel.oid, 0);
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
          if (col) add(refs.writes, rel.oid, col.attnum);
        }
        return;
      }
      case "UpdateStmt":
      case "MergeStmt": {
        const rel = resolveRangeVar(v.relation);
        if (!rel) return;
        const targets: Json[] =
          tag === "UpdateStmt" ? (v.targetList ?? []) : collectMergeTargets(v);
        for (const t of targets) {
          const name: string | undefined = t?.ResTarget?.name;
          const col = name ? resolver.col(rel.oid, name) : undefined;
          if (col) add(refs.writes, rel.oid, col.attnum);
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

interface BaseRef {
  relOid: number;
  attnum: number;
}

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
  cols: Map<string, BaseRef[]>;
  /** star-passthrough sources: `SELECT * FROM t` lets unknown names fall through */
  sources: Binding[];
  /** outputs in declaration order, for positional column aliasing */
  ordered: OutputCol[];
}

type Binding = BaseBinding | DerivedBinding;

class Scope {
  readonly bindings = new Map<string, Binding>();
  readonly ctes = new Map<string, DerivedBinding>();
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
  if (direct && direct.length > 0) return direct;
  const hits: BaseRef[][] = [];
  for (const s of b.sources) {
    const r = colsInBinding(s, col, ctx);
    if (r) hits.push(r);
  }
  return hits.length === 1 ? hits[0]! : null;
}

/** Unqualified column: search each scope level; ambiguous names are dropped. */
function findColumn(scope: Scope | undefined, name: string, ctx: BodyCtx): BaseRef[] | null {
  for (let s = scope; s; s = s.parent) {
    const hits: BaseRef[][] = [];
    for (const b of s.bindings.values()) {
      const r = colsInBinding(b, name, ctx);
      if (r) hits.push(r);
    }
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) return null;
  }
  return null;
}

function emitReads(refs: BaseRef[] | null, ctx: BodyCtx): void {
  for (const r of refs ?? []) {
    if (r.attnum > 0) add(ctx.refs.reads, r.relOid, r.attnum);
  }
}

function resolveColumnRefRefs(cr: Json, scope: Scope, ctx: BodyCtx): BaseRef[] | null {
  const fields: Json[] = cr?.fields ?? [];
  if (fields.length === 0) return null;
  const star = isStar(fields[fields.length - 1]);
  const names = fields.map(fieldName);
  if (fields.length === 1) {
    const colName = names[0];
    if (star || !colName) return null;
    return findColumn(scope, colName, ctx);
  }
  const qual = names[fields.length - 2];
  if (!qual) return null;
  const colName = star ? null : (names[fields.length - 1] ?? null);
  let binding = lookupBinding(scope, qual);
  if (!binding) {
    const lower = qual.toLowerCase();
    if (lower === "new" || lower === "old") {
      if (!colName) return null;
      const out: BaseRef[] = [];
      for (const rel of ctx.triggerRels) {
        const c = ctx.resolver.col(rel.oid, colName);
        if (c) out.push({ relOid: rel.oid, attnum: c.attnum });
      }
      return out.length > 0 ? out : null;
    }
    const schemaName = fields.length >= 3 ? names[fields.length - 3] : undefined;
    const rel = ctx.resolver.resolveRel(qual, schemaName, ctx.schema);
    if (rel) binding = { kind: "base", rel };
  }
  if (!binding || !colName) return null;
  return colsInBinding(binding, colName, ctx);
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
    emitReads(resolveColumnRefRefs(node.ColumnRef, scope, ctx), ctx);
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
    if (rel) scope.bindings.set(alias ?? rv.relname, { kind: "base", rel });
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
    bindFromItem(j.larg, scope, ctx);
    bindFromItem(j.rarg, scope, ctx);
    walkExprs(j.quals, scope, ctx);
    // JOIN USING (col, …): the column is read on every side that has it
    for (const name of nameList(j.usingClause)) {
      for (const b of scope.bindings.values()) emitReads(colsInBinding(b, name, ctx), ctx);
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
        out.sources = [...scope.bindings.values()];
        out.ordered.push({ name: null, refs: [] });
        continue;
      }
      refs = resolveColumnRefRefs(cr, scope, ctx) ?? [];
      if (!name) name = fieldName(fields[fields.length - 1]) ?? null;
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
      sel.sortClause,
      sel.distinctClause,
      sel.limitOffset,
      sel.limitCount,
      sel.valuesLists,
    ],
    scope,
    ctx,
  );
  return buildOutputs(sel.targetList ?? [], scope, ctx);
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

/** `target := …` / `target[i] := …` prefix of PL/pgSQL assignment expressions. */
const ASSIGN_PREFIX = /^\s*[a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)*(?:\[[^\]]*\])?\s*:=\s*/;

async function tryParse(parser: PgParser, sql: string): Promise<Json | null> {
  try {
    return await parser.parseQuery(sql);
  } catch {
    // PL/pgSQL expressions ("a + b") aren't full statements — retry as a SELECT.
    try {
      return await parser.parseQuery(`SELECT ${sql}`);
    } catch {
      // assignment statements keep their "var := " prefix in the parse tree
      const rhs = sql.replace(ASSIGN_PREFIX, "");
      if (rhs === sql) return null;
      try {
        return await parser.parseQuery(`SELECT ${rhs}`);
      } catch {
        return null;
      }
    }
  }
}

/** Crude lexical fallback when the WASM parser is unavailable. Table-level only. */
export function regexAnalyze(src: string, ctx: BodyCtx): void {
  const cleaned = src.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const ident = String.raw`([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)?)`;
  const writeRe = new RegExp(
    String.raw`\b(?:insert\s+into|update|delete\s+from|truncate\s+(?:table\s+)?|merge\s+into)\s+(?:only\s+)?${ident}`,
    "gi",
  );
  const readRe = new RegExp(String.raw`\b(?:from|join)\s+(?:only\s+)?${ident}`, "gi");
  const callRe = /\b([a-zA-Z_][\w$]*)\s*\(/g;

  const resolve = (raw: string): CatalogRel | undefined => {
    const parts = raw.split(".");
    const name = parts[parts.length - 1]!;
    return ctx.resolver.resolveRel(name, parts.length > 1 ? parts[0] : undefined, ctx.schema);
  };

  for (const m of cleaned.matchAll(writeRe)) {
    const rel = resolve(m[1]!);
    if (rel) add(ctx.refs.writes, rel.oid, 0);
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
  const refs: FuncRefs = { reads: new Map(), writes: new Map(), calls: new Set(), parsed: false };
  const ctx: BodyCtx = { resolver, schema: fn.schema, selfOid: fn.oid, triggerRels, refs };

  if (parser) {
    try {
      if (fn.language === "plpgsql" && fn.def) {
        const tree = await parser.parsePlPgSQL(fn.def);
        const exprs: string[] = [];
        walk(tree?.plpgsql_funcs ?? tree, (tag, v) => {
          if (tag === "PLpgSQL_expr" && typeof v.query === "string") exprs.push(v.query);
        });
        for (const q of exprs) {
          const parsedTree = await tryParse(parser, q);
          if (parsedTree) analyzeParsedQuery(parsedTree, ctx);
        }
        refs.parsed = true;
      } else if (fn.language === "sql" && fn.src) {
        const parsedTree = await tryParse(parser, fn.src);
        if (parsedTree) {
          analyzeParsedQuery(parsedTree, ctx);
          refs.parsed = true;
        }
      }
    } catch {
      refs.parsed = false;
    }
  }
  if (!refs.parsed) regexAnalyze(fn.src ?? fn.def ?? "", ctx);
  return refs;
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
      ? "SQL parser: pg-query-emscripten (WASM) loaded"
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
  let done = 0;
  for (const fn of candidates) {
    const start = Date.now();
    const refs = await analyzeFunc(fn, resolver, triggerRelsByFunc.get(fn.oid) ?? [], parser);
    out.set(fn.oid, refs);
    done++;
    log(
      `[${done}/${candidates.length}] ${fn.schema}.${fn.name}(): ` +
        `${refs.parsed ? "parsed" : "regex fallback"} — ` +
        `${refs.reads.size} read rels, ${refs.writes.size} write rels, ` +
        `${refs.calls.size} calls (${Date.now() - start} ms)`,
    );
  }
  return out;
}
