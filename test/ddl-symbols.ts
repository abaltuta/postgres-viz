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
  assert.equal(v.endLine, 4, "multi-line view range covers the full SELECT body");
}

const VIEW_WITHOUT_SEMICOLON = `-- reporting.recent_orders
SELECT o.id,
       o.created_at
FROM orders o`;

{
  const syms = parseDdlSymbols(VIEW_WITHOUT_SEMICOLON);
  const v = find(syms, "view", "reporting.recent_orders");
  assert.equal(
    v.endLine,
    3,
    "view ranges extend to the last SELECT line when pg_get_viewdef omits a semicolon",
  );
}

const CTE_VIEW = `-- reporting.order_totals
WITH totals AS (
  SELECT order_id, sum(amount) AS total
  FROM payments
)
SELECT order_id, total
FROM totals;`;

{
  const syms = parseDdlSymbols(CTE_VIEW);
  const v = find(syms, "view", "reporting.order_totals");
  assert.equal(v.line, 0, "CTE view symbol anchors at the comment line");
  assert.equal(v.endLine, 6, "CTE view range covers the full WITH/SELECT body");
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

  const sel = child(f, "statement", "SELECT payroll.run");
  assert.equal(sel.line, 5, "SELECT statement line inside the body");
  child(f, "statement", "INSERT INTO audit_log");
  child(f, "statement", "UPDATE payroll.run");
  assert.ok(
    !f.children.some((c) => c.name === "SELECT count"),
    "SELECT statements are named from their FROM target, not the select-list expression",
  );

  // NEW.x := assignment is a row mutation, NOT a DML statement
  assert.ok(
    !f.children.some((c) => c.name.includes("NEW") || c.name.includes("updated_at")),
    "NEW.col := assignment must not produce a statement symbol",
  );
}

// ── shape 3b: procedure header + CALL statement inside the body ──
const PROCEDURE = `CREATE OR REPLACE PROCEDURE payroll.run_audit()
 LANGUAGE plpgsql
AS $procedure$
BEGIN
  CALL payroll.refresh_audit();
END;
$procedure$`;

{
  const syms = parseDdlSymbols(PROCEDURE);
  const p = find(syms, "function", "payroll.run_audit");
  assert.equal(p.line, 0, "procedure header is treated as a routine symbol");
  child(p, "statement", "CALL payroll.refresh_audit");
}

// ── shape 4: trigger (single line) ──
const TRIGGER = `CREATE TRIGGER instruction_audit BEFORE UPDATE ON payroll.instruction FOR EACH ROW EXECUTE FUNCTION fn();`;

{
  const syms = parseDdlSymbols(TRIGGER);
  const t = find(syms, "trigger", "instruction_audit");
  assert.equal(t.line, 0);
  assert.equal(t.endLine, 0, "single-line symbol endLine equals its line");
}

const CONSTRAINT_TRIGGER = `CREATE CONSTRAINT TRIGGER instruction_check AFTER INSERT ON payroll.instruction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn();`;

{
  const syms = parseDdlSymbols(CONSTRAINT_TRIGGER);
  find(syms, "trigger", "instruction_check");
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

// ── quoted identifiers: names may contain spaces and escaped quotes ──
const QUOTED_TABLE = `-- Reporting.Active Orders (columns)
CREATE TABLE Reporting.Active Orders (
  "Display Name" text,
  CONSTRAINT "order ""positive""" CHECK (total > 0)
);`;

{
  const syms = parseDdlSymbols(QUOTED_TABLE);
  const t = find(syms, "table", "Reporting.Active Orders");
  child(t, "column", "Display Name");
  child(t, "constraint", 'order "positive"');
}

const QUOTED_CREATE = `CREATE UNIQUE INDEX CONCURRENTLY "Reporting"."Active Orders idx" ON "Reporting"."Active Orders" (id);
CREATE TRIGGER "audit trigger" BEFORE UPDATE ON "Reporting"."Active Orders" FOR EACH ROW EXECUTE FUNCTION fn();
CREATE OR REPLACE FUNCTION "Reporting"."refresh Audit"()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  CALL "Reporting"."do Refresh"();
END;
$function$`;

{
  const syms = parseDdlSymbols(QUOTED_CREATE);
  find(syms, "index", "Reporting.Active Orders idx");
  find(syms, "trigger", "audit trigger");
  const f = find(syms, "function", "Reporting.refresh Audit");
  child(f, "statement", "CALL Reporting.do Refresh");
}

const COMMENTED_FUNCTION = `-- not.the.function.name
CREATE FUNCTION public.real_name()
 RETURNS void
 LANGUAGE sql
AS $$ SELECT 1 $$`;

{
  const syms = parseDdlSymbols(COMMENTED_FUNCTION);
  find(syms, "function", "public.real_name");
  assert.ok(
    !syms.some((s) => s.name === "not.the.function.name"),
    "ordinary comments do not rename CREATE headers",
  );
}

const FUNCTION_WITH_DOLLAR_TAG_TEXT = `CREATE OR REPLACE FUNCTION public.taggy()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE NOTICE '$function$ is only text';
  UPDATE public.jobs SET touched = true;
END;
$function$;
CREATE INDEX jobs_touched_idx ON public.jobs (touched);`;

{
  const syms = parseDdlSymbols(FUNCTION_WITH_DOLLAR_TAG_TEXT);
  const f = find(syms, "function", "public.taggy");
  assert.equal(f.endLine, 8, "function closes on the standalone dollar tag line");
  child(f, "statement", "UPDATE public.jobs");
  find(syms, "index", "jobs_touched_idx");
}

const FUNCTION_IGNORES_NON_CODE_TEXT = `CREATE OR REPLACE FUNCTION public.literal_scan()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  SELECT 'FROM public.fake_source' FROM public.real_source;
  RAISE NOTICE $msg$
UPDATE public.fake_notice SET touched = true;
$msg$;
  /*
  INSERT INTO public.fake_comment VALUES (1);
  UPDATE public.fake_comment SET touched = true;
  */
  UPDATE public.real_target SET touched = true;
  UPDATE ONLY public.real_only_target SET touched = true;
  DELETE FROM ONLY public.real_only_target WHERE touched;
END;
$function$`;

{
  const syms = parseDdlSymbols(FUNCTION_IGNORES_NON_CODE_TEXT);
  const f = find(syms, "function", "public.literal_scan");
  child(f, "statement", "SELECT public.real_source");
  child(f, "statement", "UPDATE public.real_target");
  child(f, "statement", "UPDATE public.real_only_target");
  child(f, "statement", "DELETE FROM public.real_only_target");
  for (const stale of [
    "SELECT public.fake_source",
    "UPDATE public.fake_notice",
    "INSERT INTO public.fake_comment",
    "UPDATE public.fake_comment",
  ]) {
    assert.ok(
      !f.children.some((c) => c.name === stale),
      `routine body comments/strings must not produce stale statement symbol ${stale}`,
    );
  }
}

const SINGLE_QUOTED_FUNCTION = `CREATE FUNCTION public.one()
 RETURNS integer
 LANGUAGE sql
AS 'SELECT 1';
CREATE INDEX one_idx ON public.jobs (id);`;

{
  const syms = parseDdlSymbols(SINGLE_QUOTED_FUNCTION);
  const f = find(syms, "function", "public.one");
  assert.equal(f.endLine, 3, "single-quoted function bodies end at their semicolon");
  find(syms, "index", "one_idx");
}

const QUOTED_VIEW = `-- Reporting.Active Orders
 SELECT o.id
   FROM orders o;`;

{
  const syms = parseDdlSymbols(QUOTED_VIEW);
  const v = find(syms, "view", "Reporting.Active Orders");
  assert.equal(v.endLine, 2, "quoted view range includes the FROM line");
}

const STALE_COMMENT = `-- stale.name

SELECT 1;

-- stale.constraint

CHECK ((amount >= 0))`;

{
  const syms = parseDdlSymbols(STALE_COMMENT);
  assert.ok(
    !syms.some((s) => s.name === "stale.name"),
    "non-adjacent comments do not name later SELECT bodies",
  );
  find(syms, "constraint", "CHECK");
  assert.ok(
    !syms.some((s) => s.name === "stale.constraint"),
    "non-adjacent comments do not name later standalone constraints",
  );
}

// ── garbage input never throws ──
assert.deepEqual(parseDdlSymbols("%%%"), [], "garbage input returns [] without throwing");
assert.deepEqual(parseDdlSymbols(""), [], "empty input returns []");

console.log(
  "ddl-symbols OK — table/view/function/trigger/index/constraint shapes, nesting, anchors",
);
