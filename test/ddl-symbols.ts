/**
 * Tests for the pgviz: DDL symbol scanner (`src/ddl-symbols.ts`) — runs in
 * `pnpm smoke`. Fixtures mirror the exact text `fetchDdl` (src/extension.ts)
 * emits for every node type: the `-- schema.table (columns)` + CREATE TABLE
 * column listing, a view's `-- schema.name` + pg_get_viewdef SELECT, a
 * pg_get_functiondef body with embedded DML (and a `NEW.x :=` assignment that
 * must NOT become a statement), a single-line trigger/index, and a
 * `-- schema.name` + CHECK constraint. jsonb `'{}'` defaults must not break
 * column parsing.
 */
import assert from "node:assert/strict";
import { type DdlSymbol, parseDdlSymbols } from "../src/ddl-symbols";

function find(syms: DdlSymbol[], kind: string, name: string): DdlSymbol {
  const hit = syms.find((s) => s.kind === kind && s.name === name);
  assert.ok(hit, `symbol not found: ${kind} "${name}"`);
  return hit;
}

function child(parent: DdlSymbol, kind: string, name: string): DdlSymbol {
  const hit = parent.children.find((s) => s.kind === kind && s.name === name);
  assert.ok(hit, `child not found under ${parent.name}: ${kind} "${name}"`);
  return hit;
}

// ── shape 1: table + column listing (jsonb '{}' default must not break) ──
const TABLE = `-- payroll.instruction (columns)
CREATE TABLE payroll.instruction (
  id bigint NOT NULL DEFAULT nextval('seq'),
  status text NOT NULL,
  payload jsonb DEFAULT '{}',
  CONSTRAINT instruction_pkey PRIMARY KEY (id),
  CHECK (status <> '')
);`;

{
  const syms = parseDdlSymbols(TABLE);
  const t = find(syms, "table", "payroll.instruction");
  assert.equal(t.line, 1, "table header is on line 1 (0-based)");
  assert.equal(t.endLine, 7, "table block closes on the `);` line");

  const id = child(t, "column", "id");
  assert.equal(id.line, 2, "first column points at its own line");
  child(t, "column", "status");
  // jsonb '{}' default must not swallow following lines
  child(t, "column", "payload");

  // CONSTRAINT lines become constraint children, named when a name is present
  child(t, "constraint", "instruction_pkey");
  // bare CHECK keeps the keyword as the name
  child(t, "constraint", "CHECK");
  assert.ok(
    !t.children.some((c) => c.kind === "column" && c.name === "CONSTRAINT"),
    "CONSTRAINT lines are not parsed as columns",
  );
}

// ── shape 2: view (pg_get_viewdef SELECT) ──
const VIEW = `-- reporting.active_orders
 SELECT o.id,
    o.total
   FROM orders o
  WHERE o.status = 'active';`;

{
  const syms = parseDdlSymbols(VIEW);
  // name comes from the preceding -- schema.name comment
  const v = find(syms, "view", "reporting.active_orders");
  assert.equal(v.line, 0, "view symbol anchors at the comment line");
}

// ── shape 3: function with embedded DML + a NEW.x := assignment ──
const FUNC = `CREATE OR REPLACE FUNCTION payroll.audit_run(p_id bigint)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  SELECT count(*) INTO v_n FROM payroll.run WHERE id = p_id;
  INSERT INTO audit_log (run_id) VALUES (p_id);
  UPDATE payroll.run SET seen = true WHERE id = p_id;
  NEW.updated_at := now();
END;
$function$`;

{
  const syms = parseDdlSymbols(FUNC);
  const f = find(syms, "function", "payroll.audit_run");
  assert.equal(f.line, 0, "function header on line 0");
  assert.equal(f.endLine, 10, "function endLine is the closing $function$ line");

  const sel = child(f, "statement", "SELECT count");
  assert.equal(sel.line, 5, "SELECT statement line inside the body");
  child(f, "statement", "INSERT INTO audit_log");
  child(f, "statement", "UPDATE payroll.run");

  // NEW.x := assignment is a row mutation, NOT a DML statement
  assert.ok(
    !f.children.some((c) => c.name.includes("NEW") || c.name.includes("updated_at")),
    "NEW.col := assignment must not produce a statement symbol",
  );
}

// ── shape 4: trigger (single line) ──
const TRIGGER = `CREATE TRIGGER instruction_audit BEFORE UPDATE ON payroll.instruction FOR EACH ROW EXECUTE FUNCTION fn();`;

{
  const syms = parseDdlSymbols(TRIGGER);
  const t = find(syms, "trigger", "instruction_audit");
  assert.equal(t.line, 0);
  assert.equal(t.endLine, 0, "single-line symbol endLine equals its line");
}

// ── shape 5: UNIQUE INDEX (single line) ──
const INDEX = `CREATE UNIQUE INDEX instruction_status_idx ON payroll.instruction USING btree (status);`;

{
  const syms = parseDdlSymbols(INDEX);
  const i = find(syms, "index", "instruction_status_idx");
  assert.equal(i.line, 0);
}

// ── shape 6: standalone constraint (pg_get_constraintdef) ──
const CONSTRAINT = `-- payroll.amount_positive
CHECK ((amount >= 0))`;

{
  const syms = parseDdlSymbols(CONSTRAINT);
  // named from the preceding -- schema.name comment
  find(syms, "constraint", "payroll.amount_positive");
}

// ── garbage input never throws ──
assert.deepEqual(parseDdlSymbols("%%%"), [], "garbage input returns [] without throwing");
assert.deepEqual(parseDdlSymbols(""), [], "empty input returns []");

console.log(
  "ddl-symbols OK — table/view/function/trigger/index/constraint shapes, nesting, anchors",
);
