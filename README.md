# Postgres Viz

A VS Code extension that draws the **call graph / dependency graph of a PostgreSQL database**: which triggers fire which functions, which functions read/write which tables *and columns*, which views select which columns from which tables — across plain SQL, views, matviews, triggers, PL/pgSQL, FKs, and generated columns.

## What it extracts

| Dependency | Source | Precision |
| --- | --- | --- |
| view / matview → table columns | `pg_depend` + `pg_rewrite` | exact, column-level |
| view → functions it calls | `pg_depend` | exact |
| trigger → table, timing/events, `UPDATE OF` columns | `pg_trigger` | exact |
| trigger → function it executes | `pg_trigger.tgfoid` | exact |
| PL/pgSQL function → tables/columns read & written | `pg-query-emscripten` (real PG parser as WASM) over every embedded SQL expression | best-effort, column-level; `NEW.x`/`OLD.x` attributed to the trigger's table |
| function → function calls (`PERFORM`, `CALL`, expressions) | parser | best-effort |
| `BEGIN ATOMIC` SQL functions (PG 14+) | `pg_depend.prosqlbody` deps | exact, column-level |
| foreign keys | `pg_constraint` | exact, column-level |
| CHECK / PK / UNIQUE / EXCLUDE constraints → columns, and functions used in CHECK expressions | `pg_constraint` + `pg_depend` | exact |
| column defaults / generated columns → columns & functions | `pg_attrdef` deps | exact |

If the WASM parser fails to load, function bodies degrade to a regex fallback (table-level only). The bundled parser grammar is PostgreSQL 16; newer syntax in function bodies degrades gracefully to the fallback.

## Usage

```bash
pnpm install
pnpm build
```

Open the folder in VS Code and press **F5** (Run Extension). In the dev host:

1. `Postgres Viz: Visualize Database` — opens the graph panel; connection profiles are workspace-scoped (metadata in workspace state, URLs in VS Code secret storage). `Postgres Viz: Show Logs` opens the output channel with per-step introspection/analysis logs.
2. Click a node → neighborhood highlight + side panel with all connections; **Go to Definition** opens the source schema when found (`.hcl`, then the latest matching `folder/up.sql` migration); **Open DDL** shows generated database DDL.
3. Editor-title commands: search, grid/tree layout selection, edge display mode, view options, faceted filters, fit, relayout, and refresh.
4. Command palette / connection menu: impact analysis, dependency path reports, snapshot save/diff, JSON/PNG/SVG export, and load diagnostics.

Columns and triggers are drawn *inside* their table (compound nodes). Only columns that participate in at least one dependency are drawn. Table-level edges collapse/expand automatically when you toggle the columns filter.

### Settings

- `postgresViz.schemas` — schemas to introspect (empty = all non-system).
- `postgresViz.excludeSchemas` — schemas skipped when no whitelist is set (default `hdb_catalog`).
- `postgresViz.includeForeignKeys` — include FK edges (default true).
- `postgresViz.hclExcludeGlobs` — workspace globs excluded when scanning Atlas `.hcl` schema files for source definitions.
- `postgresViz.sqlMigrationExcludeGlobs` — workspace globs excluded when scanning `folder/up.sql` migrations for source definitions.

## Development

```bash
pnpm watch       # rebuild extension + webview on change
pnpm typecheck
pnpm lint        # oxlint
pnpm format      # oxfmt
pnpm smoke       # no-DB smoke/unit suite
```

### Integration test (real Postgres)

Runs the full introspect → analyze → graph pipeline against real Postgres and asserts every edge kind:

```bash
pnpm test:db:docker  # starts/stops postgres:16 on localhost:54339 when DATABASE_URL is unset
pnpm test:db         # uses DATABASE_URL, or postgres://postgres:pg@localhost:54339/postgres
```

## Architecture

- `src/introspect.ts` — one pass over the system catalogs (`pg_class`, `pg_attribute`, `pg_trigger`, `pg_proc`, `pg_depend`, `pg_rewrite`, `pg_constraint`, `pg_attrdef`).
- `src/analyze.ts` — parses PL/pgSQL bodies with `pg-query-emscripten` (`parsePlpgsql` → every `PLpgSQL_expr` → `parse`), then runs two passes per statement: a conservative whole-tree pass for table-level reads/writes and calls, and a **scope-aware pass for column attribution** that models FROM aliases, CTEs (including `WITH x(a, b)` column lists), derived tables, and correlated subqueries — so `rc.cid` reached through a CTE and a subquery alias still traces back to `orders.customer_id`, and the same alias bound to different tables in sibling scopes cannot cross-contaminate. Regex fallback included.
- `src/graph.ts` — turns catalog + analysis into Cytoscape elements (tables as compound nodes containing referenced columns and triggers).
- `src/graph-index.ts` / `src/graph-reports.ts` / `src/graph-diff.ts` — pure graph traversal, impact/path reports, and snapshot diff reports.
- `src/load-service.ts` — cancellable database load pipeline with diagnostics.
- `src/connection-profiles.ts` — named workspace connection profiles.
- `src/db.ts` / `src/ddl.ts` — shared Postgres client timeouts and DDL query helpers.
- `src/sql-migrations.ts` — pure scanner/indexer for `folder/up.sql` migrations; latest matching migration wins for source jumps.
- `src/protocol.ts` — shared view preferences and host/webview message contracts.
- `src/tree-provider.ts` — native VS Code explorer tree for database objects.
- `src/webview-controller.ts` — webview panel lifecycle, HTML, message dispatch, and ready replay.
- `src/extension.ts` — VS Code command chrome, connection menu, graph cache, reports/exports, DDL viewer.
- `webview/core.ts` — read-only webview graph helpers for class-derived visibility, unit ownership, call-tree closure, and position snapshots.
- `webview/cytoscape-adapter.ts` — the only webview layer that writes Cytoscape elements, classes, positions, parent moves, styles, and edge routes.
- `webview/main.ts` — webview orchestration, Cytoscape rendering decisions, grid/tree layouts (including dagre-backed tree v2), filters, search, and detail panel.

## Known limitations

- Dynamic SQL (`EXECUTE format(...)`) can't be statically resolved.
- Unqualified column refs are attributed only when unambiguous within the visible scopes.
- Languages other than `plpgsql`/`sql` (plpython, C, …) appear as nodes but their bodies aren't analyzed.
- Tested against PG 14+; PG ≤ 13 works without `BEGIN ATOMIC` body deps.
