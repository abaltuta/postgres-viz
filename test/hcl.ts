/**
 * Tests for the Atlas-HCL symbol scanner (`src/hcl.ts`) — runs in `pnpm smoke`.
 * The fixture mirrors the real shapes found in GP/BPO schema files: single-
 * and two-label blocks, `schema =` declared before OR after children, trigger
 * `on =` owners, nested column/index/check/foreign_key, unnamed primary_key,
 * and braces inside string defaults (jsonb!).
 */
import assert from "node:assert/strict";
import { type HclEntry, indexEntries, parseHclSymbols } from "../src/hcl";

const FIXTURE = `schema "payroll" {
  comment = "payroll objects"
}

# single-label table, schema attribute AFTER the children
table "instruction" {
  column "id" {
    null = false
    type = bigint
  }
  column "payload" {
    type    = jsonb
    default = "{}"
  }
  index "instruction_status_idx" {
    columns = [column.status]
  }
  check "amount_positive" {
    expr = "amount >= 0"
  }
  foreign_key "fk_payrun" {
    columns     = [column.payrun_id]
    ref_columns = [table.payrun.column.id]
  }
  primary_key {
    columns = [column.id]
  }
  schema = schema.payroll
}

// two-label form: first label is the schema
table "analytics" "employment_cost_group" {
  column "total_cost" {
    type = numeric
  }
}

view "customer_orders" {
  schema = schema.public
}

materialized "order_stats" {
  schema = schema.public
}

function "recalculate_totals" {
  schema = schema.payroll
  lang   = SQL
}

trigger "instruction_audit" {
  on = table.instruction
  after {
    update = true
  }
}

# same-named functions in different schemas — schema must disambiguate
function "set_updated_at" {
  schema = schema.public
}

function "payroll" "set_updated_at" {
  lang = PLpgSQL
}
`;

function find(entries: HclEntry[], kind: string, name: string): HclEntry {
  const hit = entries.find((e) => e.kind === kind && e.name === name);
  assert.ok(hit, `entry not found: ${kind} "${name}"`);
  return hit;
}

const entries = parseHclSymbols(FIXTURE);

// top-level blocks, schema resolution in both forms
assert.equal(find(entries, "schema", "payroll").line, 0);
const instruction = find(entries, "table", "instruction");
assert.equal(instruction.schema, "payroll", "schema attribute declared after children");
assert.equal(instruction.line, 5);
const ecg = find(entries, "table", "employment_cost_group");
assert.equal(ecg.schema, "analytics", "two-label form: first label is the schema");
assert.equal(find(entries, "view", "customer_orders").schema, "public");
assert.equal(find(entries, "materialized", "order_stats").schema, "public");
assert.equal(find(entries, "function", "recalculate_totals").schema, "payroll");

// trigger owner comes from `on = table.X`
const trg = find(entries, "trigger", "instruction_audit");
assert.equal(trg.owner, "instruction");

// nested entries inherit owner + (late-declared) schema
const col = find(entries, "column", "id");
assert.equal(col.owner, "instruction");
assert.equal(col.schema, "payroll", "children backfilled with the block schema");
assert.equal(find(entries, "index", "instruction_status_idx").owner, "instruction");
assert.equal(find(entries, "check", "amount_positive").owner, "instruction");
assert.equal(find(entries, "foreign_key", "fk_payrun").owner, "instruction");

// brace counting survives "{}" string defaults: payload's siblings still parse
assert.equal(find(entries, "column", "payload").owner, "instruction");
assert.equal(find(entries, "column", "total_cost").owner, "employment_cost_group");

// unnamed primary_key blocks are skipped
assert.ok(!entries.some((e) => e.kind === "primary_key"), "unnamed primary_key produces no entry");

// column position points at the name label
assert.ok(col.line === 6 && col.col === lineCol(), "column line/col point at its label");
function lineCol(): number {
  return FIXTURE.split("\n")[6]!.indexOf('"id"') + 1;
}

// ── schema disambiguation: functions live in schemas, lookups must respect it ──
const map = indexEntries(entries.map((e) => ({ ...e, file: "schemas.hcl" })));
assert.equal(
  map.get("function|public||set_updated_at")?.line,
  find(entries, "function", "set_updated_at").line,
  "schema-qualified key resolves the public variant",
);
const payrollVariant = entries.filter(
  (e) => e.kind === "function" && e.name === "set_updated_at" && e.schema === "payroll",
)[0];
assert.ok(payrollVariant, "two-label function form: first label is the schema");
assert.equal(
  map.get("function|payroll||set_updated_at")?.line,
  payrollVariant.line,
  "schema-qualified key resolves the payroll variant",
);
assert.equal(
  map.get("function|||set_updated_at"),
  undefined,
  "the schema-less key is dropped as ambiguous — never jump to the wrong schema",
);
assert.ok(map.get("table|payroll||instruction"), "unambiguous entries keep their qualified keys");
assert.ok(map.get("table|||instruction"), "unambiguous entries keep their loose keys too");

console.log(`hcl OK — ${entries.length} entries, both label forms, owners/schemas + ambiguity`);
