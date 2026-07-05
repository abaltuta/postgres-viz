import assert from "node:assert/strict";
import {
  indexSqlMigrationEntries,
  parseSqlMigrationSymbols,
  sqlMigrationKeyFromPath,
  type LocatedSqlMigrationEntry,
} from "../src/sql-migrations";

const FIXTURE = `-- semicolons inside the body must not split this routine
CREATE OR REPLACE FUNCTION public.recalculate_totals(p_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM refresh_totals();
END;
$$;

CREATE PROCEDURE public.refresh_audit()
LANGUAGE plpgsql
AS $proc$
BEGIN
  CALL public.recalculate_totals(1);
END;
$proc$;

CREATE VIEW reporting.active_orders AS SELECT 1 AS id;
CREATE RECURSIVE VIEW reporting.order_tree(id) AS SELECT 1 AS id;
CREATE MATERIALIZED VIEW reporting.order_stats AS SELECT 1 AS id;
CREATE TABLE public.orders (id bigint PRIMARY KEY);
CREATE INDEX orders_customer_idx ON public.orders (customer_id);

CREATE TRIGGER orders_audit
  AFTER INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.recalculate_totals();

CREATE TRIGGER orders_update_on_column
  AFTER UPDATE OF on ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.recalculate_totals();

ALTER TABLE public.orders ADD CONSTRAINT total_non_negative CHECK (total >= 0);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS created_at timestamptz;
CREATE VIEW "Reporting"."Active Orders" AS SELECT 1;
`;

function find(kind: string, name: string) {
  const hit = parseSqlMigrationSymbols(FIXTURE).find((e) => e.kind === kind && e.name === name);
  assert.ok(hit, `entry not found: ${kind} ${name}`);
  return hit;
}

const fn = find("function", "recalculate_totals");
assert.equal(fn.schema, "public");
assert.equal(fn.line, 1, "function line points at the CREATE line");
assert.ok(fn.col > 0, "function col points at the routine name");

assert.equal(find("procedure", "refresh_audit").schema, "public");
assert.equal(find("view", "active_orders").schema, "reporting");
assert.equal(find("view", "order_tree").schema, "reporting");
assert.equal(find("materialized", "order_stats").schema, "reporting");
assert.equal(find("table", "orders").schema, "public");
const idColumn = find("column", "id");
assert.equal(idColumn.schema, "public");
assert.equal(idColumn.owner, "orders", "CREATE TABLE columns resolve to their owning table");

const index = find("index", "orders_customer_idx");
assert.equal(index.schema, "public");
assert.equal(index.owner, "orders", "index owner comes from ON table");

const trigger = find("trigger", "orders_audit");
assert.equal(trigger.schema, "public");
assert.equal(trigger.owner, "orders", "multiline trigger owner comes from ON table");
assert.equal(
  find("trigger", "orders_update_on_column").owner,
  "orders",
  "UPDATE OF column named on does not hide the trigger table",
);

const constraint = find("constraint", "total_non_negative");
assert.equal(constraint.schema, "public");
assert.equal(constraint.owner, "orders");

const column = find("column", "created_at");
assert.equal(column.schema, "public");
assert.equal(column.owner, "orders");
assert.ok(
  !parseSqlMigrationSymbols(FIXTURE).some((e) => e.kind === "column" && e.name === "CONSTRAINT"),
  "ADD CONSTRAINT is not parsed as an ADD column",
);

const quoted = find("view", "Active Orders");
assert.equal(quoted.schema, "Reporting", "quoted identifiers keep their exact spelling");

const QUOTED_CHILD_SQL = `
CREATE TABLE "Reporting"."Order Lines" (
  "Line Id" bigint,
  CONSTRAINT "Order Lines PK" PRIMARY KEY ("Line Id")
);
CREATE INDEX "Order Lines Line Id Idx" ON "Reporting"."Order Lines" ("Line Id");
ALTER TABLE "Reporting"."Order Lines"
  ADD COLUMN "Display Total" numeric,
  ADD CONSTRAINT "Display Total Positive" CHECK ("Display Total" >= 0);
`;

const quotedChildEntries = parseSqlMigrationSymbols(QUOTED_CHILD_SQL);
for (const [kind, name] of [
  ["column", "Line Id"],
  ["constraint", "Order Lines PK"],
  ["index", "Order Lines Line Id Idx"],
  ["column", "Display Total"],
  ["constraint", "Display Total Positive"],
] as const) {
  const hit = quotedChildEntries.find((e) => e.kind === kind && e.name === name);
  assert.ok(hit, `quoted ${kind} found: ${name}`);
  assert.equal(hit.schema, "Reporting", `${name} schema keeps quoted spelling`);
  assert.equal(hit.owner, "Order Lines", `${name} owner keeps quoted spelling`);
}

const QUOTED_KEYWORD_COLUMN_SQL = `
CREATE TABLE public.keyword_columns (
  "CONSTRAINT" text,
  "LIKE" text
);
ALTER TABLE public.keyword_columns
  ADD COLUMN "PRIMARY" boolean,
  ADD COLUMN "CHECK" boolean;
`;

const quotedKeywordEntries = parseSqlMigrationSymbols(QUOTED_KEYWORD_COLUMN_SQL);
for (const name of ["CONSTRAINT", "LIKE", "PRIMARY", "CHECK"]) {
  const hit = quotedKeywordEntries.find((e) => e.kind === "column" && e.name === name);
  assert.ok(hit, `quoted keyword column found: ${name}`);
  assert.equal(hit.schema, "public", `${name} schema resolves`);
  assert.equal(hit.owner, "keyword_columns", `${name} owner resolves`);
}

const NOISE_SQL = `
-- CREATE TABLE public.comment_table (id bigint);
/* CREATE VIEW public.block_view AS SELECT 1; */
SELECT 'CREATE FUNCTION public.string_fn() RETURNS void' AS text;
SELECT E'escaped quote \\'; CREATE FUNCTION public.escape_string_fn() RETURNS void' AS text;
SELECT $$CREATE TABLE public.dollar_table (id bigint);$$;
SELECT "CREATE TABLE public.quoted_noise (id int)" FROM (SELECT 1) AS s;
/* outer block comment
  /* nested block comment */
  CREATE TABLE public.nested_comment_table (id bigint);
*/

CREATE TABLE Public.Real_Table (
  id bigint,
  note text DEFAULT 'CREATE VIEW public.embedded_view AS SELECT 1',
  amount numeric CONSTRAINT real_table_amount_check CHECK ((amount > 0) AND (amount < 10)),
  LIKE public.template INCLUDING DEFAULTS,
  CONSTRAINT real_table_pk PRIMARY KEY (id),
  "Display Name" text DEFAULT '{"label":"a,b"}'::jsonb
);

CREATE TABLE public.ctas_table AS SELECT make_interval(months => 1);
ALTER TABLE IF EXISTS Public.Real_Table
  ADD COLUMN IF NOT EXISTS New_Flag boolean,
  ADD COLUMN second_flag text DEFAULT 'a,b',
  ADD COLUMN constrained_flag boolean CONSTRAINT real_table_constrained_flag_check CHECK (constrained_flag IN (true, false)),
  ADD CONSTRAINT real_table_amount_positive CHECK ((amount > 0) AND (amount < 10)),
  ADD PRIMARY KEY (id);
`;

const noiseEntries = parseSqlMigrationSymbols(NOISE_SQL);
const noiseNames = new Set(noiseEntries.map((e) => `${e.kind}:${e.name}`));
for (const absent of [
  "table:comment_table",
  "view:block_view",
  "function:string_fn",
  "function:escape_string_fn",
  "table:dollar_table",
  "table:quoted_noise",
  "table:nested_comment_table",
  "view:embedded_view",
  "column:LIKE",
  "column:CONSTRAINT",
  "column:PRIMARY",
  "column:months",
]) {
  assert.ok(!noiseNames.has(absent), `comments/strings/CTAS do not produce ${absent}`);
}

const real = noiseEntries.find((e) => e.kind === "table" && e.name === "real_table");
assert.ok(real, "unquoted table identifiers are found");
assert.equal(real.schema, "public", "unquoted schema identifiers fold to lower case");

for (const name of [
  "id",
  "note",
  "amount",
  "Display Name",
  "new_flag",
  "second_flag",
  "constrained_flag",
]) {
  const hit = noiseEntries.find((e) => e.kind === "column" && e.name === name);
  assert.ok(hit, `column found: ${name}`);
  assert.equal(hit.schema, "public", `${name} schema is normalized`);
  assert.equal(hit.owner, "real_table", `${name} owner is normalized`);
}

for (const name of ["real_table_amount_check", "real_table_pk"]) {
  const hit = noiseEntries.find((e) => e.kind === "constraint" && e.name === name);
  assert.ok(hit, `CREATE TABLE named constraint found: ${name}`);
  assert.equal(hit.schema, "public", `${name} schema is normalized`);
  assert.equal(hit.owner, "real_table", `${name} owner is normalized`);
}

const alterConstraint = noiseEntries.find(
  (e) => e.kind === "constraint" && e.name === "real_table_amount_positive",
);
assert.ok(alterConstraint, "multi-action ALTER TABLE indexes named constraints");
assert.equal(alterConstraint.schema, "public");
assert.equal(alterConstraint.owner, "real_table");

const alterColumnConstraint = noiseEntries.find(
  (e) => e.kind === "constraint" && e.name === "real_table_constrained_flag_check",
);
assert.ok(alterColumnConstraint, "ALTER TABLE ADD COLUMN indexes named inline constraints");
assert.equal(alterColumnConstraint.schema, "public");
assert.equal(alterColumnConstraint.owner, "real_table");

const located = (file: string, migrationKey: string, sql: string): LocatedSqlMigrationEntry[] =>
  parseSqlMigrationSymbols(sql).map((entry) => ({ ...entry, file, migrationKey }));

assert.equal(
  sqlMigrationKeyFromPath("/workspace/db/migrations/001_create_users/up.sql"),
  "workspace/db/migrations/001_create_users",
  "migration key is the folder that owns up.sql",
);
assert.equal(
  sqlMigrationKeyFromPath("C:\\repo\\db\\migrations\\002_add_orders\\down.sql"),
  "C:/repo/db/migrations/002_add_orders",
  "migration key normalizes Windows separators",
);
assert.equal(
  sqlMigrationKeyFromPath("file:///repo/db/migrations/003_add_views/up.sql?cache=1#frag"),
  "repo/db/migrations/003_add_views",
  "migration key ignores URI query and fragment suffixes",
);

const map = indexSqlMigrationEntries([
  ...located(
    "migrations/001_create_fn/up.sql",
    "001_create_fn",
    `CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`,
  ),
  ...located(
    "migrations/010_replace_fn/up.sql",
    "010_replace_fn",
    `CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`,
  ),
  ...located(
    "migrations/011_payroll_fn/up.sql",
    "011_payroll_fn",
    `CREATE FUNCTION payroll.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`,
  ),
]);

assert.equal(
  map.get("function|public||set_updated_at")?.file,
  "migrations/010_replace_fn/up.sql",
  "latest matching migration wins inside the same schema",
);
assert.equal(
  map.get("function|||set_updated_at"),
  undefined,
  "schema-less key is dropped when schemas disagree",
);

const naturalMap = indexSqlMigrationEntries([
  ...located(
    "migrations/9_replace_fn/up.sql",
    sqlMigrationKeyFromPath("migrations/9_replace_fn/up.sql"),
    `CREATE OR REPLACE FUNCTION public.versioned_fn() RETURNS int LANGUAGE sql AS $$ SELECT 9 $$;`,
  ),
  ...located(
    "migrations/10_replace_fn/up.sql",
    sqlMigrationKeyFromPath("migrations/10_replace_fn/up.sql"),
    `CREATE OR REPLACE FUNCTION public.versioned_fn() RETURNS int LANGUAGE sql AS $$ SELECT 10 $$;`,
  ),
]);
assert.equal(
  naturalMap.get("function|public||versioned_fn")?.file,
  "migrations/10_replace_fn/up.sql",
  "latest matching migration uses numeric folder order, not lexicographic order",
);

const ownerMap = indexSqlMigrationEntries([
  ...located(
    "migrations/020_orders/up.sql",
    "020_orders",
    `CREATE TABLE public.orders (id bigint, total numeric);`,
  ),
  ...located(
    "migrations/021_customers/up.sql",
    "021_customers",
    `CREATE TABLE public.customers (id bigint);`,
  ),
]);

assert.equal(
  ownerMap.get("column|public|orders|id")?.file,
  "migrations/020_orders/up.sql",
  "owner-qualified column key resolves to the owning table",
);
assert.equal(
  ownerMap.get("column|public|customers|id")?.file,
  "migrations/021_customers/up.sql",
  "same column name resolves independently for a different owner",
);
assert.equal(
  ownerMap.get("column|public||id"),
  undefined,
  "owner-less key is dropped when owners disagree",
);
assert.equal(
  ownerMap.get("column|||id"),
  undefined,
  "fully loose key is dropped when owners disagree",
);

const upDownMap = indexSqlMigrationEntries([
  ...located(
    "migrations/030_refresh_view/down.sql",
    "030_refresh_view",
    `CREATE VIEW public.current_orders AS SELECT 0 AS id;`,
  ),
  ...located(
    "migrations/030_refresh_view/up.sql",
    "030_refresh_view",
    `CREATE VIEW public.current_orders AS SELECT 1 AS id;`,
  ),
]);

assert.equal(
  upDownMap.get("view|public||current_orders")?.file,
  "migrations/030_refresh_view/up.sql",
  "up.sql wins over down.sql for the same migration folder",
);

console.log(
  "sql-migrations OK - scanner, comments/strings, quoted names, owner matching, latest migration",
);
