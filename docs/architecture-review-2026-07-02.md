# Architecture review - 2026-07-02

## Current shape

Postgres Viz is already split better than a single extension file:

- `src/introspect.ts` owns catalog extraction.
- `src/analyze.ts` owns SQL / PL/pgSQL dependency analysis.
- `src/graph.ts` owns graph payload construction.
- `src/db.ts` and `src/ddl.ts` own shared database access and DDL lookup.
- `src/protocol.ts` owns host/webview message and preference types.
- `src/tree-provider.ts` owns the native database explorer tree.
- `src/extension.ts` owns VS Code commands, connection state, graph loading, DDL documents, symbols, HCL indexing, tree actions, and webview lifecycle.
- `webview/main.ts` owns rendering, layout, filtering, focus/call-tree views, selection, routing, search, details, and keyboard/pointer behavior.

The test surface is also stronger now: `test/integration.ts` exercises the real
Postgres catalog -> analyzer -> graph path against a fixture with views,
matviews, triggers, PL/pgSQL, `BEGIN ATOMIC` SQL functions, generated columns,
constraints, indexes, foreign keys, schema compounds, composite row parameters,
and payroll-style migration SQL.

Approximate file sizes at review time:

- `webview/main.ts`: 1777 lines
- `src/analyze.ts`: 1038 lines
- `src/extension.ts`: 913 lines
- `test/integration.ts`: 561 lines
- `src/introspect.ts`: 390 lines
- `src/graph.ts`: 387 lines

## Main risks

1. `webview/main.ts` is the highest-risk module.
   It still mixes graph element materialization, visual state classes, layout,
   selection, focus views, call-tree views, panel rendering, edge routing, and
   host message handling. The existing `docs/state-review-2026-06-11.md`
   correctly identifies the core issue: visibility and highlight state are
   spread across many Cytoscape classes, and mode transitions are incremental.

2. `src/extension.ts` remains a service locator plus command controller.
   The recent extraction of DB, DDL, protocol, and tree-provider code is good,
   but `extension.ts` still owns connection persistence, graph cache policy,
   loading, progress, command registration, webview lifecycle, symbol providers,
   DDL document provider, HCL index, and tree command orchestration.

3. `src/analyze.ts` is hard to change safely.
   The analyzer contains worker-parser lifecycle, parser fallback, AST walking,
   scope modeling, CTE / derived-table provenance, statement handling, trigger
   assignment inference, and output shaping in one file. Its behavior is
   valuable, but it is difficult to review targeted changes without rereading a
   large amount of parser-state logic.

4. There is no durable graph query layer.
   Feature work such as impact analysis, path finding, filters, exports, and
   tree/search behaviors will each reimplement traversal unless `GraphPayload`
   gets an indexed query facade.

5. Load/refresh is not designed around cancellation and diagnostics.
   Database analysis can be slow and partially degraded. Users need a structured
   post-load report: object counts, skipped schemas, parser fallback count,
   elapsed phases, warnings, and cancellation behavior.

## Recommended target architecture

### Keep

Keep the current core pipeline:

```text
Postgres Client -> introspect() -> analyzeAll() -> buildGraph() -> GraphPayload
```

That pipeline is conceptually sound and is now covered by a real DB integration
fixture. Do not rewrite the analyzer before the graph/UI state model is simpler;
the analyzer is complex because the domain is complex.

### Extract next

1. `GraphIndex`
   Add a pure module that builds indexes over `GraphPayload`:
   nodes by id, nodes by type, owner/parent links, incoming/outgoing edges by
   kind, card/detail edge grouping, reachable nodes, shortest paths, and impact
   summaries. Use this from the webview, tree commands, search, and future
   export/report features.

2. `LoadService`
   Move connection loading out of `extension.ts` into a service that accepts a
   connection string, schema config, include-FK option, logger, cancellation
   token, and cache policy. Return `{ graph, database, diagnostics }`.

3. `ConnectionProfiles`
   Replace the single secret key with named profiles:
   workspace state stores profile metadata; secret storage stores connection
   strings by profile id. This unlocks local/staging/prod switching without
   making users re-enter URLs.

4. `WebviewController`
   Keep command registration in `extension.ts`, but move panel creation,
   message dispatch, pending reveal/search/call-tree replay, and HTML generation
   into a controller class.

5. Webview state reducer
   Replace incremental class mutations with an idempotent state reducer:

   ```text
   AppState + Action -> AppState
   AppState -> Cytoscape classes/layout/panel
   ```

   Start with the existing `ViewSpec` idea from `docs/state-review-2026-06-11.md`.
   View switch should apply from a canonical base every time; selection should be
   mode-aware; element ids should be canonical and long-lived references should
   not cross view transitions.

### Possible larger rewrite

If you are willing to do a larger rewrite, make the UI a small app with three
explicit layers:

1. `graph-model`: pure TypeScript graph index, traversal, filtering, impact
   analysis, path finding, and export/report projections.
2. `graph-view-state`: pure TypeScript reducer for selected node, current view,
   filters, layout settings, highlighted paths, and diagnostics panel state.
3. `cytoscape-adapter`: the only code allowed to add/remove Cytoscape elements,
   classes, positions, and edge routes.

This is the best long-term direction because most recurring bugs are not parser
bugs; they are view-state ownership bugs.

## Incremental plan

1. Land the DB test wrapper and keep `test:db` as "use an existing DB".
2. Add `GraphIndex` with tests before adding more traversal features.
3. Move graph loading into `LoadService` with cancellation and diagnostics.
4. Move webview panel/message plumbing into `WebviewController`.
5. Refactor webview visibility/highlight classes into owned groups.
6. Convert focus/call-tree to idempotent `ViewSpec` application.
7. Add feature work on top of `GraphIndex`, not directly on raw Cytoscape state.

## Implementation status

Completed in the follow-up implementation:

- `scripts/test-db.mjs` and `pnpm test:db:docker` manage a disposable
  `postgres:16` integration database.
- `src/graph-index.ts` provides node/edge indexes, parent/card ownership,
  incoming/outgoing edge-kind filters, card/detail aggregate lookup,
  reachability, shortest paths, and impact summaries.
- `src/load-service.ts` owns the database load pipeline and returns graph load
  diagnostics; extension progress is cancellable.
- `src/webview-controller.ts` owns panel creation, HTML generation,
  host/webview message dispatch, ready replay, and queued navigation/export
  messages.
- `src/connection-profiles.ts` replaces the single saved connection with named
  workspace profiles: metadata in workspace state, connection strings in secret
  storage, plus legacy single-secret migration.
- Class ownership and idempotent `ViewSpec` application are split across
  `webview/core.ts`, `webview/cytoscape-adapter.ts`, and `webview/main.ts`,
  with smoke coverage in `test/webview.ts`.
- `webview/cytoscape-adapter.ts` owns concrete Cytoscape element, class,
  position, parent-move, style, and edge-route writes. `webview/core.ts`
  remains the read-only helper layer for traversal, visibility derivation, and
  position snapshots; `webview/main.ts` keeps orchestration, rendering choices,
  layout decisions, panels, and command handling.
- GraphIndex-backed user features are implemented:
  impact analysis reports, dependency path reports, snapshot diff reports,
  faceted filters, JSON export, PNG/SVG export, load diagnostics, and named
  connection switching.

## Test strategy

- Keep `pnpm smoke` for no-DB coverage: analyzer, DB/DDL helpers, connection
  profiles, load service, protocol, parser-worker IPC, graph index/reports/diff,
  tree model, webview state, HCL/SQL migration matching, lenses, and DDL symbols.
- Use `pnpm test:db:docker` for the real catalog/analyzer/graph regression path.
- Add pure tests for `GraphIndex`: direct dependents, transitive dependents,
  shortest path, edge-kind filters, and aggregation behavior.
- Add pure webview reducer tests before changing call-tree/focus behavior:
  applying a view twice is stable, focus(A) -> focus(B) -> exit restores base
  positions, and selection during call-tree does not clear revealed edges.
- Add one golden graph snapshot for the integration fixture once `GraphPayload`
  stabilizes enough to avoid noisy churn.

## Feature opportunities

Prioritized feature suggestions from a sidecar feature review:

1. Impact analysis view
   "What depends on this?" and "What does this affect?" with direct/transitive
   dependencies and edge-kind filters. Build on `GraphIndex`.

2. Path finder between objects
   Pick source and target objects, highlight the shortest readable dependency
   path, and explain each edge.

3. Snapshot diff
   Compare a saved graph with a refreshed DB or Atlas HCL-derived model, then
   highlight added/removed/changed objects and edges.

4. Named connection profiles
   Workspace-scoped local/staging/prod profiles with visible active profile and
   quick switching.

5. Faceted filters
   Schema, object type, edge kind, read/write-only, mutation-only, FK-only, and
   "hide functions without table effects".

6. Export/share
   PNG/SVG export plus Markdown/JSON impact reports for a selected node or the
   current view.

7. Load diagnostics and cancellable refresh
   Show a structured summary of included/skipped schemas, parse fallbacks,
   object counts, phase timings, and large graph warnings.
