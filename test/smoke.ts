/**
 * Smoke test for the function-body analyzer. Run with `pnpm smoke`.
 * Exercises both the libpg-query parser path and the regex fallback
 * against a small fake catalog — no database needed.
 */
import assert from "node:assert/strict";
import {
  analyzeFunc,
  byteOffsetToIndex,
  columnRefEnd,
  disposeParser,
  getParser,
  Resolver,
} from "../src/analyze";
import type { FuncRefs, PgParser } from "../src/analyze";
import { buildGraph } from "../src/graph";
import { routineNameFromLabel } from "../src/routine-label";
import type { Catalog, CatalogFunc, CatalogRel } from "../src/types";

const ORDERS = 1001;
const AUDIT_LOG = 1002;
const CUSTOMERS = 1003;
const LOG_ORDER_FN = 2001;
const NOTIFY_FN = 2002;

const rels: CatalogRel[] = [
  { oid: ORDERS, schema: "public", name: "orders", kind: "table" },
  { oid: AUDIT_LOG, schema: "public", name: "audit_log", kind: "table" },
  { oid: CUSTOMERS, schema: "public", name: "customers", kind: "table" },
];

const cols = [
  { relOid: ORDERS, attnum: 1, name: "id", type: "bigint" },
  { relOid: ORDERS, attnum: 2, name: "total", type: "numeric" },
  { relOid: ORDERS, attnum: 3, name: "customer_id", type: "bigint" },
  { relOid: ORDERS, attnum: 4, name: "Display Name", type: "text" },
  { relOid: AUDIT_LOG, attnum: 1, name: "id", type: "bigint" },
  { relOid: AUDIT_LOG, attnum: 2, name: "table_name", type: "text" },
  { relOid: AUDIT_LOG, attnum: 3, name: "payload", type: "jsonb" },
  { relOid: CUSTOMERS, attnum: 1, name: "id", type: "bigint" },
  { relOid: CUSTOMERS, attnum: 2, name: "name", type: "text" },
];

const body = `
DECLARE
  order_count int;
BEGIN
  SELECT count(*) INTO order_count FROM orders o WHERE o.customer_id = NEW.customer_id;
  INSERT INTO audit_log (table_name, payload) VALUES ('orders', to_jsonb(NEW));
  UPDATE customers SET name = name WHERE id = NEW.customer_id;
  PERFORM notify_stats();
  RETURN NEW;
END;
`;

const logOrderFn: CatalogFunc = {
  oid: LOG_ORDER_FN,
  schema: "public",
  name: "log_order",
  language: "plpgsql",
  kind: "f",
  args: "",
  returns: "trigger",
  src: body,
  def: `CREATE OR REPLACE FUNCTION public.log_order() RETURNS trigger LANGUAGE plpgsql AS $fn$${body}$fn$;`,
  hasSqlBody: false,
};

const notifyFn: CatalogFunc = {
  oid: NOTIFY_FN,
  schema: "public",
  name: "notify_stats",
  language: "plpgsql",
  kind: "f",
  args: "",
  returns: "void",
  src: "BEGIN RETURN; END;",
  def: null,
  hasSqlBody: false,
};

// SELECT-only BEFORE trigger fn that mutates NEW — must yield a MODIFIES
// attribution and zero write-family attributions (it issues no DML)
const PRORATION_FN = 2003;
const prorationBody = `
DECLARE
  supports boolean;
BEGIN
  SELECT o.total > 0 INTO supports FROM orders o WHERE o.id = NEW.id;
  IF NOT supports AND NEW.total = 0 THEN
    NEW.total := 1;
  END IF;
  RETURN NEW;
END;
`;
const prorationFn: CatalogFunc = {
  oid: PRORATION_FN,
  schema: "public",
  name: "enforce_proration",
  language: "plpgsql",
  kind: "f",
  args: "",
  returns: "trigger",
  src: prorationBody,
  def: `CREATE OR REPLACE FUNCTION public.enforce_proration() RETURNS trigger LANGUAGE plpgsql AS $fn$${prorationBody}$fn$;`,
  hasSqlBody: false,
};

const QUOTED_ASSIGN_FN = 2004;
const quotedAssignFn: CatalogFunc = {
  oid: QUOTED_ASSIGN_FN,
  schema: "public",
  name: "quoted_assign",
  language: "plpgsql",
  kind: "f",
  args: "",
  returns: "trigger",
  src: `BEGIN
  NEW."Display Name" := OLD."Display Name";
  RETURN NEW;
END;`,
  def: null,
  hasSqlBody: false,
};

const catalog: Pick<Catalog, "rels" | "cols" | "funcs"> = {
  rels,
  cols,
  funcs: [logOrderFn, notifyFn, prorationFn, quotedAssignFn],
};

assert.equal(byteOffsetToIndex("é.x", 3), 2, "UTF-8 byte offsets map to UTF-16 indices");
assert.equal(columnRefEnd('o."Display Name" + 1', 0), 16, "quoted column spans include qualifiers");

const ordersRel = rels[0]!;

const GRAPH_PARENT = 3001;
const GRAPH_CHILD = 3002;
const GRAPH_FN = 3003;

function emptyCatalog(overrides: Partial<Catalog>): Catalog {
  return {
    rels: [],
    cols: [],
    triggers: [],
    funcs: [],
    viewDeps: [],
    viewFuncDeps: [],
    fks: [],
    constraints: [],
    constraintFuncDeps: [],
    indexes: [],
    sqlBodyDeps: [],
    defaultDeps: [],
    ...overrides,
  };
}

function refs(overrides: Partial<FuncRefs>): FuncRefs {
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
    parsed: true,
    ...overrides,
  };
}

function hasRef(map: Map<number, Set<number>>, relOid: number, attnum: number): boolean {
  return map.get(relOid)?.has(attnum) ?? false;
}

function sqlFunc(oid: number, name: string, src: string): CatalogFunc {
  return {
    oid,
    schema: "public",
    name,
    language: "sql",
    kind: "f",
    args: "",
    returns: "void",
    src,
    def: null,
    hasSqlBody: false,
  };
}

async function runAnalyzerEdgeCaseSmoke(parser: PgParser, resolver: Resolver): Promise<void> {
  const qualifiedStar = await analyzeFunc(
    sqlFunc(
      2101,
      "qualified_star_scope",
      `
WITH picked AS (
  SELECT o.* FROM orders o JOIN customers c ON c.id = o.customer_id
)
SELECT picked.name FROM picked
`,
    ),
    resolver,
    [],
    parser,
  );
  assert.equal(qualifiedStar.parsed, true, "qualified-star SQL function should parse");
  assert.ok(hasRef(qualifiedStar.reads, CUSTOMERS, 1), "join condition reads customers.id");
  assert.equal(
    hasRef(qualifiedStar.reads, CUSTOMERS, 2),
    false,
    "SELECT o.* must not expose customers.name through the derived table",
  );

  const usingSibling = await analyzeFunc(
    sqlFunc(
      2102,
      "join_using_sibling_scope",
      "SELECT 1 FROM orders o, customers c JOIN audit_log a USING (id)",
    ),
    resolver,
    [],
    parser,
  );
  assert.equal(
    hasRef(usingSibling.reads, ORDERS, 1),
    false,
    "JOIN USING must not read columns from comma-sibling FROM items",
  );
  assert.ok(hasRef(usingSibling.reads, CUSTOMERS, 1), "JOIN USING reads customers.id");
  assert.ok(hasRef(usingSibling.reads, AUDIT_LOG, 1), "JOIN USING reads audit_log.id");

  const nestedCteShadow = await analyzeFunc(
    sqlFunc(
      2103,
      "nested_cte_shadow",
      `
SELECT count(*) FROM orders
WHERE EXISTS (
  WITH orders AS (SELECT 1)
  SELECT 1 FROM orders
)
`,
    ),
    resolver,
    [],
    parser,
  );
  assert.ok(
    hasRef(nestedCteShadow.reads, ORDERS, 0),
    "a nested CTE name must not hide an outer real relation read",
  );

  const joinAlias = await analyzeFunc(
    sqlFunc(
      2104,
      "join_alias",
      `SELECT j.total, j.customer_name
       FROM (orders o JOIN customers c ON c.id = o.customer_id)
         AS j(order_id, total, customer_id, display_name, customer_pk, customer_name)`,
    ),
    resolver,
    [],
    parser,
  );
  assert.ok(hasRef(joinAlias.reads, ORDERS, 2), "join alias column list resolves orders.total");
  assert.ok(
    hasRef(joinAlias.reads, CUSTOMERS, 2),
    "join alias column list resolves customers.name",
  );

  const naturalJoin = await analyzeFunc(
    sqlFunc(2105, "natural_join", "SELECT id FROM orders NATURAL JOIN customers"),
    resolver,
    [],
    parser,
  );
  assert.ok(hasRef(naturalJoin.reads, ORDERS, 1), "NATURAL JOIN reads the left merged key");
  assert.ok(hasRef(naturalJoin.reads, CUSTOMERS, 1), "NATURAL JOIN reads the right merged key");

  const outputAlias = await analyzeFunc(
    sqlFunc(2106, "output_alias", "SELECT o.total AS id FROM orders o ORDER BY id"),
    resolver,
    [],
    parser,
  );
  assert.ok(hasRef(outputAlias.reads, ORDERS, 2), "ORDER BY output alias keeps source provenance");
  assert.equal(
    hasRef(outputAlias.reads, ORDERS, 1),
    false,
    "ORDER BY output alias must not resolve to the input column with the same name",
  );

  const conflict = await analyzeFunc(
    sqlFunc(
      2107,
      "on_conflict",
      "INSERT INTO orders(id, total) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET total = excluded.total",
    ),
    resolver,
    [],
    parser,
  );
  assert.ok(hasRef(conflict.updates, ORDERS, 2), "ON CONFLICT assignment records an update");

  const merge = await analyzeFunc(
    sqlFunc(
      2108,
      "merge_actions",
      `MERGE INTO orders o USING customers c ON c.id = o.customer_id
       WHEN MATCHED AND c.name IS NULL THEN DELETE
       WHEN MATCHED THEN UPDATE SET total = 1
       WHEN NOT MATCHED THEN INSERT (id, total) VALUES (c.id, 0)`,
    ),
    resolver,
    [],
    parser,
  );
  assert.ok(hasRef(merge.deletes, ORDERS, 0), "MERGE DELETE records a delete operation");
  assert.ok(hasRef(merge.updates, ORDERS, 2), "MERGE UPDATE records its target column");
  assert.ok(hasRef(merge.inserts, ORDERS, 1), "MERGE INSERT records id");
  assert.ok(hasRef(merge.inserts, ORDERS, 2), "MERGE INSERT records total");
  assert.equal(merge.writes.size, 0, "classified MERGE actions do not emit generic writes");

  const ambiguous = await analyzeFunc(
    sqlFunc(2109, "ambiguous_join", "SELECT id FROM orders o JOIN customers c ON true"),
    resolver,
    [],
    parser,
  );
  assert.ok(
    ambiguous.diagnostics.some((diagnostic) => diagnostic.reason === "ambiguous"),
    "ambiguous unqualified columns produce diagnostics",
  );
  assert.equal(
    ambiguous.occurrences.some((occurrence) => occurrence.attnum === 1),
    false,
    "ambiguous columns never produce speculative occurrences",
  );
  assert.deepEqual(
    ambiguous.unresolved.get("reads"),
    new Set([ORDERS, CUSTOMERS]),
    "ambiguous candidates retain conservative table dependencies",
  );
  assert.ok(
    outputAlias.occurrences.some(
      (occurrence) =>
        occurrence.relOid === ORDERS && occurrence.attnum === 2 && occurrence.start != null,
    ),
    "parsed SQL definitions retain exact occurrence offsets",
  );
}

function runGraphBuilderSmoke(): void {
  const parent: CatalogRel = {
    oid: GRAPH_PARENT,
    schema: "public",
    name: "parents",
    kind: "table",
  };
  const child: CatalogRel = { oid: GRAPH_CHILD, schema: "public", name: "children", kind: "table" };
  const fn: CatalogFunc = {
    oid: GRAPH_FN,
    schema: "public",
    name: "touch_children",
    language: "sql",
    kind: "f",
    args: "tenant_id integer, amount numeric(12,2)",
    returns: "void",
    src: null,
    def: null,
    hasSqlBody: false,
  };
  const parentId = { relOid: GRAPH_PARENT, attnum: 1, name: "id", type: "bigint" };
  const childId = { relOid: GRAPH_CHILD, attnum: 1, name: "id", type: "bigint" };
  const childParentId = { relOid: GRAPH_CHILD, attnum: 2, name: "parent_id", type: "bigint" };
  const childStatus = { relOid: GRAPH_CHILD, attnum: 3, name: "status", type: "text" };
  const fk = {
    name: "children_parent_id_fkey",
    relOid: GRAPH_CHILD,
    refRelOid: GRAPH_PARENT,
    cols: [2],
    refCols: [1],
  };
  const analysisA = new Map<number, FuncRefs>([
    [GRAPH_FN, refs({ reads: new Map([[GRAPH_CHILD, new Set([3, 2])]]) })],
  ]);
  const analysisB = new Map<number, FuncRefs>([
    [GRAPH_FN, refs({ reads: new Map([[GRAPH_CHILD, new Set([2, 3])]]) })],
  ]);
  const graphA = buildGraph(
    emptyCatalog({
      rels: [child, parent],
      cols: [childStatus, parentId, childParentId, childId],
      funcs: [fn],
      fks: [fk],
    }),
    analysisA,
    { includeFks: true },
  );
  const graphB = buildGraph(
    emptyCatalog({
      rels: [parent, child],
      cols: [parentId, childId, childParentId, childStatus],
      funcs: [fn],
      fks: [fk],
    }),
    analysisB,
    { includeFks: true },
  );
  assert.deepEqual(graphB, graphA, "buildGraph output should be deterministic");
  const bundles = graphA.edges.filter((edge) => edge.data.agg);
  assert.equal(
    new Set(bundles.map((edge) => `${edge.data.source}|${edge.data.target}`)).size,
    bundles.length,
    "overview has at most one directed bundle per card pair",
  );
  for (const bundle of bundles) {
    assert.equal(
      Object.values(bundle.data.kinds ?? {}).reduce((sum, count) => sum + count, 0),
      bundle.data.count,
      "bundle count equals its per-kind counts",
    );
  }
  assert.equal(
    graphA.nodes.find((n) => n.data.id === "f3003")?.data.label,
    "touch_children(tenant_id integer, amount numeric(12,2))",
    "function graph labels include identity arguments",
  );
  assert.equal(
    routineNameFromLabel("touch_children(tenant_id integer, amount numeric(12,2))"),
    "touch_children",
    "routine-name extraction handles nested parentheses in argument types",
  );

  const truncatedFk = buildGraph(
    emptyCatalog({
      rels: [parent, child],
      cols: [parentId, childId, childParentId, childStatus],
      fks: [
        {
          name: "truncated_fk",
          relOid: GRAPH_CHILD,
          refRelOid: GRAPH_PARENT,
          cols: [2, 3],
          refCols: [1],
        },
      ],
    }),
    new Map(),
    { includeFks: true },
  );
  const fabricated = truncatedFk.edges.find(
    (e) => e.data.kind === "fk" && e.data.source === "c3002_3" && e.data.target === "c3001_1",
  );
  assert.equal(fabricated, undefined, "FK builder must not reuse the first ref column as fallback");
  const aggregate = truncatedFk.edges.find(
    (e) => e.data.kind === "fk" && e.data.source === "r3002" && e.data.target === "r3001",
  );
  assert.equal(aggregate?.data.count, 1, "FK aggregate counts only exact column pairs");
}

async function main(): Promise<void> {
  const resolver = new Resolver(catalog);

  // ── parser path ──
  const parser = await getParser();
  assert.ok(parser, "pg-query-emscripten failed to load — the WASM parser path is broken");

  const refs = await analyzeFunc(logOrderFn, resolver, [ordersRel], parser);
  assert.equal(refs.parsed, true, "expected the parser path, not the regex fallback");

  assert.ok(refs.reads.has(ORDERS), "orders should be read");
  assert.ok(refs.reads.get(ORDERS)!.has(3), "orders.customer_id should be read (incl. NEW.…)");

  assert.ok(refs.inserts.has(AUDIT_LOG), "audit_log should be inserted into");
  assert.ok(refs.inserts.get(AUDIT_LOG)!.has(2), "audit_log.table_name should be inserted");
  assert.ok(refs.inserts.get(AUDIT_LOG)!.has(3), "audit_log.payload should be inserted");

  assert.ok(refs.updates.has(CUSTOMERS), "customers should be updated");
  assert.ok(refs.updates.get(CUSTOMERS)!.has(2), "customers.name should be updated");

  assert.ok(refs.calls.has(NOTIFY_FN), "notify_stats() call should be detected");

  // ── trigger NEW-assignment: modifies, never a write ──
  const proration = await analyzeFunc(prorationFn, resolver, [ordersRel], parser);
  assert.ok(proration.modifies.has(ORDERS), "NEW.total := … modifies orders");
  assert.ok(proration.modifies.get(ORDERS)!.has(2), "…specifically orders.total");
  assert.equal(proration.writes.size, 0, "SELECT-only trigger fn has no generic writes");
  assert.equal(proration.updates.size, 0, "…no updates");
  assert.equal(proration.inserts.size, 0, "…no inserts");
  assert.equal(proration.deletes.size, 0, "…no deletes");
  assert.ok(proration.reads.has(ORDERS), "the SELECT still reads orders");

  const quotedAssign = await analyzeFunc(quotedAssignFn, resolver, [ordersRel], null);
  assert.equal(quotedAssign.parsed, false, "quoted assignment regression uses fallback scanner");
  assert.ok(
    quotedAssign.modifies.get(ORDERS)?.has(4),
    'quoted NEW."Display Name" assignment modifies the matching column',
  );

  // ── regex fallback path ──
  const fallback = await analyzeFunc(logOrderFn, resolver, [ordersRel], null);
  assert.equal(fallback.parsed, false);
  assert.ok(fallback.reads.has(ORDERS), "fallback: orders read");
  assert.ok(fallback.inserts.has(AUDIT_LOG), "fallback: audit_log inserted");
  assert.ok(fallback.updates.has(CUSTOMERS), "fallback: customers updated");
  assert.ok(fallback.calls.has(NOTIFY_FN), "fallback: notify_stats call");

  await runAnalyzerEdgeCaseSmoke(parser, resolver);

  runGraphBuilderSmoke();

  console.log("smoke OK — parser + fallback paths and graph builder checks passed");
  disposeParser();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
