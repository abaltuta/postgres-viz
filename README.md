# postgres-viz

Which views, functions and indexes depend on the column you're about to change? postgres-viz captures PostgreSQL dependencies in a portable `.pgviz.json` file. Open it in the viewer to follow a reference and inspect the SQL behind it, even after disconnecting from the database.

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
2. Choose **Referenced by** and **2 hops**. In the row containing `billing.invoice_total(bigint, bigint)`, select **reporting.open_invoices**.
3. Read the two SQL definitions. The function reads the invoice total, and the reporting view calls the function. The generated balance and a partial index also reference the original column.

For a diagram of the same relationships, use **Visual neighborhood**. The **Orbital map**, **Dependency matrix**, **Arc diagram** and **Reference index** show connections across the database. Press Ctrl-C in the terminal to stop the viewer.

## Scan a PostgreSQL database

Pass a URI to capture and immediately explore a database. Use `scan` to save a file you can reopen or share.

```sh
postgres-viz 'postgresql://user@host:5432/database'
```

```sh
postgres-viz scan 'postgresql://user@host:5432/database' --out database.pgviz.json
postgres-viz open database.pgviz.json
```

If `DATABASE_URL` is set, you can omit the URI. By default the CLI scans all eligible schemas. Repeat `--schema NAME` to include specific schemas, or repeat `--exclude-schema NAME` to exclude them. Use `--no-fks` to omit foreign-key links. A failed scan preserves the previous file.

## Share and query offline

Send the snapshot to a teammate. They can run `postgres-viz open database.pgviz.json` or open it in VS Code without database access. The CLI serves the file on loopback. Use `open --no-browser` with the filename to print the local URL without launching a browser.

Snapshots contain object names, SQL definitions, snippets and diagnostics. Review literals and comments before sharing. The connection URI is excluded. From this checkout, use `refs` to trace the demo column in your terminal.

```sh
postgres-viz refs --file examples/commerce/commerce.pgviz.json --column billing.invoices.total --depth 2
```

Use `--json` for machine-readable output. For mixed-case or spaced names, pass one shell argument with each SQL identifier quoted, such as `'billing."Invoice Lines"."Total"'`.

## PostgreSQL parser coverage

postgres-viz scans PostgreSQL 16 through 19. The table shows which dependencies it can trace in SQL and PL/pgSQL routines on each server version. It uses PostgreSQL 17 grammar with targeted extensions for 18 and 19. A dash means the server version has no such syntax.

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

For example, a literal `EXECUTE 'SELECT total FROM billing.invoices'` can yield a column reference. If the table name comes from a runtime variable, the analyzer reports the unresolved SQL. The fixtures exercise scope resolution, routine calls and version-specific statements. [Parser tests](internal/analysis) · [Live PostgreSQL version fixtures](internal/integration/version_features_test.go)

**Catalog coverage.** The scan also reads dependencies directly from PostgreSQL, including those for views, materialized views, indexes and constraints. On 18 and 19 it captures virtual generated-column dependencies, additional `NOT NULL` constraint objects and foreign-key details such as `PERIOD` and `NOT ENFORCED`.

A view calling a function can establish a dependency for the view as a whole. Check the recorded endpoint before attributing it to a particular output column. The viewer labels catalog, parsed and fallback evidence. Snapshot diagnostics identify unresolved references, including dynamic SQL whose destination is only known at runtime. [Snapshot format and evidence](docs/snapshot-v1.md)

## Examples

| Saved example | What to follow |
| --- | --- |
| [Commerce](examples/commerce/commerce.pgviz.json) | The invoice total, its generated balance, the partial expression index and the reporting view across a 50-table database. |
| [Simple ledger](examples/simple/simple.pgviz.json) | One table, one function and one view isolate a two-hop dependency. |
| [Routine lab](examples/routines/routines.pgviz.json) | Follow `ledger.entries.account_id` to `ledger.post_deltas`. Compare its literal and runtime-built `EXECUTE` commands in the [routine definitions](examples/routines/schema.sql). |

## Editors

- **VS Code** - Use **Extensions: Install from VSIX** with the package for your platform. Open a snapshot in the viewer or run **postgres-viz: Capture Database Snapshot** from the Command Palette. Regenerating the file refreshes the viewer. Open evidence in a matching workspace source or in the captured SQL. [Extension](editors/vscode)
- **Zed** - Extract the Zed ZIP. Run **zed: install dev extension** and choose the folder containing `extension.toml`. Open a snapshot to browse its outline, or launch the viewer from the task picker with the CLI on Zed's PATH. [Setup and capture tasks](editors/zed/README.md)
- **Vim** - Extract the Vim ZIP into your Vim runtime directory, with `postgres-viz.vim` under `plugin/`. With the CLI on Vim's PATH and `DATABASE_URL` set, run `:PostgresVizScan database.pgviz.json`. Edit that file and run `:PostgresVizOpen`. Requires Vim with job support. [Plugin](editors/vim/plugin/postgres-viz.vim)

## Development

Use the Go version pinned in [mise.toml](mise.toml), Node.js 22.16 or newer, and the pnpm version pinned in [package.json](package.json). Run the following from the repository root on macOS or Linux.

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm build
./dist/postgres-viz demo
```

With the pinned toolchain active, run `pnpm typecheck`, `pnpm lint` and `pnpm smoke`. After building, set `CHROME_BIN` to a Chrome or Chromium executable and run `pnpm test:ui`. Run `pnpm test:db` for the database fixtures. It starts a disposable PostgreSQL 16 server with Docker by default. Set `PGVIZ_POSTGRES_MAJOR` to test 17, 18 or 19, or set `DATABASE_URL` to a disposable server where the test role can create databases.

To regenerate the commerce example, set `DATABASE_URL` to an empty PostgreSQL 16 database, load the schema, then scan it.

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -1 -f examples/commerce/schema.sql
./dist/postgres-viz scan --out examples/commerce/commerce.pgviz.json
```

On macOS or Linux with `zip` installed, `pnpm release` writes the release packages to `release/assets/`. It builds CLI ZIPs and matching VSIX packages for macOS, Linux and Windows on amd64 and arm64, plus Zed and Vim ZIPs and `SHA256SUMS`. [Release instructions](docs/releasing.md)

## License

postgres-viz is distributed under the [MIT License](LICENSE).
