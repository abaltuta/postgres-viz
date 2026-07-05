import assert from "node:assert/strict";
import {
  fetchDdl,
  quoteQualifiedSqlName,
  quoteSqlIdent,
  quoteSqlObjectName,
  renderTableDdl,
} from "../src/ddl";

assert.equal(quoteSqlIdent("orders"), '"orders"');
assert.equal(quoteSqlIdent('display"name'), '"display""name"');
assert.equal(quoteQualifiedSqlName("public.orders"), '"public"."orders"');
assert.equal(quoteQualifiedSqlName("Reporting.Active Orders"), '"Reporting"."Active Orders"');
assert.equal(quoteQualifiedSqlName("public.orders.v1"), '"public"."orders.v1"');
assert.equal(quoteQualifiedSqlName(".orders.v1"), '"orders.v1"');
assert.equal(
  quoteQualifiedSqlName('"Reporting.v2"."Active.Orders"'),
  '"Reporting.v2"."Active.Orders"',
);
assert.equal(
  quoteQualifiedSqlName('"odd""schema"."Active.Orders"'),
  '"odd""schema"."Active.Orders"',
);
assert.equal(
  quoteSqlObjectName({ schema: "Reporting.v2", name: "Active.Orders" }),
  '"Reporting.v2"."Active.Orders"',
  "structured schema/name quoting preserves dots inside identifiers",
);

async function main(): Promise<void> {
  const ddl = renderTableDdl("Reporting.Active Orders", [
    { name: "id", type: "bigint", notnull: true, def: "nextval('orders_id_seq'::regclass)" },
    { name: "Display Name", type: "text", def: null },
    { name: 'json"payload', type: "jsonb", def: "'{}'::jsonb" },
  ]);

  assert.match(ddl, /^-- Reporting\.Active Orders \(columns\)/, "comment anchor stays readable");
  assert.match(
    ddl,
    /CREATE TABLE "Reporting"\."Active Orders" \(/,
    "table names are quoted in generated DDL",
  );
  assert.match(ddl, /"id" bigint NOT NULL DEFAULT nextval/, "column metadata is rendered");
  assert.match(ddl, /"Display Name" text/, "column names with spaces are quoted");
  assert.match(ddl, /"json""payload" jsonb DEFAULT '\{\}'::jsonb/, "embedded quotes are escaped");

  const multilineLabelDdl = renderTableDdl("public.line\nbreak", []);
  assert.equal(
    multilineLabelDdl.split("\n")[0],
    "-- public.line break (columns)",
    "comment anchors stay on one line",
  );

  const missingConnectionDdl = await fetchDdl(undefined, "view", 1, "public.line\nbreak");
  assert.equal(
    missingConnectionDdl,
    "-- public.line break: connect in the Postgres Viz panel first",
    "fallback DDL comments flatten object-name newlines",
  );
  const schemaDdl = await fetchDdl("postgres://unused", "schema", 1, "public\nschema");
  assert.equal(
    schemaDdl,
    "-- public schema: schemas do not have generated DDL documents",
    "schema nodes never fall through to table-column DDL generation",
  );

  const dottedNameDdl = renderTableDdl(
    "Reporting.v2.Active.Orders",
    [{ name: "id", type: "bigint" }],
    { schema: "Reporting.v2", name: "Active.Orders", display: "Reporting.v2.Active.Orders" },
  );
  assert.match(
    dottedNameDdl,
    /CREATE TABLE "Reporting\.v2"\."Active\.Orders" \(/,
    "structured table names do not split dots inside identifiers",
  );

  console.log("ddl OK - generated table DDL quotes identifiers");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
