/**
 * Pure cytoscape-graph helpers shared by the webview and its headless tests.
 *
 * Everything here derives visibility and traversal from CLASSES and edge data,
 * never from `:visible` — computed style is stale right after batched class
 * changes, which has caused a string of view bugs (piled-up rows, stacked
 * views inheriting leftovers, fits that covered the long-hidden full graph).
 */
import type { CollectionReturnValue, Core, NodeSingular } from "cytoscape";

// ── class-group ownership ──
// Every cytoscape class belongs to exactly ONE group; a function may only
// write classes of the group it owns. This is the structural fix for the
// "state gets messed up on view swap" family of bugs.

/** whether an element renders at all (read via isShownByClasses) */
export const HIDE_CLASSES = [
  "hidden-el", // owned by filters / schema grouping
  "isolated-hidden", // owned by the "hide isolated" filter
  "focus-hidden", // owned by views
  "untouched-hidden", // owned by views
] as const;

/** visual weight of an already-visible element — owned by views/selection */
export const HIGHLIGHT_CLASSES = [
  "dimmed",
  "revealed",
  "hot",
  "agg-suppressed",
  "hover-reveal",
  "matched",
] as const;

/** rendering form — owned by materialization (virtual-card) and edge config */
export const STRUCTURE_CLASSES = ["virtual-card", "edge-off", "ortho"] as const;

/** everything a view may have touched — stripped when (re)entering base state */
export const VIEW_OWNED_CLASSES = ["focus-hidden", "untouched-hidden", ...HIGHLIGHT_CLASSES];

/** Return ALL elements to the canonical base: no view masks, no highlights.
 *  Filter classes (hidden-el, isolated-hidden) and structure classes are
 *  owned elsewhere and deliberately survive. */
export function resetViewState(cy: Core): void {
  cy.batch(() => {
    cy.elements().removeClass(VIEW_OWNED_CLASSES.join(" "));
  });
}

// ── position snapshot/restore across views ──

export type PositionSnapshot = Map<string, { x: number; y: number }>;

/** Snapshot every node — compound parents store their DERIVED center, so a
 *  card that was materialized before a view isn't lost (the drift bug:
 *  skipping parents stranded them at the view layout's position forever). */
export function snapshotPositions(cy: Core): PositionSnapshot {
  const saved: PositionSnapshot = new Map();
  cy.nodes().forEach((n) => {
    if (n.isParent()) {
      // midpoint of child positions, not boundingBox — deterministic in
      // headless tests and unaffected by label/style sizing
      let x1 = Infinity;
      let y1 = Infinity;
      let x2 = -Infinity;
      let y2 = -Infinity;
      n.children().forEach((k) => {
        const p = k.position();
        x1 = Math.min(x1, p.x);
        y1 = Math.min(y1, p.y);
        x2 = Math.max(x2, p.x);
        y2 = Math.max(y2, p.y);
      });
      saved.set(n.id(), { x: (x1 + x2) / 2, y: (y1 + y2) / 2 });
    } else {
      saved.set(n.id(), { ...n.position() });
    }
  });
  return saved;
}

/** Restore by id. Only childless elements accept a position (compound
 *  positions are derived) — call AFTER dematerializing, when former parents
 *  are plain nodes again. Ids that no longer exist are skipped. */
export function restorePositions(cy: Core, saved: PositionSnapshot): void {
  cy.batch(() => {
    saved.forEach((pos, id) => {
      const n = cy.getElementById(id);
      if (n.nonempty() && n.isNode() && !n.isParent()) n.position(pos);
    });
  });
}

// ── focus/call-tree keep mask ──

/** Every card/standalone unit (children of schemas or roots), never rows. */
export function allCardUnits(cy: Core): NodeSingular[] {
  const out: NodeSingular[] = [];
  cy.nodes().forEach((n) => {
    if (n.data("type") === "schema") return;
    const p = n.parent().first();
    if (p.empty() || p.data("type") === "schema") out.push(n as NodeSingular);
  });
  return out;
}

/** Hide every unit outside `keep` (with its rows), then schema compounds left
 *  with no visible child. Writes ONLY focus-hidden. */
export function applyKeepMask(cy: Core, keep: ReadonlySet<string>): void {
  cy.batch(() => {
    for (const u of allCardUnits(cy)) {
      if (!keep.has(u.id())) u.union(u.descendants()).addClass("focus-hidden");
    }
    cy.nodes('[type="schema"]').forEach((s) => {
      let anyVisible = false;
      s.children().forEach((d) => {
        if (
          !d.hasClass("focus-hidden") &&
          !d.hasClass("hidden-el") &&
          !d.hasClass("isolated-hidden")
        ) {
          anyVisible = true;
        }
      });
      if (!anyVisible) s.addClass("focus-hidden");
    });
  });
}

/** Visibility from classes on self + ancestors (see module doc). */
export function isShownByClasses(n: NodeSingular): boolean {
  let e: NodeSingular = n;
  for (;;) {
    for (const c of HIDE_CLASSES) {
      if (e.hasClass(c)) return false;
    }
    const p = e.parent().first();
    if (p.empty()) return true;
    e = p as NodeSingular;
  }
}

/** The card a node belongs to (columns/triggers/constraints/indexes → their table). */
export function unitOf(n: NodeSingular): NodeSingular {
  let u: NodeSingular = n;
  for (;;) {
    const p = u.parent().first();
    if (p.empty() || p.data("type") === "schema") return u;
    u = p as NodeSingular;
  }
}

/** What a viewport fit should cover: the class-derived shown leaf nodes. */
export function fitTarget(cy: Core): CollectionReturnValue {
  const shown = cy.nodes().filter((n) => !n.isParent() && isShownByClasses(n as NodeSingular));
  return shown.length > 0 ? shown : cy.elements();
}

/**
 * Panel row dedupe: a table-level aggregate ("reads ×3 recurring_payrun") is
 * pure noise when the same kind/direction/counterpart already shows its
 * column-level rows — keep the columns, drop the rollup. Whole-table-only
 * relationships (no detail rows) keep their aggregate.
 */
export function suppressRedundantAggs<
  T extends { kind: string; counterUnit: string; out: boolean; agg?: boolean; detail?: boolean },
>(rows: T[]): T[] {
  const detailPairs = new Set(
    rows.filter((r) => r.detail).map((r) => `${r.kind}|${r.counterUnit}|${r.out}`),
  );
  return rows.filter((r) => !(r.agg && detailPairs.has(`${r.kind}|${r.counterUnit}|${r.out}`)));
}

/** Edge kinds that mean "this function touches that table's data". */
export const DATA_KINDS = new Set(["reads", "inserts", "updates", "deletes", "writes", "modifies"]);

/**
 * Call-tree closure from a trigger/function node: a trigger seeds with the
 * function(s) it executes; functions follow outgoing calls/executes
 * level by level (cycle-safe) up to `maxLevels` deep (the seed functions are
 * level 1); `keep` adds every table the closure touches plus the root's
 * direct callers for context.
 */
export function callTreeClosure(
  cy: Core,
  node: NodeSingular,
  maxLevels = Number.POSITIVE_INFINITY,
): { fns: Set<string>; keep: Set<string>; roots: Set<string> } {
  const startUnit = unitOf(node);
  const fns = new Set<string>();
  let frontier: string[] = [];
  if (node.data("type") === "trigger") {
    node.connectedEdges('[kind="executes"]').forEach((e) => {
      frontier.push(e.target().id());
    });
  } else {
    frontier.push(startUnit.id());
  }
  const roots = new Set(frontier);
  for (let level = 1; frontier.length > 0 && level <= maxLevels; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (fns.has(id)) continue;
      fns.add(id);
      cy.edges('[!detail][kind="calls"], [!detail][kind="executes"]').forEach((e) => {
        if (e.source().id() === id && !fns.has(e.target().id())) next.push(e.target().id());
      });
    }
    frontier = next;
  }
  const keep = new Set<string>(fns);
  keep.add(startUnit.id());
  cy.edges("[!detail]").forEach((e) => {
    if (DATA_KINDS.has(String(e.data("kind"))) && fns.has(e.source().id())) {
      keep.add(e.target().id());
    }
  });
  // context: who calls / fires the root
  cy.edges('[!detail][kind="calls"], [!detail][kind="executes"]').forEach((e) => {
    if (roots.has(e.target().id())) keep.add(e.source().id());
  });
  return { fns, keep, roots };
}
