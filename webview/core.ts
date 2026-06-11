/**
 * Pure cytoscape-graph helpers shared by the webview and its headless tests.
 *
 * Everything here derives visibility and traversal from CLASSES and edge data,
 * never from `:visible` — computed style is stale right after batched class
 * changes, which has caused a string of view bugs (piled-up rows, stacked
 * views inheriting leftovers, fits that covered the long-hidden full graph).
 */
import type { CollectionReturnValue, Core, NodeSingular } from "cytoscape";

export const HIDE_CLASSES = [
  "hidden-el",
  "isolated-hidden",
  "focus-hidden",
  "untouched-hidden",
] as const;

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

/** Edge kinds that mean "this function touches that table's data". */
export const DATA_KINDS = new Set(["reads", "inserts", "updates", "deletes", "writes"]);

/**
 * Call-tree closure from a trigger/function node: a trigger seeds with the
 * function(s) it executes; functions follow outgoing calls/executes
 * transitively (cycle-safe); `keep` adds every table the closure touches plus
 * the root's direct callers for context.
 */
export function callTreeClosure(
  cy: Core,
  node: NodeSingular,
): { fns: Set<string>; keep: Set<string>; roots: Set<string> } {
  const startUnit = unitOf(node);
  const fns = new Set<string>();
  const queue: string[] = [];
  if (node.data("type") === "trigger") {
    node.connectedEdges('[kind="executes"]').forEach((e) => {
      queue.push(e.target().id());
    });
  } else {
    queue.push(startUnit.id());
  }
  const roots = new Set(queue);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (fns.has(id)) continue;
    fns.add(id);
    cy.edges('[!detail][kind="calls"], [!detail][kind="executes"]').forEach((e) => {
      if (e.source().id() === id && !fns.has(e.target().id())) queue.push(e.target().id());
    });
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
