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

table "payrun" {
  column "id" {
    type = bigint
  }
  schema = schema.payroll
}

// two-label form: first label is the schema
table "analytics" "employment_cost_group" {
  column "total_cost" {
    type = numeric
  }
}

table "analytics" "employment \\"cost\\" group" {
  column "Display \\"Name\\"" {
    type = text
  }
}

/*
table "ignored_comment_block" {
}
*/

table "commented" { /* } */
  /*
    schema = schema.fake
    }
  */
  schema = schema.public
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

trigger "employment_cost_group_touch" {
  on = table.analytics.employment_cost_group
}

trigger "quoted_owner_touch" {
  on = table["analytics"]["employment cost group"]
}

trigger "escaped_quoted_owner_touch" {
  on = table["analytics"]["employment \\"cost\\" group"]
}

function "escaped_schema_attr" {
  schema = schema["quoted \\"schema\\""]
}

# same-named functions in different schemas — schema must disambiguate
function "set_updated_at" {
  schema = schema.public
}

function "payroll" "set_updated_at" {
  lang = PLpgSQL
}

function "mirror" "mirror" {
}

  function "indented_helper" {
    schema = schema.public
  }

view "inline_view" { schema = schema.public }

trigger "inline_touch" { on = table.analytics.employment_cost_group }
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
const escapedTable = find(entries, "table", 'employment "cost" group');
assert.equal(escapedTable.schema, "analytics", "escaped labels are unescaped in two-label blocks");
assert.equal(find(entries, "table", "commented").schema, "public", "block comments do not affect brace depth");
assert.ok(
  !entries.some((e) => e.kind === "table" && e.name === "ignored_comment_block"),
  "commented-out block headers do not produce symbols",
);
assert.equal(find(entries, "view", "customer_orders").schema, "public");
assert.equal(find(entries, "view", "inline_view").schema, "public", "same-line schema attrs are parsed");
assert.equal(find(entries, "materialized", "order_stats").schema, "public");
assert.equal(find(entries, "function", "recalculate_totals").schema, "payroll");
assert.equal(
  find(entries, "function", "escaped_schema_attr").schema,
  'quoted "schema"',
  "bracketed schema attributes unescape quoted labels",
);
const mirror = find(entries, "function", "mirror");
const mirrorLine = FIXTURE.split("\n")[mirror.line]!;
const firstMirrorLabel = mirrorLine.indexOf('"mirror"');
assert.equal(
  mirror.col,
  mirrorLine.indexOf('"mirror"', firstMirrorLabel + 1) + 1,
  "duplicate two-label blocks point at the name label, not the schema label",
);

// trigger owner comes from `on = table.X`
const trg = find(entries, "trigger", "instruction_audit");
assert.equal(trg.owner, "instruction");
const schemaQualifiedTrigger = find(entries, "trigger", "employment_cost_group_touch");
assert.equal(schemaQualifiedTrigger.owner, "employment_cost_group");
assert.equal(schemaQualifiedTrigger.schema, "analytics");
const quotedOwnerTrigger = find(entries, "trigger", "quoted_owner_touch");
assert.equal(quotedOwnerTrigger.owner, "employment cost group");
assert.equal(quotedOwnerTrigger.schema, "analytics");
const escapedQuotedOwnerTrigger = find(entries, "trigger", "escaped_quoted_owner_touch");
assert.equal(escapedQuotedOwnerTrigger.owner, 'employment "cost" group');
assert.equal(escapedQuotedOwnerTrigger.schema, "analytics");
const inlineTrigger = find(entries, "trigger", "inline_touch");
assert.equal(inlineTrigger.owner, "employment_cost_group", "same-line trigger owners are parsed");
assert.equal(inlineTrigger.schema, "analytics");

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
assert.equal(find(entries, "column", 'Display "Name"').owner, 'employment "cost" group');

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
  find(entries, "function", "indented_helper").schema,
  "public",
  "top-level blocks may be indented",
);
assert.equal(
  map.get("function|||set_updated_at"),
  undefined,
  "the schema-less key is dropped as ambiguous — never jump to the wrong schema",
);
assert.ok(map.get("column|payroll|instruction|id"), "exact owner-qualified column key is kept");
assert.ok(map.get("column|payroll|payrun|id"), "second owner-qualified column key is kept");
assert.equal(
  map.get("column|payroll||id"),
  undefined,
  "the owner-less schema-qualified column key is dropped as ambiguous",
);
assert.equal(
  map.get("column|||id"),
  undefined,
  "the loose column key is dropped as ambiguous across owners",
);
assert.ok(map.get("table|payroll||instruction"), "unambiguous entries keep their qualified keys");
assert.ok(map.get("table|||instruction"), "unambiguous entries keep their loose keys too");

console.log(`hcl OK — ${entries.length} entries, both label forms, owners/schemas + ambiguity`);
