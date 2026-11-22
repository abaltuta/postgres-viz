# postgres-viz

Before you rename a PostgreSQL column, find the functions that read it and the views that depend on those functions. Click a reference to see the SQL behind it.

postgres-viz is a standalone CLI with a built-in browser viewer. Scan your database once, then explore or share the resulting `.pgviz.json` file offline.

**[Download the latest release](https://github.com/abaltuta/postgres-viz/releases/latest)** for macOS, Linux, or Windows. The release includes the standalone CLI and packages for VS Code, Zed, and Vim.

![The orbital map of the commerce database, with the invoice-total function selected and its SQL definition showing the read of billing.invoices.total.](docs/images/commerce-dependencies.png)

## Install

**mise** (macOS, Linux, Windows)

```sh
mise use -g github:abaltuta/postgres-viz@0.10.0
```

**Homebrew** (macOS, Linux)

```sh
brew tap abaltuta/postgres-viz https://github.com/abaltuta/postgres-viz
brew install abaltuta/postgres-viz/postgres-viz
```

**Scoop** (Windows)

```powershell
scoop bucket add postgres-viz https://github.com/abaltuta/postgres-viz
scoop install postgres-viz/postgres-viz
```

## 60-second demo

After installing, run the bundled ten-schema commerce example. The demo works offline.

```sh
postgres-viz demo
```

1. Open **Object explorer**, search for `billing.invoices.total`, and select **total**.
2. Choose **Referenced by** and **2 hops**. Find the path through `billing.invoice_total(bigint, bigint)` to `reporting.open_invoices`.
3. Select the reporting view on that path. The first SQL definition shows where the function reads the column. The second shows where the view calls the function.

Switch to **Visual neighborhood** to see those connections side by side, or **Orbital map** for the whole database. Press Ctrl-C in the terminal to stop the viewer.

## Scan a PostgreSQL database

Pass a connection URI to open your database in the viewer. If you already set `DATABASE_URL`, run `postgres-viz` on its own.

```sh
postgres-viz 'postgresql://user@host:5432/database'
```

Use `scan` to save a snapshot and `open` to read it later.

```sh
postgres-viz scan 'postgresql://user@host:5432/database' --out database.pgviz.json
postgres-viz open database.pgviz.json
```

The default scan covers all eligible schemas. Repeat `--schema NAME` to select schemas or `--exclude-schema NAME` to skip them. Use `--no-fks` to omit foreign-key links. If a scan fails, your previous snapshot is preserved.

## Share and query offline

Send the snapshot to a teammate. They can open it with the CLI or VS Code without a database login. The CLI serves the viewer on localhost. To print its URL without launching a browser, run `postgres-viz open database.pgviz.json --no-browser`.

The file omits the connection URI but includes object names, SQL definitions, snippets and diagnostics. Review SQL literals and comments before sharing.

You can also trace references from the terminal. From this checkout, try the same two-hop search as the demo.

```sh
postgres-viz refs --file examples/commerce/commerce.pgviz.json --column billing.invoices.total --depth 2
```

Use `--json` for machine-readable output. For mixed-case or spaced names, pass one shell argument with each SQL identifier quoted, such as `'billing."Invoice Lines"."Total"'`.

## How the parser works

In the routine lab, searching for references to `ledger.entries.account_id` leads to a line inside `ledger.account_deltas`.

```sql
WHERE e.owner = a.id
```

How did the viewer find a column whose name appears nowhere on that line?

The scan starts with a read-only, repeatable-read transaction. It collects objects, column names and their order, plus dependencies PostgreSQL already records in `pg_depend`. These catalog entries can explain, for example, why a view depends on a function. To find reads inside a quoted SQL function body, postgres-viz also parses the definition. The embedded PostgreSQL parser runs in a child process and returns a syntax tree without executing the routine.

The surrounding query gives `owner` its meaning.

```sql
SELECT a.id, calc.amount
FROM ledger.accounts AS a
CROSS JOIN LATERAL (
  SELECT sum(e.amount) AS amount
  FROM ledger.entries AS e(owner)
  WHERE e.owner = a.id
) AS calc
```

The analyzer walks the tree and keeps track of the names visible in each query. Inside the subquery, `e` refers to `ledger.entries`. The column alias list `(owner)` renames its first column, which the catalog identifies as `account_id`. The remaining columns keep their names, so `e.amount` still means `ledger.entries.amount`. Because the subquery is `LATERAL`, it can also see `a.id` from the outer query.

The snapshot now records that `ledger.account_deltas` **reads** `ledger.entries.account_id`, with `WHERE e.owner = a.id` as evidence. Parsing the SQL embedded in the PL/pgSQL procedure `ledger.post_deltas` finds a **call** to that function. Those two relationships are enough to answer a two-hop reference query offline. [Read both routines](examples/routines/schema.sql)

Try it against the saved snapshot from the repository root:

```sh
postgres-viz refs --file examples/routines/routines.pgviz.json --column ledger.entries.account_id --depth 2
```

Dynamic SQL shows the limit of this approach. The same procedure uses a literal `EXECUTE 'INSERT INTO ledger.journal ...'`, so the analyzer can parse that string and identify the destination. Another `EXECUTE` builds a table name from a procedure argument. The snapshot flags that destination as unresolved. If a routine body fails to parse, a simpler scan can still recover some references. The viewer labels that evidence **fallback**. [Snapshot format and evidence](docs/snapshot-v1.md)

## PostgreSQL parser coverage

postgres-viz supports PostgreSQL 16 through 19. It uses the PostgreSQL 17 grammar with targeted extensions for newer syntax. A dash means the server version has no such syntax.

| What the analyzer can trace | PG 16 | PG 17 | PG 18 | PG 19 |
| --- | :---: | :---: | :---: | :---: |
| Source columns through table aliases, joins, CTEs, correlated subqueries and `LATERAL` | Yes | Yes | Yes | Yes |
| Read and write targets in `INSERT`, `UPDATE`, `DELETE` and `MERGE` | Yes | Yes | Yes | Yes |
| Routine calls with positional or named arguments, defaults and variadic arguments, when the target is unambiguous | Yes | Yes | Yes | Yes |
| PL/pgSQL embedded queries, `%ROWTYPE` field references and trigger `OLD` / `NEW` fields | Yes | Yes | Yes | Yes |
| SQL in a literal PL/pgSQL `EXECUTE` string | Yes | Yes | Yes | Yes |
| Source columns read by `JSON_TABLE`, such as the JSON payload column | - | Yes | Yes | Yes |
| Column reads in a `MERGE ... RETURNING` list | - | Yes | Yes | Yes |
| Old and new target-row columns in DML `RETURNING`, including `WITH (OLD AS ..., NEW AS ...)` aliases | - | - | Yes | Yes |
| Conflict-target, predicate and returned-column reads in `INSERT ... ON CONFLICT (...) DO SELECT ... RETURNING` | - | - | - | Yes |

The catalog also supplies dependencies for views, materialized views, indexes and constraints. A view's call to a function may be recorded for the whole view. Check the endpoint before attributing the call to an output column.

On PostgreSQL 18 and 19, snapshots also include virtual generated-column dependencies, additional `NOT NULL` constraint objects and foreign-key details such as `PERIOD` and `NOT ENFORCED`. [Parser tests](internal/analysis) · [Live PostgreSQL fixtures](internal/integration/version_features_test.go)

## Examples

| Saved example | What to follow |
| --- | --- |
| [Commerce](examples/commerce/commerce.pgviz.json) | The invoice total, its generated balance, the partial expression index and the reporting view across a 50-table database. |
| [Simple ledger](examples/simple/simple.pgviz.json) | One table, one function and one view isolate a two-hop dependency. |
| [Routine lab](examples/routines/routines.pgviz.json) | Follow `ledger.entries.account_id` to `ledger.post_deltas`. Compare its literal and runtime-built `EXECUTE` commands in the [routine definitions](examples/routines/schema.sql). |

## Editors

- **VS Code**. Install the VSIX for your platform, then open a `.pgviz.json` file. To scan a live database, run **postgres-viz: Capture Database Snapshot**. Select evidence to open the matching workspace source or captured SQL. [VS Code setup](editors/vscode)
- **Zed**. Extract the Zed ZIP and use **zed: install dev extension** on the folder containing `extension.toml`. Browse a snapshot in the outline, or launch the viewer from the task picker with `postgres-viz` on your PATH. [Zed setup and tasks](editors/zed/README.md)
- **Vim**. Install the plugin and put `postgres-viz` on Vim's PATH. Open a snapshot and run `:PostgresVizOpen`. To capture one, set `DATABASE_URL` and run `:PostgresVizScan database.pgviz.json`. Requires Vim with job support. [Vim setup](editors/vim/README.md)

## Development

For issue reports and pull requests, see the [contribution guide](collaboration.md).

Use the Go version pinned in [mise.toml](mise.toml), Node.js 22.16 or newer, and the pnpm version pinned in [package.json](package.json). Run the following from the repository root on macOS or Linux.

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm build
./dist/postgres-viz demo
```

Run the local checks with the pinned toolchain active.

| Check | Command |
| --- | --- |
| Types, lint and smoke tests | `pnpm typecheck`, `pnpm lint`, `pnpm smoke` |
| Browser interactions | After building, set `CHROME_BIN` to your Chrome or Chromium executable and run `pnpm test:ui`. |
| Live database fixtures | `pnpm test:db` starts PostgreSQL 16 in Docker. Set `PGVIZ_POSTGRES_MAJOR` for 17, 18 or 19, or point `DATABASE_URL` at a disposable server where the test role can create databases. |

To regenerate the commerce example, set `DATABASE_URL` to an empty PostgreSQL 16 database, load the schema, then scan it.

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -1 -f examples/commerce/schema.sql
./dist/postgres-viz scan --out examples/commerce/commerce.pgviz.json
```

On macOS or Linux with `zip` installed, `pnpm release` writes the release packages to `release/assets/`. It builds CLI ZIPs and matching VSIX packages for macOS, Linux and Windows on amd64 and arm64, plus Zed and Vim ZIPs and `SHA256SUMS`. [Release instructions](docs/releasing.md)

## License

postgres-viz is distributed under the [MIT License](LICENSE).
