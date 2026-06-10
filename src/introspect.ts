import type { Client } from "pg";
import type {
  Catalog,
  CatalogCol,
  CatalogFunc,
  CatalogRel,
  CatalogTrigger,
  DefaultDep,
  Fk,
  RelKind,
  SqlBodyDep,
  ViewDep,
  ViewFuncDep,
} from "./types";

const REL_KINDS: Record<string, RelKind> = {
  r: "table",
  p: "table",
  v: "view",
  m: "matview",
  f: "foreign",
};

/** `$1` is always the (possibly NULL) text[] of schemas to include. */
function schemaPred(nspname: string): string {
  return `(CASE WHEN $1::text[] IS NULL
    THEN ${nspname} !~ '^pg_' AND ${nspname} <> 'information_schema'
    ELSE ${nspname} = ANY($1::text[]) END)`;
}

export async function introspect(client: Client, schemas: string[] | null): Promise<Catalog> {
  const params = [schemas];

  const rels: CatalogRel[] = (
    await client.query(
      `SELECT c.oid AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p','v','m','f') AND ${schemaPred("n.nspname")}`,
      params,
    )
  ).rows.map((r) => ({
    oid: Number(r.oid),
    schema: String(r.schema),
    name: String(r.name),
    kind: REL_KINDS[r.relkind] ?? "table",
  }));

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

  const funcs = await fetchFuncs(
    client,
    `p.prokind IN ('f','p') AND ${schemaPred("n.nspname")}`,
    params,
  );

  // Pull in trigger functions / view-called functions living outside the schema filter
  // (extensions etc.). System-schema functions are kept only when a trigger uses them.
  const relOids = new Set(rels.map((r) => r.oid));
  const known = new Set(funcs.map((f) => f.oid));
  const trigFnOids = new Set(triggers.map((t) => t.funcOid));
  const wanted = new Set<number>();
  for (const t of triggers) if (!known.has(t.funcOid)) wanted.add(t.funcOid);
  for (const d of viewFuncDeps) {
    if (relOids.has(d.viewOid) && !known.has(d.funcOid)) wanted.add(d.funcOid);
  }
  if (wanted.size > 0) {
    const extra = await fetchFuncs(client, `p.oid = ANY($1::oid[])`, [[...wanted]]);
    for (const f of extra) {
      const system = f.schema === "pg_catalog" || f.schema === "information_schema";
      if (!system || trigFnOids.has(f.oid)) funcs.push(f);
    }
  }

  return { rels, cols, triggers, funcs, viewDeps, viewFuncDeps, fks, sqlBodyDeps, defaultDeps };
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
