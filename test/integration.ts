/**
 * End-to-end integration test against a real Postgres (run with `pnpm test:db`,
 * which starts a disposable docker container). Loads a fixture schema covering
 * views, matviews, triggers (incl. UPDATE OF), PL/pgSQL bodies, FKs, generated
 * columns and BEGIN ATOMIC SQL functions, then runs the full
 * introspect → analyzeAll → buildGraph pipeline and asserts the edges.
 */
import assert from "node:assert/strict";
import { Client } from "pg";
import { analyzeAll } from "../src/analyze";
import { buildGraph } from "../src/graph";
import { introspect } from "../src/introspect";
import type { EdgeKind, GraphPayload, NodeType } from "../src/types";

const url = process.env.DATABASE_URL ?? "postgres://postgres:pg@localhost:54339/postgres";

const FIXTURE = `
CREATE TABLE customers (
  id bigint PRIMARY KEY,
  name text NOT NULL,
  email text
);

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
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await client.query(FIXTURE);

    const catalog = await introspect(client, null);
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
    assertEdge(g, "writes", logOrder, auditLog, "log_order writes audit_log");
    assertEdge(g, "writes", logOrder, auditTableName, "log_order writes audit_log.table_name");
    assertEdge(g, "writes", logOrder, auditPayload, "log_order writes audit_log.payload");
    assertEdge(g, "writes", logOrder, customersName, "log_order writes customers.name");
    assertEdge(g, "calls", logOrder, notifyStats, "log_order calls notify_stats");

    // BEGIN ATOMIC SQL function → exact deps from pg_depend
    assertEdge(g, "reads", totalFor, ordersTotal, "total_for uses orders.total");
    assertEdge(g, "reads", totalFor, ordersCustomerId, "total_for uses orders.customer_id");

    // FK column → column
    assertEdge(g, "fk", ordersCustomerId, customersId, "orders.customer_id → customers.id");

    // generated column → source column
    assertEdge(g, "default", ordersVat, ordersTotal, "orders.vat generated from orders.total");

    console.log(
      `integration OK — ${g.nodes.length} nodes, ${g.edges.length} edges, stats: ${JSON.stringify(g.stats)}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
