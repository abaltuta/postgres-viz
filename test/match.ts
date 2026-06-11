/**
 * Tests for the symbol-search fuzzy matcher (`src/match.ts`) — runs in
 * `pnpm smoke`. Encodes why plain substring made "#" search feel broken:
 * qualified and skip-ahead queries must hit.
 */
import assert from "node:assert/strict";
import { fuzzyIncludes } from "../src/match";

// substring still works
assert.ok(fuzzyIncludes("instr", "payroll.instruction"));
assert.ok(fuzzyIncludes("payroll.instruction", "payroll.instruction"));

// in-order subsequence: skip-ahead chars hit (this is what '#' users type)
assert.ok(fuzzyIncludes("payinstr", "payroll.instruction"), "schema+name without the dot");
assert.ok(fuzzyIncludes("pr.instr", "payroll.instruction"), "partial schema, dot, partial name");
assert.ok(fuzzyIncludes("recpayfreq", "payroll.recurring_payrun.frequency_in_days"));

// case-insensitive both ways
assert.ok(fuzzyIncludes("INSTR", "payroll.instruction"));
assert.ok(fuzzyIncludes("instr", "PAYROLL.INSTRUCTION"));

// spaces in the query are ignored (quick-open habit)
assert.ok(fuzzyIncludes("payroll instr", "payroll.instruction"));

// empty query matches everything
assert.ok(fuzzyIncludes("", "anything"));

// out-of-order or absent chars do NOT match
assert.ok(!fuzzyIncludes("instruction.payroll", "payroll.instruction"), "wrong order");
assert.ok(!fuzzyIncludes("xyz", "payroll.instruction"));
assert.ok(!fuzzyIncludes("instructionz", "payroll.instruction"), "trailing miss");

console.log("match OK — subsequence fuzzy matching for # symbol search");
