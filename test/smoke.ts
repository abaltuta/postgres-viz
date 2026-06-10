/**
 * Smoke test for the function-body analyzer. Run with `pnpm smoke`.
 * Exercises both the libpg-query parser path and the regex fallback
 * against a small fake catalog — no database needed.
 */
import assert from "node:assert/strict";
import { analyzeFunc, getParser, Resolver } from "../src/analyze";
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

const catalog: Pick<Catalog, "rels" | "cols" | "funcs"> = {
  rels,
  cols,
  funcs: [logOrderFn, notifyFn],
};

const ordersRel = rels[0]!;

async function main(): Promise<void> {
  const resolver = new Resolver(catalog);

  // ── parser path ──
  const parser = await getParser();
  assert.ok(parser, "pg-query-emscripten failed to load — the WASM parser path is broken");

  const refs = await analyzeFunc(logOrderFn, resolver, [ordersRel], parser);
  assert.equal(refs.parsed, true, "expected the parser path, not the regex fallback");

  assert.ok(refs.reads.has(ORDERS), "orders should be read");
  assert.ok(refs.reads.get(ORDERS)!.has(3), "orders.customer_id should be read (incl. NEW.…)");

  assert.ok(refs.writes.has(AUDIT_LOG), "audit_log should be written");
  assert.ok(refs.writes.get(AUDIT_LOG)!.has(2), "audit_log.table_name should be written");
  assert.ok(refs.writes.get(AUDIT_LOG)!.has(3), "audit_log.payload should be written");

  assert.ok(refs.writes.has(CUSTOMERS), "customers should be written");
  assert.ok(refs.writes.get(CUSTOMERS)!.has(2), "customers.name should be written");

  assert.ok(refs.calls.has(NOTIFY_FN), "notify_stats() call should be detected");

  // ── regex fallback path ──
  const fallback = await analyzeFunc(logOrderFn, resolver, [ordersRel], null);
  assert.equal(fallback.parsed, false);
  assert.ok(fallback.reads.has(ORDERS), "fallback: orders read");
  assert.ok(fallback.writes.has(AUDIT_LOG), "fallback: audit_log written");
  assert.ok(fallback.writes.has(CUSTOMERS), "fallback: customers written");
  assert.ok(fallback.calls.has(NOTIFY_FN), "fallback: notify_stats call");

  console.log("smoke OK — parser + fallback paths both detect reads/writes/calls");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
