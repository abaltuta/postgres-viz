/**
 * Headless-cytoscape regression tests for the webview's view logic
 * (`webview/core.ts`). Runs in plain Node as part of `pnpm smoke` — no DOM,
 * no database. Each block encodes a bug that shipped once:
 *
 *  1. call-tree traversal (trigger → executed fn → transitive callees + the
 *     tables they touch + the root's callers)
 *  2. "NO CONNECTIONS" panel: a row node removed and re-added by
 *     dematerialize/materialize leaves stale references edge-less — consumers
 *     must re-resolve by id
 *  3. call-tree fitted way too big: `:visible` is stale right after batched
 *     class changes, so fits must use the class-derived shown set
 */
import assert from "node:assert/strict";
import cytoscape, { Core, NodeSingular } from "cytoscape";
import {
  allCardUnits,
  applyKeepMask,
  callTreeClosure,
  fitTarget,
  isShownByClasses,
  resetViewState,
  restorePositions,
  snapshotPositions,
  suppressRedundantAggs,
  unitOf,
} from "../webview/core";

function build(): Core {
  return cytoscape({
    headless: true,
    elements: {
      nodes: [
        { data: { id: "orders", type: "table" } },
        { data: { id: "trg", type: "trigger", parent: "orders" } },
        { data: { id: "audit", type: "table" } },
        { data: { id: "audit_payload", type: "column", parent: "audit" } },
        { data: { id: "f1", type: "function" } },
        { data: { id: "f2", type: "function" } },
        { data: { id: "f3", type: "function" } },
        { data: { id: "unrelated", type: "table" } },
      ],
      edges: [
        // trigger executes f1 — a row endpoint makes it a detail edge
        { data: { id: "e1", source: "trg", target: "f1", kind: "executes", detail: true } },
        { data: { id: "e2", source: "f1", target: "f2", kind: "calls" } },
        { data: { id: "e3", source: "f2", target: "audit", kind: "inserts" } },
        // context: f3 calls the root function f1
        { data: { id: "e4", source: "f3", target: "f1", kind: "calls" } },
      ],
    },
  });
}

// ── 1. call-tree closure from a trigger ──
{
  const cy = build();
  const trg = cy.getElementById("trg") as unknown as NodeSingular;
  assert.equal(unitOf(trg).id(), "orders", "unitOf(row) is its card");
  const { fns, keep, roots } = callTreeClosure(cy, trg);
  assert.deepEqual([...fns].sort(), ["f1", "f2"], "trigger → f1 → f2 transitive closure");
  assert.deepEqual([...roots], ["f1"], "the executed function is the root");
  assert.ok(keep.has("orders"), "the trigger's own table is kept");
  assert.ok(keep.has("audit"), "tables the closure writes are kept");
  assert.ok(keep.has("f3"), "direct callers of the root are kept for context");
  assert.ok(!keep.has("unrelated"), "untouched tables stay out");

  // depth limiting: levels count from the seed functions
  const lvl1 = callTreeClosure(cy, trg, 1);
  assert.deepEqual([...lvl1.fns], ["f1"], "1 level = just the executed function");
  assert.ok(!lvl1.keep.has("f2"), "level-2 callee excluded at depth 1");
  assert.ok(!lvl1.keep.has("audit"), "tables touched only by deeper levels excluded");
  const lvl2 = callTreeClosure(cy, trg, 2);
  assert.deepEqual([...lvl2.fns].sort(), ["f1", "f2"], "2 levels = seed + direct callees");
  assert.ok(lvl2.keep.has("audit"), "depth 2 brings f2's tables back");
}

// ── 2. stale row reference after dematerialize/materialize ──
{
  const cy = build();
  const stale = cy.getElementById("trg") as unknown as NodeSingular;
  // dematerializeAll removes row nodes (their edges go with them) …
  cy.remove(cy.getElementById("trg"));
  // … and a later materializeCard adds the same ids as NEW elements (cy.add,
  // not restore — the stale reference stays detached)
  cy.add([
    { group: "nodes", data: { id: "trg", type: "trigger", parent: "orders" } },
    {
      group: "edges",
      data: { id: "e1", source: "trg", target: "f1", kind: "executes", detail: true },
    },
  ]);
  assert.equal(
    stale.connectedEdges().length,
    0,
    "the stale reference is detached — using it rendered the empty panel",
  );
  const fresh = cy.getElementById("trg") as unknown as NodeSingular;
  assert.ok(fresh.nonempty(), "re-resolving by id finds the live node");
  assert.equal(fresh.connectedEdges().length, 1, "the live node still has its executes edge");
  const { fns } = callTreeClosure(cy, fresh);
  assert.deepEqual([...fns].sort(), ["f1", "f2"], "closure works from the re-resolved node");
}

// ── 3. fit target derives from classes, not (stale) computed style ──
{
  const cy = build();
  cy.batch(() => {
    for (const id of ["audit", "f2", "f3", "unrelated"]) {
      cy.getElementById(id).addClass("focus-hidden");
    }
  });
  // immediately after the batch — exactly when fitView runs in the webview
  const target = fitTarget(cy);
  const ids = new Set(target.map((e) => e.id()));
  assert.ok(ids.has("trg") && ids.has("f1"), "shown leaves are fitted");
  assert.ok(!ids.has("unrelated") && !ids.has("f2"), "class-hidden nodes are not fitted");
  assert.ok(
    !ids.has("audit_payload"),
    "children of a hidden card are excluded via the ancestor walk",
  );
  assert.equal(
    isShownByClasses(cy.getElementById("audit_payload") as unknown as NodeSingular),
    false,
    "isShownByClasses checks ancestors",
  );
  // a fully hidden graph falls back to everything rather than fitting nothing
  cy.nodes().addClass("focus-hidden");
  assert.equal(fitTarget(cy).length, cy.elements().length, "all-hidden falls back to all");
}

// ── 4. panel rows: table-level aggregates are noise when their columns show ──
{
  const rows = [
    // reads with column detail present → aggregate suppressed
    { kind: "reads", agg: true, counterUnit: "recurring_payrun", out: true, label: "rp table" },
    { kind: "reads", detail: true, counterUnit: "recurring_payrun", out: true, label: "rp.type" },
    { kind: "reads", detail: true, counterUnit: "recurring_payrun", out: true, label: "rp.id" },
    // modifies with column detail present → aggregate suppressed
    { kind: "modifies", agg: true, counterUnit: "instruction", out: true, label: "instr table" },
    { kind: "modifies", detail: true, counterUnit: "instruction", out: true, label: "proration" },
    // whole-table-only relationship (no detail) → aggregate STAYS
    { kind: "deletes", agg: true, counterUnit: "employee_totals", out: true, label: "et table" },
    // same pair, different kind → unrelated detail must not suppress it
    { kind: "writes", agg: true, counterUnit: "recurring_payrun", out: true, label: "w table" },
    // same kind+unit but opposite direction → not suppressed
    { kind: "reads", agg: true, counterUnit: "recurring_payrun", out: false, label: "read by" },
  ];
  const kept = suppressRedundantAggs(rows).map((r) => r.label);
  assert.deepEqual(
    kept,
    ["rp.type", "rp.id", "proration", "et table", "w table", "read by"],
    "aggregates with column detail vanish; whole-table-only and cross-kind/direction stay",
  );
}

// ── 5. view-state class ownership: reset strips ONLY view-owned classes ──
{
  const cy = build();
  const n = cy.getElementById("orders");
  n.addClass("focus-hidden untouched-hidden dimmed revealed hot hover-reveal matched");
  n.addClass("hidden-el isolated-hidden virtual-card"); // filter/structure-owned
  const e = cy.getElementById("e2");
  e.addClass("revealed agg-suppressed edge-off ortho");
  resetViewState(cy);
  for (const owned of ["focus-hidden", "untouched-hidden", "dimmed", "revealed", "hot"]) {
    assert.ok(!n.hasClass(owned), `view-owned class ${owned} stripped`);
  }
  assert.ok(!n.hasClass("hover-reveal") && !n.hasClass("matched"), "highlight layer stripped");
  assert.ok(!e.hasClass("revealed") && !e.hasClass("agg-suppressed"), "edge highlights stripped");
  for (const kept of ["hidden-el", "isolated-hidden", "virtual-card"]) {
    assert.ok(n.hasClass(kept), `filter/structure class ${kept} survives a view reset`);
  }
  assert.ok(e.hasClass("edge-off") && e.hasClass("ortho"), "edge structure classes survive");
}

// ── 6. position snapshot/restore survives the dematerialize round-trip ──
// (the drift bug: parents weren't saved, so cards materialized BEFORE a view
// were stranded at the view layout's position on exit)
{
  const cy = cytoscape({
    headless: true,
    elements: {
      nodes: [
        { data: { id: "card" } },
        { data: { id: "r1", parent: "card" } },
        { data: { id: "r2", parent: "card" } },
        { data: { id: "fn" } },
      ],
      edges: [],
    },
  });
  // def-level positions are ignored in the {nodes, edges} init form — set them
  cy.getElementById("r1").position({ x: 90, y: 190 });
  cy.getElementById("r2").position({ x: 110, y: 210 });
  cy.getElementById("fn").position({ x: 500, y: 500 });
  const saved = snapshotPositions(cy);
  assert.ok(saved.has("card"), "compound parents ARE snapshotted (their derived center)");
  const center = saved.get("card")!;
  assert.ok(Math.abs(center.x - 100) < 1 && Math.abs(center.y - 200) < 1, "center of children");
  // a view now moves everything, then dematerializes the card's rows
  cy.getElementById("fn").position({ x: -50, y: -60 });
  cy.nodes("[parent]").forEach((r) => {
    r.position({ x: 999, y: 999 });
  });
  cy.remove(cy.getElementById("card").children()); // demat: card becomes childless
  cy.getElementById("card").position({ x: 777, y: 777 }); // stranded at view position
  restorePositions(cy, saved);
  const c = cy.getElementById("card").position();
  assert.ok(Math.abs(c.x - 100) < 1 && Math.abs(c.y - 200) < 1, "card restored to base center");
  const f = cy.getElementById("fn").position();
  assert.equal(`${f.x},${f.y}`, "500,500", "standalone node restored");
}

// ── 7. keep-mask: non-keep units hidden with descendants, empty schemas hidden ──
{
  const cy = cytoscape({
    headless: true,
    elements: {
      nodes: [
        { data: { id: "s1", type: "schema" } },
        { data: { id: "a", type: "table", parent: "s1" } },
        { data: { id: "a_col", type: "column", parent: "a" } },
        { data: { id: "b", type: "table", parent: "s1" } },
        { data: { id: "s2", type: "schema" } },
        { data: { id: "c", type: "table", parent: "s2" } },
        { data: { id: "f1", type: "function" } },
      ],
      edges: [],
    },
  });
  const units = allCardUnits(cy).map((u) => u.id());
  assert.deepEqual(units.sort(), ["a", "b", "c", "f1"], "units = cards + standalones, no rows");
  applyKeepMask(cy, new Set(["a", "f1"]));
  assert.ok(!cy.getElementById("a").hasClass("focus-hidden"), "kept card visible");
  assert.ok(!cy.getElementById("a_col").hasClass("focus-hidden"), "kept card's rows visible");
  assert.ok(cy.getElementById("b").hasClass("focus-hidden"), "non-keep card hidden");
  assert.ok(cy.getElementById("c").hasClass("focus-hidden"), "non-keep card in s2 hidden");
  assert.ok(
    cy.getElementById("s2").hasClass("focus-hidden"),
    "schema with no visible child hidden",
  );
  assert.ok(!cy.getElementById("s1").hasClass("focus-hidden"), "schema with a kept child stays");
  assert.ok(!cy.getElementById("f1").hasClass("focus-hidden"), "kept standalone stays");
}

console.log(
  "webview OK — closure, stale-row, fit, agg dedupe, class ownership, positions, keep-mask",
);
