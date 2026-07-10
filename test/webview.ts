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
import cytoscape, { Core, EdgeSingular, NodeSingular } from "cytoscape";
import { DEFAULT_PREFS } from "../src/protocol";
import {
  aggregateMemberLabels,
  allCardUnits,
  callTreeClosure,
  fitTarget,
  isShownByClasses,
  snapshotPositions,
  suppressRedundantAggs,
  unitOf,
} from "../webview/core";
import {
  applyFilterClasses,
  applySelectionClasses,
  applyKeepMask,
  dematerializeCard,
  edgeHidden,
  edgeShownByClasses,
  markSingleCardEdgesOrthogonal,
  materializeCard,
  materializeNeighborhood,
  type MaterializationState,
  restackRows,
  resetViewState,
  restoreViewPositions,
} from "../webview/cytoscape-adapter";

function emptyMaterializationState(): MaterializationState {
  return {
    rowsByCard: new Map(),
    detailEdgesByCard: new Map(),
    cardOfNode: new Map(),
    materialized: new Set(),
    materializeCap: 30,
  };
}

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

// ── 2. data dependency closure includes view SELECT edges ──
{
  const cy = cytoscape({
    headless: true,
    elements: {
      nodes: [
        { data: { id: "orders_v", type: "view" } },
        { data: { id: "orders", type: "table" } },
      ],
      edges: [{ data: { id: "e_selects", source: "orders_v", target: "orders", kind: "selects" } }],
    },
  });
  const view = cy.getElementById("orders_v") as unknown as NodeSingular;
  const { keep } = callTreeClosure(cy, view);
  assert.ok(keep.has("orders"), "selects edges count as data touches");
}

// ── 3. stale row reference after dematerialize/materialize ──
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

// ── 4. fit target derives from classes, not (stale) computed style ──
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

// ── 5. panel rows: table-level aggregates are noise when their columns show ──
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

// ── 6. panel aggregate members are found from either endpoint card ──
{
  const detailEdgesByCard = new Map([
    [
      "orders",
      [
        { data: { id: "d1", source: "fn", target: "orders_total", kind: "reads" } },
        { data: { id: "d2", source: "orders_customer_id", target: "customers_id", kind: "fk" } },
      ],
    ],
    [
      "customers",
      [{ data: { id: "d2", source: "orders_customer_id", target: "customers_id", kind: "fk" } }],
    ],
  ]);
  const nodeDefById = new Map([
    ["orders_total", { data: { label: "total", type: "column" } }],
    ["orders_customer_id", { data: { label: "customer_id", type: "column" } }],
    ["customers_id", { data: { label: "id", type: "column" } }],
  ]);
  const cardOfNode = new Map([
    ["orders_total", "orders"],
    ["orders_customer_id", "orders"],
    ["customers_id", "customers"],
  ]);
  const rowTypes = new Set(["column", "trigger", "constraint", "index"]);
  assert.equal(
    aggregateMemberLabels(
      { source: "fn", target: "orders", kind: "reads" },
      detailEdgesByCard,
      nodeDefById,
      cardOfNode,
      rowTypes,
    ),
    "total",
    "function -> table aggregates find detail rows indexed under the target card",
  );
  assert.equal(
    aggregateMemberLabels(
      { source: "orders", target: "customers", kind: "fk" },
      detailEdgesByCard,
      nodeDefById,
      cardOfNode,
      rowTypes,
    ),
    "customer_id→id",
    "row-row detail edges are deduped when both endpoint cards index them",
  );

  const malformedNodeDefById = new Map([
    ["orders_bad", { data: { label: undefined, type: "column" } }],
    ["customers_bad", { data: { label: "", type: "column" } }],
  ]);
  assert.equal(
    aggregateMemberLabels(
      { source: "orders", target: "customers", kind: "fk" },
      new Map([
        [
          "orders",
          [{ data: { id: "bad_fk", source: "orders_bad", target: "customers_bad", kind: "fk" } }],
        ],
      ]),
      malformedNodeDefById,
      new Map([
        ["orders_bad", "orders"],
        ["customers_bad", "customers"],
      ]),
      rowTypes,
    ),
    "orders_bad→customers_bad",
    "malformed aggregate member labels fall back to stable node ids",
  );
}

// ── 7. view-state class ownership: reset strips ONLY view-owned classes ──
{
  const cy = build();
  const n = cy.getElementById("orders");
  n.addClass("focus-hidden untouched-hidden dimmed revealed hot hover-reveal matched");
  n.addClass("hidden-el facet-hidden isolated-hidden virtual-card"); // filter/structure-owned
  const e = cy.getElementById("e2");
  e.addClass("revealed agg-suppressed edge-off ortho");
  resetViewState(cy);
  for (const owned of ["focus-hidden", "untouched-hidden", "dimmed", "revealed", "hot"]) {
    assert.ok(!n.hasClass(owned), `view-owned class ${owned} stripped`);
  }
  assert.ok(!n.hasClass("hover-reveal") && !n.hasClass("matched"), "highlight layer stripped");
  assert.ok(!e.hasClass("revealed") && !e.hasClass("agg-suppressed"), "edge highlights stripped");
  for (const kept of ["hidden-el", "facet-hidden", "isolated-hidden", "virtual-card"]) {
    assert.ok(n.hasClass(kept), `filter/structure class ${kept} survives a view reset`);
  }
  assert.ok(e.hasClass("edge-off") && e.hasClass("ortho"), "edge structure classes survive");
}

// ── 8. position snapshot/restore survives the dematerialize round-trip ──
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
  restoreViewPositions(cy, saved);
  const c = cy.getElementById("card").position();
  assert.ok(Math.abs(c.x - 100) < 1 && Math.abs(c.y - 200) < 1, "card restored to base center");
  const f = cy.getElementById("fn").position();
  assert.equal(`${f.x},${f.y}`, "500,500", "standalone node restored");
}

// ── 9. dematerialize clears stale bookkeeping for missing cards ──
{
  const cy = cytoscape({ headless: true, elements: { nodes: [], edges: [] } });
  const state = emptyMaterializationState();
  state.materialized.add("gone");
  dematerializeCard(cy, state, "gone");
  assert.ok(!state.materialized.has("gone"), "missing cards do not leak materialized state");
}

// ── 10. keep-mask: non-keep units hidden with descendants, empty schemas hidden ──
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

  applyKeepMask(cy, new Set(["b"]));
  assert.ok(cy.getElementById("a").hasClass("focus-hidden"), "previously kept card can be hidden");
  assert.ok(!cy.getElementById("b").hasClass("focus-hidden"), "previously hidden card can be kept");
  assert.ok(!cy.getElementById("s1").hasClass("focus-hidden"), "schema is recomputed on remask");
  assert.ok(cy.getElementById("f1").hasClass("focus-hidden"), "standalone keep mask is replaced");
}

// ── 11. faceted filters hide incident edges and empty schema compounds ──
{
  const cy = cytoscape({
    headless: true,
    elements: {
      nodes: [
        { data: { id: "s_public", label: "public", type: "schema", schema: "public" } },
        {
          data: {
            id: "orders",
            label: "orders",
            type: "table",
            parent: "s_public",
            schema: "public",
          },
        },
        {
          data: {
            id: "orders_total",
            label: "total",
            type: "column",
            parent: "orders",
            schema: "public",
          },
        },
        { data: { id: "s_private", label: "private", type: "schema", schema: "private" } },
        {
          data: {
            id: "customers",
            label: "customers",
            type: "table",
            parent: "s_private",
            schema: "private",
          },
        },
      ],
      edges: [{ data: { id: "e", source: "orders", target: "customers", kind: "reads" } }],
    },
  });
  applyFilterClasses(
    cy,
    emptyMaterializationState(),
    { ...DEFAULT_PREFS, filterSchemas: ["public"], hideIsolated: true },
    DEFAULT_PREFS.edgeMode,
    false,
  );
  assert.ok(cy.getElementById("customers").hasClass("facet-hidden"), "filtered schema node hidden");
  assert.ok(
    cy.getElementById("s_private").hasClass("facet-hidden"),
    "empty filtered schema hidden",
  );
  assert.ok(cy.getElementById("e").hasClass("facet-hidden"), "edge to filtered endpoint hidden");
  assert.ok(
    cy.getElementById("orders").hasClass("isolated-hidden"),
    "filtered-out endpoint does not keep the visible endpoint non-isolated",
  );
}

// ── 12. orthogonal edge marking ignores filter-hidden parallel edges ──
{
  const cy = cytoscape({
    headless: true,
    elements: {
      nodes: [{ data: { id: "a", type: "table" } }, { data: { id: "b", type: "table" } }],
      edges: [
        { data: { id: "visible", source: "a", target: "b", kind: "reads", agg: true } },
        { data: { id: "filtered", source: "a", target: "b", kind: "calls", agg: true } },
      ],
    },
  });
  cy.getElementById("filtered").addClass("facet-hidden ortho");
  markSingleCardEdgesOrthogonal(cy);
  assert.ok(cy.getElementById("visible").hasClass("ortho"), "visible singleton pair is orthogonal");
  assert.ok(
    !cy.getElementById("filtered").hasClass("ortho"),
    "filter-hidden parallel edge does not keep stale orthogonal routing",
  );
}

// ── 13. endpoint-hidden edges are not panel-visible ──
{
  const cy = cytoscape({
    headless: true,
    elements: {
      nodes: [
        { data: { id: "visible", type: "table" } },
        { data: { id: "masked", type: "table" } },
      ],
      edges: [{ data: { id: "e", source: "visible", target: "masked", kind: "reads" } }],
    },
  });
  const edge = cy.getElementById("e") as unknown as EdgeSingular;
  cy.getElementById("masked").addClass("focus-hidden");
  assert.equal(edgeHidden(edge), false, "edge itself is not edge-hidden");
  assert.equal(
    edgeShownByClasses(edge),
    false,
    "panel-facing edge visibility also checks hidden endpoints",
  );
}

// ── 14. row selection suppresses every overview bundle touching its card ──
{
  const cy = cytoscape({
    headless: true,
    elements: {
      nodes: [
        { data: { id: "orders", type: "table" } },
        { data: { id: "orders_total", type: "column", parent: "orders" } },
        { data: { id: "fn", type: "function" } },
      ],
      edges: [
        {
          data: {
            id: "detail_reads",
            source: "fn",
            target: "orders_total",
            kind: "reads",
            detail: true,
          },
        },
        { data: { id: "agg_reads", source: "fn", target: "orders", kind: "reads", agg: true } },
        { data: { id: "agg_writes", source: "fn", target: "orders", kind: "writes", agg: true } },
        {
          data: {
            id: "agg_reverse_reads",
            source: "orders",
            target: "fn",
            kind: "reads",
            agg: true,
          },
        },
      ],
    },
  });
  applySelectionClasses(cy, cy.getElementById("orders_total") as unknown as NodeSingular, unitOf);
  assert.ok(
    cy.getElementById("agg_reads").hasClass("agg-suppressed"),
    "matching aggregate is suppressed when its detail row is revealed",
  );
  assert.ok(
    cy.getElementById("agg_writes").hasClass("agg-suppressed"),
    "parallel overview bundles are suppressed while typed edges are revealed",
  );
  assert.ok(
    cy.getElementById("agg_reverse_reads").hasClass("agg-suppressed"),
    "reverse overview bundles touching the selected card are suppressed",
  );
}

// ── 15. row focus/search needs counterpart rows for row-row details ──
{
  const make = (): { cy: Core; state: MaterializationState } => {
    const rowsByCard = new Map([
      [
        "orders",
        [
          {
            data: {
              id: "orders_customer_id",
              label: "customer_id",
              type: "column" as const,
              parent: "orders",
              schema: "public",
              oid: 1,
              ord: 1,
            },
          },
        ],
      ],
      [
        "customers",
        [
          {
            data: {
              id: "customers_id",
              label: "id",
              type: "column" as const,
              parent: "customers",
              schema: "public",
              oid: 2,
              ord: 1,
            },
          },
        ],
      ],
    ]);
    const fk = {
      data: {
        id: "fk_detail",
        source: "orders_customer_id",
        target: "customers_id",
        kind: "fk" as const,
        detail: true,
      },
    };
    return {
      cy: cytoscape({
        headless: true,
        elements: {
          nodes: [
            { data: { id: "orders", type: "table" } },
            { data: { id: "customers", type: "table" } },
          ],
          edges: [
            {
              data: {
                id: "agg_fk",
                source: "orders",
                target: "customers",
                kind: "fk",
                agg: true,
              },
            },
          ],
        },
      }),
      state: {
        rowsByCard,
        detailEdgesByCard: new Map([
          ["orders", [fk]],
          ["customers", [fk]],
        ]),
        cardOfNode: new Map([
          ["orders_customer_id", "orders"],
          ["customers_id", "customers"],
        ]),
        materialized: new Set(),
        materializeCap: 30,
      },
    };
  };

  const single = make();
  materializeCard(single.cy, single.state, "orders");
  assert.ok(single.cy.getElementById("orders_customer_id").nonempty(), "source row exists");
  assert.ok(
    single.cy.getElementById("fk_detail").empty(),
    "one-card materialization cannot restore a row-row edge",
  );

  const hood = make();
  materializeNeighborhood(hood.cy, hood.state, "orders");
  assert.ok(hood.cy.getElementById("customers_id").nonempty(), "counterpart row exists");
  assert.ok(hood.cy.getElementById("fk_detail").nonempty(), "row-row detail edge is restored");
  applySelectionClasses(
    hood.cy,
    hood.cy.getElementById("orders_customer_id") as unknown as NodeSingular,
    unitOf,
  );
  assert.ok(
    hood.cy.getElementById("agg_fk").hasClass("agg-suppressed"),
    "selection can suppress the aggregate once the detail edge exists",
  );
}

// ── 16. malformed row order stacks after ordered rows ──
{
  const cy = cytoscape({
    headless: true,
    elements: {
      nodes: [
        { data: { id: "orders", label: "orders", type: "table" } },
        { data: { id: "orders_id", label: "id", type: "column", parent: "orders", ord: 1 } },
        { data: { id: "orders_name", label: "name", type: "column", parent: "orders", ord: 2 } },
        { data: { id: "orders_bad", label: "bad", type: "column", parent: "orders" } },
        { data: { id: "orders_nan", label: "nan", type: "column", parent: "orders", ord: NaN } },
      ],
      edges: [],
    },
  });
  restackRows(cy);
  const yOf = (id: string): number => cy.getElementById(id).position("y");
  assert.ok(yOf("orders_id") < yOf("orders_name"), "ordered rows keep their ord order");
  assert.ok(yOf("orders_name") < yOf("orders_bad"), "missing ord stacks after ordered rows");
  assert.ok(yOf("orders_name") < yOf("orders_nan"), "malformed ord stacks after ordered rows");
}

// ── 17. edge modes separate bundles/details and cap eager row materialization ──
{
  const cy = cytoscape({
    headless: true,
    elements: {
      nodes: [
        { data: { id: "a", label: "a", type: "table", schema: "public" } },
        { data: { id: "b", label: "b", type: "table", schema: "public" } },
      ],
      edges: [
        {
          data: {
            id: "bundle",
            source: "a",
            target: "b",
            kind: "reads",
            agg: true,
            count: 5,
            kinds: { reads: 3, calls: 2 },
            label: "2 kinds · ×5",
          },
        },
        { data: { id: "typed", source: "a", target: "b", kind: "reads" } },
      ],
    },
  });
  const state: MaterializationState = {
    rowsByCard: new Map([
      [
        "a",
        [
          {
            data: { id: "a1", label: "a1", type: "column", parent: "a", schema: "public", oid: 1 },
          },
          {
            data: { id: "a2", label: "a2", type: "column", parent: "a", schema: "public", oid: 1 },
          },
        ],
      ],
      [
        "b",
        [
          {
            data: { id: "b1", label: "b1", type: "column", parent: "b", schema: "public", oid: 2 },
          },
        ],
      ],
    ]),
    detailEdgesByCard: new Map(),
    cardOfNode: new Map(),
    materialized: new Set(),
    materializeCap: 30,
    materializeAllRowsCap: 2,
  };
  applyFilterClasses(cy, state, DEFAULT_PREFS, "all", false);
  assert.ok(cy.getElementById("bundle").hasClass("edge-off"), "all mode hides overview bundles");
  assert.ok(!cy.getElementById("typed").hasClass("edge-off"), "all mode shows typed edges");
  assert.deepEqual([...state.materialized], ["a"], "all mode honors the eager row budget");

  applyFilterClasses(
    cy,
    state,
    { ...DEFAULT_PREFS, filterEdgeKinds: ["calls"] },
    "cards",
    false,
  );
  assert.ok(!cy.getElementById("bundle").hasClass("edge-off"), "cards mode shows overview bundles");
  assert.ok(
    !cy.getElementById("bundle").hasClass("facet-hidden"),
    "a bundle survives when any member kind matches",
  );
  assert.equal(
    cy.getElementById("bundle").data("displayLabel"),
    "×2",
    "bundle labels show only the active kind count",
  );
  assert.ok(cy.getElementById("typed").hasClass("edge-off"), "cards mode hides typed edges");
}

console.log(
  "webview OK — closure, stale-row, fit, agg members, agg dedupe, class ownership, positions, demat, keep-mask, facets, routing, panel visibility, selection aggs, row neighborhoods, row order, edge budgets",
);
