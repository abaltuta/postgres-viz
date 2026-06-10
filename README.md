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

1. `Postgres Viz: Visualize Database` — opens the graph panel; enter the connection string in the bar at the top (stored in VS Code secret storage, prefilled next time). `Postgres Viz: Show Logs` opens the output channel with per-step introspection/analysis logs.
2. Click a node → neighborhood highlight + side panel with all connections; **Open DDL** shows the view/function/trigger/table definition.
3. Toolbar: search, layout switcher (fcose/tree/concentric/grid), and filters for columns, views, functions, triggers, FK edges, and isolated nodes.

Columns and triggers are drawn *inside* their table (compound nodes). Only columns that participate in at least one dependency are drawn. Table-level edges collapse/expand automatically when you toggle the columns filter.

### Settings

- `postgresViz.schemas` — schemas to introspect (empty = all non-system).
- `postgresViz.includeForeignKeys` — include FK edges (default true).

## Development

```bash
pnpm watch       # rebuild extension + webview on change
pnpm typecheck
pnpm lint        # oxlint
pnpm format      # oxfmt
pnpm smoke       # analyzer smoke test (no DB needed)
```

### Integration test (real Postgres)

Runs the full introspect → analyze → graph pipeline against a disposable container and asserts every edge kind:

```bash
docker run -d --rm --name pgviz-test -p 54339:5432 -e POSTGRES_PASSWORD=pg postgres:16
pnpm test:db     # set DATABASE_URL to use a different server
docker stop pgviz-test
```

## Architecture

- `src/introspect.ts` — one pass over the system catalogs (`pg_class`, `pg_attribute`, `pg_trigger`, `pg_proc`, `pg_depend`, `pg_rewrite`, `pg_constraint`, `pg_attrdef`).
- `src/analyze.ts` — parses PL/pgSQL bodies with `pg-query-emscripten` (`parsePlpgsql` → every `PLpgSQL_expr` → `parse`), then runs two passes per statement: a conservative whole-tree pass for table-level reads/writes and calls, and a **scope-aware pass for column attribution** that models FROM aliases, CTEs (including `WITH x(a, b)` column lists), derived tables, and correlated subqueries — so `rc.cid` reached through a CTE and a subquery alias still traces back to `orders.customer_id`, and the same alias bound to different tables in sibling scopes cannot cross-contaminate. Regex fallback included.
- `src/graph.ts` — turns catalog + analysis into Cytoscape elements (tables as compound nodes containing referenced columns and triggers).
- `src/extension.ts` — commands, secret-stored connection string, webview panel, DDL viewer.
- `webview/main.ts` — Cytoscape rendering, fcose layout, filters, search, detail panel.

## Known limitations

- Dynamic SQL (`EXECUTE format(...)`) can't be statically resolved.
- Unqualified column refs are attributed only when unambiguous within the visible scopes.
- Languages other than `plpgsql`/`sql` (plpython, C, …) appear as nodes but their bodies aren't analyzed.
- Tested against PG 14+; PG ≤ 13 works without `BEGIN ATOMIC` body deps.
