import type { Client } from "pg";
import type {
  Catalog,
  CatalogCol,
  CatalogConstraint,
  CatalogFunc,
  CatalogIndex,
  CatalogRel,
  CatalogTrigger,
  ConstraintFuncDep,
  DefaultDep,
  Fk,
  RelKind,
  SqlBodyDep,
  ViewDep,
  ViewFuncDep,
} from "./types";

export type Log = (msg: string) => void;

export interface SchemaFilter {
  /** explicit whitelist; null = all non-system schemas */
  include: string[] | null;
  /** schemas dropped when no whitelist is set (e.g. hdb_catalog) */
  exclude: string[];
}

const REL_KINDS: Record<string, RelKind> = {
  r: "table",
  p: "table",
  v: "view",
  m: "matview",
  f: "foreign",
};

/** `$1` = include whitelist (or NULL), `$2` = exclude list — in every query. */
function schemaPred(nspname: string): string {
  return `(CASE WHEN $1::text[] IS NULL
    THEN ${nspname} !~ '^pg_' AND ${nspname} <> 'information_schema'
         AND NOT (${nspname} = ANY($2::text[]))
    ELSE ${nspname} = ANY($1::text[]) END)`;
}

/** Objects installed by an extension (pgcrypto, uuid-ossp, …) are noise. */
function notExtensionOwned(classid: string, oid: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM pg_depend ext_dep
    WHERE ext_dep.classid = '${classid}'::regclass
      AND ext_dep.objid = ${oid}
      AND ext_dep.deptype = 'e')`;
}

function countBy<T>(items: T[], key: (item: T) => string): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return (
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n} ${k}`)
      .join(", ") || "none"
  );
}

export async function introspect(
  client: Client,
  filter: SchemaFilter,
  log: Log = () => {},
): Promise<Catalog> {
  const params: unknown[] = [filter.include, filter.exclude];
  log(
    filter.include
      ? `introspecting schemas: ${filter.include.join(", ")}`
      : `introspecting all non-system schemas${
          filter.exclude.length > 0 ? ` except: ${filter.exclude.join(", ")}` : ""
        }`,
  );

  let stepStart = Date.now();
  const took = (): string => {
    const ms = Date.now() - stepStart;
    stepStart = Date.now();
    return `${ms} ms`;
  };

  const rels: CatalogRel[] = (
    await client.query(
      `SELECT c.oid AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p','v','m','f') AND ${schemaPred("n.nspname")}
         AND ${notExtensionOwned("pg_class", "c.oid")}`,
      params,
    )
  ).rows.map((r) => ({
    oid: Number(r.oid),
    schema: String(r.schema),
    name: String(r.name),
    kind: REL_KINDS[r.relkind] ?? "table",
  }));
  log(`pg_class: ${rels.length} relations (${countBy(rels, (r) => r.kind)}) — ${took()}`);

  const cols: CatalogCol[] = (
    await client.query(
      `SELECT a.attrelid AS rel_oid, a.attnum AS attnum, a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE a.attnum > 0 AND NOT a.attisdropped
         AND c.relkind IN ('r','p','v','m','f') AND ${schemaPred("n.nspname")}`,
      params,
    )
  ).rows.map((r) => ({
    relOid: Number(r.rel_oid),
    attnum: Number(r.attnum),
    name: String(r.name),
    type: String(r.type),
  }));
  log(`pg_attribute: ${cols.length} columns — ${took()}`);

  const triggers: CatalogTrigger[] = (
    await client.query(
      `SELECT t.oid AS oid, t.tgname AS name, t.tgrelid AS rel_oid, t.tgfoid AS func_oid,
              t.tgtype AS tgtype, t.tgattr::int2[] AS update_cols
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE NOT t.tgisinternal AND ${schemaPred("n.nspname")}`,
      params,
    )
  ).rows.map((r) => ({
    oid: Number(r.oid),
    name: String(r.name),
    relOid: Number(r.rel_oid),
    funcOid: Number(r.func_oid),
    tgtype: Number(r.tgtype),
    updateCols: ((r.update_cols ?? []) as unknown[]).map(Number),
  }));
  log(`pg_trigger: ${triggers.length} user triggers — ${took()}`);

  // Column-level (and table-level) dependencies of view/matview rewrite rules.
  // This is exact: Postgres records which columns of which relations every view uses.
  const viewDeps: ViewDep[] = (
    await client.query(
      `SELECT DISTINCT r.ev_class AS view_oid, d.refobjid AS rel_oid, d.refobjsubid AS attnum
       FROM pg_depend d
       JOIN pg_rewrite r ON r.oid = d.objid
       WHERE d.classid = 'pg_rewrite'::regclass
         AND d.refclassid = 'pg_class'::regclass
         AND d.deptype = 'n'
         AND r.ev_class <> d.refobjid`,
    )
  ).rows.map((r) => ({
    viewOid: Number(r.view_oid),
    relOid: Number(r.rel_oid),
    attnum: Number(r.attnum),
  }));
  log(
    `pg_rewrite/pg_depend: ${viewDeps.length} view→relation deps ` +
      `(${viewDeps.filter((d) => d.attnum > 0).length} column-level) — ${took()}`,
  );

  const viewFuncDeps: ViewFuncDep[] = (
    await client.query(
      `SELECT DISTINCT r.ev_class AS view_oid, d.refobjid AS func_oid
       FROM pg_depend d
       JOIN pg_rewrite r ON r.oid = d.objid
       WHERE d.classid = 'pg_rewrite'::regclass
         AND d.refclassid = 'pg_proc'::regclass
         AND d.deptype = 'n'`,
    )
  ).rows.map((r) => ({ viewOid: Number(r.view_oid), funcOid: Number(r.func_oid) }));
  log(`pg_depend: ${viewFuncDeps.length} view→function deps — ${took()}`);

  const fks: Fk[] = (
    await client.query(
      `SELECT con.conname AS name, con.conrelid AS rel_oid, con.confrelid AS ref_rel_oid,
              con.conkey AS cols, con.confkey AS ref_cols
       FROM pg_constraint con
       WHERE con.contype = 'f'`,
    )
  ).rows.map((r) => ({
    name: String(r.name),
    relOid: Number(r.rel_oid),
    refRelOid: Number(r.ref_rel_oid),
    cols: ((r.cols ?? []) as unknown[]).map(Number),
    refCols: ((r.ref_cols ?? []) as unknown[]).map(Number),
  }));
  log(`pg_constraint: ${fks.length} foreign keys — ${took()}`);

  // CHECK / PRIMARY KEY / UNIQUE / EXCLUDE constraints (FKs are separate, as edges).
  const constraints: CatalogConstraint[] = (
    await client.query(
      `SELECT con.oid AS oid, con.conname AS name, con.conrelid AS rel_oid,
              con.contype::text AS contype, con.conkey AS cols,
              pg_get_constraintdef(con.oid, true) AS def
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE con.contype IN ('c','u','p','x') AND ${schemaPred("n.nspname")}`,
      params,
    )
  ).rows.map((r) => ({
    oid: Number(r.oid),
    name: String(r.name),
    relOid: Number(r.rel_oid),
    contype: String(r.contype),
    cols: ((r.cols ?? []) as unknown[]).map(Number),
    def: r.def === null || r.def === undefined ? null : String(r.def),
  }));
  const conNames: Record<string, string> = { c: "CHECK", p: "PK", u: "UNIQUE", x: "EXCLUDE" };
  log(
    `pg_constraint: ${constraints.length} constraints ` +
      `(${countBy(constraints, (c) => conNames[c.contype] ?? c.contype)}) — ${took()}`,
  );

  // Plain indexes. Constraint-backed ones (PK/UNIQUE/EXCLUDE) are skipped —
  // they already appear as constraint rows.
  const indexes: CatalogIndex[] = (
    await client.query(
      `SELECT i.indexrelid AS oid, ic.relname AS name, i.indrelid AS rel_oid,
              i.indkey::int2[] AS cols, pg_get_indexdef(i.indexrelid, 0, true) AS def
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${schemaPred("n.nspname")}
         AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)`,
      params,
    )
  ).rows.map((r) => ({
    oid: Number(r.oid),
    name: String(r.name),
    relOid: Number(r.rel_oid),
    cols: ((r.cols ?? []) as unknown[]).map(Number).filter((a) => a > 0),
    def: r.def === null || r.def === undefined ? null : String(r.def),
  }));
  log(`pg_index: ${indexes.length} plain indexes (constraint-backed excluded) — ${took()}`);

  // Functions referenced by constraint expressions (CHECK (my_fn(col)) …) — exact, from pg_depend.
  const constraintFuncDeps: ConstraintFuncDep[] = (
    await client.query(
      `SELECT DISTINCT d.objid AS con_oid, d.refobjid AS func_oid
       FROM pg_depend d
       WHERE d.classid = 'pg_constraint'::regclass
         AND d.refclassid = 'pg_proc'::regclass
         AND d.deptype = 'n'`,
    )
  ).rows.map((r) => ({ conOid: Number(r.con_oid), funcOid: Number(r.func_oid) }));
  log(`pg_depend: ${constraintFuncDeps.length} constraint→function deps — ${took()}`);

  // Exact relation deps of new-style (BEGIN ATOMIC) SQL functions — tracked by pg_depend.
  const sqlBodyDeps: SqlBodyDep[] = (
    await client.query(
      `SELECT DISTINCT d.objid AS func_oid, d.refobjid AS rel_oid, d.refobjsubid AS attnum
       FROM pg_depend d
       WHERE d.classid = 'pg_proc'::regclass
         AND d.refclassid = 'pg_class'::regclass
         AND d.deptype = 'n'`,
    )
  ).rows.map((r) => ({
    funcOid: Number(r.func_oid),
    relOid: Number(r.rel_oid),
    attnum: Number(r.attnum),
  }));
  log(`pg_depend: ${sqlBodyDeps.length} SQL-body (BEGIN ATOMIC) function deps — ${took()}`);

  // Column defaults & generated columns: what other columns/functions they reference.
  const defaultDeps: DefaultDep[] = (
    await client.query(
      `SELECT ad.adrelid AS rel_oid, ad.adnum AS attnum,
              CASE WHEN d.refclassid = 'pg_class'::regclass THEN d.refobjid END AS ref_rel_oid,
              CASE WHEN d.refclassid = 'pg_class'::regclass THEN d.refobjsubid END AS ref_attnum,
              CASE WHEN d.refclassid = 'pg_proc'::regclass THEN d.refobjid END AS ref_func_oid
       FROM pg_depend d
       JOIN pg_attrdef ad ON ad.oid = d.objid
       WHERE d.classid = 'pg_attrdef'::regclass
         AND d.deptype IN ('n','a')
         AND d.refclassid IN ('pg_class'::regclass, 'pg_proc'::regclass)
         AND NOT (d.refclassid = 'pg_class'::regclass
                  AND d.refobjid = ad.adrelid AND d.refobjsubid = ad.adnum)`,
    )
  ).rows.map((r) => ({
    relOid: Number(r.rel_oid),
    attnum: Number(r.attnum),
    refRelOid: r.ref_rel_oid === null ? null : Number(r.ref_rel_oid),
    refAttnum: r.ref_attnum === null ? null : Number(r.ref_attnum),
    refFuncOid: r.ref_func_oid === null ? null : Number(r.ref_func_oid),
  }));
  log(`pg_attrdef/pg_depend: ${defaultDeps.length} default/generated-column deps — ${took()}`);

  const funcs = await fetchFuncs(
    client,
    `p.prokind IN ('f','p') AND ${schemaPred("n.nspname")}
     AND ${notExtensionOwned("pg_proc", "p.oid")}`,
    params,
  );
  log(
    `pg_proc: ${funcs.length} functions/procedures ` +
      `(${countBy(funcs, (f) => f.language)}) — ${took()}`,
  );

  // Pull in trigger functions / view-called functions living outside the schema filter
  // (extensions etc.). System-schema functions are kept only when a trigger uses them.
  const relOids = new Set(rels.map((r) => r.oid));
  const known = new Set(funcs.map((f) => f.oid));
  const trigFnOids = new Set(triggers.map((t) => t.funcOid));
  const conOids = new Set(constraints.map((c) => c.oid));
  const wanted = new Set<number>();
  for (const t of triggers) if (!known.has(t.funcOid)) wanted.add(t.funcOid);
  for (const d of viewFuncDeps) {
    if (relOids.has(d.viewOid) && !known.has(d.funcOid)) wanted.add(d.funcOid);
  }
  for (const d of constraintFuncDeps) {
    if (conOids.has(d.conOid) && !known.has(d.funcOid)) wanted.add(d.funcOid);
  }
  if (wanted.size > 0) {
    const extra = await fetchFuncs(client, `p.oid = ANY($1::oid[])`, [[...wanted]]);
    let kept = 0;
    for (const f of extra) {
      const system = f.schema === "pg_catalog" || f.schema === "information_schema";
      if (!system || trigFnOids.has(f.oid)) {
        funcs.push(f);
        kept++;
      }
    }
    log(
      `pg_proc: ${kept} extra out-of-filter functions referenced by ` +
        `triggers/views/constraints (${wanted.size} candidates) — ${took()}`,
    );
  }

  return {
    rels,
    cols,
    triggers,
    funcs,
    viewDeps,
    viewFuncDeps,
    fks,
    constraints,
    constraintFuncDeps,
    indexes,
    sqlBodyDeps,
    defaultDeps,
  };
}

async function fetchFuncs(
  client: Client,
  where: string,
  params: unknown[],
): Promise<CatalogFunc[]> {
  const sql = (hasSqlBodyExpr: string) => `
    SELECT p.oid AS oid, n.nspname AS schema, p.proname AS name, l.lanname AS language,
           p.prokind::text AS kind,
           pg_get_function_identity_arguments(p.oid) AS args,
           format_type(p.prorettype, NULL) AS returns,
           p.prosrc AS src,
           CASE WHEN l.lanname IN ('plpgsql','sql') AND p.prokind IN ('f','p')
                THEN pg_get_functiondef(p.oid) END AS def,
           ${hasSqlBodyExpr} AS has_sql_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE ${where}`;

  let rows: Record<string, unknown>[];
  try {
    rows = (await client.query(sql("p.prosqlbody IS NOT NULL"), params)).rows;
  } catch {
    // prosqlbody only exists on PG 14+
    rows = (await client.query(sql("false"), params)).rows;
  }
  return rows.map((r) => ({
    oid: Number(r.oid),
    schema: String(r.schema),
    name: String(r.name),
    language: String(r.language),
    kind: String(r.kind),
    args: String(r.args ?? ""),
    returns: String(r.returns ?? ""),
    src: r.src === null || r.src === undefined ? null : String(r.src),
    def: r.def === null || r.def === undefined ? null : String(r.def),
    hasSqlBody: Boolean(r.has_sql_body),
  }));
}
