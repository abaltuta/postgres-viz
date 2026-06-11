/**
 * End-to-end integration test against a real Postgres (run with `pnpm test:db`,
 * which starts a disposable docker container). Loads a fixture schema covering
 * views, matviews, triggers (incl. UPDATE OF), PL/pgSQL bodies, FKs, generated
 * columns and BEGIN ATOMIC SQL functions, then runs the full
 * introspect → analyzeAll → buildGraph pipeline and asserts the edges.
 */
import assert from "node:assert/strict";
import { Client } from "pg";
import { analyzeAll, disposeParser } from "../src/analyze";
import { buildGraph } from "../src/graph";
import { introspect } from "../src/introspect";
import type { EdgeKind, GraphPayload, NodeType } from "../src/types";

const url = process.env.DATABASE_URL ?? "postgres://postgres:pg@localhost:54339/postgres";

const FIXTURE = `
CREATE TABLE customers (
  id bigint PRIMARY KEY,
  name text NOT NULL,
  email text,
  updated_at timestamptz
);

-- Hasura-style generic trigger fn: writes a column of whatever table the
-- trigger is attached to, with no table name anywhere in the body
CREATE FUNCTION set_current_timestamp_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _new record;
BEGIN
  _new := NEW;
  _new."updated_at" = NOW();
  RETURN _new;
END $$;

CREATE TRIGGER customers_set_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_current_timestamp_updated_at();

CREATE TABLE orders (
  id bigint PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers(id),
  total numeric NOT NULL DEFAULT 0,
  vat numeric GENERATED ALWAYS AS (total * 0.19) STORED,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  table_name text,
  payload jsonb
);

CREATE VIEW customer_orders AS
  SELECT c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id;

CREATE MATERIALIZED VIEW order_stats AS
  SELECT customer_id, sum(total) AS sum_total FROM orders GROUP BY customer_id;

CREATE FUNCTION notify_stats() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('stats', '');
END $$;

CREATE FUNCTION log_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_count int;
BEGIN
  SELECT count(*) INTO order_count FROM orders o WHERE o.customer_id = NEW.customer_id;
  INSERT INTO audit_log (table_name, payload) VALUES ('orders', to_jsonb(NEW));
  UPDATE customers SET name = name WHERE id = NEW.customer_id;
  PERFORM notify_stats();
  RETURN NEW;
END $$;

CREATE TRIGGER orders_audit
  AFTER INSERT OR UPDATE OF total ON orders
  FOR EACH ROW EXECUTE FUNCTION log_order();

CREATE FUNCTION total_for(cid bigint) RETURNS numeric LANGUAGE sql BEGIN ATOMIC
  SELECT coalesce(sum(total), 0) FROM orders WHERE customer_id = cid;
END;

-- constraints: CHECK calling a function, on top of the PK/UNIQUE/FK above
CREATE FUNCTION non_negative(n numeric) RETURNS boolean IMMUTABLE LANGUAGE sql
  AS 'SELECT n >= 0';
ALTER TABLE orders ADD CONSTRAINT total_non_negative CHECK (non_negative(total));

-- alias gauntlet: CTE with column-list rename, named CTE outputs, derived-table
-- alias, and a correlated subquery referencing both
CREATE FUNCTION alias_gauntlet() RETURNS SETOF text LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  WITH recent(cid, amount) AS (
    SELECT o.customer_id, o.total FROM orders o
  ),
  named AS (
    SELECT c.email AS contact FROM customers c
  )
  SELECT n.contact
  FROM named n
  JOIN (SELECT r.cid FROM recent r WHERE r.amount > 10) rc ON rc.cid > 0
  WHERE EXISTS (
    SELECT 1 FROM customers cc WHERE cc.id = rc.cid AND cc.name <> n.contact
  );
END $$;

-- same alias bound to different tables in sibling subquery scopes
CREATE FUNCTION collision_check() RETURNS int LANGUAGE plpgsql AS $$
DECLARE x int;
BEGIN
  SELECT count(*) INTO x FROM (
    SELECT t.total FROM orders t
  ) a JOIN (
    SELECT t.email FROM customers t
  ) b ON true;
  RETURN x;
END $$;

-- aliased UPDATE target
CREATE FUNCTION touch_customer(cid bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE customers AS tgt SET email = tgt.name WHERE tgt.id = cid;
END $$;

-- ── shapes lifted from real BPO/EOR payroll migrations ──
CREATE SCHEMA payroll;

CREATE TABLE payroll.paycode (
  id bigint PRIMARY KEY,
  paycode_type text NOT NULL,
  currency text NOT NULL,
  exclude_from_validation boolean DEFAULT false
);

CREATE TABLE payroll.report_entry (
  id bigint PRIMARY KEY,
  payroll_report_id uuid NOT NULL,
  employee_id bigint NOT NULL,
  payroll_paycode_id bigint REFERENCES payroll.paycode (id),
  amount numeric NOT NULL
);

CREATE TABLE payroll.employee_totals (
  payroll_report_id uuid,
  employee_id bigint,
  paycode_type text,
  computed_total numeric
);

CREATE TABLE payroll.payrun (
  id bigint PRIMARY KEY,
  recurring_id bigint,
  cutoff_date date,
  finalized_at timestamptz
);

CREATE TABLE payroll.instruction (
  id bigint PRIMARY KEY,
  recurring_payrun_id bigint,
  status text
);

CREATE FUNCTION payroll.entry_amount(entry payroll.report_entry)
  RETURNS numeric IMMUTABLE LANGUAGE sql AS 'SELECT entry.amount';

-- modeled on payroll.calculate_report_submitted_employee_totals: old-style
-- LANGUAGE sql, a data-modifying CTE, aggregation, and a CTE re-read by alias
CREATE FUNCTION payroll.recalculate_totals(report_id uuid) RETURNS void LANGUAGE sql AS $fn$
WITH deleted AS (
  DELETE FROM payroll.employee_totals
  WHERE payroll_report_id = report_id
  RETURNING employee_id
),
computed AS (
  SELECT
    e.payroll_report_id,
    e.employee_id,
    p.paycode_type,
    SUM(payroll.entry_amount(e)) AS computed_total
  FROM payroll.report_entry e
  JOIN payroll.paycode p ON e.payroll_paycode_id = p.id
  WHERE e.payroll_report_id = report_id
    AND p.exclude_from_validation = FALSE
  GROUP BY e.payroll_report_id, e.employee_id, p.paycode_type
)
INSERT INTO payroll.employee_totals (payroll_report_id, employee_id, paycode_type, computed_total)
SELECT t.payroll_report_id, t.employee_id, t.paycode_type, COALESCE(t.computed_total, 0)
FROM computed t;
$fn$;

-- modeled on payroll.payrun_instruction_update_status: composite-type parameter
-- (Hasura computed-field style), EXISTS subquery, CASE over param fields
CREATE FUNCTION payroll.payrun_status(payrun payroll.payrun)
  RETURNS text STABLE LANGUAGE plpgsql AS $fn$
DECLARE
  cutoff date := payrun.cutoff_date;
  needs_review boolean;
BEGIN
  needs_review := EXISTS (
    SELECT 1
    FROM payroll.instruction i
    WHERE i.recurring_payrun_id = payrun.recurring_id
      AND i.status = 'NEEDS_REVIEW'
  );
  RETURN (
    SELECT CASE
      WHEN needs_review AND CURRENT_DATE > cutoff THEN 'OVERDUE'
      WHEN NOT needs_review AND (CURRENT_DATE > cutoff OR payrun.finalized_at IS NOT NULL)
        THEN 'COMPLETED'
      ELSE 'IN_PROGRESS'
    END
  );
END $fn$;
`;

async function connectWithRetry(attempts = 40): Promise<Client> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastErr = err;
      await client.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`could not connect to ${url}: ${String(lastErr)}`);
}

function nodeId(g: GraphPayload, type: NodeType, label: string, parentId?: string): string {
  const hit = g.nodes.find(
    (n) =>
      n.data.type === type &&
      n.data.label === label &&
      (parentId === undefined || n.data.parent === parentId),
  );
  assert.ok(hit, `node not found: ${type} ${label}${parentId ? ` (parent ${parentId})` : ""}`);
  return hit.data.id;
}

function assertEdge(
  g: GraphPayload,
  kind: EdgeKind,
  source: string,
  target: string,
  what: string,
): void {
  const hit = g.edges.find(
    (e) => e.data.kind === kind && e.data.source === source && e.data.target === target,
  );
  assert.ok(hit, `missing edge: ${what} (${kind} ${source} → ${target})`);
}

async function main(): Promise<void> {
  const client = await connectWithRetry();
  try {
    await client.query(
      "DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS payroll CASCADE;",
    );
    await client.query(FIXTURE);

    const catalog = await introspect(client, { include: null, exclude: [] });
    const analysis = await analyzeAll(catalog);
    const g = buildGraph(catalog, analysis, { includeFks: true });

    // relations
    const customers = nodeId(g, "table", "customers");
    const orders = nodeId(g, "table", "orders");
    const auditLog = nodeId(g, "table", "audit_log");
    const customerOrders = nodeId(g, "view", "customer_orders");
    const orderStats = nodeId(g, "matview", "order_stats");

    // referenced columns materialized as child nodes
    const customersName = nodeId(g, "column", "name", customers);
    const customersId = nodeId(g, "column", "id", customers);
    const ordersTotal = nodeId(g, "column", "total", orders);
    const ordersCustomerId = nodeId(g, "column", "customer_id", orders);
    const ordersVat = nodeId(g, "column", "vat", orders);
    const auditTableName = nodeId(g, "column", "table_name", auditLog);
    const auditPayload = nodeId(g, "column", "payload", auditLog);

    // functions & trigger
    const logOrder = nodeId(g, "function", "log_order()");
    const notifyStats = nodeId(g, "function", "notify_stats()");
    const totalFor = nodeId(g, "function", "total_for()");
    const trigger = nodeId(g, "trigger", "orders_audit", orders);

    // view → column-level deps (pg_depend)
    assertEdge(g, "selects", customerOrders, customersName, "view selects customers.name");
    assertEdge(g, "selects", customerOrders, ordersTotal, "view selects orders.total");
    assertEdge(g, "selects", orderStats, ordersCustomerId, "matview selects orders.customer_id");
    assertEdge(g, "selects", orderStats, ordersTotal, "matview selects orders.total");

    // trigger wiring
    assertEdge(g, "executes", trigger, logOrder, "trigger executes log_order");
    assertEdge(g, "update-of", trigger, ordersTotal, "trigger UPDATE OF total");

    // PL/pgSQL body analysis (parser path)
    const logOrderRefs = [...analysis.values()].find((r) => r.parsed);
    assert.ok(logOrderRefs, "at least one function should be analyzed via the parser");
    assertEdge(g, "reads", logOrder, orders, "log_order reads orders");
    assertEdge(
      g,
      "reads",
      logOrder,
      ordersCustomerId,
      "log_order reads orders.customer_id (incl. NEW.…)",
    );
    assertEdge(g, "inserts", logOrder, auditLog, "log_order inserts into audit_log");
    assertEdge(g, "inserts", logOrder, auditTableName, "log_order inserts audit_log.table_name");
    assertEdge(g, "inserts", logOrder, auditPayload, "log_order inserts audit_log.payload");
    assertEdge(g, "updates", logOrder, customersName, "log_order updates customers.name");
    assertEdge(g, "calls", logOrder, notifyStats, "log_order calls notify_stats");

    // BEGIN ATOMIC SQL function → exact deps from pg_depend
    assertEdge(g, "reads", totalFor, ordersTotal, "total_for uses orders.total");
    assertEdge(g, "reads", totalFor, ordersCustomerId, "total_for uses orders.customer_id");

    // FK column → column
    assertEdge(g, "fk", ordersCustomerId, customersId, "orders.customer_id → customers.id");

    // ── edge aggregation ──
    const fkDetail = g.edges.find(
      (e) =>
        e.data.kind === "fk" && e.data.source === ordersCustomerId && e.data.target === customersId,
    );
    assert.ok(fkDetail?.data.detail, "column-level fk edge is flagged detail");
    const fkAgg = g.edges.find(
      (e) => e.data.kind === "fk" && e.data.source === orders && e.data.target === customers,
    );
    assert.ok(fkAgg?.data.agg, "card-level fk aggregate orders→customers exists");
    assert.equal(fkAgg!.data.count, 1, "fk aggregate counts its member edges");
    assert.ok(fkAgg!.data.label, "fk aggregate carries the constraint name");
    const writesAgg = g.edges.find(
      (e) => e.data.kind === "inserts" && e.data.source === logOrder && e.data.target === auditLog,
    );
    assert.ok(writesAgg?.data.agg, "log_order→audit_log card edge is an aggregate");
    assert.equal(writesAgg!.data.count, 2, "aggregate counts table_name + payload writes");
    assert.ok(
      g.edges.every((e) => !("dup" in e.data)),
      "dup mechanism fully removed",
    );

    // generated column → source column
    assertEdge(g, "default", ordersVat, ordersTotal, "orders.vat generated from orders.total");

    // ── constraints ──
    const customersEmail = nodeId(g, "column", "email", customers);
    const customersPk = nodeId(g, "constraint", "customers_pkey", customers);
    const checkCon = nodeId(g, "constraint", "total_non_negative", orders);
    const nonNegative = nodeId(g, "function", "non_negative()");
    assertEdge(g, "constrains", customersPk, customersId, "PK constrains customers.id");
    assertEdge(g, "constrains", checkCon, ordersTotal, "CHECK constrains orders.total");
    assertEdge(g, "calls", checkCon, nonNegative, "CHECK calls non_negative()");

    // ── alias gauntlet: provenance through CTEs, derived tables, correlation ──
    const gauntlet = nodeId(g, "function", "alias_gauntlet()");
    assertEdge(
      g,
      "reads",
      gauntlet,
      ordersCustomerId,
      "WITH recent(cid…) rename → r.cid → rc.cid traces to orders.customer_id",
    );
    assertEdge(g, "reads", gauntlet, ordersTotal, "r.amount traces to orders.total");
    assertEdge(
      g,
      "reads",
      gauntlet,
      customersEmail,
      "named.contact → n.contact traces to customers.email",
    );
    assertEdge(g, "reads", gauntlet, customersId, "correlated cc.id read");
    assertEdge(
      g,
      "reads",
      gauntlet,
      nodeId(g, "column", "name", customers),
      "correlated cc.name read",
    );

    // sibling scopes reusing alias `t` must not cross-contaminate
    const collision = nodeId(g, "function", "collision_check()");
    assertEdge(g, "reads", collision, ordersTotal, "collision: t.total → orders.total");
    assertEdge(g, "reads", collision, customersEmail, "collision: t.email → customers.email");

    // aliased UPDATE target
    const touch = nodeId(g, "function", "touch_customer()");
    assertEdge(
      g,
      "updates",
      touch,
      customersEmail,
      "UPDATE … AS tgt SET email updates customers.email",
    );
    assertEdge(g, "reads", touch, customersName, "tgt.name read via target alias");
    assertEdge(g, "reads", touch, customersId, "tgt.id read via target alias");

    // generic trigger fn: assignment-target write lands on the attached table
    const setUpdatedAt = nodeId(g, "function", "set_current_timestamp_updated_at()");
    assertEdge(
      g,
      "writes",
      setUpdatedAt,
      nodeId(g, "column", "updated_at", customers),
      "set_current_timestamp_updated_at writes customers.updated_at via trigger attachment",
    );

    // ── real-world payroll shapes (BPO/EOR style) ──
    const entryTable = nodeId(g, "table", "report_entry");
    const paycode = nodeId(g, "table", "paycode");
    const totalsTable = nodeId(g, "table", "employee_totals");
    const payrunTable = nodeId(g, "table", "payrun");
    const instruction = nodeId(g, "table", "instruction");
    const recalc = nodeId(g, "function", "recalculate_totals()");
    const entryAmount = nodeId(g, "function", "entry_amount()");
    const payrunStatus = nodeId(g, "function", "payrun_status()");

    // LANGUAGE sql body with a data-modifying CTE + aggregation
    assertEdge(g, "deletes", recalc, totalsTable, "DELETE inside CTE deletes from employee_totals");
    assertEdge(
      g,
      "inserts",
      recalc,
      nodeId(g, "column", "computed_total", totalsTable),
      "INSERT column list inserts employee_totals.computed_total",
    );
    assertEdge(g, "reads", recalc, entryTable, "reads report_entry");
    assertEdge(
      g,
      "reads",
      recalc,
      nodeId(g, "column", "payroll_paycode_id", entryTable),
      "join key e.payroll_paycode_id read",
    );
    assertEdge(
      g,
      "reads",
      recalc,
      nodeId(g, "column", "paycode_type", paycode),
      "p.paycode_type read in CTE, re-read through alias t",
    );
    assertEdge(
      g,
      "reads",
      recalc,
      nodeId(g, "column", "exclude_from_validation", paycode),
      "p.exclude_from_validation filter read",
    );
    assertEdge(g, "calls", recalc, entryAmount, "schema-qualified payroll.entry_amount() call");

    // schema grouping: relations and functions nest inside schema compounds
    const publicSchema = nodeId(g, "schema", "public");
    const payrollSchema = nodeId(g, "schema", "payroll");
    assert.equal(
      g.nodes.find((n) => n.data.id === customers)!.data.parent,
      publicSchema,
      "customers table nests inside the public schema compound",
    );
    assert.equal(
      g.nodes.find((n) => n.data.id === paycode)!.data.parent,
      payrollSchema,
      "paycode table nests inside the payroll schema compound",
    );
    assert.equal(
      g.nodes.find((n) => n.data.id === recalc)!.data.parent,
      payrollSchema,
      "recalculate_totals() nests inside the payroll schema compound",
    );

    // composite-type parameter fields attribute to the rowtype's table
    assertEdge(
      g,
      "reads",
      payrunStatus,
      nodeId(g, "column", "cutoff_date", payrunTable),
      "payrun.cutoff_date (composite param) traces to payroll.payrun",
    );
    assertEdge(
      g,
      "reads",
      payrunStatus,
      nodeId(g, "column", "finalized_at", payrunTable),
      "payrun.finalized_at traces to payroll.payrun",
    );
    assertEdge(g, "reads", payrunStatus, instruction, "EXISTS subquery reads instruction");
    assertEdge(
      g,
      "reads",
      payrunStatus,
      nodeId(g, "column", "status", instruction),
      "i.status read inside EXISTS",
    );

    console.log(
      `integration OK — ${g.nodes.length} nodes, ${g.edges.length} edges, stats: ${JSON.stringify(g.stats)}`,
    );
  } finally {
    await client.end();
    disposeParser();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
