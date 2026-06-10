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
 * pg-query-emscripten (the real Postgres parser compiled to WASM) is optional at
 * runtime: if it fails to load we fall back to regexes. Its API reports parse
 * failures via an `error` field rather than throwing — normalize to throws.
 */
export async function getParser(): Promise<PgParser | null> {
  if (cachedParser !== undefined) return cachedParser;
  try {
    const mod: Json = await import("pg-query-emscripten");
    const factory = typeof mod === "function" ? mod : (mod?.default ?? mod);
    const instance = typeof factory === "function" ? await factory() : factory;
    if (typeof instance?.parse !== "function" || typeof instance?.parsePlpgsql !== "function") {
      cachedParser = null;
      return cachedParser;
    }
    cachedParser = {
      async parseQuery(sql: string): Promise<Json> {
        const r = instance.parse(sql);
        if (r?.error) throw new Error(String(r.error.message ?? "parse error"));
        return r?.parse_tree;
      },
      async parsePlPgSQL(sql: string): Promise<Json> {
        const r = instance.parsePlpgsql(sql);
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

function analyzeStmt(stmt: Json, ctx: BodyCtx): void {
  const { resolver, schema, refs } = ctx;

  // CTE names shadow real relations of the same name.
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

  // Alias → relation map for column attribution.
  const aliases = new Map<string, CatalogRel>();
  walk(stmt, (tag, v) => {
    if (!isRangeVar(tag, v)) return;
    const rel = resolveRangeVar(v);
    if (!rel) return;
    const alias: string | undefined = v.alias?.aliasname;
    if (alias && !aliases.has(alias)) aliases.set(alias, rel);
    if (!aliases.has(v.relname)) aliases.set(v.relname, rel);
  });
  const aliasRels = [...new Set(aliases.values())];

  const readCol = (rel: CatalogRel, colName: string): void => {
    const col = resolver.col(rel.oid, colName);
    if (col) add(refs.reads, rel.oid, col.attnum);
  };

  walk(stmt, (tag, v) => {
    if (isRangeVar(tag, v)) {
      const rel = resolveRangeVar(v);
      if (!rel) return;
      add(writeTargets.has(v) ? refs.writes : refs.reads, rel.oid, 0);
      return;
    }
    switch (tag) {
      case "ColumnRef": {
        const fields: Json[] = v.fields ?? [];
        if (fields.length === 0) return;
        const star = isStar(fields[fields.length - 1]);
        const names = fields.map(fieldName);
        if (fields.length === 1) {
          const colName = names[0];
          if (star || !colName) return;
          const cands = aliasRels.filter((r) => resolver.col(r.oid, colName));
          if (cands.length === 1) readCol(cands[0]!, colName);
          return;
        }
        const qual = names[fields.length - 2];
        if (!qual) return;
        const colName = star ? undefined : names[fields.length - 1];
        const lower = qual.toLowerCase();
        if (lower === "new" || lower === "old") {
          if (colName) for (const rel of ctx.triggerRels) readCol(rel, colName);
          return;
        }
        let rel = aliases.get(qual);
        if (!rel && fields.length >= 3)
          rel = resolver.resolveRel(qual, names[fields.length - 3], schema);
        if (!rel) rel = resolver.resolveRel(qual, undefined, schema);
        if (!rel) return;
        if (colName) readCol(rel, colName);
        else add(refs.reads, rel.oid, 0);
        return;
      }
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
}

async function tryParse(parser: PgParser, sql: string): Promise<Json | null> {
  try {
    return await parser.parseQuery(sql);
  } catch {
    // PL/pgSQL expressions ("a + b") aren't full statements — retry as a SELECT.
    try {
      return await parser.parseQuery(`SELECT ${sql}`);
    } catch {
      return null;
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

export async function analyzeAll(catalog: Catalog): Promise<Map<number, FuncRefs>> {
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
  const out = new Map<number, FuncRefs>();
  for (const fn of catalog.funcs) {
    if (fn.language !== "plpgsql" && fn.language !== "sql") continue;
    // BEGIN ATOMIC bodies: pg_depend already has exact deps (see sqlBodyDeps).
    if (fn.language === "sql" && fn.hasSqlBody) continue;
    out.set(fn.oid, await analyzeFunc(fn, resolver, triggerRelsByFunc.get(fn.oid) ?? [], parser));
  }
  return out;
}
