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
import { callTreeClosure, fitTarget, isShownByClasses, unitOf } from "../webview/core";

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

console.log("webview OK — call-tree closure, stale-row re-resolution, class-derived fit");
