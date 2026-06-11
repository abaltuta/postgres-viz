# Webview state review — adversarial findings + target architecture

Two independent read-only reviews (state-transition bug hunt + architecture
critique) of `webview/main.ts`. Both converge on the same root cause:

> Visibility is a multi-dimensional property encoded as ~12 independent
> cytoscape classes, and **nothing owns the full set for any given mode**.
> Every view transition is incremental (enter mutates, exit un-mutates), so
> any two operations touching overlapping classes corrupt each other.

## Confirmed bugs (ship fixes in this order)

1. **HIGH — position drift accumulates across focus swaps.**
   `enterIsolatedView` saves only NON-parent positions (`!n.isParent()`);
   a card materialized *before* entering the view is a parent, so its
   position is never saved. `exitView` dematerializes first (pinning the
   card at the view-layout position), then restores — the card is stranded.
   The next view re-captures `saved` from corrupted positions, so drift is
   permanent. Matches the user's "random when swapping focus" exactly.
   *Fix:* save parent centers too (drop the guard); restore loop already
   handles it because cards are non-parents again by restore time.

2. **HIGH — any tap during a call tree wipes the chain's edges.**
   `selectNode`/`clearSelection` do `cy.edges().removeClass("hot revealed
   agg-suppressed")` unconditionally; with edge-mode `off` the calltree's
   `revealed` coating is the only thing drawing edges. One background tap
   → blank view. *Fix:* `viewState.reapply` callback re-runs the view's
   `apply()` after selection changes.

3. **HIGH — exiting focus/calltree via the panel toggle with a ROW root
   dims the whole graph permanently.** The toggle handlers use the node
   captured at renderPanel time; `exitView` removes that row →
   `selectNode(detached)` dims everything and un-dims a dead collection.
   *Fix:* re-resolve by id (same pattern as focusNode/showCallTree).

4. **MED — exit view while edge-mode = all dematerializes everything and
   never re-materializes.** *Fix:* `applyFilters()` at end of `exitView`.

5. **MED — extension-pushed graph during a view leaks the canvas tint and
   a dead panel.** `render()` must remove `view-focus`/`view-calltree`
   from `#content` and hide `#panel`.

6. **MED-LOW — `exitView` leaves stale "avoid boxes" routing** (segments
   anchored to view geometry). *Fix:* re-route on exit.

7. **LOW — `hover-reveal`/`matched` survive view transitions; `hoverUnit`
   not reset in `render()`.** Add to the class strips.

8. **LOW-MED — panel edge rows link to focus-hidden nodes** → camera flies
   to blank space. Filter li-clicks through `isShownByClasses`.

Suspected (verify live): stacked zoom-nudge setTimeouts on fast stepper
clicks; focusSchema vs auto-checked "hide isolated"; `hot` not stripped by
calltree `apply()`.

## Target architecture (incremental, tests stay green)

1. **Class-group ownership** (zero-risk commit): partition all classes in
   `core.ts` into `VISIBILITY_MASK` (hidden-el, isolated-hidden,
   focus-hidden, untouched-hidden), `HIGHLIGHT_LAYER` (dimmed, revealed,
   hot, agg-suppressed, hover-reveal, matched), `STRUCTURE_HINTS`
   (virtual-card, edge-off, ortho). Rule: a function owns ONE group.
2. **`ViewSpec` + idempotent `applyViewSpec(spec)`**: `{mode, rootId,
   keepUnits, touchedRows, levels, savedPositions}`. Always reset to a
   canonical base (strip mask+highlight, demat all) then apply the spec.
   Replaces the enter/exit dance; view switch = `applyViewSpec(newSpec)`.
   Positions snapshot at spec creation, BEFORE any mutation (fixes the
   B-1 interleave: enterIsolatedView currently exits first, then saves).
3. **Data-driven crumb**: render crumb from the spec; listeners on stable
   containers dispatching spec updates (`levels: n+1`), no recursive
   `showCallTree`, no orphaned setTimeouts.
4. **selectNode is mode-aware**: in calltree it only touches `hot`;
   deselect re-applies the spec.
5. **Element identity invariant**: keep add/remove materialization (perf:
   live set stays ~1/10th of 4k+ nodes) but `cy.getElementById(id)` is the
   ONLY canonical reference — never hold a `NodeSingular` across a
   transition. `materialized` becomes private to materialize/demat.

Judgement from both reviews: **refactor now** (steps 1–2 first). The last
four fixed bugs and the eight above are the same class; patching adds a
guard per bug, the spec model removes the class.

## Testing

`applyViewSpec` and the spec reducers are headless-testable (extend
test/webview.ts): assert idempotence (apply twice = same classes), assert
focus(A)→focus(B)→exit restores base positions exactly, assert selection
during calltree keeps the reveal set.
